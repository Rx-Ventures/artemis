/**
 * The remote bridge surface: what a driving Artemis and a serving Artemis
 * agree on.
 * ============================================================================
 *
 * ADR 0004 makes remote control a *bridge mode*: the renderer's existing UI
 * speaks its ordinary `IpcRequestMap` vocabulary, and a thin client maps each
 * call onto the HTTP routes named here. Nothing in this file invents a second
 * vocabulary — every body carries the same `RunHandle`s, `AgentEvent`s and
 * `TerminalInfo`s the desktop already renders, because the whole point of the
 * design is that the remote machine is drawn by the same code that draws the
 * local one.
 *
 * Two kinds of thing live here:
 *
 *  1. **Routes and bodies** for the observe/control surface, all under the
 *     native `/api/v0` prefix beside the session routes. Requests carry ids in
 *     the path and JSON in the body; the token travels in the `Authorization`
 *     header and never in a URL, where it would land in every proxy and access
 *     log between the two machines.
 *
 *  2. **The event stream's framing.** `GET /api/v0/events` is Server-Sent
 *     Events carrying `IpcPushMap` payloads — the exact objects
 *     `webContents.send` would have carried — one SSE message per push, the
 *     push channel's own name in the `event:` field and the feed's sequence
 *     number in `id:`. A client reconnecting sends the last id it applied
 *     (the standard `Last-Event-ID` header) and is replayed what it missed;
 *     when the server's retention has already dropped some of that, the first
 *     message is an explicit {@link RemoteGapPayload} rather than a silently
 *     shortened history — the same honesty rule `RunsEventsResponse.truncated`
 *     states for the in-process replay buffer.
 */

import type { AgentEvent } from './events.js';
import type { Attachment } from './attachment.js';
import type { PermissionDecision } from './permissions.js';
import type { RunHandle, RunInput } from './run.js';
import type { TerminalInfo } from './terminal.js';
import type { SessionDelegatedWork } from './ipc.js';
import { SERVER_API_VERSION } from './server.js';

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

const API = `/api/${SERVER_API_VERSION}`;

/** `GET` the live runs; `POST` to start one (with the user's own settings). */
export const REMOTE_RUNS_PATH = `${API}/runs`;

/** `GET` which conversations still hold background work. */
export const REMOTE_LIVE_WORK_PATH = `${API}/runs/live-work`;

/** `GET` the event stream. See the file comment for the framing. */
export const REMOTE_EVENTS_PATH = `${API}/events`;

/** `GET` the serving machine's terminals; `POST` to open a shell. */
export const REMOTE_TERMINALS_PATH = `${API}/terminals`;

/** Verbs addressed at one run. Each is a `POST` to `/runs/{id}/{action}`. */
export const REMOTE_RUN_ACTIONS = [
  'send',
  'interrupt',
  'respond-permission',
  'stop-task',
  'dispose',
] as const;

export type RemoteRunAction = (typeof REMOTE_RUN_ACTIONS)[number];

/** Verbs addressed at one terminal: `POST /terminals/{id}/{action}`. */
export const REMOTE_TERMINAL_ACTIONS = ['write', 'resize', 'close'] as const;

export type RemoteTerminalAction = (typeof REMOTE_TERMINAL_ACTIONS)[number];

/** `/api/v0/runs/{id}` or `/api/v0/runs/{id}/{action}`. */
export function remoteRunPath(runId: string, action?: RemoteRunAction | 'events'): string {
  const base = `${REMOTE_RUNS_PATH}/${encodeURIComponent(runId)}`;
  return action === undefined ? base : `${base}/${action}`;
}

/** `/api/v0/terminals/{id}/{action}` (or `/replay`). */
export function remoteTerminalPath(
  terminalId: string,
  action: RemoteTerminalAction | 'replay',
): string {
  return `${REMOTE_TERMINALS_PATH}/${encodeURIComponent(terminalId)}/${action}`;
}

