/**
 * Shells on the serving machine, reachable from a remote window (ADR 0004).
 * ============================================================================
 *
 * The ADR puts remote terminals in scope with one sentence of architecture —
 * "PTY bytes ride the event stream; rendering is local xterm" — and that
 * sentence is the whole design. Nothing here draws anything. A remote window
 * runs the same xterm it always ran, in the same dock, against a shell whose
 * process lives on another machine; the wire carries the bytes the PTY emitted
 * and the keystrokes typed at it, and that is all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS, AND WHAT IT REFUSES TO OWN
 * ---------------------------------------------------------------------------
 *
 * The desktop's terminal host states three containment rules — main picks the
 * program, main owns the ids, main owns the lifetime — and the reason they are
 * *facts* rather than policy is that the renderer has no way to express a
 * violation. This surface must not become that way. So it is deliberately a
 * router over a {@link TerminalSource} and never a spawner:
 *
 *  - **The serving side picks the shell.** {@link TerminalSource.start} takes a
 *    directory and a size. There is no argv on this wire, no environment, no
 *    binary name — a remote client cannot ask for `bash -c` any more than the
 *    local renderer can, and the environment (including the
 *    `CLAUDE_CONFIG_DIR`/`CODEX_HOME` strip that keeps a shell from inheriting
 *    whichever account the sidebar happens to be reading) is composed on the
 *    serving machine by the code that spawns.
 *  - **The serving side owns the ids.** Every id in every route is resolved
 *    against {@link owners} below, which only {@link start} writes to. An id
 *    nobody was handed matches nothing, and — the remote-specific half — an id
 *    handed to *another connection family* matches nothing either.
 *  - **The serving side owns the lifetime.** The only route that ends a shell
 *    is `close`, which is the ✕ and nothing else. Losing the event stream does
 *    not kill a terminal, and must not: a remote window is a view onto a
 *    process, and a `pnpm dev` should survive a laptop lid exactly as it
 *    survives its pane going away locally.
 *
 * ---------------------------------------------------------------------------
 * WHO CAN SEE A SHELL
 * ---------------------------------------------------------------------------
 *
 * By the connection's *workspace key*, which is the ledger's own rule — see
 * `workspaceKeyFor`. Two tokens pinned to the same directory are one person at
 * two desks and share what they opened; a scratch-pinned token is keyed to
 * itself and shares with nobody.
 *
 * The serving machine's *own* window is not in any family, and its terminals
 * are therefore invisible here. That is the important direction: the local user
 * has shells open with their own history in them, and a remote token — even one
 * the same person minted — has no business reading the scrollback of a session
 * it did not start. Locally started terminals are unknown ids to this file, and
 * unknown ids are refused with the same 404 an absent one gets.
 */

import type { ServerConnection, TerminalEvent, TerminalInfo } from '@rx-artemis/protocol';

import type { PushFeed } from './feed.js';
import { workspaceKeyFor } from './ledger.js';

/**
 * The host's shell registry, reduced to what the routes need.
 *
 * The same narrowing discipline `RunSource` and `SessionSource` keep: this
 * holds no `list`, because listing is answered from {@link owners} and a host's
 * full list includes the local window's shells; and no `subscribe`, because the
 * host does the subscribing and hands events to {@link RemoteTerminals.observe}.
 */
export interface TerminalSource {
  /**
   * Open a shell. The host chooses the program and composes the environment.
   *
   * `cwd` has already been confined to the connection's pin by the caller.
   */
  start(request: {
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
  }): Promise<TerminalInfo>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** End the shell. Reached only from the ✕ — see the file comment. */
  close(id: string): void;
  /** The retained tail, for a window that reloaded or has just attached. */
  replay(id: string): { readonly data: string; readonly truncated: boolean };
  /** True for an id the host issued and has not forgotten. */
  has(id: string): boolean;
}

/**
 * How many shells one connection family may hold open at once.
 *
 * Under the host's own ceiling on purpose. The host's cap protects the machine
 * from Artemis; this one protects the *local user's* share of it from a remote
 * client that lost its mind, so that a runaway loop over the wire cannot take
 * the last slot from the person sitting at the keyboard.
 */
export const MAX_REMOTE_TERMINALS_PER_FAMILY = 6;

/** Raised when a route names a shell this connection cannot see. */
export class UnknownRemoteTerminalError extends Error {
  constructor() {
    super('There is no such terminal on the serving machine.');
    this.name = 'UnknownRemoteTerminalError';
  }
}

/** Raised when a family is already holding {@link MAX_REMOTE_TERMINALS_PER_FAMILY}. */
export class TooManyRemoteTerminalsError extends Error {
  constructor() {
    super(
      `This connection already has ${MAX_REMOTE_TERMINALS_PER_FAMILY} shells open on the serving machine. Close one first.`,
    );
    this.name = 'TooManyRemoteTerminalsError';
  }
}

/** One remotely started shell, and who may see it. */
interface RemoteTerminalOwner {
  readonly workspaceKey: string;
  /** The connection that opened it, for the attribution record only. */
  readonly connectionId: string;
  info: TerminalInfo;
}

