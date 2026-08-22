/**
 * Routines, as one hook.
 *
 * Kept out of the app store for `useServerState`'s reason, verbatim: this is a
 * fact about the installation, there is at most one of it, every window is
 * pushed the same one, and the pane is the only surface that renders most of
 * it. Unlike the server there is no traffic counter to poll — every change,
 * firings included, arrives on the push — so this is subscribe-plus-one-read
 * and nothing else.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ArtemisBridge,
  RoutineDraft,
  RoutineId,
  RoutinePatch,
  RoutinesState,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

/** Before main has answered: no routines, which is a fresh install's truth. */
export const NO_ROUTINES: RoutinesState = { routines: [] };

/** The routines channels, or `null` in a window with no bridge at all. */
function routineChannels(): ArtemisBridge['routines'] | null {
  return resolveBridge().bridge?.routines ?? null;
}

export interface RoutinesPane {
  readonly state: RoutinesState;
  /** A create/edit/delete call is in flight. */
  readonly busy: boolean;

  create(draft: RoutineDraft): void;
  update(id: RoutineId, patch: RoutinePatch): void;
  remove(id: RoutineId): void;
  runNow(id: RoutineId): void;
}

export function useRoutines(): RoutinesPane {
  const [state, setState] = useState<RoutinesState>(NO_ROUTINES);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const routines = routineChannels();
    if (routines === null) return undefined;

    // Subscribe before the first read and let a push win it — the same race
    // `useServerState` documents: the read answers with dispatch-time state,
    // and a firing that lands while it is in flight must not be overwritten.
    let pushed = false;
    const unsubscribe = routines.onChange((next) => {
      pushed = true;
      setState(next);
    });

    void call(() => routines.list({})).then((result) => {
      if (result.ok && !pushed && mounted.current) setState(result.value.state);
    });

    return unsubscribe;
  }, []);

  /** Run one mutation, holding `busy` across it so the form settles once. */
  const run = useCallback(
    (operation: (routines: ArtemisBridge['routines']) => Promise<unknown>) => {
      const routines = routineChannels();
      if (routines === null) return;
      setBusy(true);
      void Promise.resolve(operation(routines)).finally(() => {
        if (mounted.current) setBusy(false);
      });
    },
    [],
  );

  return {
    state,
    busy,

    create: useCallback(
      (draft) => {
        run((routines) =>
          call(() => routines.create({ draft })).then((r) => r.ok && setState(r.value.state)),
        );
      },
      [run],
    ),

    update: useCallback(
      (id, patch) => {
        run((routines) =>
          call(() => routines.update({ id, patch })).then((r) => r.ok && setState(r.value.state)),
        );
      },
      [run],
    ),

    remove: useCallback(
      (id) => {
        run((routines) =>
          call(() => routines.remove({ id })).then((r) => r.ok && setState(r.value.state)),
        );
      },
      [run],
    ),

    runNow: useCallback(
      (id) => {
        run((routines) =>
          call(() => routines.runNow({ id })).then((r) => r.ok && setState(r.value.state)),
        );
      },
      [run],
    ),
  };
}
