/**
 * The shared-config scripts, run for real.
 *
 * The generator is a string builder, and a string builder can be asserted with
 * `toContain` all day while emitting shell that does the wrong thing. Every
 * claim this feature makes is a claim about a filesystem — "nothing is
 * deleted", "auth is untouched", "re-running is safe", "the undo puts it back"
 * — so the substantial tests here build a sandbox, point `HOME` at it, run the
 * generated script, and look at what is on disk afterwards.
 *
 * That is worth the cost because of what the script does when it is wrong. It
 * moves directories holding months of transcripts. The failure mode of a bad
 * quote is not a broken link, it is `mv` given two arguments it was not meant
 * to have — and the profile directory Artemis ships with by default lives under
 * `~/Library/Application Support`, which is to say every real invocation runs
 * through a path with a space in it. The sandbox reproduces that on purpose.
 *
 * Every suite that runs the script runs it once per shell on the machine — see
 * {@link SHELLS}, which is the other half of a bug this file used to pass.
 *
 * There are two scripts now, and they are tested the same way for the same
 * reason. The `/bin/sh` suites run wherever there is a shell to run them in; the
 * PowerShell suites run on Windows, where the arrangement is made out of
 * junctions and a hard link instead of symlinks and the claims that need
 * checking are correspondingly different — see {@link POWERSHELL}. Each half is
 * skipped where its interpreter is not, which is how one file covers a feature
 * whose implementation is genuinely two.
 */

import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ProfileMetadata,
  SharedConfigDirStatus,
  SharedConfigEntry,
  SharedConfigStatus,
} from '@rx-artemis/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BACKUP_SUFFIX,
  SHARED_DIRECTORIES,
  SHARED_ENTRIES,
  buildSharedConfigScript,
  dirsNeedingWork,
  entryGap,
  powerShellQuote,
  scriptShell,
  sharedConfigDirs,
  shellQuote,
  statusDisagrees,
  statusHasLinks,
  summarizeDir,
} from './sharedClaudeConfig';

/**
 * Declared up here, not next to the suites that use it: `describe` bodies run
 * during collection, so a `const` defined further down is still in its temporal
 * dead zone when the first `it.skipIf` reads it.
 */
const canRunShell = process.platform !== 'win32';

/**
 * The shells the generated script is run under here.
 *
 * `sh` used to be the only one, and it is the single shell that could not have
 * caught what this file let through. The script iterated its list of shared
 * names with `for name in $SHARED_DIRS` — splitting on `IFS`, which sh and bash
 * do and zsh does not. The suite passed green while every user who pasted the
 * script into the default macOS shell got one symlink named after all eight
 * directories joined by spaces and nothing else linked at all.
 *
 * The shebang is not the thing under test, because it is not the thing that
 * runs: the pane says "run this in a terminal" beside a Copy button, and a
 * shell that is already running treats `#!` as a comment. So the question these
 * suites have to answer is not "does this work in sh" but "does this work in
 * whatever the user pasted it into", and the only honest way to ask it is to
 * paste it into all of them.
 *
 * Detected rather than assumed. CI images are not guaranteed to carry zsh, and
 * a suite that fails on a missing shell is a suite somebody deletes.
 */
const SHELLS: readonly string[] = !canRunShell
  ? []
  : ['sh', 'bash', 'zsh'].filter((shell) => {
      try {
        execFileSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    });

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
  // `.native` expands Windows 8.3 short names (a GitHub-hosted runner's TMP is
  // `C:\Users\RUNNER~1\...`), which otherwise poison every comparison in here:
  // a junction's `.Target` always reads back long-form, so a sandbox built on a
  // short-form root reads as `foreign` beside a junction the script just made.
  // Real roots never hit this — Electron and `homedir()` hand back long paths.
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'artemis-shared-')));
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

