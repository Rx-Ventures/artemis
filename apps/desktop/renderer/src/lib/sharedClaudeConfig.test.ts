/**
 * The shared-config scripts, run for real.
 *
 * The generator is a string builder, and a string builder can be asserted with
 * `toContain` all day while emitting shell that does the wrong thing. Every
 * claim this feature makes is a claim about a filesystem — "nothing is
 * deleted", "auth is untouched", "re-running is safe", "the undo puts it back"
 * — so the substantial tests here build a sandbox, point `HOME` at it, run the
 * generated script with `/bin/sh`, and look at what is on disk afterwards.
 *
 * That is worth the cost because of what the script does when it is wrong. It
 * moves directories holding months of transcripts. The failure mode of a bad
 * quote is not a broken link, it is `mv` given two arguments it was not meant
 * to have — and the profile directory Artemis ships with by default lives under
 * `~/Library/Application Support`, which is to say every real invocation runs
 * through a path with a space in it. The sandbox reproduces that on purpose.
 *
 * Skipped on Windows, where there is no `/bin/sh` and the feature is not
 * offered either.
 */

import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProfileMetadata } from '@rx-artemis/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BACKUP_SUFFIX,
  SHARED_DIRECTORIES,
  buildSharedConfigScript,
  sharedConfigDirs,
  shellQuote,
} from './sharedClaudeConfig';

/**
 * Declared up here, not next to the suites that use it: `describe` bodies run
 * during collection, so a `const` defined further down is still in its temporal
 * dead zone when the first `it.skipIf` reads it.
 */
const canRunShell = process.platform !== 'win32';

/* -------------------------------------------------------------------------- */
/* Selecting the directories                                                  */
/* -------------------------------------------------------------------------- */

function profile(over: Partial<ProfileMetadata>): ProfileMetadata {
  return {
    id: 'p1' as ProfileMetadata['id'],
    label: 'One',
    providerId: 'claude' as ProfileMetadata['providerId'],
    configDir: '/tmp/one',
    ...over,
  } as ProfileMetadata;
}

describe('sharedConfigDirs', () => {
  it('keeps only Claude profiles', () => {
    const dirs = sharedConfigDirs([
      profile({ configDir: '/a' }),
      profile({ configDir: '/b', providerId: 'codex' as ProfileMetadata['providerId'] }),
    ]);
    expect(dirs).toEqual(['/a']);
  });

  it('keeps disabled profiles — a hidden account still has a directory', () => {
    const dirs = sharedConfigDirs([profile({ configDir: '/a', disabled: true })]);
    expect(dirs).toEqual(['/a']);
  });

  it('de-duplicates a directory two profiles share', () => {
    // The second pass would otherwise move the first pass's own symlinks into
    // backups, which is how "share twice" becomes "lose the link".
    const dirs = sharedConfigDirs([profile({ configDir: '/a' }), profile({ configDir: '/a' })]);
    expect(dirs).toEqual(['/a']);
  });
});

