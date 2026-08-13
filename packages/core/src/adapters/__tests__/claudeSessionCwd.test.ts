/**
 * Reading a working directory back out of a transcript.
 *
 * Against real files in a real directory tree, because every claim this module
 * makes is a claim about a store on disk: where the file is, what the first few
 * lines of it look like, and what happens when one of those assumptions does not
 * hold. A mocked `fs` would agree with whatever the author believed about JSONL
 * layout, and the bug this exists to fix came from precisely such a belief being
 * wrong upstream.
 *
 * The fixtures are shaped after the transcript in the report: two
 * `queue-operation` records first, then a `user` record carrying `cwd` — and, in
 * the case that matters, an opening message whose content is a block array
 * rather than a string, which is what makes the SDK lose the directory in the
 * first place.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { recoverSessionCwds } from '../claudeSessionCwd.js';

const boxes: string[] = [];

afterEach(() => {
  for (const box of boxes.splice(0)) rmSync(box, { recursive: true, force: true });
});

/** A store with a `projects/` directory, the way a profile's config dir looks. */
function store(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'artemis-cwd-'));
  boxes.push(dir);
  mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

/** Write a transcript under an encoded project directory, as Claude lays them out. */
function transcript(
  configDir: string,
  encodedProject: string,
  sessionId: string,
  lines: readonly unknown[],
): string {
  const dir = path.join(configDir, 'projects', encodedProject);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

/** The bookkeeping records that precede the conversation, and carry no cwd. */
const QUEUE = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-13T00:00:00.000Z' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-08-13T00:00:01.000Z' },
];

/**
 * The record the SDK gives up on: an opening prompt carrying an image, so
 * `message.content` is a block array rather than a string. It holds the cwd all
 * the same, which is the whole basis of this module.
 */
function openingWithImage(cwd: string): unknown {
  return {
    type: 'user',
    uuid: 'u1',
    cwd,
    gitBranch: 'main',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
        { type: 'text', text: 'why did this vanish' },
      ],
    },
  };
}

