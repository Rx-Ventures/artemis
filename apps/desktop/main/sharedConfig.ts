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
 * WINDOWS MAKES TWO OF THOSE COMPARISONS DIFFERENT
 * ---------------------------------------------------------------------------
 *
 * The Windows script cannot use `ln -s`: a symbolic link there needs
 * `SeCreateSymbolicLinkPrivilege`, so it uses the two link kinds an ordinary
 * user can make. Each one changes what "linked" has to mean here, in opposite
 * directions.
 *
 * **Junctions**, for the directories, are almost free. Node reports a junction
 * as a symbolic link and `readlink` resolves it, so the existing two calls
 * already answer — with two adjustments to the string they are compared with.
 * The target can come back carrying the `\\?\` prefix Windows uses to reach a
 * path without the Win32 parser touching it, which is the same directory spelled
 * for a different audience; and the comparison is case-insensitive, because the
 * script's own test is PowerShell's `-eq` and NTFS agrees with it. See
 * {@link normalizeLinkTarget} and {@link sameLinkPath}.
 *
 * **Hard links**, for `CLAUDE.md`, cannot be seen at all. A hard link is a
 * second name for one file, not a pointer to it, so `lstat` reports an ordinary
 * file and there is nothing to `readlink`. The question has to become identity
 * rather than reference: `fs.stat` both names with `{ bigint: true }` and ask
 * whether they are the same file. See {@link sameFileIdentity}, and note the
 * consequence it comes with — Windows records no *direction* on a hard link, so
 * this can say the two names are one file and can never say which of them the
 * script made. The undo script has the same blind spot and handles it the same
 * conservative way.
 *
 * Everything above is win32-only. On macOS and Linux the comparisons are exactly
 * the byte equality they always were.
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
 *
 * The identity comparison above is the one exception, and it is gated on
 * `nlink`: a file with one name cannot be a hard link to anything, and that is
 * already in the `lstat` result. Only a `CLAUDE.md` that really is linked twice
 * costs the two extra `stat`s.
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

/**
 * Whether this machine is the one the junction and hard-link rules apply to.
 *
 * Read once, at module load, and never taken as an argument. Making it an option
 * would let a caller ask what a Windows reading of a Linux disk would look like,
 * which is not a question with a useful answer — and would quietly turn the
 * identity comparison on for a platform whose script does not make hard links.
 */
const WINDOWS = process.platform === 'win32';

/* -------------------------------------------------------------------------- */
/* Comparing two paths the way the script does                                */
/* -------------------------------------------------------------------------- */

/**
 * Take the Windows extended-length prefix off a link target.
 *
 * `\\?\C:\Users\you\.claude\skills` and `C:\Users\you\.claude\skills` are one
 * directory. The prefix means "hand this to the filesystem without letting the
 * Win32 path parser near it" — no `MAX_PATH` limit, no `.`/`..` collapsing, no
 * turning `/` into `\` — and it is how a junction's substitute name is actually
 * stored, as `\??\C:\…`. Node normally hands both forms back cleaned up, but
 * "normally" is doing real work in that sentence: it depends on the libuv
 * version, on whether the reparse point was written by `mklink`, PowerShell or
 * something else, and on whether the target was long enough to need the prefix
 * in the first place. Comparing raw strings would make the same junction read as
 * `linked` on one machine and `foreign` on the next.
 *
 * `\\?\UNC\server\share` is the same trick for a network path and unwinds to
 * `\\server\share`, which is what a caller would have written.
 *
 * Left alone on anything that does not start with one of the two prefixes, so
 * this is safe to call on a POSIX path — it just returns it.
 */
export function normalizeLinkTarget(target: string): string {
  if (target.startsWith('\\\\?\\UNC\\')) return `\\\\${target.slice(8)}`;
  if (target.startsWith('\\\\?\\') || target.startsWith('\\??\\')) return target.slice(4);
  return target;
}

/**
 * Do these two spellings name the same link target?
 *
 * On macOS and Linux this is `===`, unchanged and deliberately so: the script's
 * test is `[ "$(readlink "$target")" = "$source" ]`, a link that reaches the
 * right directory by another spelling reads as `foreign`, and being cleverer
 * than the script would mean describing an outcome the user is not going to get.
 *
 * On Windows the script's test is PowerShell's `-eq` against `.Target`, which is
 * case-insensitive — so this is too, or a profile registered as `c:\users\…`
 * would read as unlinked next to a junction the script had just made and would
 * happily leave alone. The extended-length prefix comes off both sides first,
 * for the reason {@link normalizeLinkTarget} gives.
 */
export function sameLinkPath(a: string, b: string, windows: boolean = WINDOWS): boolean {
  if (!windows) return a === b;
  return normalizeLinkTarget(a).toLowerCase() === normalizeLinkTarget(b).toLowerCase();
}

/** The two numbers that say which file something is, and nothing else. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Are these two names the same file?
 *
 * The hard-link question, kept pure so it can be argued with directly. `dev` and
 * `ino` — the volume serial number and the file index on Windows — are what a
 * hard link shares and a copy does not, and the pair is the only thing that
 * distinguishes "the script linked these" from "somebody made a `CLAUDE.md`
 * with the same contents".
 *
 * `null` for either side is `false` rather than a throw: the caller gets `null`
 * from a `stat` that failed, which for this display means "there is no link
 * there", exactly as an unreadable directory means "nothing to report".
 *
 * A zero `ino` is `false` too, and that is not defensiveness. Node reports zero
 * where the filesystem does not supply a file index — some network redirectors,
 * and FAT — and two unrelated files would then both be zero and compare equal.
 * Reporting a profile's own `CLAUDE.md` as shared when it is not is the failure
 * this whole display exists to end, so the ambiguous case answers "not linked".
 */
export function sameFileIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) return false;
  if (a.ino === 0n) return false;
  return a.dev === b.dev && a.ino === b.ino;
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
  // Junctions land here too, and that is the whole reason the Windows script
  // uses them: Node reports a directory reparse point as a symbolic link, so
  // this branch already covers both platforms' idea of a linked directory.
  if (info.isSymbolicLink()) {
    const link = await readlink(at).catch(() => null);
    if (link !== null && sameLinkPath(link, target)) return { state: 'linked' };
    // A link whose target cannot even be read is still not this arrangement's
    // link, so it is `foreign` — just without a path to name.
    return link === null ? { state: 'foreign' } : { state: 'foreign', target: link };
  }

  // Everything below is the Windows hard link, and nothing else reaches it: on
  // macOS and Linux an entry that is not a symlink is `own`, full stop, and
  // `nlink` is 1 for the ordinary file that this is being asked about anyway.
  if (!WINDOWS || info.isDirectory() || info.nlink < 2) return { state: 'own' };
  return (await sameFile(at, target)) ? { state: 'linked' } : { state: 'own' };
}

/** Do these two paths reach one file, by identity rather than by reference? */
async function sameFile(at: string, target: string): Promise<boolean> {
  const [here, there] = await Promise.all([identity(at), identity(target)]);
  return sameFileIdentity(here, there);
}

/**
 * Which file this path is, or `null` when that cannot be read.
 *
 * `stat`, not `lstat`, and following on purpose: the script hard-links to
 * whatever `$Root\CLAUDE.md` resolves to, so a root entry that is itself a link
 * into a dotfiles folder is the file the profile now shares — the same reason
 * {@link readRootMissing} follows.
 *
 * `{ bigint: true }` because an NTFS file index is 64 bits and `Number` is not.
 * Two files in the same directory can differ only in the low bits of an index
 * that has already lost precision, which is a comparison that returns `true`
 * for the wrong pair.
 */
async function identity(at: string): Promise<FileIdentity | null> {
  return stat(at, { bigint: true })
    .then((info) => ({ dev: info.dev, ino: info.ino }))
    .catch(() => null);
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
