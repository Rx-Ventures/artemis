/**
 * Telling a scheduler's transcripts apart from a person's.
 *
 * Against real files in a real directory tree, for the same reason
 * `claudeSessionCwd.test.ts` is: every claim the module makes is a claim about
 * a store on disk — where the encoding puts the file, what the first lines of
 * a firing look like — and a mocked `fs` would agree with whatever the author
 * believed. The fixtures are shaped after the firings in the store this was
 * built against: `ai-title` and `queue-operation` bookkeeping first, the
 * enqueue record carrying the `<scheduled-task …>` content, then the `user`
 * record opening with the same turn.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeProjectDir, findScheduledSpawns } from '../claudeSessionSpawn.js';

const boxes: string[] = [];

afterEach(() => {
  for (const box of boxes.splice(0)) rmSync(box, { recursive: true, force: true });
});

/** A store with a `projects/` directory, the way a profile's config dir looks. */
function store(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'artemis-spawn-'));
  boxes.push(dir);
  mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

/** Write a transcript where the encoding puts it for this cwd. */
function transcript(
  configDir: string,
  cwd: string,
  sessionId: string,
  lines: readonly unknown[],
): string {
  const dir = path.join(configDir, 'projects', encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

const FIRING_TURN =
  '<scheduled-task name="deployment-alerts-triage" file="/Users/me/.claude/scheduled-tasks/deployment-alerts-triage/SKILL.md"> fire it </scheduled-task>';

/** A firing's head, as the scheduler actually writes it. */
function firing(cwd: string): unknown[] {
  return [
    { type: 'ai-title', aiTitle: 'Triage deployment alerts' },
    { type: 'queue-operation', operation: 'enqueue', content: FIRING_TURN },
    { type: 'queue-operation', operation: 'dequeue' },
    { type: 'user', uuid: 'u1', cwd, message: { role: 'user', content: FIRING_TURN } },
  ];
}

/** A person's head: same bookkeeping, conversational opening. */
function conversation(cwd: string, opening = 'why is checkout slow today'): unknown[] {
  return [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'queue-operation', operation: 'dequeue' },
    { type: 'user', uuid: 'u1', cwd, message: { role: 'user', content: opening } },
  ];
}

const CWD = '/Users/me/code/app';

function query(configDir: string | undefined, ids: readonly string[]) {
  return {
    configDir,
    sessions: ids.map((id) => ({ id, cwd: CWD })),
    cache: new Map<string, boolean>(),
  };
}

describe('findScheduledSpawns', () => {
  it('recognises a firing by its opening turn', async () => {
    const dir = store();
    transcript(dir, CWD, 'fired', firing(CWD));
    transcript(dir, CWD, 'talked', conversation(CWD));

    const spawned = await findScheduledSpawns(query(dir, ['fired', 'talked']));

    expect([...spawned]).toEqual(['fired']);
  });

  it('recognises a firing from the enqueue record alone', async () => {
    const dir = store();
    // The enqueue carries the same content as the turn it queues, and comes
    // first — most firings are recognised here, before any user record.
    transcript(dir, CWD, 's1', [
      { type: 'queue-operation', operation: 'enqueue', content: FIRING_TURN },
    ]);

    const spawned = await findScheduledSpawns(query(dir, ['s1']));

    expect(spawned.has('s1')).toBe(true);
  });

  it('recognises a firing whose opening turn is a block array', async () => {
    const dir = store();
    transcript(dir, CWD, 's1', [
      {
        type: 'user',
        cwd: CWD,
        message: { role: 'user', content: [{ type: 'text', text: FIRING_TURN }] },
      },
    ]);

    const spawned = await findScheduledSpawns(query(dir, ['s1']));

    expect(spawned.has('s1')).toBe(true);
  });

  it('finds the file under the encoded project directory', async () => {
    const dir = store();
    const cwd = '/Users/me/code/_wt-my.app';
    const encoded = encodeProjectDir(cwd);
    // Underscore, dot and slash all become `-` — the exact layout the provider
    // writes, which is what makes encoding forward safe where decoding is not.
    expect(encoded).toBe('-Users-me-code--wt-my-app');
    transcript(dir, cwd, 's1', firing(cwd));

    const spawned = await findScheduledSpawns({
      configDir: dir,
      sessions: [{ id: 's1', cwd }],
      cache: new Map(),
    });

    expect(spawned.has('s1')).toBe(true);
  });

  it('answers from the cache without touching the file again', async () => {
    const dir = store();
    const file = transcript(dir, CWD, 's1', firing(CWD));
    const cache = new Map<string, boolean>();

    const first = await findScheduledSpawns({
      configDir: dir,
      sessions: [{ id: 's1', cwd: CWD }],
      cache,
    });
    expect(first.has('s1')).toBe(true);

    // A deleted transcript would fail a re-read; the cached verdict must hold,
    // because a transcript's opening record never changes after it is written.
    rmSync(file);
    const second = await findScheduledSpawns({
      configDir: dir,
      sessions: [{ id: 's1', cwd: CWD }],
      cache,
    });

    expect(second.has('s1')).toBe(true);
    expect(cache.get('s1')).toBe(true);
  });

  it('caches the negative verdict too', async () => {
    const dir = store();
    transcript(dir, CWD, 's1', conversation(CWD));
    const cache = new Map<string, boolean>();

    await findScheduledSpawns({ configDir: dir, sessions: [{ id: 's1', cwd: CWD }], cache });

    expect(cache.get('s1')).toBe(false);
  });
});

describe('what stays an ordinary row', () => {
  it('a person quoting the marker mid-prompt', async () => {
    const dir = store();
    transcript(
      dir,
      CWD,
      's1',
      conversation(CWD, 'why does <scheduled-task name="x"> appear in my logs?'),
    );

    const spawned = await findScheduledSpawns(query(dir, ['s1']));

    expect(spawned.size).toBe(0);
  });

  it('a similarly named tag', async () => {
    const dir = store();
    transcript(dir, CWD, 's1', conversation(CWD, '<scheduled-tasks-report>weekly</…>'));

    const spawned = await findScheduledSpawns(query(dir, ['s1']));

    expect(spawned.size).toBe(0);
  });

  it('a session whose file is not where the encoding says', async () => {
    const dir = store();
    // Nothing written at all. Unclassifiable stays ordinary — the failure mode
    // is a firing listed as a conversation, which is the old behaviour, not a
    // new wrong answer.
    const spawned = await findScheduledSpawns(query(dir, ['gone']));

    expect(spawned.size).toBe(0);
  });

  it('a transcript that never opens its conversation', async () => {
    const dir = store();
    const filler = Array.from({ length: 60 }, (_, i) => ({
      type: 'queue-operation',
      operation: `op${String(i)}`,
    }));
    transcript(dir, CWD, 's1', [
      ...filler,
      { type: 'user', cwd: CWD, message: { role: 'user', content: FIRING_TURN } },
    ]);

    // Past the line bound: unclassified, for the same no-full-scan reason the
    // cwd recovery gives up.
    const spawned = await findScheduledSpawns(query(dir, ['s1']));

    expect(spawned.size).toBe(0);
  });

  it('a truncated record ahead of the answer is skipped, not fatal', async () => {
    const dir = store();
    const file = path.join(dir, 'projects', encodeProjectDir(CWD));
    mkdirSync(file, { recursive: true });
    writeFileSync(
      path.join(file, 's1.jsonl'),
      `{"type":"queue-operation","content":"<sched\n${JSON.stringify({
        type: 'user',
        cwd: CWD,
        message: { role: 'user', content: FIRING_TURN },
      })}\n`,
    );

    const spawned = await findScheduledSpawns(query(dir, ['s1']));

    expect(spawned.has('s1')).toBe(true);
  });

  it('everything, for the ambient store', async () => {
    const spawned = await findScheduledSpawns({
      configDir: undefined,
      sessions: [{ id: 's1', cwd: CWD }],
      cache: new Map(),
    });

    expect(spawned.size).toBe(0);
  });
});
