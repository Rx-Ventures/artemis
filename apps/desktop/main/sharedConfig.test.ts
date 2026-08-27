/**
 * The shared-config probe, against a real filesystem.
 * ============================================================================
 *
 * Every one of these tests builds a sandbox, points `HOME` at it, and looks at
 * what the probe says about it. There is no mocking of `fs` here on purpose: the
 * whole value of this module is that it agrees with the disk, and a test against
 * a fake `lstat` would agree with whatever the test author believed `lstat` does.
 * Symlinks are the subject matter, and symlinks are exactly where a belief about
 * `lstat` goes wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IMPORTS RENDERER CODE
 * ---------------------------------------------------------------------------
 *
 * The first suite runs the *real* generated script and then probes the result.
 * That crosses a boundary main-process source never crosses — `@/lib/…` is
 * renderer code — and it is the single most valuable assertion available here:
 * the pane's reading and the script's writing are two independent
 * implementations of one arrangement, and this is the only place they are made
 * to agree. If the names the script walks and the names {@link SHARED_ENTRIES}
 * lists ever drift, or a link's spelling stops matching what the prober compares
 * against, a share that ran perfectly starts rendering as a gap — and nothing
 * else in the suite would notice.
 *
 * That round trip runs once per shell on the machine, for the reason set out in
 * the generator's own suite: the script reaches the user through a Copy button,
 * so the shell that runs it is whichever one they had open, and it has already
 * behaved differently in one of them.
 *
 * On Windows the round trip runs against the PowerShell script instead, and it
 * is worth more there than anywhere else. The arrangement is made out of
 * junctions and a hard link, the prober answers for them with two different
 * questions — `readlink`, and a `dev`/`ino` comparison — and neither question is
 * asked at all on the other platforms. A drift between the script and the reader
 * would be invisible in every other suite in the repository.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SHARED_ENTRIES, type SharedConfigDirStatus } from '@rx-artemis/protocol';
import { buildSharedConfigScript } from '@/lib/sharedClaudeConfig';

import {
  normalizeLinkTarget,
  readSharedConfigStatus,
  sameFileIdentity,
  sameLinkPath,
} from './sharedConfig.js';

const canRunShell = process.platform !== 'win32';

/** Every shell present, for the reason given in the header. Detected, not assumed. */
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
/* Sandbox                                                                    */
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

/**
 * The same sandbox shape the generator's own tests build, and deliberately so:
 * a root missing most of the shared directories, a used profile with a
 * `session-env` of its own, and the space in `App Support` that mirrors
 * `~/Library/Application Support`.
 */
function sandbox(): Sandbox {
  const base = mkdtempSync(path.join(tmpdir(), 'artemis-probe-'));
  sandboxes.push(base);

  const home = path.join(base, 'home');
  const root = path.join(home, '.claude');
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  mkdirSync(path.join(root, 'session-env'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), 'root instructions\n');

  const work = path.join(base, 'App Support', 'profiles', 'work');
  mkdirSync(path.join(work, 'session-env'), { recursive: true });
  mkdirSync(path.join(work, 'projects'), { recursive: true });
  writeFileSync(path.join(work, '.claude.json'), 'work account\n');

  const max = path.join(base, 'App Support', 'profiles', 'max');
  mkdirSync(max, { recursive: true });

  return { home, root, work, max };
}

function runScriptIn(
  shell: string,
  box: Sandbox,
  dirs: readonly string[],
  mode: 'share' | 'restore',
): string {
  const script = path.join(box.home, `${mode}.sh`);
  writeFileSync(script, buildSharedConfigScript(dirs, mode, 'darwin'));
  // Named explicitly rather than left to the shebang, which is what a pasted
  // script does not get.
  return execFileSync(shell, [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: box.home },
  });
}

/** One directory's reading, by path. */
async function probe(box: Sandbox, dirs: readonly string[]): Promise<SharedConfigDirStatus[]> {
  const status = await readSharedConfigStatus({ dirs, home: box.home });
  return [...status.dirs];
}

/** The state of one named entry in a reading. */
function stateOf(status: SharedConfigDirStatus, name: string): string | undefined {
  return status.entries.find((entry) => entry.name === name)?.state;
}