function runIn(
  shell: string,
  box: Sandbox,
  dirs: readonly string[],
  mode: 'share' | 'restore',
): string {
  const script = path.join(box.home, `${mode}.sh`);
  writeFileSync(script, buildSharedConfigScript(dirs, mode, 'darwin'));
  // The shell is named explicitly rather than left to the shebang, because the
  // shebang is exactly what a pasted script does not get.
  return execFileSync(shell, [script], {
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

describe.each(SHELLS)('the share script (%s)', (shell) => {
  const run = (box: Sandbox, dirs: readonly string[], mode: 'share' | 'restore'): string =>
    runIn(shell, box, dirs, mode);

  it('links every shared directory and creates the ones the root lacks', () => {
    const box = sandbox();
    run(box, [box.work, box.max], 'share');

    // Every name its own link. Under zsh this used to be a single link called
    // `commands ide plans plugins skills todos session-env projects`.
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

describe.each(SHELLS)('the restore script (%s)', (shell) => {
  const run = (box: Sandbox, dirs: readonly string[], mode: 'share' | 'restore'): string =>
    runIn(shell, box, dirs, mode);

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
    const script = buildSharedConfigScript([], 'share', 'darwin');
    expect(script).toContain('No Claude profiles to cover.');
  });

  it('quotes every directory it names', () => {
    const script = buildSharedConfigScript(['/Users/x/Application Support/p'], 'share', 'darwin');
    expect(script).toContain("profile '/Users/x/Application Support/p'");
  });

  /*
   * The rule the per-shell suites enforce by consequence, stated here as itself
   * so the next person to reach for `SHARED_DIRS="…"` gets a failure that names
   * what is wrong rather than a puzzling zsh-only symlink.
   */
  it('never iterates a list by expanding a variable', () => {
    for (const mode of ['share', 'restore'] as const) {
      const script = buildSharedConfigScript(['/tmp/p'], mode, 'darwin');
      // Word splitting is what sh does and zsh does not; the names have to be
      // literal words in the script text or the loop runs once on all of them.
      expect(script).not.toMatch(/for\s+\w+\s+in\s+\$/);
      for (const name of SHARED_ENTRIES) expect(script).toContain(`'${name}'`);
    }
  });

  /*
   * The platform decides which script, and it is the only thing that does.
   * Asserted on the shebang and the prelude rather than on any particular line,
   * because what would actually go wrong is not a subtly wrong script — it is a
   * `#!/bin/sh` handed to somebody running Windows.
   */
  it('writes sh for macOS and Linux and PowerShell for Windows', () => {
    for (const mode of ['share', 'restore'] as const) {
      for (const platform of ['darwin', 'linux'] as const) {
        expect(buildSharedConfigScript(['/tmp/p'], mode, platform)).toMatch(/^#!\/bin\/sh\n/);
      }
      const windows = buildSharedConfigScript(['C:\\p'], mode, 'win32');
      expect(windows).not.toContain('#!/bin/sh');
      expect(windows).toContain("$Root = Join-Path $env:USERPROFILE '.claude'");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The Windows script                                                         */
/* -------------------------------------------------------------------------- */

/*
 * Run for real, for the same reason the sh suites are: this one moves the same
 * directories with a different pair of verbs, and `toContain` on a string that
 * says `New-Item -ItemType Junction` proves only that the words are in the right
 * order. Two of the claims here are Windows-only and cannot be checked any other
 * way — that a junction and a hard link are made without an administrator, and
 * that removing a junction takes away the reparse point rather than the folder
 * on the far side of it, which is the user's own `~/.claude`.
 *
 * `$env:USERPROFILE` is what the script expands, so that is what the sandbox
 * overrides — the Windows counterpart of pointing `HOME` at a temporary tree.
 */
const POWERSHELL = ((): string | null => {
  if (process.platform !== 'win32') return null;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return 'powershell.exe';
  } catch {
    return null;
  }
})();

interface WindowsSandbox {
  readonly home: string;
  readonly root: string;
  /** Config dir with a space and a single quote in its path. */
  readonly work: string;
  /** Empty config dir — the fresh-profile case. */
  readonly max: string;
}

function windowsSandbox(): WindowsSandbox {
  // `.native` expands Windows 8.3 short names (a GitHub-hosted runner's TMP is
  // `C:\Users\RUNNER~1\...`), which otherwise poison every comparison in here:
  // a junction's `.Target` always reads back long-form, so a sandbox built on a
  // short-form root reads as `foreign` beside a junction the script just made.
  // Real roots never hit this — Electron and `homedir()` hand back long paths.
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'artemis-win-')));
  sandboxes.push(base);

  const home = path.join(base, 'home');
  const root = path.join(home, '.claude');
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  mkdirSync(path.join(root, 'session-env'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), 'root instructions\n');
  writeFileSync(path.join(root, 'skills', 'root.md'), 'root skill\n');

  /*
   * The apostrophe is the point, and it is the one character the POSIX sandbox
   * could not put in a directory name without also testing `'\''`. PowerShell
   * escapes it by doubling instead, so a path a Windows user genuinely has —
   * `C:\Users\O'Brien\AppData\Roaming\…` — is the case that decides whether the
   * generated `Update-Profile '…'` line parses at all.
   */
  const work = path.join(base, "O'Brien App Data", 'profiles', 'work');
  mkdirSync(path.join(work, 'session-env'), { recursive: true });
  mkdirSync(path.join(work, 'projects'), { recursive: true });
  mkdirSync(path.join(work, 'sessions'), { recursive: true });
  writeFileSync(path.join(work, 'session-env', 'env.json'), 'work env\n');
  writeFileSync(path.join(work, 'projects', 'history.jsonl'), 'work history\n');
  writeFileSync(path.join(work, 'sessions', 'live.json'), 'work session\n');
  writeFileSync(path.join(work, '.claude.json'), 'work account\n');
  writeFileSync(path.join(work, 'CLAUDE.md'), 'work instructions\n');

  const max = path.join(base, "O'Brien App Data", 'profiles', 'max');
  mkdirSync(max, { recursive: true });

  return { home, root, work, max };
}

function runPowerShell(
  box: WindowsSandbox,
  dirs: readonly string[],
  mode: 'share' | 'restore',
): string {
  const script = path.join(box.home, `${mode}.ps1`);
  writeFileSync(script, buildSharedConfigScript(dirs, mode, 'win32'));
  return execFileSync(
    POWERSHELL as string,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { encoding: 'utf8', env: { ...process.env, USERPROFILE: box.home } },
  );
}

/** Whether this path is a reparse point, and where it points. */
function junctionTarget(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
  } catch {
    return null;
  }
}

/** Do these two names reach one file — the hard-link question. */
function sameFile(a: string, b: string): boolean {
  try {
    const one = statSync(a, { bigint: true });
    const two = statSync(b, { bigint: true });
    return one.dev === two.dev && one.ino === two.ino;
  } catch {
    return false;
  }
}

describe.skipIf(POWERSHELL === null)('the Windows share script', () => {
  it('junctions every shared directory and creates the ones the root lacks', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work, box.max], 'share');

    for (const name of SHARED_DIRECTORIES) {
      // `readlink` on a junction is what the main process's prober reads, so
      // asserting on it here is asserting on the thing that actually decides
      // whether the pane says `linked`.
      expect(junctionTarget(path.join(box.work, name))).toBe(path.join(box.root, name));
      expect(junctionTarget(path.join(box.max, name))).toBe(path.join(box.root, name));
      expect(statSync(path.join(box.root, name)).isDirectory()).toBe(true);
    }
    // Reached *through* the junction, which is the only proof that the reparse
    // point points somewhere real rather than merely existing.
    expect(readFileSync(path.join(box.max, 'skills', 'root.md'), 'utf8')).toBe('root skill\n');
  });

  it('hard-links CLAUDE.md to the root file', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');

    const at = path.join(box.work, 'CLAUDE.md');
    // Not a symlink and not a copy: one file with two names, which is the whole
    // reason the prober had to learn a second question.
    expect(lstatSync(at).isSymbolicLink()).toBe(false);
    expect(sameFile(at, path.join(box.root, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(at, 'utf8')).toBe('root instructions\n');
    // The profile's own instructions were moved aside, not written over.
    expect(readFileSync(path.join(box.work, `CLAUDE.md${BACKUP_SUFFIX}`), 'utf8')).toBe(
      'work instructions\n',
    );
  });

  it('does not invent a CLAUDE.md the user does not have', () => {
    const box = windowsSandbox();
    rmSync(path.join(box.root, 'CLAUDE.md'));
    const out = runPowerShell(box, [box.max], 'share');

    expect(exists(path.join(box.max, 'CLAUDE.md'))).toBe(false);
    expect(out).toContain('skip  CLAUDE.md');
  });

  it('moves displaced data aside instead of deleting it', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');

    expect(
      readFileSync(path.join(box.work, `session-env${BACKUP_SUFFIX}`, 'env.json'), 'utf8'),
    ).toBe('work env\n');
    expect(
      readFileSync(path.join(box.work, `projects${BACKUP_SUFFIX}`, 'history.jsonl'), 'utf8'),
    ).toBe('work history\n');
  });

  it('leaves auth alone', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');

    expect(readFileSync(path.join(box.work, '.claude.json'), 'utf8')).toBe('work account\n');
    expect(junctionTarget(path.join(box.work, 'sessions'))).toBeNull();
    expect(readFileSync(path.join(box.work, 'sessions', 'live.json'), 'utf8')).toBe(
      'work session\n',
    );
  });

  it('is idempotent — a second run makes no second backup', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');
    const out = runPowerShell(box, [box.work], 'share');

    expect(out).toContain('keep');
    expect(exists(path.join(box.work, `session-env${BACKUP_SUFFIX}.2`))).toBe(false);
    expect(exists(path.join(box.work, `CLAUDE.md${BACKUP_SUFFIX}.2`))).toBe(false);
    expect(junctionTarget(path.join(box.work, 'session-env'))).toBe(
      path.join(box.root, 'session-env'),
    );
  });

  it('numbers the second backup rather than writing over the first', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');

    // The name filled up again after sharing was already on: the user removed
    // the junction and put a folder of their own back at `session-env`.
    rmSync(path.join(box.work, 'session-env'), { recursive: true });
    mkdirSync(path.join(box.work, 'session-env'));
    writeFileSync(path.join(box.work, 'session-env', 'second.json'), 'second env\n');

    runPowerShell(box, [box.work], 'share');

    // Both survive under distinct names. Nothing this script does is allowed to
    // be the reason a folder full of somebody's data stopped existing.
    expect(readFileSync(path.join(box.work, `session-env${BACKUP_SUFFIX}`, 'env.json'), 'utf8')).toBe(
      'work env\n',
    );
    expect(
      readFileSync(path.join(box.work, `session-env${BACKUP_SUFFIX}.2`, 'second.json'), 'utf8'),
    ).toBe('second env\n');
  });

  it('refuses to link the root config into itself, trailing separator and all', () => {
    const box = windowsSandbox();
    const out = runPowerShell(box, [box.root, `${box.root}\\`], 'share');

    expect(out).toContain('this is your own .claude');
    // A self-link would have replaced this folder with a junction to the backup
    // it had just been renamed into. Windows paths get typed with a trailing
    // backslash, so the second spelling has to be skipped too or the safest
    // check in the script misses the case it exists for.
    expect(junctionTarget(path.join(box.root, 'skills'))).toBeNull();
    expect(readFileSync(path.join(box.root, 'skills', 'root.md'), 'utf8')).toBe('root skill\n');
    expect(exists(path.join(box.root, `skills${BACKUP_SUFFIX}`))).toBe(false);
  });

  it('skips a directory that is not there', () => {
    const box = windowsSandbox();
    const gone = path.join(box.home, 'nope');
    const out = runPowerShell(box, [gone], 'share');

    expect(out).toContain('no such directory');
    expect(exists(gone)).toBe(false);
  });
});

