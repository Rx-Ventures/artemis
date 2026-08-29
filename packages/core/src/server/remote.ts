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
  PermissionDecision,
  RunHandle,
  RunInput,
  ServerConnection,
  ServerLiveWorkBody,
  ServerRunBody,
  ServerRunEventsBody,
  ServerRunInterruptBody,
  ServerRunPermissionBody,
  ServerRunsBody,
  ServerRunSendBody,
  ServerRunActionBody,
} from '@rx-artemis/protocol';
import {
  connectionAllowsModel,
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
import { WorkspaceUnavailableError } from './workspaces.js';

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
    if (method === 'POST') return attribute(await handleStartRun(input));
    return attribute(methodNotAllowed('The run list is a GET; starting a run is a POST.'));
  }

  const runRoute = parseRemoteResourcePath(path, REMOTE_RUNS_PATH);
  if (runRoute !== undefined) {
    if (runRoute.action === 'events') {
      if (method !== 'GET') return attribute(methodNotAllowed('A run replay is a GET.'));
      return attribute(await handleRunEvents(input, runRoute.id));
    }
    if (method !== 'POST') return attribute(methodNotAllowed('Run actions are POSTs.'));
    if (runRoute.action === undefined) {
      return attribute(
        fail(404, 'invalid_request_error', 'unknown_endpoint', 'A run action names its verb.'),
      );
    }
    return attribute(await handleRunAction(input, runRoute.id, runRoute.action));
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

/** The answer on every control verb the host chose not to expose. */
function notControllable(): ServerReply {
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
/* Control routes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v0/runs`: start a run with the user's own settings.
 *
 * The body carries a whole `RunInput` — see the protocol on why the remote
 * principal is owed more than the completions surface offers — and the
 * token's scope is enforced before anything is spent: the profile must be
 * inside the allowance (with the same one-refusal-for-absent-and-invisible
 * rule the run routes use), a named model must be allowed on it, and the
 * working directory is the connection's pin, not the caller's choice.
 */
async function handleStartRun(input: RemoteRequestInput): Promise<ServerReply> {
  const { request, context, connection } = input;
  const startUserRun = context.runs?.startUserRun;
  if (startUserRun === undefined) return notControllable();

  const runInput = readRunInput(request.body);
  if (runInput === undefined) {
    return fail(
      400,
      'invalid_request_error',
      'invalid_body',
      'The body must be `{ input }` carrying providerId, profileId, cwd and prompt.',
    );
  }

  if (!connectionAllowsProfile(connection, runInput.profileId)) {
    return fail(404, 'invalid_request_error', 'unknown_profile', 'No such account for this connection.');
  }
  if (
    runInput.model !== undefined &&
    !connectionAllowsModel(connection, runInput.profileId, runInput.model)
  ) {
    return fail(
      404,
      'invalid_request_error',
      'model_not_found',
      `No model "${runInput.model}" on that account for this connection.`,
    );
  }

  const pinned = await resolvePinnedCwd(input, runInput);
  if (typeof pinned !== 'string') return pinned;

  let handle: RunHandle;
  try {
    handle = await startUserRun({ ...runInput, cwd: pinned });
  } catch (error) {
    return fail(
      400,
      'invalid_request_error',
      'run_rejected',
      error instanceof Error ? error.message : 'The run could not be started.',
    );
  }

  /*
   * Guarded from the moment it exists: a client that vanishes for good has
   * this run interrupted rather than left burning the plan — the same
   * deliberate policy the completions surface has structurally — and the
   * session id it announces is recorded against this connection through the
   * guard's feed subscription. See `guard.ts`.
   */
  context.guard?.trackRun({
    runId: String(handle.runId),
    connectionId: connection.id,
    profileId: String(handle.profileId),
    workspaceKey: workspaceKeyFor(connection),
    cwd: handle.cwd,
  });

  const body: ServerRunBody = { object: 'artemis.run', run: handle };
  return ok(body);
}

/**
 * The working directory a bridge-started run actually gets.
 *
 * The pin is the token's whole authority story — see `ServerConnection` — so
 * the caller's `cwd` is honoured only as far as it stays inside it:
 *
 *  - a `directory` pin admits the directory and anything beneath it, which is
 *    what lets a remote window work in a repo's subfolder or a worktree
 *    inside it;
 *  - an `ephemeral` pin resolves to the connection's scratch space and the
 *    caller's `cwd` is ignored entirely — it names a path on the wrong
 *    machine, and scratch is minted here;
 *  - `none` cannot run turns at all.
 */
async function resolvePinnedCwd(
  input: RemoteRequestInput,
  runInput: RunInput,
): Promise<string | ServerReply> {
  const { context, connection } = input;
  const workspace = connection.workspace;

  if (workspace.kind === 'none') {
    return fail(
      403,
      'invalid_request_error',
      'workspace_unavailable',
      'This connection has nowhere to run turns — it was created catalogue-only.',
    );
  }

  if (workspace.kind === 'directory') {
    const root = workspace.path;
    if (runInput.cwd === root || runInput.cwd.startsWith(`${root}/`)) return runInput.cwd;
    return fail(
      403,
      'invalid_request_error',
      'outside_workspace',
      `This connection's turns are pinned to ${root}.`,
    );
  }

  if (context.workspaces === undefined) return notControllable();
  try {
    const resolved = await context.workspaces.resolve({
      connectionId: connection.id,
      workspace,
      ...(runInput.resumeSessionId === undefined
        ? {}
        : { sessionId: runInput.resumeSessionId }),
    });
    return resolved.path;
  } catch (error) {
    return fail(
      403,
      'invalid_request_error',
      'workspace_unavailable',
      error instanceof WorkspaceUnavailableError
        ? error.message
        : 'This connection has nowhere to run turns.',
    );
  }
}

/** Shape-check the body's `input`. Capability questions stay the engine's. */
function readRunInput(body: unknown): RunInput | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as { input?: unknown }).input;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  for (const field of ['providerId', 'profileId', 'cwd', 'prompt']) {
    if (typeof candidate[field] !== 'string' || candidate[field] === '') return undefined;
  }
  return raw as RunInput;
}

