/**
 * Where a turn actually runs, on this disk.
 * ============================================================================
 *
 * A connection names a {@link ServerWorkspace}; a turn needs a real path. This
 * module is the whole of that translation, and it exists as its own file
 * because two of the three kinds need something to *happen* — a directory
 * created, and later removed — and the code that creates directories on a
 * user's machine should be readable in one place.
 *
 * ---------------------------------------------------------------------------
 * WHAT `ephemeral` HAS TO GET RIGHT
 * ---------------------------------------------------------------------------
 *
 * **It has to survive a conversation.** A turn that writes `notes.md` and a
 * follow-up that reads it are one conversation, and a fresh directory between
 * them makes the agent's own work vanish mid-thought. So a scratch directory is
 * keyed by session, not by turn, whenever `perSession` is on.
 *
 * **It has to be cleaned up, including after a crash.** Directories are removed
 * when their session is released and again when the server stops — but a
 * process that is killed does neither, and the leftovers are not the OS's to
 * collect on macOS or Linux, where `/tmp` survives until reboot at best. So
 * {@link sweepStaleWorkspaces} runs at startup and removes anything older than
 * a day from a previous life.
 *
 * **It must not collide.** Two connections, two sessions, or two Artemis
 * installations sharing a temp directory must never land in the same folder:
 * one agent's `rm -rf build` would take out another's work. Every path carries
 * a random component for exactly that reason, and `mkdtemp` is what provides it
 * — an id derived from the session would be predictable, and predictable is
 * enough for a hostile local process to plant a symlink first.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not confine the agent. A scratch directory is where a turn *starts*,
 * not a boundary it cannot cross — an agent with a shell can `cd` anywhere the
 * user can. Confinement is the provider's own permission modes and, for the
 * local providers, `ProviderDescriptor.sandbox`. Saying otherwise would be a
 * safety claim this codebase does not make elsewhere and will not make here.
 */

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerWorkspace } from '@rx-artemis/protocol';

/**
 * The directory scratch workspaces live under, inside the OS temp directory.
 *
 * A named parent rather than loose `mkdtemp` calls at the top level, so that a
 * sweep can tell Artemis's leftovers from every other program's — deleting a
 * day-old temp directory that belonged to someone else would be this module
 * doing real damage.
 */
export const SCRATCH_ROOT_NAME = 'artemis-server-workspaces';

/** How old a leftover must be before a startup sweep removes it. */
export const STALE_WORKSPACE_MS = 24 * 60 * 60_000;

/** A resolved place for a turn to run. */
export interface ResolvedWorkspace {
  /** Absolute path the turn runs in. */
  readonly path: string;
  /** True when this directory is Artemis's to delete afterwards. */
  readonly ephemeral: boolean;
}

/** A connection cannot run turns at all. See `ServerWorkspace`'s `none`. */
export class WorkspaceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceUnavailableError';
  }
}

export interface WorkspaceResolverOptions {
  /** Where scratch directories are made. Defaults to the OS temp directory. */
  readonly root?: string;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface WorkspaceResolver {
  /**
   * The directory this turn runs in, creating a scratch one if needed.
   *
   * @throws {WorkspaceUnavailableError} for a `none` workspace, or a `directory`
   *   that has stopped existing — a turn pointed at a folder the user has since
   *   deleted must fail loudly rather than run somewhere else.
   */
  resolve(input: {
    readonly connectionId: string;
    readonly workspace: ServerWorkspace;
    /** The conversation, when there is one. Absent means a one-off turn. */
    readonly sessionId?: string;
  }): Promise<ResolvedWorkspace>;

  /**
   * Drop the scratch directory held for a session, if any.
   *
   * Called when a conversation ends. Safe to call for a session that never had
   * one, and safe to call twice.
   */
  release(sessionId: string): Promise<void>;

  /** Remove every scratch directory this resolver made. For server shutdown. */
  disposeAll(): Promise<void>;
}

export function createWorkspaceResolver(
  options: WorkspaceResolverOptions = {},
): WorkspaceResolver {
  const root = options.root ?? join(tmpdir(), SCRATCH_ROOT_NAME);

  /** Session id → the scratch directory it is using. */
  const bySession = new Map<string, string>();
  /** Every directory this resolver created, so shutdown can remove them all. */
  const created = new Set<string>();

  /**
   * Make one scratch directory.
   *
   * `mkdtemp` rather than a composed name: it creates *and* claims the
   * directory in one syscall with a random suffix, so there is no window in
   * which a local process could predict the path and get there first with a
   * symlink. `0o700` because what an agent writes here is the user's work.
   */
  async function makeScratch(connectionId: string): Promise<string> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // The connection id is a prefix rather than the whole name: useful when
    // looking at `/tmp` to see which connection left something behind, and not
    // relied on for uniqueness, which `mkdtemp` provides.
    const path = await mkdtemp(join(root, `${safePrefix(connectionId)}-`));
    created.add(path);
    return path;
  }

