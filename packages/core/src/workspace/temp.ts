/**
 * Is this directory somewhere the operating system will delete?
 *
 * ## Why anything asks
 *
 * The recent-folders menu remembers ten directories, and a directory under the
 * temporary root does not survive to be gone back to: the OS clears it on
 * reboot, and the tools that create these — an agent unpacking a scratch
 * checkout, an editor staging an attachment — delete them sooner than that. A
 * session started in one keeps that path forever, so resuming it a week later
 * offers the menu a directory that has not existed for days. Ten of those evict
 * every real project from a list of ten.
 *
 * ## Why it is string work and not a `stat`
 *
 * The interesting case is a path that is *already gone*, which is exactly the
 * case no filesystem call can answer — `stat` says "missing", and missing is
 * also what a typo and an unmounted volume say. Where the path *is* answers the
 * question without needing the directory to still be there.
 *
 * It is also why this cannot live in the renderer: `tmpdir()` is a fact about
 * the machine, and the renderer is not allowed to know one.
 *
 * ## What counts
 *
 * Anything at or below a temporary root, of which there can be several:
 *
 *  - **`tmpdir()`** — the real answer, and on macOS a per-user directory such
 *    as `/var/folders/tz/…/T` rather than anything named "tmp".
 *  - **`/tmp`** — hard-coded by plenty of tools whatever `TMPDIR` says, so it
 *    counts on POSIX even when it is not the configured root.
 *  - **The `/private` twin of both**, because macOS reaches one directory by two
 *    names: `/var` and `/tmp` are symlinks into `/private`, and a path that has
 *    been through `realpath` comes back spelled the long way. Comparing only the
 *    short form would miss every resolved path, and vice versa.
 */

import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';

/**
 * Is `path` inside a directory the OS treats as scratch space?
 *
 * @param path an absolute path. A relative one is not judged — resolving it
 *             against *this* process's cwd would answer about a directory the
 *             caller never named, which is `describeWorkspace`'s rule too.
 */
export function isTemporaryPath(path: string): boolean {
  const value = path.trim();
  if (value.length === 0 || !isAbsolute(value)) return false;
  return temporaryRoots().some((root) => isAtOrBelow(value, root));
}

/**
 * Every spelling of every temporary root.
 *
 * Recomputed per call rather than cached at import: `TMPDIR` is read by
 * `tmpdir()` each time, and a module-level constant would freeze whatever the
 * environment happened to say when this file was first loaded — which in a test,
 * and in an app launched from a desktop session, is not what it says later.
 */
function temporaryRoots(): readonly string[] {
  const roots = new Set<string>();

  const add = (candidate: string): void => {
    if (candidate.length === 0) return;
    roots.add(candidate);
    // The macOS symlink twins. Only there: on Linux `/private` is nobody's
    // directory, so the extra entry is unreachable rather than wrong, but
    // spelling out the platform says why the entry exists at all.
    if (process.platform !== 'darwin') return;
    if (candidate.startsWith('/private/')) roots.add(candidate.slice('/private'.length));
    else if (candidate.startsWith('/')) roots.add(`/private${candidate}`);
  };

  add(tmpdir());
  if (process.platform !== 'win32') add('/tmp');
  return [...roots];
}

/**
 * Is `path` the directory `root`, or something inside it?
 *
 * Compared segment by segment rather than by string prefix, so `/tmpfoo` is not
 * read as being inside `/tmp` — the failure a `startsWith` would introduce, and
 * one that would silently drop somebody's real project from the menu.
 *
 * Case-insensitively on Windows only. macOS is usually case-insensitive too, but
 * it reports paths back in a consistent case, whereas Windows genuinely hands
 * out `C:\Users` and `C:\USERS` for the same directory.
 */
function isAtOrBelow(path: string, root: string): boolean {
  const target = segments(path);
  const base = segments(root);
  if (base.length === 0 || target.length < base.length) return false;

  const fold = process.platform === 'win32';
  return base.every((segment, index) => {
    const other = target[index] as string;
    return fold ? segment.toLowerCase() === other.toLowerCase() : segment === other;
  });
}

/** Path segments, on either platform's separator. See `repo.ts` on why both. */
function segments(path: string): readonly string[] {
  return path.split(/[\\/]/).filter(Boolean);
}
