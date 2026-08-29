/**
 * The remote bridge surface: another Artemis, driving this one (ADR 0004).
 * ============================================================================
 *
 * These routes exist so the desktop's `remote` bridge mode can speak its
 * ordinary `IpcRequestMap` vocabulary at a machine it is not running on: the
 * run list is `runs:list`, the per-run replay is `runs:events`, and the event
 * stream is `IPC_PUSH` with a sequence number. Nothing here invents a second
 * vocabulary — the bodies are the protocol package's own shapes, defined in
 * `protocol/remote.ts` so the two ends cannot drift.
 *
 * ## Who may see what
 *
 * Every route is scoped by the *connection's allowance*, exactly as the
 * catalogue is: a run is visible when `connectionAllowsProfile` admits the
 * account it bills, and an invisible run is indistinguishable from an absent
 * one — one 404 for "not there" and "not yours", the same rule the session
 * routes state. The stored-session privacy rule is untouched: live runs are
 * a different surface from stored history, and observing what this machine is
 * *doing* is the feature, while reading what it once *said* stays gated by
 * the ledger's pin.
 *
 * ## The event stream
 *
 * `GET /api/v0/events` is Server-Sent Events over the push feed. It opens
 * with a hello naming the feed's head, replays from `Last-Event-ID` when the
 * client presents one, reports an honest gap when retention has dropped what
 * was asked for, and then follows the live feed with a heartbeat comment
 * often enough that proxies keep the socket and the client can tell quiet
 * from dead. Reconnecting with replay-from is what lets a briefly-dropped
 * client resume without a full re-sync — and what keeps the server's
 * deliberate interrupt-on-disconnect from firing on a network blip rather
 * than a departure.
 */

import type { FeedEvent, FeedScope, PushFeed } from './feed.js';
import type {
  ServerConnection,
  ServerLiveWorkBody,
  ServerRunEventsBody,
  ServerRunsBody,
} from '@rx-artemis/protocol';
import {
  connectionAllowsProfile,
  parseRemoteResourcePath,
  REMOTE_EVENTS_PATH,
  REMOTE_LIVE_WORK_PATH,
  REMOTE_RUNS_PATH,
  REMOTE_STREAM_GAP,
  REMOTE_STREAM_HELLO,
  REMOTE_TERMINALS_PATH,
  SSE_HEARTBEAT,
  sseMessage,
  type RemoteGapPayload,
  type RemoteHelloPayload,
} from '@rx-artemis/protocol';

import type {
  ServerContext,
  ServerReply,
  ServerRequestInfo,
  ServerStreamReply,
} from './http.js';
import { workspaceKeyFor } from './ledger.js';
import { CORS_HEADERS, fail, ok } from './replies.js';

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/** Is this a path the remote bridge surface owns? */
export function isRemotePath(path: string): boolean {
  return (
    path === REMOTE_RUNS_PATH ||
    path === REMOTE_LIVE_WORK_PATH ||
    path === REMOTE_EVENTS_PATH ||
    path === REMOTE_TERMINALS_PATH ||
    path.startsWith(`${REMOTE_RUNS_PATH}/`) ||
    path.startsWith(`${REMOTE_TERMINALS_PATH}/`)
  );
}