describe('shellQuote', () => {
  it('wraps a plain path in single quotes', () => {
    expect(shellQuote('/Users/x/Application Support/a')).toBe(
      "'/Users/x/Application Support/a'",
    );
  });

  /*
   * Asserted by round-trip rather than against an expected string, because the
   * expected string is the thing that is easy to get wrong — the first version
   * of this test hand-wrote `'\''` through two layers of escaping and failed
   * against a correct implementation. What actually has to hold is that `sh`
   * hands the value back unchanged, so `sh` is what checks it.
   */
  it.skipIf(!canRunShell)('round-trips anything a path can hold', () => {
    const nasty = [
      "/Users/o'brien/.claude",
      '/Users/x/Application Support/p',
      '/tmp/a b/$HOME/`whoami`/"q"/\\slash/;rm -rf/*',
      "/tmp/it's a $(date) test",
    ];
    for (const value of nasty) {
      const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf8',
      });
      expect(out).toBe(value);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Running the scripts                                                        */
/* -------------------------------------------------------------------------- */

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  readonly home: string;
  readonly root: string;
  /** Config dir with a space in its path, seeded with data to displace. */
  readonly work: string;
  /** Empty config dir — the fresh-profile case. */
  readonly max: string;
}

function sandbox(): Sandbox {
  const base = mkdtempSync(path.join(tmpdir(), 'artemis-shared-'));
  sandboxes.push(base);

  const home = path.join(base, 'home');
  const root = path.join(home, '.claude');
  // Deliberately not every shared directory: a real `~/.claude` has no
  // `commands` and no `todos`, and the script has to create them.
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  mkdirSync(path.join(root, 'session-env'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), 'root instructions\n');
  writeFileSync(path.join(root, 'skills', 'root.md'), 'root skill\n');

  // The space is the point — this mirrors `~/Library/Application Support`.
  const work = path.join(base, 'App Support', 'profiles', 'work');
  // `session-env` is the realistic collision: a used profile has one, and it
  // is on the shared list. `projects` and `sessions` are seeded alongside it
  // as the two that must survive untouched.
  mkdirSync(path.join(work, 'session-env'), { recursive: true });
  mkdirSync(path.join(work, 'projects'), { recursive: true });
  mkdirSync(path.join(work, 'sessions'), { recursive: true });
  writeFileSync(path.join(work, 'session-env', 'env.json'), 'work env\n');
  writeFileSync(path.join(work, 'projects', 'history.jsonl'), 'work history\n');
  writeFileSync(path.join(work, 'sessions', 'live.json'), 'work session\n');
  writeFileSync(path.join(work, '.claude.json'), 'work account\n');

  const max = path.join(base, 'App Support', 'profiles', 'max');
  mkdirSync(max, { recursive: true });
  writeFileSync(path.join(max, '.claude.json'), 'max account\n');

  return { home, root, work, max };
}

function run(box: Sandbox, dirs: readonly string[], mode: 'share' | 'restore'): string {
  const script = path.join(box.home, `${mode}.sh`);
  writeFileSync(script, buildSharedConfigScript(dirs, mode));
  return execFileSync('sh', [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: box.home },
  });
}

/** Where a symlink points, or null when the path is not a symlink. */
function linkTarget(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
  } catch {
    return null;
  }
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!canRunShell)('the share script', () => {
  it('links every shared directory and creates the ones the root lacks', () => {
    const box = sandbox();
    run(box, [box.work, box.max], 'share');

    for (const name of SHARED_DIRECTORIES) {
      expect(linkTarget(path.join(box.work, name))).toBe(path.join(box.root, name));
      expect(linkTarget(path.join(box.max, name))).toBe(path.join(box.root, name));
      // `commands` and `todos` did not exist under the root; a link to a
      // missing path is a broken read, not an empty folder.
      expect(statSync(path.join(box.root, name)).isDirectory()).toBe(true);
    }
  });

  it('links CLAUDE.md through to the root file', () => {
    const box = sandbox();
    run(box, [box.work], 'share');

    expect(linkTarget(path.join(box.work, 'CLAUDE.md'))).toBe(path.join(box.root, 'CLAUDE.md'));
    expect(readFileSync(path.join(box.work, 'CLAUDE.md'), 'utf8')).toBe('root instructions\n');
  });

  it('does not invent a CLAUDE.md the user does not have', () => {
    const box = sandbox();
    rmSync(path.join(box.root, 'CLAUDE.md'));
    const out = run(box, [box.work], 'share');

    // An empty CLAUDE.md is not "no instructions" — it is an instruction file
    // that says nothing, written into every profile at once.
    expect(exists(path.join(box.work, 'CLAUDE.md'))).toBe(false);
    expect(out).toContain('skip  CLAUDE.md');
  });

  it('moves displaced data aside instead of deleting it', () => {
    const box = sandbox();
    run(box, [box.work], 'share');

    const backup = path.join(box.work, `session-env${BACKUP_SUFFIX}`);
    expect(readFileSync(path.join(backup, 'env.json'), 'utf8')).toBe('work env\n');
  });

  it('leaves auth alone', () => {
    const box = sandbox();
    run(box, [box.work], 'share');

    // The whole reason the directory is not linked wholesale.
    expect(readFileSync(path.join(box.work, '.claude.json'), 'utf8')).toBe('work account\n');
    expect(linkTarget(path.join(box.work, 'sessions'))).toBeNull();
    expect(readFileSync(path.join(box.work, 'sessions', 'live.json'), 'utf8')).toBe(
      'work session\n',
    );
  });

  /*
   * `projects` is shared, and this is what that means on disk.
   *
   * Worth its own test because it is the entry with a consequence outside the
   * filesystem: every profile now reads one store, and Artemis de-duplicates
   * nothing, so the sidebar lists each session once per profile. The script's
   * side of the bargain is the part asserted here — the transcripts survive the
   * move, and the link resolves to the shared store.
   */
  it('shares projects and keeps the displaced transcripts', () => {
    const box = sandbox();
    run(box, [box.work], 'share');

    expect(SHARED_DIRECTORIES).toContain('projects');
    expect(linkTarget(path.join(box.work, 'projects'))).toBe(path.join(box.root, 'projects'));

    const backup = path.join(box.work, `projects${BACKUP_SUFFIX}`);
    expect(readFileSync(path.join(backup, 'history.jsonl'), 'utf8')).toBe('work history\n');
  });

  it('is idempotent — a second run makes no second backup', () => {
    const box = sandbox();
    run(box, [box.work], 'share');
    const out = run(box, [box.work], 'share');

    expect(out).toContain('keep');
    expect(exists(path.join(box.work, `session-env${BACKUP_SUFFIX}.2`))).toBe(false);
    expect(linkTarget(path.join(box.work, 'session-env'))).toBe(
      path.join(box.root, 'session-env'),
    );
  });

  it('refuses to link the root config into itself', () => {
    const box = sandbox();
    const out = run(box, [box.root], 'share');

    expect(out).toContain('this is ~/.claude itself');
    // Still a real directory holding its own file, not a link to a backup of
    // itself — which is what a self-link would have produced.
    expect(linkTarget(path.join(box.root, 'skills'))).toBeNull();
    expect(readFileSync(path.join(box.root, 'skills', 'root.md'), 'utf8')).toBe('root skill\n');
  });

  it('skips a directory that is not there', () => {
    const box = sandbox();
    const gone = path.join(box.home, 'nope');
    const out = run(box, [gone], 'share');

    expect(out).toContain('no such directory');
    expect(exists(gone)).toBe(false);
  });
});