export interface RemoteTerminals {
  /** Every shell this connection's family opened, newest last. */
  list(connection: ServerConnection): readonly TerminalInfo[];
  start(
    connection: ServerConnection,
    request: { readonly cwd: string; readonly cols: number; readonly rows: number },
  ): Promise<TerminalInfo>;
  write(connection: ServerConnection, id: string, data: string): TerminalInfo;
  resize(connection: ServerConnection, id: string, cols: number, rows: number): TerminalInfo;
  close(connection: ServerConnection, id: string): TerminalInfo;
  replay(
    connection: ServerConnection,
    id: string,
  ): { readonly data: string; readonly truncated: boolean };
  /**
   * Every terminal event the host sees, remote and local alike.
   *
   * Events for ids this file did not issue are dropped, which is what keeps
   * the local window's shells off the wire. The rest are published to the feed
   * scoped to the owning family — see the file comment on who can see a shell.
   */
  observe(event: TerminalEvent): void;
  /** Forget everything. For shutdown and tests; does not kill shells. */
  dispose(): void;
}

export interface RemoteTerminalsOptions {
  readonly source: TerminalSource;
  /** Where PTY bytes go. Absent means terminals work but nothing streams. */
  readonly feed?: PushFeed;
  /** The attribution record. See `sessions/lifecycleLog.ts`. */
  readonly onAccess?: (event: {
    readonly kind: 'remote.terminal.started' | 'remote.terminal.closed';
    readonly connectionId: string;
    readonly terminalId: string;
    readonly cwd?: string;
  }) => void;
  readonly maxPerFamily?: number;
}

export function createRemoteTerminals(options: RemoteTerminalsOptions): RemoteTerminals {
  const maxPerFamily = options.maxPerFamily ?? MAX_REMOTE_TERMINALS_PER_FAMILY;
  /** Terminal id → who opened it. The only authority on remote visibility. */
  const owners = new Map<string, RemoteTerminalOwner>();

  /**
   * Resolve an id against a connection, or refuse.
   *
   * "Not yours" and "not there" are one answer, for the reason the run routes
   * give: a token that can tell the two apart can enumerate the serving
   * machine's shells by asking about ids until one stops 404ing.
   */
  function ownedBy(connection: ServerConnection, id: string): RemoteTerminalOwner {
    const owner = owners.get(id);
    if (owner === undefined || owner.workspaceKey !== workspaceKeyFor(connection)) {
      throw new UnknownRemoteTerminalError();
    }
    // A shell the host has forgotten (evicted after exiting, killed at quit) is
    // gone even though this file still has a row for it. Drop the row and give
    // the same answer, so the two registries cannot disagree for long.
    if (!options.source.has(id)) {
      owners.delete(id);
      throw new UnknownRemoteTerminalError();
    }
    return owner;
  }

  function familyOf(connection: ServerConnection): RemoteTerminalOwner[] {
    const key = workspaceKeyFor(connection);
    return [...owners.values()].filter((owner) => owner.workspaceKey === key);
  }

  return {
    list(connection): readonly TerminalInfo[] {
      return familyOf(connection).map((owner) => owner.info);
    },

    async start(connection, request): Promise<TerminalInfo> {
      // Counted over the family and over *live* shells only: an exited record
      // is kept so its last words stay on screen, and holding a slot for a dead
      // process would make the cap tighten every time something crashed.
      const live = familyOf(connection).filter((owner) => !owner.info.exited);
      if (live.length >= maxPerFamily) throw new TooManyRemoteTerminalsError();

      const info = await options.source.start(request);
      owners.set(String(info.id), {
        workspaceKey: workspaceKeyFor(connection),
        connectionId: connection.id,
        info,
      });
      options.onAccess?.({
        kind: 'remote.terminal.started',
        connectionId: connection.id,
        terminalId: String(info.id),
        cwd: info.cwd,
      });
      return info;
    },

    write(connection, id, data): TerminalInfo {
      const owner = ownedBy(connection, id);
      options.source.write(id, data);
      return owner.info;
    },

    resize(connection, id, cols, rows): TerminalInfo {
      const owner = ownedBy(connection, id);
      options.source.resize(id, cols, rows);
      return owner.info;
    },

    close(connection, id): TerminalInfo {
      const owner = ownedBy(connection, id);
      options.source.close(id);
      options.onAccess?.({
        kind: 'remote.terminal.closed',
        connectionId: connection.id,
        terminalId: id,
      });
      // The row is not deleted here. `close` kills the child, and the exit
      // event that follows is what the remote window renders; forgetting the
      // terminal now would make that event unroutable and the tab would go
      // quiet instead of saying the shell ended.
      return owner.info;
    },

    replay(connection, id): { readonly data: string; readonly truncated: boolean } {
      ownedBy(connection, id);
      return options.source.replay(id);
    },

    observe(event): void {
      const owner = owners.get(String(event.id));
      if (owner === undefined) return;
      if (event.type === 'exit') {
        // Mirror the host's own record: the tab stays, showing what the shell
        // said before it died, and the cap stops counting it.
        owner.info = { ...owner.info, exited: true };
      }
      options.feed?.publish('artemis:push:terminal-event', event, {
        workspaceKey: owner.workspaceKey,
      });
    },

    dispose(): void {
      owners.clear();
    },
  };
}