/* -------------------------------------------------------------------------- */
/* The round trip                                                             */
/* -------------------------------------------------------------------------- */

describe.each(SHELLS)('after the real share script runs (%s)', (shell) => {
  const runScript = (box: Sandbox, dirs: readonly string[], mode: 'share' | 'restore'): string =>
    runScriptIn(shell, box, dirs, mode);

  it('reads every entry as linked', async () => {
    const box = sandbox();
    runScript(box, [box.work, box.max], 'share');

    const [work, max] = await probe(box, [box.work, box.max]);

    for (const status of [work, max]) {
      expect(status?.state).toBe('checked');
      // Not "at least one is linked": the point of the round trip is that the
      // prober recognises *all* of the script's own work. One name it cannot
      // classify is a row the pane would report as a gap forever.
      expect(status?.entries.map((entry) => entry.state)).toEqual(
        SHARED_ENTRIES.map(() => 'linked'),
      );
    }
  });

  it('says the root has nothing missing once the script has created it', async () => {
    const box = sandbox();
    runScript(box, [box.work], 'share');

    const status = await readSharedConfigStatus({ dirs: [box.work], home: box.home });
    // The sandbox root started with two of the eight directories. `mkdir -p`
    // created the rest, and the pane must not go on claiming they are absent.
    expect(status.rootMissing).toEqual([]);
    expect(status.root).toBe(box.root);
  });

  it('reports the backup the script left behind', async () => {
    const box = sandbox();
    runScript(box, [box.work], 'share');

    const [work] = await probe(box, [box.work]);
    const displaced = work?.entries.find((entry) => entry.name === 'session-env');

    // The profile had a `session-env` of its own; it is now linked, with the
    // original renamed alongside it. Both halves matter — the link is what the
    // user asked for, and the backup is a folder holding their data that nothing
    // in the app has ever mentioned.
    expect(displaced?.state).toBe('linked');
    expect(displaced?.backup).toBe(true);
    // `projects` was displaced too, and that one holds transcripts.
    expect(work?.entries.find((entry) => entry.name === 'projects')?.backup).toBe(true);
    // Nothing was displaced under a name the profile never had.
    expect(work?.entries.find((entry) => entry.name === 'skills')?.backup).toBeUndefined();
  });

  it('reads nothing as linked again after the undo script', async () => {
    const box = sandbox();
    runScript(box, [box.work], 'share');
    runScript(box, [box.work], 'restore');

    const [work] = await probe(box, [box.work]);

    expect(work?.entries.some((entry) => entry.state === 'linked')).toBe(false);
    // The two the profile owned came back as its own, and the backups are gone.
    expect(stateOf(work as SharedConfigDirStatus, 'session-env')).toBe('own');
    expect(stateOf(work as SharedConfigDirStatus, 'projects')).toBe('own');
    expect(work?.entries.every((entry) => entry.backup === undefined)).toBe(true);
    // The ones it never had are simply absent again.
    expect(stateOf(work as SharedConfigDirStatus, 'commands')).toBe('missing');
  });

  it('does not link CLAUDE.md when the root has none, and says why', async () => {
    const box = sandbox();
    rmSync(path.join(box.root, 'CLAUDE.md'));
    runScript(box, [box.work], 'share');

    const status = await readSharedConfigStatus({ dirs: [box.work], home: box.home });
    const work = status.dirs[0] as SharedConfigDirStatus;

    // A perfectly-run share leaves this entry unlinked. Without `rootMissing`
    // the pane would have to call that a gap, and a correct arrangement would
    // read as broken for as long as the user has no root CLAUDE.md.
    expect(stateOf(work, 'CLAUDE.md')).toBe('missing');
    expect(status.rootMissing).toEqual(['CLAUDE.md']);
  });
});

/* -------------------------------------------------------------------------- */
/* The same round trip, in PowerShell                                         */
/* -------------------------------------------------------------------------- */

/** PowerShell, if this is Windows and it will start. Detected, not assumed. */
const POWERSHELL = ((): string | null => {
  if (process.platform !== 'win32') return null;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return 'powershell.exe';
  } catch {
    return null;
  }
})();