describe.skipIf(POWERSHELL === null)('the Windows restore script', () => {
  it('puts the original layout back', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');
    runPowerShell(box, [box.work], 'restore');

    expect(junctionTarget(path.join(box.work, 'session-env'))).toBeNull();
    expect(readFileSync(path.join(box.work, 'session-env', 'env.json'), 'utf8')).toBe('work env\n');
    expect(exists(path.join(box.work, `session-env${BACKUP_SUFFIX}`))).toBe(false);
    expect(readFileSync(path.join(box.work, 'projects', 'history.jsonl'), 'utf8')).toBe(
      'work history\n',
    );
    // The hard link goes and the profile's own instructions come back.
    expect(readFileSync(path.join(box.work, 'CLAUDE.md'), 'utf8')).toBe('work instructions\n');
    expect(sameFile(path.join(box.work, 'CLAUDE.md'), path.join(box.root, 'CLAUDE.md'))).toBe(
      false,
    );
    // Nothing was displaced here, so the junction simply goes.
    expect(exists(path.join(box.work, 'commands'))).toBe(false);
  });

  /*
   * The test this whole file is worth writing for.
   *
   * `Remove-Item -Recurse` on a junction has a long history of deleting what is
   * on the far side of it, and the far side of these is the user's own
   * `~/.claude` — every skill, every transcript. The restore script uses
   * `[System.IO.Directory]::Delete($Path, $false)` precisely because it cannot
   * recurse. If somebody ever "simplifies" that line, this fails and nothing
   * else in the suite does.
   */
  it('takes away the junction and not the folder it points at', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');
    runPowerShell(box, [box.work], 'restore');

    expect(readFileSync(path.join(box.root, 'skills', 'root.md'), 'utf8')).toBe('root skill\n');
    expect(readFileSync(path.join(box.root, 'CLAUDE.md'), 'utf8')).toBe('root instructions\n');
    for (const name of SHARED_DIRECTORIES) {
      expect(statSync(path.join(box.root, name)).isDirectory()).toBe(true);
    }
  });

  it('does not touch something the user put back by hand', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');

    rmSync(path.join(box.work, 'skills'), { recursive: true });
    mkdirSync(path.join(box.work, 'skills'));
    writeFileSync(path.join(box.work, 'skills', 'mine.md'), 'mine\n');

    const out = runPowerShell(box, [box.work], 'restore');

    expect(out).toContain('not the link this script made');
    expect(readFileSync(path.join(box.work, 'skills', 'mine.md'), 'utf8')).toBe('mine\n');
  });

  it('leaves a CLAUDE.md alone once the root has no copy left to compare it with', () => {
    const box = windowsSandbox();
    runPowerShell(box, [box.work], 'share');
    // The blind spot, asserted rather than only commented: Windows records no
    // direction on a hard link, so with the root's name gone the profile's is
    // simply the last name the data has. Removing it would be deleting a file,
    // not undoing a link.
    rmSync(path.join(box.root, 'CLAUDE.md'));

    const out = runPowerShell(box, [box.work], 'restore');

    expect(out).toContain('not the link this script made');
    expect(readFileSync(path.join(box.work, 'CLAUDE.md'), 'utf8')).toBe('root instructions\n');
  });

  it('is safe to run when nothing was ever shared', () => {
    const box = windowsSandbox();
    const out = runPowerShell(box, [box.work], 'restore');

    expect(out).toContain('Done.');
    expect(readFileSync(path.join(box.work, 'session-env', 'env.json'), 'utf8')).toBe('work env\n');
  });
});

