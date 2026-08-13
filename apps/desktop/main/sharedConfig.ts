/**
 * Reading the shared-`~/.claude` arrangement off the disk.
 * ============================================================================
 *
 * The Advanced pane's switch records an intention. The script that acts on it
 * runs in the user's own terminal, and until this module existed nothing in
 * Artemis ever looked at the result — so a switch left on after a script that was
 * read and closed looked exactly like a share that worked, and a fifth profile
 * added after the script covered four looked exactly like a profile that was
 * covered. Both failures are silent in the direction that matters: the user
 * believes a skill is available everywhere, and it is not.
 *
 * This is the observation half. It classifies, and it decides nothing — see
 * `SharedConfigStatus`, and `AdvancedSection.tsx` for the rule that the reading
 * must never drive the switch.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS FAITHFUL TO THE SCRIPT RATHER THAN TO THE FILESYSTEM
 * ---------------------------------------------------------------------------
 *
 * Every comparison here is the comparison the shell makes, not the most
 * technically thorough one available:
 *
 *  - A link is `linked` when its *text* equals `$ROOT/<name>`, because that is
 *    `[ "$(readlink "$target")" = "$source" ]`. A relative link into the same
 *    directory reads as `foreign`, which is exactly how the scripts will treat
 *    it — the share script will move it aside, the undo script will leave it.
 *    `realpath` would call it linked and then the user would watch the script
 *    disagree.
 *  - A profile directory exists when `stat` says it is a directory, following
 *    symlinks, because that is `[ ! -d "$dir" ]`.
 *  - The root is `$HOME/.claude` from {@link homedir}, because the script writes
 *    `ROOT="$HOME/.claude"` and lets the shell expand it.
 *
 * The one place this is deliberately *kinder* than the shell is the root test:
 * the script compares strings, this compares `path.resolve`d strings, so a
 * profile whose `configDir` is `~/.claude/` with a trailing slash is reported as
 * being the root instead of as a directory with nothing linked. The pane's job is
 * to say what is there, and a trailing slash is not a fact about the disk.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 *
 * `lstat` only, nine names per profile plus nine on the root, no traversal and
 * no `readdir`. Everything fans out through `Promise.all`, so the wall-clock cost
 * is one round of syscalls rather than nine per directory. Nothing here caches:
 * a stale reading is worse than a slow one, and the whole point is to be checked
 * again after the user has run something.
 */

import type { Stats } from 'node:fs';
import { lstat, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  BACKUP_SUFFIX,
  SHARED_ENTRIES,
  type SharedConfigDirStatus,
  type SharedConfigEntry,
  type SharedConfigStatus,
} from '@rx-artemis/protocol';

/** Where the scripts' `$ROOT` points on this machine. */
export function sharedConfigRoot(home: string = homedir()): string {
  return path.join(home, '.claude');
}

export interface ReadSharedConfigOptions {
  /** The directories to read, from `sharedConfigDirs`. Order is preserved. */
  readonly dirs: readonly string[];
  /**
   * Stand-in for `$HOME`. Defaults to {@link homedir}, which is what the shell
   * expands `$HOME` to; overridden only by tests, which point it at a sandbox
   * the way they point the script's own `HOME` at one.
   */
  readonly home?: string;
}

/**
 * Classify every shared entry in every given directory.
 *
 * Never rejects for anything a filesystem can do to it: an unreadable directory
 * reads as `absent` and an entry that cannot be `lstat`ed reads as `missing`,
 * because a pane that fails wholesale on one bad path tells the user less than
 * one that reports the other three profiles correctly. A permission error and a
 * missing file are genuinely indistinguishable to the reader anyway — in both
 * cases there is no link there.
 */
export async function readSharedConfigStatus(
  options: ReadSharedConfigOptions,
): Promise<SharedConfigStatus> {
  const root = sharedConfigRoot(options.home ?? homedir());

  const [rootMissing, dirs] = await Promise.all([
    readRootMissing(root),
    Promise.all(options.dirs.map((dir) => readDir(dir, root))),
  ]);

  return { root, rootMissing, dirs };
}

/**
 * Which shared names the root does not have.
 *
 * `stat` rather than `lstat`, following symlinks, because the script's test is
 * `[ ! -e "$ROOT/$name" ]` — and a root entry that is itself a link to somewhere
 * the user keeps their dotfiles is present as far as linking to it is concerned.
 * A *broken* link there is correctly reported as missing: it is a path that
 * cannot be read, and linking every profile at it would spread the broken read.
 */
async function readRootMissing(root: string): Promise<readonly string[]> {
  const present = await Promise.all(
    SHARED_ENTRIES.map(async (name) => ({ name, there: await exists(path.join(root, name)) })),
  );
  return present.filter(({ there }) => !there).map(({ name }) => name);
}

async function readDir(dir: string, root: string): Promise<SharedConfigDirStatus> {
  // The case the issue that asked for this display called out: the profile whose
  // config dir *is* `~/.claude` is skipped by both scripts, and reporting nine
  // unlinked entries for it would make it look permanently broken when it is in
  // fact the thing everything else points at.
  if (path.resolve(dir) === path.resolve(root)) return { dir, state: 'root', entries: [] };
  if (!(await isDirectory(dir))) return { dir, state: 'absent', entries: [] };

  const entries = await Promise.all(SHARED_ENTRIES.map((name) => readEntry(dir, root, name)));
  return { dir, state: 'checked', entries };
}

async function readEntry(dir: string, root: string, name: string): Promise<SharedConfigEntry> {
  const at = path.join(dir, name);
  const [found, backup] = await Promise.all([
    classify(at, path.join(root, name)),
    exists(path.join(dir, `${name}${BACKUP_SUFFIX}`), { follow: false }),
  ]);

  return { name, ...found, ...(backup ? { backup: true } : {}) };
}

/** The state of one path, and where it points when that is worth saying. */
async function classify(
  at: string,
  target: string,
): Promise<Pick<SharedConfigEntry, 'state' | 'target'>> {
  const info = await lstatOrNull(at);
  if (info === null) return { state: 'missing' };
  if (!info.isSymbolicLink()) return { state: 'own' };

  const link = await readlink(at).catch(() => null);
  if (link === target) return { state: 'linked' };
  // A link whose target cannot even be read is still not this arrangement's
  // link, so it is `foreign` — just without a path to name.
  return link === null ? { state: 'foreign' } : { state: 'foreign', target: link };
}

async function lstatOrNull(at: string): Promise<Stats | null> {
  return lstat(at).catch(() => null);
}

/**
 * Is there a directory here, following symlinks?
 *
 * Follows, because `[ -d "$dir" ]` does: a profile whose config dir is itself a
 * symlink to a real directory is one the script will happily walk into.
 */
async function isDirectory(at: string): Promise<boolean> {
  return stat(at)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

/**
 * Is there anything at all here?
 *
 * `follow: false` for the backups, matching `[ -e "$backup" ] || [ -L "$backup" ]`
 * in the script — a backup that is a broken symlink is still occupying the name
 * the undo script wants to restore from, and still a thing the user should be
 * told is sitting there.
 */
async function exists(at: string, options: { readonly follow?: boolean } = {}): Promise<boolean> {
  const read = options.follow === false ? lstat(at) : stat(at);
  return read.then(() => true).catch(() => false);
}