/** `$env:USERPROFILE` is what the Windows script expands, so that is what moves. */
function runPowerShellIn(box: Sandbox, dirs: readonly string[], mode: 'share' | 'restore'): string {
  const script = path.join(box.home, `${mode}.ps1`);
  writeFileSync(script, buildSharedConfigScript(dirs, mode, 'win32'));
  return execFileSync(
    POWERSHELL as string,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { encoding: 'utf8', env: { ...process.env, USERPROFILE: box.home } },
  );
}

describe.skipIf(POWERSHELL === null)('after the real Windows share script runs', () => {
  it('reads every entry as linked', async () => {
    const box = sandbox();
    runPowerShellIn(box, [box.work, box.max], 'share');

    const [work, max] = await probe(box, [box.work, box.max]);

    for (const status of [work, max]) {
      expect(status?.state).toBe('checked');
      /*
       * The assertion this file exists for, and on Windows it is checking two
       * separate mechanisms at once: eight junctions the prober recognises
       * through `readlink`, and one hard link it can only recognise by asking
       * whether the two names are the same file. One name it cannot classify is
       * a row the pane would report as a gap forever, and neither mechanism is
       * exercised anywhere else in the repository.
       */
      expect(status?.entries.map((entry) => entry.state)).toEqual(
        SHARED_ENTRIES.map(() => 'linked'),
      );
    }
  });

  it('reads the hard-linked CLAUDE.md as linked, which no lstat can see', async () => {
    const box = sandbox();
    runPowerShellIn(box, [box.max], 'share');

    const at = path.join(box.max, 'CLAUDE.md');
    // Not a symlink and not a copy. Without the identity comparison this entry
    // reads as `own` — a file of the profile's own that the share script would
    // move aside — which is a perfectly-run share reporting as a gap forever.
    expect(lstatSync(at).isSymbolicLink()).toBe(false);
    expect(stateOf((await probe(box, [box.max]))[0] as SharedConfigDirStatus, 'CLAUDE.md')).toBe(
      'linked',
    );
  });

  it('reads nothing as linked again after the undo script', async () => {
    const box = sandbox();
    runPowerShellIn(box, [box.work], 'share');
    runPowerShellIn(box, [box.work], 'restore');

    const [work] = await probe(box, [box.work]);

    expect(work?.entries.some((entry) => entry.state === 'linked')).toBe(false);
    // The two the profile owned came back as its own, and the backups are gone.
    expect(stateOf(work as SharedConfigDirStatus, 'session-env')).toBe('own');
    expect(stateOf(work as SharedConfigDirStatus, 'projects')).toBe('own');
    expect(work?.entries.every((entry) => entry.backup === undefined)).toBe(true);
    expect(stateOf(work as SharedConfigDirStatus, 'commands')).toBe('missing');
  });
});

/* -------------------------------------------------------------------------- */
/* The states the script does not produce                                     */
/* -------------------------------------------------------------------------- */

