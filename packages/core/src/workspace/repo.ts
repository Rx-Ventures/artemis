/**
 * What is this directory called?
 *
 * ## Why the answer is not `basename(cwd)`
 *
 * The sidebar names the thing you are working on. For a directory that sits
 * inside a repository, the name of that thing is the repository's: in
 * `~/code/apollo/apps/desktop` you are working on *apollo*, and "desktop" is
 * the answer to a question nobody asked. Both names are here, and the caller
 * picks — {@link WorkspaceDescription.repoName} when there is one, otherwise
 * {@link WorkspaceDescription.name}.
 *
 * ## Why it does not shell out to git
 *
 * `git rev-parse --show-toplevel` is the obvious implementation and the wrong
 * one for something a UI calls on every directory change. It needs `git` on the
 * PATH — which is not guaranteed for a GUI app on macOS, where the process
 * environment is the launchd one rather than the shell's — it costs a process
 * spawn per keystroke-adjacent event, and it fails in ways that would have to
 * be told apart from "not a repository".
 *
 * Walking up looking for `.git` needs none of that. It is a handful of `stat`
 * calls, it cannot fail in a way worth reporting, and it agrees with git on
 * every layout Apollo can encounter:
 *
 *  - **A normal clone** has `.git/` at the root.
 *  - **A linked worktree** has a `.git` *file* at its root holding a `gitdir:`
 *    pointer. Both are accepted, because both mark a root — and a worktree
 *    deliberately reports its own name rather than the main checkout's. Two
 *    worktrees of one repository are two different places to be working, and
 *    the sidebar is naming a place; collapsing them to a shared repository name
 *    would make the two indistinguishable in the one view whose job is telling
 *    you where you are.
 *  - **Submodules** likewise have a `.git` file, and likewise are their own
 *    thing to be working in.
 *
 * The one case it gets wrong is a bare repository pointed at by `GIT_DIR`, with
 * no `.git` anywhere above the cwd. Nobody runs an agent in one.
 *
 * ## Never throws
 *
 * A missing, unreadable, or nonsense path yields a description with no repo
 * rather than an error. The caller is a header label; the degraded answer is
 * "the directory's own name", which is what it showed before this module
 * existed. {@link checkWorkingDirectory} is the module that has opinions about
 * whether a path is usable, and it stays the only one.
 */

import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';

/** Names for one directory. See the module docs for which to prefer. */
export interface WorkspaceDescription {
  /** The path as asked about. */
  readonly path: string;
  /** The directory's own name — its last segment. */
  readonly name: string;
  /** Root of the repository containing `path`, when there is one. */
  readonly repoRoot?: string;
  /** Last segment of {@link repoRoot}. */
  readonly repoName?: string;
}

/**
 * How far up to look for a repository root.
 *
 * A bound rather than a belief about real paths: the loop already terminates at
 * the filesystem root, and this only decides how much work a pathological path
 * can cost. Deep monorepo checkouts run to a dozen segments, so 64 is far past
 * anything real and still finite.
 */
const MAX_ASCENT = 64;

/**
 * Describe `path`: its own name, and its repository's if it is in one.
 *
 * @param path an absolute path. A relative one is described by name only —
 *             resolving it against *this* process's cwd would answer about a
 *             directory the user never named.
 */
export async function describeWorkspace(path: unknown): Promise<WorkspaceDescription> {
  const value = typeof path === 'string' ? path.trim() : '';
  const name = lastSegment(value);
  if (value.length === 0 || !isAbsolute(value)) return { path: value, name };

  const repoRoot = await findRepositoryRoot(value);
  if (repoRoot === undefined) return { path: value, name };

  return { path: value, name, repoRoot, repoName: lastSegment(repoRoot) };
}

/**
 * The nearest ancestor of `from` (inclusive) containing a `.git` entry.
 *
 * Ascends by `dirname` and stops when it stops moving, which is how a path
 * hits its root on both POSIX (`/`) and Windows (`C:\`, and a UNC share root)
 * without either being spelled out here.
 */
async function findRepositoryRoot(from: string): Promise<string | undefined> {
  const { root } = parse(from);
  let current = from;

  for (let step = 0; step < MAX_ASCENT; step += 1) {
    // Either kind of `.git` marks a root: a directory in a normal clone, a
    // file in a linked worktree or a submodule.
    if (await exists(join(current, '.git'))) return current;
    if (current === root) return undefined;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Does anything exist at this path? Any failure reads as "no". */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Last segment of a path.
 *
 * Not `node:path.basename`: that is platform-specific, and a profile or session
 * recorded on one platform is routinely read on another — `basename` on POSIX
 * returns the whole of `C:\Users\you\app`. Splitting on both separators is
 * correct for every path either platform can produce. Falls back to the input
 * so a root, or a string with nothing in it, still yields something to render.
 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}