describe('powerShellQuote', () => {
  it('wraps a plain path in single quotes', () => {
    expect(powerShellQuote('C:\\Users\\x\\App Data\\p')).toBe("'C:\\Users\\x\\App Data\\p'");
  });

  it('doubles a single quote rather than escaping it', () => {
    // PowerShell has no backslash escape inside a literal string; the quote is
    // its own escape. A backslash here would end the string early and leave the
    // rest of the path being parsed as commands.
    expect(powerShellQuote("C:\\Users\\O'Brien\\.claude")).toBe("'C:\\Users\\O''Brien\\.claude'");
  });

  /*
   * Round-tripped through PowerShell itself rather than asserted against an
   * expected string, for the reason the sh version gives: the expected string is
   * the part that is easy to get wrong, and what actually has to hold is that
   * the shell hands the value back unchanged.
   */
  it.skipIf(POWERSHELL === null)('round-trips anything a Windows path can hold', () => {
    const nasty = [
      "C:\\Users\\O'Brien\\.claude",
      'C:\\Users\\x\\App Data\\p',
      'C:\\a b\\$env:USERPROFILE\\`tick\\[bracket]\\;rm\\&amp',
      "C:\\it's a $(Get-Date) test",
      '\\\\server\\share\\profiles\\one',
    ];
    for (const value of nasty) {
      const out = execFileSync(
        POWERSHELL as string,
        ['-NoProfile', '-Command', `Write-Output ${powerShellQuote(value)}`],
        { encoding: 'utf8' },
      );
      expect(out.replace(/\r?\n$/, '')).toBe(value);
    }
  });
});