/** Tuning knobs for {@link handleRemoteRequest}'s event stream. */
export interface RemoteStreamOptions {
  /** How often the quiet stream writes its comment. Defaults to 15 s. */
  readonly heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export interface RemoteRequestInput {
  readonly request: ServerRequestInfo;
  readonly context: ServerContext;
  readonly connection: ServerConnection;
  readonly method: string;
  readonly path: string;
  readonly url: URL;
}

/** Answer one remote-bridge request. Auth has already happened. */
export async function handleRemoteRequest(
  input: RemoteRequestInput,
): Promise<ServerReply | ServerStreamReply> {
  const { context, connection, method, path } = input;
  const attribute = <T extends { status: number }>(reply: T): T & { connectionId: string } => ({
    ...reply,
    connectionId: connection.id,
  });

  if (path === REMOTE_EVENTS_PATH) {
    if (method !== 'GET') return attribute(methodNotAllowed('The event stream is a GET.'));
    return handleEventStream(input);
  }

  if (path === REMOTE_LIVE_WORK_PATH) {
    if (method !== 'GET') return attribute(methodNotAllowed('Live work is a GET.'));
    return attribute(await handleLiveWork(context, connection));
  }

  if (path === REMOTE_RUNS_PATH) {
    if (method === 'GET') return attribute(await handleRunList(context, connection));
    if (method === 'POST') return attribute(notYetControllable());
    return attribute(methodNotAllowed('The run list is a GET; starting a run is a POST.'));
  }

  const runRoute = parseRemoteResourcePath(path, REMOTE_RUNS_PATH);
  if (runRoute !== undefined) {
    if (runRoute.action === 'events') {
      if (method !== 'GET') return attribute(methodNotAllowed('A run replay is a GET.'));
      return attribute(await handleRunEvents(input, runRoute.id));
    }
    if (method !== 'POST') return attribute(methodNotAllowed('Run actions are POSTs.'));
    return attribute(notYetControllable());
  }

  // The terminal surface lands with the remote-terminal phase.
  return attribute(
    fail(
      501,
      'invalid_request_error',
      'not_implemented',
      'This Artemis build does not serve remote terminals.',
    ),
  );
}

function methodNotAllowed(message: string): ServerReply {
  return fail(405, 'invalid_request_error', 'method_not_allowed', message);
}

/** The observe-only build's answer on every control verb. */
function notYetControllable(): ServerReply {
  return fail(
    501,
    'invalid_request_error',
    'not_implemented',
    'This Artemis build serves the observation surface only — the run list, replay, and the event stream.',
  );
}

/** One refusal for "absent" and "not yours" alike, matching the session routes. */
function unknownRun(): ServerReply {
  return fail(404, 'invalid_request_error', 'unknown_run', 'No such run for this connection.');
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * May this connection hear about something concerning this scope?
 *
 * Two independent axes, both narrowing: an event about an account outside the
 * allowance is invisible however it travelled, and an event pinned to another
 * connection family's workspace (a terminal, in practice) stays inside that
 * family. An event with no scope on an axis is not narrowed by it.
 */
function scopeVisible(connection: ServerConnection, scope: FeedScope): boolean {
  if (scope.profileId !== undefined && !connectionAllowsProfile(connection, scope.profileId)) {
    return false;
  }
  if (scope.workspaceKey !== undefined && scope.workspaceKey !== workspaceKeyFor(connection)) {
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Observation routes                                                         */
/* -------------------------------------------------------------------------- */

async function handleRunList(
  context: ServerContext,
  connection: ServerConnection,
): Promise<ServerReply> {
  const listRuns = context.runs?.listRuns;
  if (listRuns === undefined) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      'This Artemis build does not expose its live runs.',
    );
  }
  const runs = await listRuns({});
  const body: ServerRunsBody = {
    object: 'artemis.runs',
    runs: runs.filter((run) => connectionAllowsProfile(connection, run.profileId)),
  };
  return ok(body);
}

async function handleLiveWork(
  context: ServerContext,
  connection: ServerConnection,
): Promise<ServerReply> {
  void connection;
  const liveWork = context.runs?.liveWork;
  /*
   * Empty rather than 501 when the host cannot answer. `RunsLiveWorkResponse`
   * is contractually a set of conversations *known* to be working — "keep
   * these", never "the rest are finished" — so an empty answer from a build
   * with no background-work ledger is true, while an error would make every
   * remote client carry a fallback for a distinction it cannot act on.
   */
  const work = liveWork === undefined ? undefined : await liveWork();
  const body: ServerLiveWorkBody = {
    object: 'artemis.live-work',
    sessionIds: work?.sessionIds ?? [],
    working: work?.working ?? [],
    delegated: work?.delegated ?? [],
  };
  return ok(body);
}

async function handleRunEvents(input: RemoteRequestInput, runId: string): Promise<ServerReply> {
  const { context, connection, url } = input;
  const getRun = context.runs?.getRun;
  const runEvents = context.runs?.runEvents;
  if (getRun === undefined || runEvents === undefined) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      'This Artemis build does not expose its live runs.',
    );
  }

  const run = await getRun(runId);
  if (run === undefined || !connectionAllowsProfile(connection, run.profileId)) {
    return unknownRun();
  }

  const rawAfter = url.searchParams.get('after');
  let afterSeq: number | undefined;
  if (rawAfter !== null) {
    if (!/^\d+$/.test(rawAfter)) {
      return fail(400, 'invalid_request_error', 'invalid_after', '`after` must be a whole number.');
    }
    afterSeq = Number(rawAfter);
  }

