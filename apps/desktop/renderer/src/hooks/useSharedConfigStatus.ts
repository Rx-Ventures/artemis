/**
 * What the shared-`~/.claude` script actually did, read on demand.
 *
 * One surface renders this — the Advanced pane — so this could have been a
 * `useState` in that component. It is a hook for the same reason
 * `useUpdateState` is: the read has a lifecycle (in flight, landed, failed) and
 * a re-read, and four pieces of state threaded through a settings pane's body is
 * how a pane starts rendering a stale answer next to a fresh one.
 *
 * **Not in the app store, deliberately.** Everything in `store.ts` is either the
 * user's own preferences or the app's live state, and both are things Artemis
 * owns. This is neither: it is a photograph of somebody else's filesystem, taken
 * once, already out of date by the time it renders. Putting it in the store would
 * invite a component to read `sharedClaudeConfigStatus` and treat it as settled
 * fact — and worse, it would sit next to `sharedClaudeConfig`, the *intention*,
 * where the next person to touch the pane would reasonably assume one should be
 * kept in sync with the other. They must not be. The disagreement between them
 * is the entire point of showing this.
 *
 * ## Read on open, and on a click. Never on a timer.
 *
 * Nothing changes these paths except a script the user runs in a terminal, so
 * there is no event to poll for. A mount reads once; the refresh is there for the
 * one moment it is genuinely needed — the user has just run the script in the
 * other window and wants the pane to agree.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ArtemisBridge, SharedConfigStatus } from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

/** What the pane knows about the disk right now. */
export interface SharedConfigReading {
  /** A read is in flight. True on the first render, before anything is known. */
  readonly reading: boolean;
  /** The last successful reading, or `null` if there has not been one. */
  readonly status: SharedConfigStatus | null;
  /**
   * Why the read failed, already safe to show.
   *
   * Mutually exclusive with {@link status}: a failed re-read clears the previous
   * answer rather than leaving last minute's states on screen under a new error.
   * A display whose whole purpose is to be trusted about the disk cannot show a
   * reading it has just been told it could not take.
   */
  readonly error: string | null;
  /** Read again. Cheap — `lstat` per shared name per profile. */
  readonly refresh: () => void;
}

/**
 * The status channel, or `null` when this window has no bridge at all.
 *
 * A bridgeless window renders `DeadEnd` rather than the app, so in practice this
 * is never null where the pane mounts — but the pane has to render *something*
 * either way, and "could not read" is the honest something.
 */
function statusChannel(): ArtemisBridge['sharedConfig'] | null {
  return resolveBridge().bridge?.sharedConfig ?? null;
}

export function useSharedConfigStatus(): SharedConfigReading {
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState(true);
  const [status, setStatus] = useState<SharedConfigStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const channel = statusChannel();
    if (channel === null) {
      setReading(false);
      setError('This window cannot reach the main process.');
      return undefined;
    }

    let cancelled = false;
    setReading(true);

    void call(() => channel.status({})).then((result) => {
      // The pane is unmounted the moment the user picks another section — see
      // `SectionBody` — so a reading that lands after that has nowhere to go.
      if (cancelled) return;
      setReading(false);
      setStatus(result.ok ? result.value : null);
      setError(result.ok ? null : result.error.message);
    });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  return { reading, status, error, refresh };
}