describe('the generated PowerShell', () => {
  it('says so when there is nothing to cover', () => {
    expect(buildSharedConfigScript([], 'share', 'win32')).toContain('No Claude profiles to cover.');
  });

  it('quotes every directory it names', () => {
    const script = buildSharedConfigScript(
      ["C:\\Users\\O'Brien\\App Data\\p"],
      'share',
      'win32',
    );
    expect(script).toContain("Update-Profile 'C:\\Users\\O''Brien\\App Data\\p'");
  });

  /*
   * PowerShell has no word splitting, so this is not the bug it was in sh — but
   * a `foreach` over a variable is still a list the reader has to go and look
   * up, and the sh generator's suite states the same rule as itself. Kept in
   * step so that neither generator can quietly grow a `$SharedDirectories`.
   */
  it('never iterates a list by expanding a variable', () => {
    for (const mode of ['share', 'restore'] as const) {
      const script = buildSharedConfigScript(['C:\\p'], mode, 'win32');
      expect(script).not.toMatch(/foreach\s*\(\s*\$\w+\s+in\s+\$/);
      for (const name of SHARED_ENTRIES) expect(script).toContain(`'${name}'`);
    }
  });

  it('makes junctions and hard links, and never a symbolic link', () => {
    const script = buildSharedConfigScript(['C:\\p'], 'share', 'win32');
    expect(script).toContain('New-Item -ItemType Junction');
    expect(script).toContain('New-Item -ItemType HardLink');
    // A symbolic link is the obvious translation of `ln -s` and the one that
    // needs an administrator, which is a thing the user finds out halfway
    // through, after their `projects/` has already been renamed.
    expect(script).not.toContain('SymbolicLink');
  });

  it('never removes a directory recursively', () => {
    const script = buildSharedConfigScript(['C:\\p'], 'restore', 'win32');
    // Comments dropped first, because the script explains at length why it does
    // not do this and the explanation names the thing it is not doing.
    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    // `Remove-Item -Recurse` on a junction has historically deleted the folder
    // on the far side of it, which here is the user's own ~/.claude.
    expect(code).not.toMatch(/Remove-Item[^\n]*-Recurse/);
    expect(code).toContain('[System.IO.Directory]::Delete($Path, $false)');
  });

  /*
   * The script is copied out of a pane and pasted into a console whose code page
   * is whatever it is, or saved as a `.ps1` that Windows PowerShell reads as
   * ANSI unless something put a BOM on it. An em dash in a comment is not worth
   * finding out which.
   */
  it('is ASCII, comments included', () => {
    for (const mode of ['share', 'restore'] as const) {
      const script = buildSharedConfigScript(['C:\\p'], mode, 'win32');
      // Named rather than counted, so a failure says which em dash crept in.
      const outside = [...script].filter((ch) => (ch.codePointAt(0) ?? 0) > 127);
      expect(outside).toEqual([]);
    }
  });
});

describe('scriptShell', () => {
  it('names PowerShell on Windows and a terminal everywhere else', () => {
    // What the pane puts in "Quit Artemis, run this in …". Wrong here is a
    // sentence that sends a Windows user looking for a terminal to paste
    // PowerShell into, which is most of an afternoon.
    expect(scriptShell('win32')).toBe('PowerShell');
    expect(scriptShell('darwin')).toBe('a terminal');
    expect(scriptShell('linux')).toBe('a terminal');
  });
});

/* -------------------------------------------------------------------------- */
/* Reading the status                                                         */
/* -------------------------------------------------------------------------- */

/*
 * These are the judgement calls the pane makes about a reading the main process
 * took — pure, so asserted here rather than through a rendered component. The
 * reading itself is tested against a real filesystem in `main/sharedConfig.test.ts`.
 */

/** A `checked` directory: everything linked except the names overridden. */
function checked(dir: string, over: Record<string, SharedConfigEntry> = {}): SharedConfigDirStatus {
  return {
    dir,
    state: 'checked',
    entries: SHARED_ENTRIES.map((name) => over[name] ?? { name, state: 'linked' }),
  };
}

function status(
  dirs: readonly SharedConfigDirStatus[],
  rootMissing: readonly string[] = [],
): SharedConfigStatus {
  return { root: '/home/u/.claude', rootMissing, dirs };
}

describe('entryGap', () => {
  it('is nothing to do for a link that already points at the root', () => {
    expect(entryGap({ name: 'skills', state: 'linked' }, [])).toBe(false);
  });

  it('is work for a folder of its own, a foreign link, or an absent directory', () => {
    expect(entryGap({ name: 'skills', state: 'own' }, [])).toBe(true);
    expect(entryGap({ name: 'skills', state: 'foreign' }, [])).toBe(true);
    // The root does not have it either, but the script `mkdir -p`s a directory
    // and links it — so this one is still outstanding work.
    expect(entryGap({ name: 'plans', state: 'missing' }, ['plans'])).toBe(true);
  });

  it('is not work for a file the root does not have', () => {
    // The share script prints `skip  CLAUDE.md (no …)`. Counting this as a gap
    // would leave a perfectly-run share reading as incomplete forever.
    expect(entryGap({ name: 'CLAUDE.md', state: 'missing' }, ['CLAUDE.md'])).toBe(false);
    // The root *does* have one here, so the profile is genuinely unlinked.
    expect(entryGap({ name: 'CLAUDE.md', state: 'missing' }, [])).toBe(true);
  });
});

describe('summarizeDir', () => {
  it('reads a fully linked directory as shared', () => {
    const summary = summarizeDir(checked('/a'), []);
    expect(summary.state).toBe('shared');
    expect(summary.linked).toBe(SHARED_ENTRIES.length);
    expect(summary.gaps).toEqual([]);
  });

  it('names what is missing on a half-linked directory', () => {
    const summary = summarizeDir(
      checked('/a', {
        skills: { name: 'skills', state: 'own', backup: true },
        projects: { name: 'projects', state: 'missing' },
      }),
      [],
    );

    expect(summary.state).toBe('partial');
    expect(summary.linked).toBe(SHARED_ENTRIES.length - 2);
    // In script order, not in the order the states happen to differ.
    expect(summary.gaps).toEqual(['skills', 'projects']);
    expect(summary.backups).toEqual(['skills']);
  });

  it('reads a never-shared directory as unshared', () => {
    const entries = SHARED_ENTRIES.map((name) => ({ name, state: 'missing' as const }));
    const summary = summarizeDir({ dir: '/a', state: 'checked', entries }, []);

    expect(summary.state).toBe('unshared');
    expect(summary.linked).toBe(0);
  });

  it('does not call a directory shared just because nothing could be linked', () => {
    // Every entry absent, and every absence one the script deliberately skips:
    // no gaps, and no links either. Without the `linked > 0` guard this reads as
    // fully shared, which is the one wrong answer a user could not argue with.
    const summary = summarizeDir(
      { dir: '/a', state: 'checked', entries: [{ name: 'CLAUDE.md', state: 'missing' }] },
      ['CLAUDE.md'],
    );

    expect(summary.gaps).toEqual([]);
    expect(summary.state).toBe('unshared');
  });

  it('passes the root and the absent through untouched', () => {
    expect(summarizeDir({ dir: '/a', state: 'root', entries: [] }, []).state).toBe('root');
    expect(summarizeDir({ dir: '/a', state: 'absent', entries: [] }, []).state).toBe('absent');
  });
});

describe('dirsNeedingWork', () => {
  const partial = checked('/partial', { skills: { name: 'skills', state: 'own' } });
  const whole = checked('/whole');
  const fresh: SharedConfigDirStatus = {
    dir: '/fresh',
    state: 'checked',
    entries: SHARED_ENTRIES.map((name) => ({ name, state: 'missing' as const })),
  };
  const reading = status([
    whole,
    partial,
    fresh,
    { dir: '/home/u/.claude', state: 'root', entries: [] },
    { dir: '/gone', state: 'absent', entries: [] },
  ]);

  it('covers only the directories the share script would change', () => {
    // The point of the narrow script: a fifth account added after the first four
    // were linked is covered without walking back over the four.
    expect(dirsNeedingWork(reading, 'share')).toEqual(['/partial', '/fresh']);
  });

  it('covers only the directories the undo script would change', () => {
    expect(dirsNeedingWork(reading, 'restore')).toEqual(['/whole', '/partial']);
  });

  it('counts a leftover backup as work for the undo script', () => {
    // Nothing is linked here any more, but the original is still sitting beside
    // the name it was moved out of, and `restore_one` would bring it back.
    const left: SharedConfigDirStatus = {
      dir: '/left',
      state: 'checked',
      entries: SHARED_ENTRIES.map((name) => ({
        name,
        state: 'missing' as const,
        ...(name === 'projects' ? { backup: true } : {}),
      })),
    };
    expect(dirsNeedingWork(status([left]), 'restore')).toEqual(['/left']);
  });

  it('never offers a script for the root or for a directory that is gone', () => {
    // Both scripts skip these by name, so a script generated for them would
    // print `skip` and do nothing.
    const only = status([
      { dir: '/home/u/.claude', state: 'root', entries: [] },
      { dir: '/gone', state: 'absent', entries: [] },
    ]);
    expect(dirsNeedingWork(only, 'share')).toEqual([]);
    expect(dirsNeedingWork(only, 'restore')).toEqual([]);
  });
});

describe('statusDisagrees', () => {
  it('is quiet when the switch is on and everything is linked', () => {
    expect(statusDisagrees(status([checked('/a'), checked('/b')]), true)).toBe(false);
  });

  it('speaks up when the switch is on and one profile was left behind', () => {
    // The failure that actually happens: the script covered the profiles that
    // existed when it was generated.
    const fresh: SharedConfigDirStatus = {
      dir: '/new',
      state: 'checked',
      entries: SHARED_ENTRIES.map((name) => ({ name, state: 'missing' as const })),
    };
    expect(statusDisagrees(status([checked('/a'), fresh]), true)).toBe(true);
  });

  it('speaks up when the switch is off and the links are still there', () => {
    // Prefs reset, a new install, or the script run by hand. The pane would
    // otherwise claim an isolation the accounts do not have.
    expect(statusDisagrees(status([checked('/a')]), false)).toBe(true);
  });

  it('is quiet when the switch is off and nothing is linked', () => {
    const fresh: SharedConfigDirStatus = {
      dir: '/a',
      state: 'checked',
      entries: SHARED_ENTRIES.map((name) => ({ name, state: 'own' as const })),
    };
    expect(statusDisagrees(status([fresh]), false)).toBe(false);
  });

  it('says nothing when there is nothing to compare', () => {
    // A reading of the root alone, or of directories that are not there, is not
    // a disagreement — and the empty state already says the useful thing.
    const only = status([
      { dir: '/home/u/.claude', state: 'root', entries: [] },
      { dir: '/gone', state: 'absent', entries: [] },
    ]);
    expect(statusDisagrees(only, true)).toBe(false);
    expect(statusDisagrees(status([]), true)).toBe(false);
  });

  it('counts the root profile as neither shared nor a straggler', () => {
    // A user whose only Claude profile *is* `~/.claude` has asked for something
    // that is already true of their machine, and a permanent warning would be
    // the pane inventing a problem.
    const only = status([checked('/a'), { dir: '/home/u/.claude', state: 'root', entries: [] }]);
    expect(statusDisagrees(only, true)).toBe(false);
  });
});

describe('statusHasLinks', () => {
  it('is false for a machine that never ran the script', () => {
    const fresh: SharedConfigDirStatus = {
      dir: '/a',
      state: 'checked',
      entries: SHARED_ENTRIES.map((name) => ({ name, state: 'missing' as const })),
    };
    // What keeps the pane from showing a status block to somebody who has never
    // touched the switch.
    expect(statusHasLinks(status([fresh]))).toBe(false);
  });

  it('is true for a link, and for a backup left behind by one', () => {
    expect(statusHasLinks(status([checked('/a')]))).toBe(true);

    const left: SharedConfigDirStatus = {
      dir: '/a',
      state: 'checked',
      entries: [{ name: 'projects', state: 'missing', backup: true }],
    };
    expect(statusHasLinks(status([left]))).toBe(true);
  });
});