describe('recoverSessionCwds', () => {
  it('finds the directory in the record the provider skipped', async () => {
    const dir = store();
    transcript(dir, '-Users-me-code-app', 's1', [
      ...QUEUE,
      openingWithImage('/Users/me/code/app'),
    ]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    // The session the sidebar used to drop entirely, with its transcript intact
    // on disk the whole time.
    expect(found.get('s1')).toBe('/Users/me/code/app');
  });

  it('does not decode the directory name it found the file under', async () => {
    const dir = store();
    // The encoding is lossy: `/Users/me/code/my-app` and `/Users/me/code/my/app`
    // both encode to this. The name locates the file and says nothing about the
    // path — decoding it is how "resume" starts an agent somewhere the user has
    // never worked.
    transcript(dir, '-Users-me-code-my-app', 's1', [
      ...QUEUE,
      openingWithImage('/Users/me/code/my/app'),
    ]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    expect(found.get('s1')).toBe('/Users/me/code/my/app');
  });

  it('searches every project directory, since the session does not say which', async () => {
    const dir = store();
    transcript(dir, '-Users-me-one', 'other', [...QUEUE, openingWithImage('/Users/me/one')]);
    transcript(dir, '-Users-me-two', 'wanted', [...QUEUE, openingWithImage('/Users/me/two')]);
    transcript(dir, '-Users-me-three', 'another', [...QUEUE, openingWithImage('/Users/me/three')]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['wanted'] });

    expect(found.get('wanted')).toBe('/Users/me/two');
    expect(found.size).toBe(1);
  });

  it('recovers several sessions in one pass', async () => {
    const dir = store();
    transcript(dir, '-a', 's1', [...QUEUE, openingWithImage('/a')]);
    transcript(dir, '-b', 's2', [...QUEUE, openingWithImage('/b')]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1', 's2'] });

    expect([...found.entries()].sort()).toEqual([
      ['s1', '/a'],
      ['s2', '/b'],
    ]);
  });

  it('takes the first directory the file names', async () => {
    const dir = store();
    // A session that was relocated ran in two places. This names the one it
    // began in, which costs a few lines instead of the whole file — and a row at
    // the first directory beats no row at all.
    transcript(dir, '-a', 's1', [
      ...QUEUE,
      openingWithImage('/Users/me/before'),
      { type: 'relocated', relocatedCwd: '/Users/me/after', cwd: '/Users/me/after' },
    ]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    expect(found.get('s1')).toBe('/Users/me/before');
  });

  it('skips a line that does not parse rather than giving up on the file', async () => {
    const dir = store();
    const file = transcript(dir, '-a', 's1', [...QUEUE]);
    // A process killed mid-write leaves a truncated record. Losing the whole
    // conversation over the last half-line would be the same failure this module
    // exists to undo.
    writeFileSync(file, `{"type":"queue-operation"}\n{"type":"user","cwd":"/Users/m\n`, {
      flag: 'a',
    });
    writeFileSync(file, `${JSON.stringify(openingWithImage('/Users/me/app'))}\n`, { flag: 'a' });

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    expect(found.get('s1')).toBe('/Users/me/app');
  });
});

describe('what stays unrecovered', () => {
  it('reports nothing for a session with no file anywhere', async () => {
    const dir = store();
    transcript(dir, '-a', 'other', [...QUEUE, openingWithImage('/a')]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['gone'] });

    // Absent from the map is what the caller treats as "still drop it", so this
    // is the path that keeps a deleted transcript out of the sidebar.
    expect(found.has('gone')).toBe(false);
  });

  it('reports nothing for a transcript that names no directory', async () => {
    const dir = store();
    transcript(dir, '-a', 's1', [
      ...QUEUE,
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'no cwd on this one' } },
    ]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    expect(found.has('s1')).toBe(false);
  });

  it('refuses a relative directory', async () => {
    const dir = store();
    // It would be resolved against Artemis's own process cwd, which is an
    // artefact of how the app was launched rather than anywhere the user has been.
    transcript(dir, '-a', 's1', [{ type: 'user', cwd: 'code/app', message: { content: 'x' } }]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    expect(found.has('s1')).toBe(false);
  });

  it('refuses a blank directory', async () => {
    const dir = store();
    transcript(dir, '-a', 's1', [{ type: 'user', cwd: '   ', message: { content: 'x' } }]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    expect(found.has('s1')).toBe(false);
  });

  it('gives up on a file that never gets to a directory', async () => {
    const dir = store();
    // 600 records of bookkeeping, then a cwd. The bound exists so that one
    // broken session cannot turn the sidebar's listing into a full scan of a
    // hundred-megabyte transcript; the price is that a file this strange stays
    // unrecovered.
    const filler = Array.from({ length: 600 }, (_, i) => ({
      type: 'queue-operation',
      operation: `op${String(i)}`,
    }));
    transcript(dir, '-a', 's1', [...filler, openingWithImage('/Users/me/app')]);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    expect(found.has('s1')).toBe(false);
  });

  it('answers empty for a store with no projects directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'artemis-cwd-'));
    boxes.push(dir);

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: ['s1'] });

    // A profile whose config directory has never been used. Not an error: the
    // caller is already holding whatever this store did report.
    expect(found.size).toBe(0);
  });

  it('answers empty for the ambient store', async () => {
    // No `CLAUDE_CONFIG_DIR` means the CLI's own default, which is not a store
    // Artemis puts sessions in — and resolving it here would be this module's
    // one guess.
    const found = await recoverSessionCwds({ configDir: undefined, sessionIds: ['s1'] });

    expect(found.size).toBe(0);
  });

  it('does no work when nothing is missing', async () => {
    const dir = store();

    const found = await recoverSessionCwds({ configDir: dir, sessionIds: [] });

    expect(found.size).toBe(0);
  });
});