  const replay = await runEvents({ runId, ...(afterSeq === undefined ? {} : { afterSeq }) });
  const body: ServerRunEventsBody = {
    object: 'artemis.run.events',
    runId,
    events: replay.events,
    truncated: replay.truncated,
  };
  return ok(body);
}

/* -------------------------------------------------------------------------- */
/* The event stream                                                           */
/* -------------------------------------------------------------------------- */

function handleEventStream(input: RemoteRequestInput): ServerReply | ServerStreamReply {
  const { request, context, connection, url } = input;
  const feed = context.feed;
  if (feed === undefined) {
    return {
      ...fail(
        501,
        'invalid_request_error',
        'not_implemented',
        'This Artemis build has no event stream.',
      ),
      connectionId: connection.id,
    };
  }

  // The standard resume header first; `?after=` for a client that cannot set
  // headers. Neither carries a secret — the token stayed in `Authorization`.
  const rawAfter = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? undefined;
  let afterSeq: number | undefined;
  if (rawAfter !== undefined && rawAfter !== '') {
    if (!/^\d+$/.test(rawAfter)) {
      return {
        ...fail(
          400,
          'invalid_request_error',
          'invalid_after',
          'The resume point must be a whole number.',
        ),
        connectionId: connection.id,
      };
    }
    afterSeq = Number(rawAfter);
  }

  return {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      // `no-transform` keeps intermediaries from buffering the stream into a
      // slow whole-response; `x-accel-buffering` is the same instruction in
      // the dialect nginx-shaped proxies actually read.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
    connectionId: connection.id,
    stream: streamFeed({
      feed,
      connection,
      version: context.version,
      heartbeatMs: context.remoteStream?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }),
  };
}

async function* streamFeed(input: {
  readonly feed: PushFeed;
  readonly connection: ServerConnection;
  readonly version: string;
  readonly heartbeatMs: number;
  readonly afterSeq?: number;
  readonly signal?: { readonly aborted: boolean };
}): AsyncGenerator<string> {
  const { feed, connection, signal } = input;
  // Read through a call: `aborted` flips from another task, and a bare
  // property read would let the compiler narrow it into impossibility.
  const aborted = (): boolean => signal?.aborted === true;

  /*
   * Subscribe before reading the head, so nothing published between the two
   * can be missed. Whatever arrives twice — replayed *and* queued — is
   * deduplicated by `lastSent`: an event's seq is sent at most once, in order.
   */
  const pending: FeedEvent[] = [];
  let notify: (() => void) | null = null;
  const unsubscribe = feed.subscribe((event) => {
    pending.push(event);
    notify?.();
  });

  const frame = (event: FeedEvent): string =>
    sseMessage({
      id: String(event.seq),
      event: event.channel,
      data: JSON.stringify(event.payload),
    });

  try {
    const hello: RemoteHelloPayload = { seq: feed.head(), version: input.version };
    yield sseMessage({ event: REMOTE_STREAM_HELLO, data: JSON.stringify(hello) });

    // Without a resume point the stream starts *now*: the hello names the
    // head, and everything after it flows live.
    let lastSent = input.afterSeq ?? hello.seq;

    if (input.afterSeq !== undefined) {
      const replay = feed.since(input.afterSeq);
      if (replay.truncated) {
        const gap: RemoteGapPayload = { afterSeq: input.afterSeq, firstSeq: replay.firstSeq };
        yield sseMessage({ event: REMOTE_STREAM_GAP, data: JSON.stringify(gap) });
      }
      for (const event of replay.events) {
        if (event.seq <= lastSent) continue;
        lastSent = event.seq;
        if (scopeVisible(connection, event.scope)) yield frame(event);
      }
    }

    while (!aborted()) {
      if (pending.length === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          notify = resolve;
          timer = setTimeout(resolve, input.heartbeatMs);
        });
        notify = null;
        if (timer !== undefined) clearTimeout(timer);
        if (aborted()) break;
        if (pending.length === 0) {
          yield SSE_HEARTBEAT;
          continue;
        }
      }

      const event = pending.shift();
      if (event === undefined || event.seq <= lastSent) continue;
      lastSent = event.seq;
      if (scopeVisible(connection, event.scope)) yield frame(event);
    }
  } finally {
    unsubscribe();
  }
}
