/**
 * The two bridge calls the sidebar is built on.
 * ============================================================================
 *
 * Both arrived with this layout and both are now first-class on `ApolloBridge`:
 *
 *  - `sessions.listAll` — every profile's history, in every project it has run
 *    in, in one call. The sidebar groups by `cwd` and labels by `profileId`,
 *    and both fields are already on every entry.
 *  - `workspace.pickDirectory` — the OS's own folder chooser, so "set working
 *    directory" is not a typed path that fails as an `ENOENT` from `spawn`
 *    twenty seconds later.
 *
 * This module exists because neither call is used raw. Each has one behaviour
 * the call sites must not get wrong, and putting that behaviour here means it
 * is written once:
 *
 * ## `listAll` degrades rather than disappears
 *
 * A packaged build whose preload predates the channel would leave
 * `sessions.listAll` undefined. That is not a hypothetical worth a crash and it
 * is not one worth silence either — the fallback lists the *current directory*
 * with `sessions.list` and reports `scope: 'cwd'`, which the sidebar renders as
 * a sentence saying other projects are not enumerated. A partial history must
 * never be presented as a complete one.
 *
 * ## Cancelling the picker is a success
 *
 * `pickDirectory` resolves `{ ok: true, value: { path: null } }` when the user
 * closes the dialog. Reading that as a failure would flash an error every time
 * someone changed their mind, so cancellation gets its own status and no copy.
 */

import type { ProfileId, ProviderId, SessionSummary } from '@rx-apollo/protocol';
import { call, resolveBridge } from './bridge';

/* -------------------------------------------------------------------------- */
/* Aggregated session listing                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which directories a listing covers.
 *
 * `'all'` — every project, from every profile.
 * `'cwd'` — the current directory only, because the aggregated channel is not
 *           in this build. The sidebar says so out loud.
 */
export type SessionScope = 'all' | 'cwd';

export interface SessionListing {
  readonly sessions: readonly SessionSummary[];
  readonly scope: SessionScope;
  /** True when the provider has more history than the page that came back. */
  readonly hasMore: boolean;
  /** Set only when the listing genuinely failed. */
  readonly error?: string;
}

const EMPTY: SessionListing = { sessions: [], scope: 'cwd', hasMore: false };

export interface ListSessionsParams {
  readonly providerId: ProviderId;
  readonly profileId: ProfileId | null;
  readonly cwd: string;
  /**
   * Page size, applied after every profile's sessions are merged and sorted.
   *
   * The contract allows omitting this for "everything", and the sidebar could
   * render everything — it is virtualised. A bound is kept anyway because the
   * whole page crosses IPC as one structured clone, and a five-year history is
   * megabytes of payload for rows nobody will scroll to. `hasMore` comes back
   * with the page, and the sidebar says when it is truncated.
   */
  readonly limit: number;
}

/**
 * Every session, from every project.
 *
 * Never loops `sessions.list` over directories: the renderer does not know what
 * directories exist, so that would be both incomplete and O(projects) round
 * trips. Either the aggregated channel answers, or the answer is scoped to the
 * current directory and labelled as such.
 */
export async function listSessionsEverywhere(
  params: ListSessionsParams,
): Promise<SessionListing> {
  const { bridge } = resolveBridge();
  if (!bridge) return EMPTY;

  if (typeof bridge.sessions.listAll === 'function') {
    const result = await call(() =>
      bridge.sessions.listAll({ providerId: params.providerId, limit: params.limit }),
    );
    if (result.ok) {
      return { sessions: result.value.sessions, scope: 'all', hasMore: result.value.hasMore };
    }
    return {
      sessions: [],
      scope: 'all',
      hasMore: false,
      // The backend's own sentence. A paraphrase would lose the cause, which is
      // the only part of a failure worth reading.
      error: result.error.message,
    };
  }

  return listCurrentDirectory(params);
}

async function listCurrentDirectory(params: ListSessionsParams): Promise<SessionListing> {
  const { bridge } = resolveBridge();
  if (!bridge || !params.profileId || params.cwd.trim().length === 0) return EMPTY;

  const profileId = params.profileId;
  const result = await call(() =>
    bridge.sessions.list({
      providerId: params.providerId,
      profileId,
      cwd: params.cwd,
      limit: params.limit,
    }),
  );
  if (!result.ok) {
    return { sessions: [], scope: 'cwd', hasMore: false, error: result.error.message };
  }
  return { sessions: result.value.sessions, scope: 'cwd', hasMore: result.value.hasMore };
}

/* -------------------------------------------------------------------------- */
/* Native directory picker                                                    */
/* -------------------------------------------------------------------------- */

export type DirectoryChoice =
  /** The user picked one. Absolute, and verified to exist by the main process. */
  | { readonly status: 'chosen'; readonly path: string }
  /** The user closed the dialog. Not an error; say nothing. */
  | { readonly status: 'cancelled' }
  /** There is no picker in this build. The text field is the way in. */
  | { readonly status: 'unavailable'; readonly message: string }
  /** The picker exists and refused. `message` is the backend's own words. */
  | { readonly status: 'failed'; readonly message: string };

export const NO_PICKER_REASON =
  'This build has no native folder picker, so the path has to be typed or pasted. The renderer cannot browse the filesystem itself.';

export function hasNativeDirectoryPicker(): boolean {
  const { bridge } = resolveBridge();
  return typeof bridge?.workspace?.pickDirectory === 'function';
}

/**
 * Open the host's folder chooser.
 *
 * `defaultPath` is where the dialog opens. The contract says a path that no
 * longer exists is ignored by the OS, so passing the current directory is
 * always safe and saves the user re-navigating to where they already were.
 */
export async function pickDirectory(defaultPath: string): Promise<DirectoryChoice> {
  const { bridge } = resolveBridge();
  if (typeof bridge?.workspace?.pickDirectory !== 'function') {
    return { status: 'unavailable', message: NO_PICKER_REASON };
  }

  const trimmed = defaultPath.trim();
  const result = await call(() =>
    bridge.workspace.pickDirectory(trimmed.length > 0 ? { defaultPath: trimmed } : {}),
  );
  if (!result.ok) return { status: 'failed', message: result.error.message };

  const path = result.value.path;
  return path === null ? { status: 'cancelled' } : { status: 'chosen', path };
}