describe('classifying what is there', () => {
  it('reads an untouched profile as owning its own entries', async () => {
    const box = sandbox();
    const [work] = await probe(box, [box.work]);

    expect(work?.state).toBe('checked');
    expect(stateOf(work as SharedConfigDirStatus, 'session-env')).toBe('own');
    expect(stateOf(work as SharedConfigDirStatus, 'skills')).toBe('missing');
    expect(work?.entries.every((entry) => entry.backup === undefined)).toBe(true);
  });

  it.skipIf(!canRunShell)('reads a link pointing elsewhere as foreign, and names it', async () => {
    const box = sandbox();
    const elsewhere = path.join(box.home, 'dotfiles', 'skills');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, path.join(box.work, 'skills'));

    const [work] = await probe(box, [box.work]);
    const skills = work?.entries.find((entry) => entry.name === 'skills');

    // Somebody's own arrangement. The undo script prints `leave` for exactly
    // this, so the pane has to be able to say what it is rather than counting it
    // as an absence.
    expect(skills?.state).toBe('foreign');
    expect(skills?.target).toBe(elsewhere);
  });

  it.skipIf(!canRunShell)(
    'reads a link that reaches the root by another spelling as foreign',
    async () => {
      const box = sandbox();
      // Relative, and resolving to precisely the right directory. `realpath`
      // would call this linked; the script will not, because it compares the
      // link's text — so neither does this, or the pane would promise an outcome
      // the user is not going to get.
      mkdirSync(path.join(box.root, 'commands'), { recursive: true });
      symlinkSync(
        path.relative(box.work, path.join(box.root, 'commands')),
        path.join(box.work, 'commands'),
      );

      const [work] = await probe(box, [box.work]);
      expect(stateOf(work as SharedConfigDirStatus, 'commands')).toBe('foreign');
    },
  );

  it.skipIf(!canRunShell)('reports a backup even when nothing was linked over it', async () => {
    const box = sandbox();
    mkdirSync(path.join(box.work, 'plans.pre-shared'), { recursive: true });

    const [work] = await probe(box, [box.work]);
    const plans = work?.entries.find((entry) => entry.name === 'plans');

    // The state the undo script's `restore` step acts on: nothing at the name,
    // and the original sitting beside it waiting to come back.
    expect(plans?.state).toBe('missing');
    expect(plans?.backup).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Directories that are not profiles                                          */
/* -------------------------------------------------------------------------- */

describe('the two directories that are not read', () => {
  it('reads ~/.claude itself as the root rather than as unlinked', async () => {
    const box = sandbox();
    const [root] = await probe(box, [box.root]);

    // Both scripts skip this by name — linking the root into itself would
    // replace every shared folder with a link to the backup it was just renamed
    // into. Nine `missing` rows here would make the user's own config directory
    // look permanently broken.
    expect(root?.state).toBe('root');
    expect(root?.entries).toEqual([]);
  });

  it('reads a trailing slash as the root too', async () => {
    const box = sandbox();
    const [root] = await probe(box, [`${box.root}/`]);

    // The script's own test is a string comparison and would miss this. The
    // pane's job is to describe the disk, and a trailing slash is not a fact
    // about the disk.
    expect(root?.state).toBe('root');
  });

  it('reads a directory that is not there as absent', async () => {
    const box = sandbox();
    const gone = path.join(box.home, 'nope');
    const [missing] = await probe(box, [gone]);

    expect(missing?.state).toBe('absent');
    expect(missing?.dir).toBe(gone);
  });

  it.skipIf(!canRunShell)('follows a symlinked config directory, as the script does', async () => {
    const box = sandbox();
    const link = path.join(box.home, 'work-link');
    symlinkSync(box.work, link);

    const [work] = await probe(box, [link]);

    // `[ -d "$dir" ]` follows, so the script walks into this one and so does the
    // reading. Reporting it as absent would hide a directory that is about to be
    // written to.
    expect(work?.state).toBe('checked');
    expect(stateOf(work as SharedConfigDirStatus, 'session-env')).toBe('own');
  });

  it('answers for every directory it was given, in order', async () => {
    const box = sandbox();
    const gone = path.join(box.home, 'nope');
    const status = await readSharedConfigStatus({
      dirs: [box.work, gone, box.root, box.max],
      home: box.home,
    });

    // The pane joins this onto its own list of profiles by path, so a dropped or
    // reordered entry would attach one profile's state to another's row.
    expect(status.dirs.map((dir) => dir.dir)).toEqual([box.work, gone, box.root, box.max]);
    expect(status.dirs.map((dir) => dir.state)).toEqual(['checked', 'absent', 'root', 'checked']);
  });

  it('reads nothing at all when there are no directories', async () => {
    const box = sandbox();
    const status = await readSharedConfigStatus({ dirs: [], home: box.home });

    expect(status.dirs).toEqual([]);
    // The root is still reported: it is what the pane names as the thing
    // everything would be compared against.
    expect(status.root).toBe(box.root);
  });
});

/* -------------------------------------------------------------------------- */
/* The two comparisons Windows needs                                          */
/* -------------------------------------------------------------------------- */

/*
 * Pure, and tested as such. Both are one-line judgements sitting under a pile of
 * `fs` calls, and both are the kind of thing that reads as obviously right and
 * is obviously right in one direction only — a prefix stripped from the wrong
 * side, an `ino` of zero taken at face value. Asserting them through a sandbox
 * would mean owning a filesystem that produces each case, and a `\\?\` target is
 * not something a test can reliably make one produce.
 */

describe('normalizeLinkTarget', () => {
  it('takes the extended-length prefix off a drive path', () => {
    // What a junction's substitute name is actually stored as, and what some
    // versions of Node hand back verbatim. The same directory, spelled for the
    // filesystem instead of for the Win32 path parser.
    expect(normalizeLinkTarget('\\\\?\\C:\\Users\\you\\.claude\\skills')).toBe(
      'C:\\Users\\you\\.claude\\skills',
    );
    expect(normalizeLinkTarget('\\??\\C:\\Users\\you\\.claude\\skills')).toBe(
      'C:\\Users\\you\\.claude\\skills',
    );
  });

  it('unwinds the UNC form to the share path a caller would have written', () => {
    expect(normalizeLinkTarget('\\\\?\\UNC\\server\\share\\profiles')).toBe(
      '\\\\server\\share\\profiles',
    );
  });

  it('leaves everything else exactly as it found it', () => {
    // Including POSIX paths: this runs on every platform, and a normalizer that
    // trimmed four characters off `/Users/…` would be a silent disaster.
    expect(normalizeLinkTarget('/Users/ada/.claude/skills')).toBe('/Users/ada/.claude/skills');
    expect(normalizeLinkTarget('C:\\Users\\you\\.claude')).toBe('C:\\Users\\you\\.claude');
    expect(normalizeLinkTarget('\\\\server\\share')).toBe('\\\\server\\share');
    expect(normalizeLinkTarget('')).toBe('');
  });
});

describe('sameLinkPath', () => {
  it('is byte equality off Windows, exactly as the shell compares it', () => {
    // The rule this module's header commits to: a link that reaches the right
    // directory by another spelling reads as `foreign`, because that is what the
    // sh script will treat it as.
    expect(sameLinkPath('/home/u/.claude/skills', '/home/u/.claude/skills', false)).toBe(true);
    expect(sameLinkPath('/home/u/.claude/skills', '/home/u/.claude/Skills', false)).toBe(false);
    expect(sameLinkPath('\\\\?\\C:\\a', 'C:\\a', false)).toBe(false);
  });

  it('ignores case and the prefix on Windows, as PowerShell does', () => {
    // The script's own test is `-eq` against `.Target`, which is
    // case-insensitive; a profile registered as `c:\users\…` would otherwise
    // read as unlinked beside a junction the script had just made.
    expect(sameLinkPath('\\\\?\\C:\\Users\\You\\.claude\\skills', 'C:\\users\\you\\.claude\\skills', true)).toBe(
      true,
    );
    expect(sameLinkPath('C:\\Users\\you\\.claude\\skills', 'C:\\Users\\you\\.claude\\plans', true)).toBe(
      false,
    );
  });
});

describe('sameFileIdentity', () => {
  it('is true only for one file under two names', () => {
    expect(sameFileIdentity({ dev: 7n, ino: 42n }, { dev: 7n, ino: 42n })).toBe(true);
    // A copy with the same contents, which is what the script would move aside
    // and link over.
    expect(sameFileIdentity({ dev: 7n, ino: 42n }, { dev: 7n, ino: 43n })).toBe(false);
    // The same index on another volume, which is a coincidence and not a link.
    expect(sameFileIdentity({ dev: 8n, ino: 42n }, { dev: 7n, ino: 42n })).toBe(false);
  });

  it('refuses to guess when the filesystem gave no index', () => {
    // Node reports zero where there is no file index to report — some network
    // redirectors, and FAT. Two unrelated files would both be zero, and calling
    // them shared is precisely the false "everything is fine" this display
    // exists to end.
    expect(sameFileIdentity({ dev: 7n, ino: 0n }, { dev: 7n, ino: 0n })).toBe(false);
  });

  it('reads a stat that failed as no link rather than as an error', () => {
    expect(sameFileIdentity(null, { dev: 7n, ino: 42n })).toBe(false);
    expect(sameFileIdentity({ dev: 7n, ino: 42n }, null)).toBe(false);
    expect(sameFileIdentity(null, null)).toBe(false);
  });
});
