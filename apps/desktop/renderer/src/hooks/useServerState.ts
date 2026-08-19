/**
 * The local server, as one hook.
 * ============================================================================
 *
 * Everything about the server that the renderer can know lives here, and
 * nothing about it lives in the app store. That follows `useUpdateState`'s
 * reasoning exactly: this is a fact about the *installation*, there is at most
 * one of it, every window is pushed the same one, and no other surface in the
 * app renders it. Putting it in the store would mean a slice that one pane
 * reads and every other subscriber re-renders for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS POLLS AS WELL AS SUBSCRIBES
 * ---------------------------------------------------------------------------
 *
 * The push channel carries phase and configuration changes only — main
 * deliberately does not push on every request, because an editor extension
 * polling `/v1/models` would put an IPC message and a re-render behind each of
 * its requests, forever, in every open window.
 *
 * But "is anything actually talking to this?" is the question the pane exists
 * to answer, and the counters that answer it therefore arrive by *pull*. So the
 * hook polls while it is mounted — which is to say, while the Server pane is on
 * screen — and stops the moment it is not. The cost is one cheap IPC call every
 * few seconds against an open settings dialog; the alternative is a counter
 * that only moves when something unrelated happens.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_SERVER_PORT,
  SERVER_HOST,
  type ArtemisBridge,
  type ServerAllowance,
  type ServerProfile,
  type ServerState,
  type ServerWorkspace,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

/** How often the traffic counters are re-read while the pane is open. */
const TRAFFIC_POLL_MS = 4_000;

/**
 * What the pane shows before main has answered.
 *
 * `stopped` rather than a fourth "unknown" phase: a server this window has not
 * heard from is one it cannot claim is running, the pane's stopped layout is
 * the honest thing to draw, and the real state replaces it within a frame or
 * two. No connections is also the truthful default — a fresh install has none.
 */
export const UNKNOWN_SERVER: ServerState = {
  phase: 'stopped',
  host: SERVER_HOST,
  port: DEFAULT_SERVER_PORT,
  autoStart: false,
  connections: [],
  traffic: { total: 0, rejected: 0 },
};

/** The server's channels, or `null` in a window with no bridge at all. */
function serverChannels(): ArtemisBridge['server'] | null {
  return resolveBridge().bridge?.server ?? null;
}

export interface ServerPane {
  readonly state: ServerState;
  /** A lifecycle call is in flight. Binds and rebinds are not instant. */
  readonly busy: boolean;
  /** The catalogue this server publishes, or `null` before the first read. */
  readonly catalogue: readonly ServerProfile[] | null;
  /** A catalogue read is in flight. The first one spawns a CLI per account. */
  readonly loadingCatalogue: boolean;
  /** Why the last catalogue read failed, or `null`. */
  readonly catalogueError: string | null;

  start(): void;
  stop(): void;
  configure(change: { readonly port?: number; readonly autoStart?: boolean }): void;
  createConnection(draft: {
    readonly label: string;
    readonly workspace: ServerWorkspace;
    readonly allow?: readonly ServerAllowance[];
  }): void;
  renameConnection(id: string, label: string): void;
  deleteConnection(id: string): void;
  /** Re-read the catalogue. `refresh` re-asks every provider and is slow. */
  reloadCatalogue(options?: { readonly refresh?: boolean }): void;
}

export function useServerState(): ServerPane {
  const [state, setState] = useState<ServerState>(UNKNOWN_SERVER);
  const [busy, setBusy] = useState(false);
  const [catalogue, setCatalogue] = useState<readonly ServerProfile[] | null>(null);
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);

  /*
   * A generation counter, so a slow refresh cannot overwrite a fast one.
   *
   * `refresh: true` takes seconds — it spawns a subprocess per account — and a
   * user who clicks Refresh twice would otherwise see the first answer land
   * after the second. Same discipline `refreshModels` keeps in the store.
   */
  const catalogueRequest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const server = serverChannels();
    if (server === null) return undefined;

    // Subscribe before the first read, and let a push win it: the read answers
    // with the state at dispatch time, so a start that lands while it is in
    // flight would otherwise be overwritten by a stale "stopped".
    let pushed = false;
    const unsubscribe = server.onChange((next) => {
      pushed = true;
      setState(next);
    });

    void call(() => server.status({})).then((result) => {
      if (result.ok && !pushed) setState(result.value.state);
    });

    // The traffic pull. See the file comment for why this is not a push.
    const timer = setInterval(() => {
      void call(() => server.status({})).then((result) => {
        if (result.ok && mounted.current) setState(result.value.state);
      });
    }, TRAFFIC_POLL_MS);

    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const reloadCatalogue = useCallback((options?: { readonly refresh?: boolean }) => {
    const server = serverChannels();
    if (server === null) return;

    const generation = catalogueRequest.current + 1;
    catalogueRequest.current = generation;
    setLoadingCatalogue(true);

    void call(() => server.catalogue(options?.refresh === true ? { refresh: true } : {})).then(
      (result) => {
        if (generation !== catalogueRequest.current || !mounted.current) return;
        setLoadingCatalogue(false);
        if (result.ok) {
          setCatalogue(result.value.profiles);
          setCatalogueError(null);
          return;
        }
        // The previous catalogue is kept rather than cleared, for the reason
        // `refreshModels` keeps its list: a transient failure that emptied the
        // table would replace something true with a "nothing is published"
        // state that is not.
        setCatalogueError(result.error.message);
      },
    );
  }, []);

  // Read once on mount. Not on every state change: a start or a token rotation
  // does not alter what is published, and the read is expensive when cold.
  useEffect(() => {
    reloadCatalogue();
  }, [reloadCatalogue]);

  /** Run a lifecycle call, holding `busy` across it so the buttons settle once. */
  const run = useCallback(
    (operation: (server: ArtemisBridge['server']) => Promise<unknown>) => {
      const server = serverChannels();
      if (server === null) return;
      setBusy(true);
      void Promise.resolve(operation(server)).finally(() => {
        if (mounted.current) setBusy(false);
      });
    },
    [],
  );

  return {
    state,
    busy,
    catalogue,
    loadingCatalogue,
    catalogueError,

    start: useCallback(() => {
      run((server) => call(() => server.start({})).then((r) => r.ok && setState(r.value.state)));
    }, [run]),

    stop: useCallback(() => {
      run((server) => call(() => server.stop({})).then((r) => r.ok && setState(r.value.state)));
    }, [run]),

    configure: useCallback(
      (change) => {
        run((server) =>
          call(() => server.configure(change)).then((r) => r.ok && setState(r.value.state)),
        );
      },
      [run],
    ),

    createConnection: useCallback(
      (draft) => {
        run((server) =>
          call(() => server.createConnection(draft)).then((r) => r.ok && setState(r.value.state)),
        );
      },
      [run],
    ),

    renameConnection: useCallback(
      (id, label) => {
        run((server) =>
          call(() => server.renameConnection({ id, label })).then(
            (r) => r.ok && setState(r.value.state),
          ),
        );
      },
      [run],
    ),

    deleteConnection: useCallback(
      (id) => {
        run((server) =>
          call(() => server.deleteConnection({ id })).then((r) => r.ok && setState(r.value.state)),
        );
      },
      [run],
    ),

    reloadCatalogue,
  };
}