/**
 * Split a `/runs/…` or `/terminals/…` sub-path back into id and action.
 *
 * Lives beside the builders so the server's router and the client's requests
 * cannot drift on the encoding: the id is percent-decoded exactly once, and an
 * id that fails to decode is treated as the id it literally was — the caller
 * asked about something that is not there either way, and a 400 about URL
 * syntax is a worse answer than "no such run".
 */
export function parseRemoteResourcePath(
  path: string,
  base: string,
): { readonly id: string; readonly action: string | undefined } | undefined {
  if (!path.startsWith(`${base}/`)) return undefined;
  const rest = path.slice(base.length + 1);
  if (rest.length === 0) return undefined;
  const cut = rest.indexOf('/');
  const rawId = cut === -1 ? rest : rest.slice(0, cut);
  const action = cut === -1 ? undefined : rest.slice(cut + 1);
  if (rawId.length === 0) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    id = rawId;
  }
  if (action !== undefined && (action.length === 0 || action.includes('/'))) return undefined;
  return { id, action };
}

/* -------------------------------------------------------------------------- */
/* Bodies: observing                                                          */
/* -------------------------------------------------------------------------- */

/** Body of `GET /api/v0/runs` — the runs this connection may see, live. */
export interface ServerRunsBody {
  readonly object: 'artemis.runs';
  readonly runs: readonly RunHandle[];
}

/** Body of `POST /api/v0/runs` — the accepted run. */
export interface ServerRunBody {
  readonly object: 'artemis.run';
  readonly run: RunHandle;
}

/**
 * Body of `GET /api/v0/runs/{id}/events?after=N`.
 *
 * `truncated` keeps the exact meaning `RunsEventsResponse.truncated` has on
 * the desktop: the retained buffer had already dropped events the caller asked
 * for, so the replay starts mid-run and the caller must say so.
 */
export interface ServerRunEventsBody {
  readonly object: 'artemis.run.events';
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  readonly truncated: boolean;
}

/**
 * Body of `GET /api/v0/runs/live-work`.
 *
 * The same three sets `RunsLiveWorkResponse` carries, with the same contract:
 * a set of conversations *known* to be working, never the complement of the
 * idle ones. A serving build that cannot answer (the headless server keeps no
 * background-work ledger) reports empty sets rather than failing, because
 * "keep these" with nothing in it is a safe answer and an error is not.
 */
export interface ServerLiveWorkBody {
  readonly object: 'artemis.live-work';
  readonly sessionIds: readonly string[];
  readonly working: readonly string[];
  readonly delegated: readonly SessionDelegatedWork[];
}

/* -------------------------------------------------------------------------- */
/* Bodies: controlling                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Body of `POST /api/v0/runs`.
 *
 * Carries a whole {@link RunInput}, and that is the deliberate difference from
 * the chat-completions surface: a completions caller is *a program borrowing an
 * account* and may not choose a permission mode or a tool set, while the holder
 * of a remote-bridge token is *the user, on another machine*, starting a run
 * with their own settings. The server still refuses what the token's scope
 * refuses — an invisible profile, a directory outside the connection's pin —
 * so widening the body widens what a legitimate caller can express, not what a
 * leaked token is worth.
 */
export interface RemoteStartRunBody {
  readonly input: RunInput;
}