describe.skipIf(!canRunShell)('the restore script', () => {
  it('puts the original layout back', () => {
    const box = sandbox();
    run(box, [box.work], 'share');
    run(box, [box.work], 'restore');

    expect(linkTarget(path.join(box.work, 'session-env'))).toBeNull();
    expect(readFileSync(path.join(box.work, 'session-env', 'env.json'), 'utf8')).toBe('work env\n');
    expect(exists(path.join(box.work, `session-env${BACKUP_SUFFIX}`))).toBe(false);
    // The transcripts come back to the profile that owned them.
    expect(linkTarget(path.join(box.work, 'projects'))).toBeNull();
    expect(readFileSync(path.join(box.work, 'projects', 'history.jsonl'), 'utf8')).toBe(
      'work history\n',
    );
    // Nothing was displaced here, so the link simply goes and leaves nothing.
    expect(exists(path.join(box.work, 'commands'))).toBe(false);
    expect(exists(path.join(box.work, 'CLAUDE.md'))).toBe(false);
  });

  it('leaves the root config untouched', () => {
    const box = sandbox();
    run(box, [box.work], 'share');
    run(box, [box.work], 'restore');

    expect(readFileSync(path.join(box.root, 'skills', 'root.md'), 'utf8')).toBe('root skill\n');
    expect(readFileSync(path.join(box.root, 'CLAUDE.md'), 'utf8')).toBe('root instructions\n');
  });

  it('does not touch something the user put back by hand', () => {
    const box = sandbox();
    run(box, [box.work], 'share');

    // The user replaced the link with a real folder of their own.
    rmSync(path.join(box.work, 'skills'));
    mkdirSync(path.join(box.work, 'skills'));
    writeFileSync(path.join(box.work, 'skills', 'mine.md'), 'mine\n');

    const out = run(box, [box.work], 'restore');

    expect(out).toContain('not the link this script made');
    expect(readFileSync(path.join(box.work, 'skills', 'mine.md'), 'utf8')).toBe('mine\n');
  });

  it('is safe to run when nothing was ever shared', () => {
    const box = sandbox();
    const out = run(box, [box.work], 'restore');

    expect(out).toContain('Done.');
    expect(readFileSync(path.join(box.work, 'session-env', 'env.json'), 'utf8')).toBe('work env\n');
  });
});

describe('the generated text', () => {
  it('says so when there is nothing to cover', () => {
    const script = buildSharedConfigScript([], 'share');
    expect(script).toContain('No Claude profiles to cover.');
  });

  it('quotes every directory it names', () => {
    const script = buildSharedConfigScript(['/Users/x/Application Support/p'], 'share');
    expect(script).toContain("profile '/Users/x/Application Support/p'");
  });
});
