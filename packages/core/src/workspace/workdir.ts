/**
 * Is this working directory actually usable?
 *
 * ## Why this module exists
 *
 * Every agentic CLI Apollo drives is ultimately a subprocess, and Node's
 * `child_process.spawn` raises **`ENOENT` when the `cwd` is bad**, not when the
 * executable is missing. The two failures are indistinguishable from the errno
 * alone, and at least one provider SDK guesses wrong: given a perfectly healthy
 * binary and a `cwd` that does not exist, the Claude Agent SDK reports
 *
 * > `Claude Code native binary at <path> exists but failed to launch. This
 * > usually means the binary does not match this system's libc …`
 *
 * — a libc diagnostic, on macOS, about a directory typo. Verified directly:
 *
 * ```
 * spawn(bin, ['--version'], { cwd: '/Users/atlas/apollo' })  → status 0
 * spawn(bin, ['--version'], { cwd: '/does/not/exist' })     → ENOENT
 * spawn(bin, ['--version'], { cwd: 'relative/path' })       → ENOENT
 * spawn(bin, ['--version'], { cwd: valid, env: {} })        → status 0
 * ```
 *
 * The last line matters: an *empty* environment still launches, so environment
 * composition is not implicated and the cwd is the whole story.
 *
 * So the fix is to never let a bad directory reach `spawn`. This module answers
 * the question once, in one place, with a message a person can act on, and the
 * run registry asks it before an adapter is ever handed the input.
 *
 * ## Why it lives in `@apollo/core` and not in `@apollo/protocol`
 *
 * It touches the filesystem. Protocol has zero dependencies and does no I/O —
 * it is loaded in the renderer's browser sandbox, where `node:fs` does not
 * exist. Core is headless but is a Node library, so a `stat` here is fine.
 *
 * ## Deliberately a check, not a throw
 *
 * {@link checkWorkingDirectory} returns a result instead of throwing, because
 * three different callers need three different error types out of the same
 * answer: the run registry raises a `RunError`, the Electron main process
 * raises its own IPC error, and the Claude adapter turns it into an
 * `AgentError` on an already-failing run. A shared thrown class would force all
 * three to agree on an exception hierarchy they otherwise have no reason to
 * share.
 */

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * Why a path cannot be used as a working directory.
 *
 * Kept small and *distinguishable*: the UI wants to say something different for
 * each one ("that folder does not exist" invites a retry, "Apollo cannot read
 * that folder" invites a permissions fix), which is exactly what the libc
 * message failed to do.
 *
 * - `not_absolute`    — relative, empty, or not a string at all.
 * - `does_not_exist`  — nothing is there (`ENOENT`).
 * - `not_a_directory` — something is there, but it is a file, or a path
 *                       component of it is (`ENOTDIR`).
 * - `not_readable`    — it exists and is a directory, but this process cannot
 *                       read or enter it, or the check itself failed.
 */
export type WorkingDirectoryProblem =
  | 'not_absolute'
  | 'does_not_exist'
  | 'not_a_directory'
  | 'not_readable';

/** A directory that exists, is a directory, and can be read and entered. */
export interface UsableWorkingDirectory {
  readonly ok: true;
  /** The path as given. Not normalised — the caller's string is what gets spawned. */
  readonly path: string;
}

/** A path that cannot be used as a working directory, and why. */
export interface UnusableWorkingDirectory {
  readonly ok: false;
  readonly path: string;
  readonly problem: WorkingDirectoryProblem;
  /**
   * A complete, human-readable sentence naming the path. Safe to show to a
   * user verbatim and safe to put in an `AgentError.message`: it contains a
   * filesystem path and nothing else.
   */
  readonly message: string;
  /** The underlying errno (`ENOENT`, `EACCES`, …) when the filesystem gave one. */
  readonly errno?: string;
}

/** The answer from {@link checkWorkingDirectory}. Narrow on `ok`. */
export type WorkingDirectoryCheck = UsableWorkingDirectory | UnusableWorkingDirectory;

/**
 * A directory needs both read (`R_OK`) and search (`X_OK`) permission to be a
 * usable cwd: read to list it, search to enter it. Checking only `R_OK` would
 * pass a directory that `spawn` then fails to `chdir` into.
 */
const DIRECTORY_ACCESS = constants.R_OK | constants.X_OK;

/**
 * Decide whether `cwd` can be a working directory.
 *
 * Four checks, in the order that produces the most specific message:
 * absoluteness (no I/O), existence, directory-ness, then readability.
 * Symlinks are followed, because `spawn` follows them too — the question is
 * always "what will the child process get?", never "what is written here?".
 *
 * Never throws, including for a non-string argument: an unexpected errno
 * degrades to `not_readable` with the code in the message rather than escaping
 * as an exception, because every caller is already on a path where it would
 * have to catch it again.
 *
 * @param cwd the candidate path. Typed `unknown` so a value that has crossed
 *            IPC can be checked without being cast first.
 */
export async function checkWorkingDirectory(cwd: unknown): Promise<WorkingDirectoryCheck> {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return {
      ok: false,
      path: typeof cwd === 'string' ? cwd : '',
      problem: 'not_absolute',
      message:
        'No working directory was given. Choose the folder the agent should work in — Apollo needs a full path such as /Users/you/projects/app.',
    };
  }

  if (!isAbsolute(cwd)) {
    return {
      ok: false,
      path: cwd,
      problem: 'not_absolute',
      message: `That working directory is not a full path: ${cwd}. Enter an absolute path such as /Users/you/projects/app.`,
    };
  }

  let stats;
  try {
    stats = await stat(cwd);
  } catch (error) {
    const errno = errnoOf(error);
    switch (errno) {
      case 'ENOENT':
        return {
          ok: false,
          path: cwd,
          problem: 'does_not_exist',
          message: `That directory does not exist: ${cwd}`,
          errno,
        };
      case 'ENOTDIR':
        // A component of the path is a file, so the path can never resolve to a
        // directory. "Does not exist" would be true but misleading — the user's
        // mistake is one segment further up.
        return {
          ok: false,
          path: cwd,
          problem: 'not_a_directory',
          message: `That path is not a directory: ${cwd} — part of it is a file.`,
          errno,
        };
      case 'EACCES':
      case 'EPERM':
        return {
          ok: false,
          path: cwd,
          problem: 'not_readable',
          message: `Apollo is not allowed to open that directory: ${cwd}. Check its permissions.`,
          errno,
        };
      default:
        return {
          ok: false,
          path: cwd,
          problem: 'not_readable',
          message: `That directory could not be checked: ${cwd}${errno === undefined ? '' : ` (${errno})`}.`,
          ...(errno === undefined ? {} : { errno }),
        };
    }
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      path: cwd,
      problem: 'not_a_directory',
      message: `That path is not a directory: ${cwd}`,
    };
  }

  try {
    await access(cwd, DIRECTORY_ACCESS);
  } catch (error) {
    const errno = errnoOf(error);
    return {
      ok: false,
      path: cwd,
      problem: 'not_readable',
      message: `Apollo is not allowed to open that directory: ${cwd}. Check its permissions.`,
      ...(errno === undefined ? {} : { errno }),
    };
  }

  return { ok: true, path: cwd };
}

/** The `code` off a Node system error, when it has one. */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
