/**
 * The boundary a tool cannot reach past.
 * ============================================================================
 *
 * Artemis has never executed a tool before. Claude's SDK, Codex's app-server
 * and OpenCode's ACP peer each run their own, inside their own process, and the
 * app's job stops at rendering what happened. For local models there is no such
 * process, so this is the file that decides what a model on your machine is
 * allowed to touch.
 *
 * It is deliberately the smallest possible thing: **one function that answers
 * whether a path is inside the run's root**, plus the machinery to make that
 * answer hard to fool. Everything above it — which tools exist, which need
 * approval — is policy. This is the floor those policies stand on, and a floor
 * with a hole in it makes every policy above it decorative.
 *
 * ## Why `realpath` and not string comparison
 *
 * The obvious implementation compares resolved path strings and is wrong in a
 * way that is easy to miss: a symlink inside the root pointing outside it passes
 * every textual check ever written. `/project/notes -> /Users/you/.ssh` resolves,
 * as a string, to a path under `/project`.
 *
 * So containment is decided on the *real* path — symlinks followed, `..`
 * collapsed by the filesystem rather than by us. A path that does not exist yet
 * is resolved through its nearest existing ancestor, because a tool creating a
 * file must be checked before the file exists and `realpath` cannot resolve
 * something that is not there.
 *
 * ## What this does not claim
 *
 * This is a **filesystem** boundary and nothing more. It does not stop a shell
 * command from opening a socket, spawning a process that outlives the run, or
 * reading a path a *different* process hands it. Those need OS-level
 * confinement, which is platform-specific and belongs in the layer that spawns
 * the command rather than here.
 *
 * Saying so precisely is the point: a security primitive that is vague about
 * its own scope gets trusted for things it never did.
 *
 * ## Time of check, time of use
 *
 * A path checked and then operated on can change in between — the classic race.
 * The mitigation is that callers must operate on {@link SandboxPath.real}, the
 * resolved path this module returns, never on the string the model supplied.
 * Resolving once and using that result closes the window that reopening it
 * would create.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** A path that has been checked, and the resolved form callers must use. */
export interface SandboxPath {
  /** The fully resolved path. **Operate on this**, never on the model's string. */
  readonly real: string;
  /** Where it sits relative to the root, for display and for tool output. */
  readonly relative: string;
}

/** Why a path was refused. The message is shown to the user, so it is plain. */
export class SandboxViolation extends Error {
  readonly attempted: string;
  readonly root: string;

  constructor(attempted: string, root: string, detail: string) {
    super(`Refused: ${detail}`);
    this.name = 'SandboxViolation';
    this.attempted = attempted;
    this.root = root;
  }
}

/**
 * Resolve a path through the nearest ancestor that exists.
 *
 * A tool writing a new file names something that is not there yet, so
 * `realpath` on the full path fails. Walking up to the nearest existing
 * ancestor and resolving *that* gives the same guarantee: if every real
 * ancestor is inside the root, a new leaf beneath one of them is too.
 *
 * The loop is bounded by the path itself — each step removes a segment — so it
 * terminates at the filesystem root in the worst case.
 */
async function resolveThroughExisting(target: string): Promise<string> {
  let probe = target;
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = await realpath(probe);
      return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
    } catch {
      const parent = path.dirname(probe);
      // At the filesystem root and still nothing resolves: hand back the
      // normalised path rather than looping. Containment is then decided on
      // the textual form, which is correct because there are no symlinks left
      // to follow.
      if (parent === probe) return path.resolve(target);
      trailing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Is this path inside the run's root?
 *
 * @param candidate a path from the model — absolute, relative, or hostile
 * @param root the run's working directory, already resolved by the caller
 * @throws {SandboxViolation} when the path resolves outside the root
 */
export async function confine(candidate: string, root: string): Promise<SandboxPath> {
  if (candidate.trim() === '') {
    throw new SandboxViolation(candidate, root, 'an empty path is not a file.');
  }

  // NUL is not a path character and is the classic way to make one string look
  // like two to different layers.
  if (candidate.includes('\0')) {
    throw new SandboxViolation(candidate, root, 'that path contains a null byte.');
  }

  const realRoot = await resolveThroughExisting(root);
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(realRoot, candidate);
  const real = await resolveThroughExisting(absolute);

  // Compared with a trailing separator so `/project-notes` is not read as being
  // inside `/project`. The equality case is the root itself, which is allowed.
  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (real !== realRoot && !real.startsWith(withSep)) {
    throw new SandboxViolation(
      candidate,
      realRoot,
      `that path is outside this run's directory. Tools may only reach ${realRoot}.`,
    );
  }

  const relative = path.relative(realRoot, real);
  return { real, relative: relative === '' ? '.' : relative };
}

/**
 * Environment for a sandboxed command.
 *
 * Strips every variable the run's own environment resolution already refuses to
 * emit, on the reasoning that a tool Artemis spawns must not be a way around
 * the isolation the provider environment enforces. A model that can read
 * `ANTHROPIC_API_KEY` out of its own shell has undone the billing trap the seam
 * exists to make structural.
 *
 * `PATH`, `HOME` and the rest are kept: a shell that cannot find `ls` is not a
 * safer shell, only a broken one.
 */
export function sandboxEnv(
  base: Readonly<Record<string, string | undefined>>,
  scrub: readonly string[],
): Record<string, string> {
  const blocked = new Set(scrub.map((key) => key.toUpperCase()));
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (blocked.has(key.toUpperCase())) continue;
    // Anything credential-shaped by name, whoever set it. The scrub list covers
    // the providers Artemis knows; this covers the ones it does not.
    if (/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS)$/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}
