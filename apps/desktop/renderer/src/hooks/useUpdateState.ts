/**
 * The updater's state, and the three things a person can do about it.
 *
 * Two surfaces render this one fact — the card at the foot of the sidebar and,
 * when the sidebar is hidden, the strip under the header — so the subscription
 * and the channel calls live here rather than in either of them. Neither owns
 * the other, and nothing about an update goes through the app store: it is a
 * fact about the *installation*, there is at most one, and every window is
 * pushed the same one. See {@link UpdateState} for what each phase means.
 */

import { useEffect, useState } from 'react';

import type { ArtemisBridge, UpdateState } from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

/** Nothing to say. Both surfaces render `null` on this. */
export const IDLE_UPDATE: UpdateState = {
  phase: 'idle',
  version: null,
  message: null,
  releaseUrl: null,
  progress: null,
};

/**
 * The updater's channels, or `null` when this window has no bridge at all.
 *
 * A bridgeless window renders `DeadEnd` rather than the app, so in practice
 * this is never null where these surfaces mount — but a button that silently
 * does nothing is worse than one that was never drawn, so the callers check.
 */
export function updaterChannels(): ArtemisBridge['updates'] | null {
  return resolveBridge().bridge?.updates ?? null;
}

/** Subscribe to the updater and report its latest pushed state. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>(IDLE_UPDATE);

  useEffect(() => {
    const updates = updaterChannels();
    if (updates === null) return undefined;
    // Subscribe before the initial read, and let any push beat the read: the
    // read answers with the state at *dispatch* time, so if a push lands while
    // it is in flight, the read's resolution is the stale one. Without the
    // flag, an offer arriving in that window would be silently overwritten by
    // an idle answer.
    let pushed = false;
    const unsubscribe = updates.onChange((next) => {
      pushed = true;
      setState(next);
    });
    void call(() => updates.state({})).then((result) => {
      if (result.ok && !pushed) setState(result.value.state);
    });
    return unsubscribe;
  }, []);

  return state;
}

/** Download and install the offered version. */
export function installUpdate(): void {
  const updates = updaterChannels();
  if (updates !== null) void call(() => updates.install({}));
}

/** Relaunch into the version already staged on disk. */
export function restartForUpdate(): void {
  const updates = updaterChannels();
  if (updates !== null) void call(() => updates.restart({}));
}

/**
 * Silence one version.
 *
 * Named rather than "whatever is showing" — see {@link UpdatesDismissRequest} —
 * so a dismiss racing a fresh offer can only ever quiet the version the surface
 * the user clicked was actually displaying.
 */
export function dismissUpdate(version: string): void {
  const updates = updaterChannels();
  if (updates !== null) void call(() => updates.dismiss({ version }));
}