  return {
    async resolve({ connectionId, workspace, sessionId }) {
      switch (workspace.kind) {
        case 'none':
          throw new WorkspaceUnavailableError(
            'This connection is catalogue-only and cannot run turns. Create one with a workspace in Settings → Server.',
          );

        case 'directory': {
          // Checked every time rather than trusted from creation: the folder
          // was chosen once and may have been moved, renamed or deleted since,
          // and a turn that silently ran somewhere else would be worse than one
          // that failed.
          const usable = await stat(workspace.path).then(
            (entry) => entry.isDirectory(),
            () => false,
          );
          if (!usable) {
            throw new WorkspaceUnavailableError(
              `This connection's folder is gone: ${workspace.path}. Re-create the connection against a folder that exists.`,
            );
          }
          return { path: workspace.path, ephemeral: false };
        }

        case 'ephemeral': {
          // No session, or `perSession` off: a directory of its own, and the
          // caller releases it when the turn ends.
          if (sessionId === undefined || workspace.perSession === false) {
            return { path: await makeScratch(connectionId), ephemeral: true };
          }

          const existing = bySession.get(sessionId);
          if (existing !== undefined) return { path: existing, ephemeral: true };

          const path = await makeScratch(connectionId);
          bySession.set(sessionId, path);
          return { path, ephemeral: true };
        }
      }
    },

    async release(sessionId) {
      const path = bySession.get(sessionId);
      if (path === undefined) return;
      bySession.delete(sessionId);
      created.delete(path);
      await removeQuietly(path);
    },

    async disposeAll() {
      const paths = [...created];
      created.clear();
      bySession.clear();
      // Concurrently, and never rejecting: this runs on the way out, and one
      // stubborn directory must not stop the others being removed.
      await Promise.all(paths.map(removeQuietly));
    },
  };
}

/**
 * Remove scratch directories left behind by a previous run.
 *
 * A process that is killed releases nothing, and on macOS and Linux `/tmp`
 * outlives the process by a long way — so without this, every hard quit leaks a
 * directory until the machine reboots. Only Artemis's own root is touched, and
 * only entries older than {@link STALE_WORKSPACE_MS}: a *running* second
 * Artemis may own the recent ones, and deleting a live agent's working
 * directory out from under it is the one failure this sweep could cause.
 *
 * Never throws. A sweep that cannot run is a leaked temp directory, which is
 * not a reason to fail a launch.
 */
export async function sweepStaleWorkspaces(
  options: { readonly root?: string; readonly now?: () => number } = {},
): Promise<number> {
  const root = options.root ?? join(tmpdir(), SCRATCH_ROOT_NAME);
  const now = options.now ?? (() => Date.now());

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // No root yet, which is the ordinary state before the first scratch turn.
    return 0;
  }

  let removed = 0;
  await Promise.all(
    entries.map(async (name) => {
      const path = join(root, name);
      try {
        const entry = await stat(path);
        if (!entry.isDirectory()) return;
        if (now() - entry.mtimeMs < STALE_WORKSPACE_MS) return;
        await rm(path, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Racing another sweep, or a directory we cannot read. Either way it is
        // not this function's business to complain.
      }
    }),
  );

  return removed;
}

/** Never rejects: teardown paths must not fail on a directory that is already gone. */
async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * A connection id, reduced to something safe to put in a filename.
 *
 * Ids are base64url, which contains `-` and `_` and is already filename-safe —
 * but this is defence against a *future* id format rather than the current one,
 * and a path built from an unfiltered identifier is how directory traversal
 * starts.
 */
function safePrefix(connectionId: string): string {
  return connectionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'conn';
}