/**
 * The per-run verbs: send, interrupt, respond-permission, stop-task, dispose.
 *
 * Every one resolves the run against the host first and refuses an id outside
 * the connection's allowance with the same 404 an absent one gets — a token
 * must not be able to steer, stop, or *probe for* another account's work.
 */
async function handleRunAction(
  input: RemoteRequestInput,
  runId: string,
  action: string,
): Promise<ServerReply> {
  const { request, context, connection } = input;
  const runs = context.runs;
  const getRun = runs?.getRun;
  if (runs === undefined || getRun === undefined) return notControllable();

  const run = await getRun(runId);
  if (run === undefined || !connectionAllowsProfile(connection, run.profileId)) {
    return unknownRun();
  }

  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<
    string,
    unknown
  >;

  try {
    switch (action) {
      case 'send': {
        if (runs.send === undefined) return notControllable();
        if (typeof body['text'] !== 'string' || body['text'].length === 0) {
          return fail(400, 'invalid_request_error', 'invalid_body', '`text` must be a non-empty string.');
        }
        const attachments = Array.isArray(body['attachments'])
          ? (body['attachments'] as never)
          : undefined;
        const outcome = await runs.send(runId, body['text'], attachments);
        const reply: ServerRunSendBody = {
          object: 'artemis.run.send',
          runId,
          deliveredImmediately: outcome.deliveredImmediately,
        };
        return ok(reply);
      }

      case 'interrupt': {
        const outcome =
          runs.interruptRun !== undefined
            ? await runs.interruptRun(runId)
            : await runs.interrupt(runId).then(() => ({ stillQueued: [] as readonly string[] }));
        const reply: ServerRunInterruptBody = {
          object: 'artemis.run.interrupt',
          runId,
          stillQueued: outcome.stillQueued ?? [],
        };
        return ok(reply);
      }

      case 'respond-permission': {
        const decision = readDecision(body['decision']);
        if (typeof body['requestId'] !== 'string' || decision === undefined) {
          return fail(
            400,
            'invalid_request_error',
            'invalid_body',
            '`requestId` and a `decision` with behavior "allow" or "deny" are required.',
          );
        }
        /*
         * The heart of the phase: the widened seam carries a real person's
         * answer — allow included — where the completions surface can only
         * ever deny. The renderer's own `permission.resolved` event follows
         * on the stream, so every attached window sees the prompt settle.
         */
        await runs.respondToPermission(runId, body['requestId'], decision);
        const reply: ServerRunPermissionBody = {
          object: 'artemis.run.permission',
          runId,
          requestId: body['requestId'],
        };
        return ok(reply);
      }

      case 'stop-task': {
        if (runs.stopTask === undefined) return notControllable();
        if (typeof body['taskId'] !== 'string' || body['taskId'].length === 0) {
          return fail(400, 'invalid_request_error', 'invalid_body', '`taskId` must be a non-empty string.');
        }
        await runs.stopTask(runId, body['taskId']);
        const reply: ServerRunActionBody = { object: 'artemis.run.action', runId };
        return ok(reply);
      }

      case 'dispose': {
        await runs.disposeRun(runId);
        context.guard?.untrackRun(runId);
        const reply: ServerRunActionBody = { object: 'artemis.run.action', runId };
        return ok(reply);
      }

      default:
        return fail(404, 'invalid_request_error', 'unknown_endpoint', `No run action "${action}".`);
    }
  } catch (error) {
    // The engine's refusals are sentences written for a person — a stale
    // permission click, a run that just ended — and they travel as such.
    return fail(
      400,
      'invalid_request_error',
      'run_action_failed',
      error instanceof Error ? error.message : 'The action failed.',
    );
  }
}

/** The decision, shape-checked: exactly the two behaviours, fields passed through. */
function readDecision(raw: unknown): PermissionDecision | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const behavior = (raw as { behavior?: unknown }).behavior;
  if (behavior !== 'allow' && behavior !== 'deny') return undefined;
  return raw as PermissionDecision;
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
      ...(context.guard === undefined ? {} : { guard: context.guard }),
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
  readonly guard?: import('./guard.js').RemoteRunGuard;
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

  // The interrupt-on-disconnect ledger: this stream is what "the client is
  // still here" means, and its close is what starts the grace clock. See
  // `guard.ts` for why the clock is minutes and not milliseconds.
  input.guard?.attach(connection.id);
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
    input.guard?.detach(connection.id);
  }
}