/** Body of `POST /api/v0/runs/{id}/send`. */
export interface RemoteSendBody {
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

/** Body of `POST /api/v0/runs/{id}/respond-permission`. */
export interface RemoteRespondPermissionBody {
  readonly requestId: string;
  readonly decision: PermissionDecision;
}

/** Body of `POST /api/v0/runs/{id}/stop-task`. */
export interface RemoteStopTaskBody {
  readonly taskId: string;
}

/** Reply to `send`. */
export interface ServerRunSendBody {
  readonly object: 'artemis.run.send';
  readonly runId: string;
  readonly deliveredImmediately: boolean;
}

/** Reply to `interrupt`. */
export interface ServerRunInterruptBody {
  readonly object: 'artemis.run.interrupt';
  readonly runId: string;
  readonly stillQueued: readonly string[];
}

/** Reply to `respond-permission`. */
export interface ServerRunPermissionBody {
  readonly object: 'artemis.run.permission';
  readonly runId: string;
  readonly requestId: string;
}

/** Reply to `dispose` and `stop-task`. */
export interface ServerRunActionBody {
  readonly object: 'artemis.run.action';
  readonly runId: string;
}

/* -------------------------------------------------------------------------- */
/* Bodies: terminals                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Body of `POST /api/v0/terminals`.
 *
 * `cwd` is optional where the desktop's `TerminalStartRequest.cwd` is not,
 * because the honest default differs: on the desktop the renderer knows the
 * pane's directory, while a remote client's idea of a directory may be a path
 * on the wrong machine. Absent means "the connection's own workspace", and a
 * present path is still confined to it — see the server's route.
 */
export interface RemoteTerminalStartBody {
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
}

/** Body of `POST /api/v0/terminals/{id}/write`. */
export interface RemoteTerminalWriteBody {
  readonly data: string;
}

/** Body of `POST /api/v0/terminals/{id}/resize`. */
export interface RemoteTerminalResizeBody {
  readonly cols: number;
  readonly rows: number;
}

/** Body of `GET /api/v0/terminals`. */
export interface ServerTerminalsBody {
  readonly object: 'artemis.terminals';
  readonly terminals: readonly TerminalInfo[];
}

/** Reply to `POST /api/v0/terminals` and the write/resize/close actions. */
export interface ServerTerminalBody {
  readonly object: 'artemis.terminal';
  readonly terminal: TerminalInfo;
}

/** Body of `GET /api/v0/terminals/{id}/replay`. */
export interface ServerTerminalReplayBody {
  readonly object: 'artemis.terminal.replay';
  readonly id: string;
  readonly data: string;
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* The event stream                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Push channels that ride the event stream, named exactly as `IPC_PUSH` names
 * them so the client's demultiplexer is a lookup rather than a translation.
 *
 * Deliberately a subset. Window state, update state and the server's own
 * lifecycle are facts about the *local* machine and never cross the wire;
 * plan-usage readings and run suggestions could travel later, but each would
 * be a claim about freshness the stream cannot yet keep, so neither is named
 * until it can be.
 */
export const REMOTE_STREAM_CHANNELS = [
  'artemis:push:agent-event',
  'artemis:push:terminal-event',
] as const;

export type RemoteStreamChannel = (typeof REMOTE_STREAM_CHANNELS)[number];

/** `event:` name of the greeting message every stream opens with. */
export const REMOTE_STREAM_HELLO = 'artemis:stream:hello';

/** `event:` name of the honest-gap message. See {@link RemoteGapPayload}. */
export const REMOTE_STREAM_GAP = 'artemis:stream:gap';

/**
 * `event:` name of the message a stream sends when it is ending on purpose.
 *
 * A dropped TCP connection and a *revoked credential* look identical to a
 * client that only ever sees the socket close, and the two want opposite
 * responses: the first should be retried on a backoff, the second should stop
 * retrying and tell the user why. So a stream the server closes deliberately
 * says so first. See {@link RemoteClosedPayload}.
 */
export const REMOTE_STREAM_CLOSED = 'artemis:stream:closed';

/** Why a stream ended, when the server ended it. */
export interface RemoteClosedPayload {
  /**
   * `expired` — the token's expiry passed while the stream was open.
   * `revoked` — the connection was deleted on the serving machine.
   *
   * Both are permanent, and a client that reconnects will be refused at the
   * door; the distinction is only there so the message on screen can be true.
   */
  readonly reason: 'expired' | 'revoked';
  readonly message: string;
}

/**
 * The first message on every stream: where the feed's head stands right now.
 *
 * Exists so a client can tell a quiet stream from a dead one — the hello is
 * proof the attach worked — and so a client that connected with no
 * `Last-Event-ID` knows which seq its *next* reconnect should name.
 */
export interface RemoteHelloPayload {
  readonly seq: number;
  /** The serving Artemis's version, for a client that wants to say so. */
  readonly version: string;
}

/**
 * The server could not replay everything the client asked for.
 *
 * Sent as the stream's first data-bearing message when the client's
 * `Last-Event-ID` names a point the retention buffer has already dropped past.
 * The client asked for everything after {@link afterSeq}; the oldest event
 * still retained is {@link firstSeq}; everything between the two is gone. The
 * client's recovery is the same one a reloaded window uses — `runs:list` plus
 * `runs:events` per run — rather than pretending the stream was continuous.
 */
export interface RemoteGapPayload {
  readonly afterSeq: number;
  readonly firstSeq: number;
}

/* -------------------------------------------------------------------------- */
/* SSE framing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One Server-Sent Events message, as both ends of the stream see it.
 *
 * `data` is the joined payload — the SSE spec allows several `data:` lines per
 * message and the decoder joins them with `\n`, which is a property of the
 * format rather than anything Artemis uses: every payload this stream writes
 * is one line of JSON.
 */
export interface SseMessage {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

/**
 * Encode one message for the wire.
 *
 * The `id` line first, so an intermediary that cuts the connection mid-message
 * cannot leave a client believing it applied an event it never received the
 * body of: a message's id only reaches the client's `Last-Event-ID` once the
 * blank line lands, per the SSE spec, whichever order the fields arrive in —
 * but writing it first keeps the frame readable in a `curl`.
 */
export function sseMessage(message: SseMessage): string {
  const lines: string[] = [];
  if (message.id !== undefined) lines.push(`id: ${message.id}`);
  if (message.event !== undefined) lines.push(`event: ${message.event}`);
  for (const line of message.data.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * The heartbeat: an SSE comment, which every conforming client discards.
 *
 * Written on an interval so proxies with idle timeouts keep the connection,
 * and so the client's read loop gets bytes often enough to notice a dead
 * socket in seconds rather than at the TCP keepalive's leisure.
 */
export const SSE_HEARTBEAT = ':hb\n\n';

/**
 * An incremental SSE decoder.
 *
 * `feed` takes the text of one transport chunk — which the network is free to
 * cut anywhere, including mid-line and mid-UTF-8 (the caller's TextDecoder
 * handles the bytes; this handles the lines) — and returns every complete
 * message the buffer now holds. State is one partial message and one partial
 * line; there is nothing to flush at end-of-stream because a message that
 * never got its blank line never finished, and the spec says to drop it.
 */
export function createSseDecoder(): { feed(chunk: string): SseMessage[] } {
  let buffered = '';
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  function finish(): SseMessage | undefined {
    if (id === undefined && event === undefined && data.length === 0) return undefined;
    const message: SseMessage = {
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
      data: data.join('\n'),
    };
    id = undefined;
    event = undefined;
    data = [];
    return message;
  }

  function readField(line: string): void {
    if (line.startsWith(':')) return; // Comment — the heartbeat lands here.
    const cut = line.indexOf(':');
    const field = cut === -1 ? line : line.slice(0, cut);
    // Per spec: a single leading space after the colon is part of the syntax.
    let value = cut === -1 ? '' : line.slice(cut + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // Unknown fields (`retry`, extensions) are ignored, per spec.
  }

  return {
    feed(chunk: string): SseMessage[] {
      buffered += chunk;
      const out: SseMessage[] = [];
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) break;
        let line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const message = finish();
          if (message !== undefined) out.push(message);
        } else {
          readField(line);
        }
      }
      return out;
    },
  };
}
