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

import { resolve, sep } from 'node:path';

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
  ServerProfile,
  ServerTerminalBody,
  ServerTerminalReplayBody,
  ServerTerminalsBody,
} from '@rx-artemis/protocol';
import {
  connectionAllowsModel,
  connectionAllowsProfile,
  connectionHasExpired,
  visibleToConnection,
  parseRemoteResourcePath,
  REMOTE_EVENTS_PATH,
  REMOTE_LIVE_WORK_PATH,
  REMOTE_RUNS_PATH,
  REMOTE_STREAM_CLOSED,
  REMOTE_STREAM_GAP,
  REMOTE_STREAM_HELLO,
  REMOTE_TERMINALS_PATH,
  SSE_HEARTBEAT,
  sseMessage,
  type RemoteClosedPayload,
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
import { pathsOf, readRunInput, RunInputError } from './runInput.js';
import { TooManyRemoteTerminalsError, UnknownRemoteTerminalError } from './terminals.js';
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
  /**
   * How often an open stream re-asks whether its token is still valid.
   * Defaults to {@link AUTHORISATION_RECHECK_MS}. Injected by tests.
   */
  readonly recheckMs?: number;
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

  if (path === REMOTE_TERMINALS_PATH) {
    if (method === 'GET') return attribute(handleTerminalList(input));
    if (method === 'POST') return attribute(await handleTerminalStart(input));
    return attribute(methodNotAllowed('The terminal list is a GET; opening a shell is a POST.'));
  }

  const terminalRoute = parseRemoteResourcePath(path, REMOTE_TERMINALS_PATH);
  if (terminalRoute !== undefined && terminalRoute.action !== undefined) {
    return attribute(handleTerminalAction(input, terminalRoute.id, terminalRoute.action));
  }

  return attribute(
    fail(404, 'invalid_request_error', 'unknown_endpoint', 'No such remote route.'),
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

/**
 * Did this host wire the control surface, or only the observation one?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE QUESTION AND NOT FIVE
 * ---------------------------------------------------------------------------
 *
 * Three of the five control verbs — interrupt, respond-permission, dispose —
 * are backed by `RunSource` members that are *required*, because the
 * completions surface has always needed them: a chat request has to be able to
 * hang up its own run. So checking "is this member present?" per verb, which is
 * what the first version of these routes did, made `notControllable()`
 * unreachable for exactly those three. A host that wired only the observation
 * surface would answer 501 to `send` and `stop-task`, in a sentence claiming to
 * be observe-only, while cheerfully accepting a remote interrupt and a remote
 * *permission answer* on the same runs.
 *
 * The distinguishing member is {@link RunSource.startUserRun}: it exists for no
 * other caller, it is the one both hosts add when they mean "this deployment is
 * remotely controllable", and it is the verb whose absence genuinely means the
 * host declined the surface. So the decision is made once, here, and every verb
 * asks the same question — which also means the 501's sentence is true whenever
 * it is sent.
 */
function controlEnabled(context: ServerContext): boolean {
  return context.runs?.startUserRun !== undefined;
}

/** One refusal for "absent" and "not yours" alike, matching the session routes. */
function unknownRun(): ServerReply {
  return fail(404, 'invalid_request_error', 'unknown_run', 'No such run for this connection.');
}

/**
 * One refusal for "no such conversation" and "not this connection's" alike.
 *
 * Worded and coded identically to the session routes' own refusal, and that
 * identity is the point: a caller able to distinguish the two could ask about
 * ids until one answered differently, and learn which conversations exist on
 * the serving machine without ever being allowed to read one.
 */
function unknownSession(): ServerReply {
  return fail(
    404,
    'invalid_request_error',
    'unknown_session',
    'No such conversation for this connection.',
  );
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

/**
 * `GET /api/v0/runs/live-work`: which of *this connection's* conversations
 * still hold background work.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS LEDGER-SCOPED AND NOT MERELY ALLOWANCE-SCOPED
 * ---------------------------------------------------------------------------
 *
 * Every sibling route filters by `connectionAllowsProfile`, because it answers
 * about *runs*, and a run names the account it bills. This one answers about
 * *sessions*, and a session id carries no account — so the allowance is not a
 * filter that can be applied to it at all. The first version of this route
 * therefore filtered by nothing, and handed any token, however narrowly scoped,
 * every live session id on the machine plus every delegated task's
 * `description` — which is provider-authored content about work the token had
 * no part in.
 *
 * The right authority is the ledger, which is the single arbiter of "may this
 * connection touch this session" for list, replay and resume alike. Asking it
 * here makes this route agree with `/api/v0/sessions` rather than inventing a
 * fourth rule, and it means the serving desktop's own conversations are absent
 * for the same reason they are absent from the session list: they were never
 * recorded against a connection.
 *
 * A build with no ledger cannot answer the question, so it answers *empty*
 * rather than everything. Empty is contractually safe here in a way it is not
 * everywhere: `RunsLiveWorkResponse` is a set of conversations known to be
 * working — "keep these", never "the rest are finished" — so an under-complete
 * answer costs a client nothing it can act on, while an over-complete one is
 * the leak.
 */
async function handleLiveWork(
  context: ServerContext,
  connection: ServerConnection,
): Promise<ServerReply> {
  const liveWork = context.runs?.liveWork;
  const ledger = context.ledger;
  const empty: ServerLiveWorkBody = {
    object: 'artemis.live-work',
    sessionIds: [],
    working: [],
    delegated: [],
  };
  if (liveWork === undefined || ledger === undefined) return ok(empty);

  const profiles = await visibleProfiles(context, connection);
  const scope = {
    workspaceKey: workspaceKeyFor(connection),
    profileIds: profiles.map((profile) => String(profile.id)),
  };
  const mine = (sessionId: string): boolean => ledger.mayAccess(scope, sessionId);

  const work = await liveWork();
  const body: ServerLiveWorkBody = {
    object: 'artemis.live-work',
    sessionIds: work.sessionIds.filter((id) => mine(String(id))),
    working: work.working.filter((id) => mine(String(id))),
    // The rows carry provider-authored task descriptions, so they are filtered
    // by the same gate rather than a laxer one.
    delegated: work.delegated.filter((entry) => mine(String(entry.sessionId))),
  };
  return ok(body);
}

/**
 * The accounts this connection can see, for scoping.
 *
 * Reads the same cached catalogue `/api/v0/sessions` does — the read is memoised
 * for minutes inside {@link Catalogue}, so a client polling live work does not
 * spawn a provider CLI per poll.
 */
async function visibleProfiles(
  context: ServerContext,
  connection: ServerConnection,
): Promise<readonly ServerProfile[]> {
  return visibleToConnection(connection, await context.catalogue.read({}));
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
 * principal is owed more than the completions surface offers — but "the user's
 * own settings" is a statement about which knobs are offered, not about what
 * this route will pass through. The input is rebuilt field by field from an
 * explicit allowlist (`runInput.ts`), and then the token's scope is enforced
 * before anything is spent: the profile must be inside the allowance (with the
 * same one-refusal-for-absent-and-invisible rule the run routes use), a named
 * model must be allowed on it, and **every path the input carries** is confined
 * to the connection's pin.
 *
 * Every path, not just `cwd`. `additionalDirectories` reaches the Claude SDK's
 * option of the same name and Codex's `writableRoots`, so confining `cwd` alone
 * left the pin — the token's entire authority story — steppable in one line of
 * JSON. They go through the same confinement, in a loop over the paths the
 * allowlist declares, so a path-bearing field cannot be added upstream and
 * quietly miss the check.
 */
async function handleStartRun(input: RemoteRequestInput): Promise<ServerReply> {
  const { request, context, connection } = input;
  const startUserRun = context.runs?.startUserRun;
  if (!controlEnabled(context) || startUserRun === undefined) return notControllable();

  let runInput: RunInput;
  try {
    runInput = readRunInput(request.body);
  } catch (error) {
    return fail(
      400,
      'invalid_request_error',
      'invalid_body',
      error instanceof RunInputError
        ? error.message
        : 'The body must be `{ input }` carrying providerId, profileId, cwd and prompt.',
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

  /*
   * The resume gate, and it must come before anything that *uses* the session
   * id.
   *
   * -----------------------------------------------------------------------
   * WHY A SESSION ID IS A CAPABILITY, NOT A PARAMETER
   * -----------------------------------------------------------------------
   *
   * `resumeSessionId` names a stored conversation, and the provider's store
   * holds every conversation on the machine — the serving user's own local
   * history included. Nothing downstream of here checks ownership:
   * `RunRegistry.start` has no notion of one, so it honours the id and the
   * provider re-opens the transcript.
   *
   * That alone would be a read of somebody else's conversation. What makes it
   * worse is what happens *next*: the run announces its session id, the guard
   * hears it, and the host records it into the ledger against this connection.
   * The ledger is keyed on session id and the last writer wins, so the entry
   * that said "this belongs to the desktop user" is overwritten to say "this
   * belongs to the caller's token" — and `mayAccess` starts returning true.
   * The private transcript then becomes durably readable through
   * `/api/v0/sessions/{id}/messages`, by the ordinary route, forever. A
   * borrowed id would have laundered itself into an owned one.
   *
   * So the id is checked against the same ledger scope the sibling completions
   * surface checks, with the same refusal the session routes give: "not yours"
   * and "not there" are one answer, because a caller that could tell them
   * apart could enumerate which conversations exist on the machine.
   *
   * -----------------------------------------------------------------------
   * WHY THIS IS ALSO BEFORE `resolvePinnedCwd`
   * -----------------------------------------------------------------------
   *
   * Not merely tidy ordering. `resolvePinnedCwd` passes the session id to the
   * workspace resolver, whose scratch map is keyed on session id alone with no
   * connection scoping — so naming another connection's session would resolve
   * this run *into that connection's scratch directory*. Refusing first is
   * what keeps a foreign id from reaching it at all.
   *
   * -----------------------------------------------------------------------
   * WHY NO LEDGER MEANS REFUSE
   * -----------------------------------------------------------------------
   *
   * The completions surface skips this check when there is no ledger, which is
   * defensible there: that surface cannot start a conversation it could later
   * be asked to re-enter, so there is nothing to own. This route can. A build
   * with no ledger has no way to establish that a session belongs to anybody,
   * and "cannot prove it is yours" has to read as no — the alternative is a
   * deployment where every stored conversation on the machine is resumable by
   * any token, reached by dropping one optional dependency.
   */
  if (runInput.resumeSessionId !== undefined) {
    const ledger = context.ledger;
    if (ledger === undefined) return unknownSession();
    const profiles = await visibleProfiles(context, connection);
    const scope = {
      workspaceKey: workspaceKeyFor(connection),
      profileIds: profiles.map((profile) => String(profile.id)),
    };
    if (!ledger.mayAccess(scope, String(runInput.resumeSessionId))) return unknownSession();
  }

  const pinned = await resolvePinnedCwd(input, runInput.cwd, runInput.resumeSessionId);
  if (typeof pinned !== 'string') return pinned;

  /*
   * The extra roots, against the same pin.
   *
   * An `ephemeral` or `none` workspace has no directory a caller could name, so
   * naming one is refused outright rather than silently rewritten to the
   * scratch path: a run told it may write to `/srv/data` and given a temporary
   * folder instead is a run whose grant was quietly changed under it.
   */
  const extraRoots: string[] = [];
  for (const { field, path } of pathsOf(runInput).slice(1)) {
    if (connection.workspace.kind !== 'directory') {
      return fail(
        403,
        'invalid_request_error',
        'outside_workspace',
        `This connection has no directory to widen, so \`${field}\` cannot be honoured.`,
      );
    }
    const inside = confineToRoot(resolve(connection.workspace.path), path);
    if (inside === undefined) return outsideWorkspace(resolve(connection.workspace.path));
    extraRoots.push(inside);
  }

  let handle: RunHandle;
  try {
    handle = await startUserRun({
      ...runInput,
      cwd: pinned,
      ...(runInput.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: extraRoots }),
    });
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

  /*
   * The attribution line, written at the moment the plan starts being spent.
   *
   * Ids only — see `RemoteAccessEvent`. The prompt that was sent is on this
   * stack and does not go anywhere near the log; what is recorded is that
   * *this* token started *this* run on *this* account, in this directory,
   * which is the question a surprising bill or an unexplained commit asks.
   */
  context.onRemoteAccess?.({
    kind: 'remote.run.started',
    connectionId: connection.id,
    runId: String(handle.runId),
    profileId: String(handle.profileId),
    cwd: handle.cwd,
  });

  const body: ServerRunBody = { object: 'artemis.run', run: handle };
  return ok(body);
}

/** The one refusal for a path that is not inside the pin. */
function outsideWorkspace(root: string): ServerReply {
  return fail(
    403,
    'invalid_request_error',
    'outside_workspace',
    `This connection is pinned to ${root}.`,
  );
}

/**
 * `requested`, if it is `root` or lies beneath it. `undefined` otherwise.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PATH IS RESOLVED BEFORE IT IS COMPARED
 * ---------------------------------------------------------------------------
 *
 * A prefix test on the raw string is not containment, and the counterexample is
 * one line long: `/w/../../etc` starts with `/w/` and names `/etc`. Every
 * dot-segment spelling has to be collapsed *before* the comparison, which is
 * exactly what `path.resolve` does — it is the same reasoning the renderer's
 * `file:` navigation check states, where the raw URL is discarded in favour of
 * the parser's serialized `href` for this precise reason.
 *
 * The boundary test is then `===` or a prefix ending in the path separator, so
 * that `/workspace-2` is not admitted by a `/workspace` pin. A trailing slash
 * on the pin would produce the same result; comparing against a resolved root
 * makes it true regardless of how the pin was typed.
 *
 * **What this does not do is resolve symlinks.** A symlink inside the pin that
 * points outside it still leads outside, and `realpath` is the only thing that
 * would catch it — at the cost of an async stat per path and a refusal for any
 * directory that does not yet exist. Artemis's local boundary
 * (`requireAbsolutePath`) is lexical for the same reasons, so this matches the
 * posture rather than inventing a second one; and the pin is a *rooting* rule
 * rather than a sandbox in any case — a shell or an agent inside it can `cd`
 * anywhere the serving user can. What the pin governs is where work is rooted
 * and what a token may *declare* it reaches, and that is what this enforces.
 */
function confineToRoot(root: string, requested: string): string | undefined {
  if (!requested.startsWith('/')) return undefined;
  const resolved = resolve(requested);
  if (resolved === root) return resolved;
  return resolved.startsWith(`${root}${sep}`) ? resolved : undefined;
}

/**
 * The working directory a bridge-started run — or shell — actually gets.
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
 *
 * `requested` is optional because the terminal route's is: a remote client
 * opening a shell may honestly have no directory to name, and the pin is the
 * right default. A run always names one, because a run is started from a
 * conversation that is already somewhere.
 */
async function resolvePinnedCwd(
  input: RemoteRequestInput,
  requested: string | undefined,
  sessionId?: string,
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
    const root = resolve(workspace.path);
    if (requested === undefined) return root;
    const inside = confineToRoot(root, requested);
    if (inside !== undefined) return inside;
    return outsideWorkspace(root);
  }

  if (context.workspaces === undefined) return notControllable();
  try {
    const resolved = await context.workspaces.resolve({
      connectionId: connection.id,
      workspace,
      ...(sessionId === undefined ? {} : { sessionId }),
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
  // One gate for all five verbs — see `controlEnabled` on why per-member checks
  // silently let interrupt, respond-permission and dispose through.
  if (runs === undefined || getRun === undefined || !controlEnabled(context)) {
    return notControllable();
  }

  const run = await getRun(runId);
  if (run === undefined || !connectionAllowsProfile(connection, run.profileId)) {
    return unknownRun();
  }

  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<
    string,
    unknown
  >;

  /*
   * Written before the verb runs, not after.
   *
   * The record exists for the incident where something went wrong, and the
   * verbs most worth attributing — an interrupt, an `allow` on a permission
   * prompt — are exactly the ones that can be followed by a crash. A line
   * written after a successful return is the line missing from every
   * transcript anybody ever needs. So this says *asked*, and the run's own
   * lifecycle lines beside it in the same file say what happened next.
   */
  const record = (): void => {
    context.onRemoteAccess?.({
      kind: action === 'respond-permission' ? 'remote.permission.answered' : 'remote.run.acted',
      connectionId: connection.id,
      action,
      runId,
      profileId: String(run.profileId),
    });
  };

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
        record();
        const outcome = await runs.send(runId, body['text'], attachments);
        const reply: ServerRunSendBody = {
          object: 'artemis.run.send',
          runId,
          deliveredImmediately: outcome.deliveredImmediately,
        };
        return ok(reply);
      }

      case 'interrupt': {
        record();
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
        record();
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
        record();
        await runs.stopTask(runId, body['taskId']);
        const reply: ServerRunActionBody = { object: 'artemis.run.action', runId };
        return ok(reply);
      }

      case 'dispose': {
        record();
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
/* Terminal routes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The answer when this build serves no shells.
 *
 * Distinct from {@link notControllable} because it is a different absence and a
 * person reading it deserves to know which: a headless deployment has no PTY to
 * offer at all, while a build with no control verbs is refusing something it
 * could in principle do. The client renders either as the sentence it is.
 */
function noTerminals(): ServerReply {
  return fail(
    501,
    'invalid_request_error',
    'not_implemented',
    'This Artemis does not serve shells over the wire — the machine hosting it has no terminal surface attached.',
  );
}

/** Terminal failures, as sentences rather than stack traces. */
function terminalFailure(error: unknown): ServerReply {
  if (error instanceof UnknownRemoteTerminalError) {
    return fail(404, 'invalid_request_error', 'unknown_terminal', error.message);
  }
  if (error instanceof TooManyRemoteTerminalsError) {
    return fail(429, 'invalid_request_error', 'too_many_terminals', error.message);
  }
  return fail(
    400,
    'invalid_request_error',
    'terminal_failed',
    error instanceof Error ? error.message : 'The terminal request failed.',
  );
}

/** `GET /api/v0/terminals`: the shells this connection's family opened. */
function handleTerminalList(input: RemoteRequestInput): ServerReply {
  const terminals = input.context.terminals;
  if (terminals === undefined) return noTerminals();
  const body: ServerTerminalsBody = {
    object: 'artemis.terminals',
    terminals: terminals.list(input.connection),
  };
  return ok(body);
}

/**
 * `POST /api/v0/terminals`: open one.
 *
 * The body names a directory, a width and a height, and nothing else — see
 * `terminals.ts` on why there is no argv and no environment on this wire. The
 * directory is confined to the connection's pin by the same function a run's
 * is, so a shell cannot be opened somewhere the token could not have run a
 * turn; an absent one means the pin itself, which is the honest default for a
 * client whose own idea of a path is a path on the wrong machine.
 */
async function handleTerminalStart(input: RemoteRequestInput): Promise<ServerReply> {
  const terminals = input.context.terminals;
  if (terminals === undefined) return noTerminals();

  const body = (typeof input.request.body === 'object' && input.request.body !== null
    ? input.request.body
    : {}) as Record<string, unknown>;

  const cols = readDimension(body['cols']);
  const rows = readDimension(body['rows']);
  if (cols === undefined || rows === undefined) {
    return fail(
      400,
      'invalid_request_error',
      'invalid_body',
      '`cols` and `rows` must be positive integers — a shell that starts at the wrong size draws its prompt at the wrong width, once.',
    );
  }

  const requested = typeof body['cwd'] === 'string' && body['cwd'].length > 0
    ? (body['cwd'] as string)
    : undefined;
  const cwd = await resolvePinnedCwd(input, requested);
  if (typeof cwd !== 'string') return cwd;

  try {
    const info = await terminals.start(input.connection, { cwd, cols, rows });
    const reply: ServerTerminalBody = { object: 'artemis.terminal', terminal: info };
    return ok(reply);
  } catch (error) {
    return terminalFailure(error);
  }
}

/** `write` / `resize` / `close` (POST) and `replay` (GET), on one shell. */
function handleTerminalAction(
  input: RemoteRequestInput,
  terminalId: string,
  action: string,
): ServerReply {
  const terminals = input.context.terminals;
  if (terminals === undefined) return noTerminals();

  const { method, connection } = input;
  const body = (typeof input.request.body === 'object' && input.request.body !== null
    ? input.request.body
    : {}) as Record<string, unknown>;

  try {
    if (action === 'replay') {
      if (method !== 'GET') return methodNotAllowed('A terminal replay is a GET.');
      const tail = terminals.replay(connection, terminalId);
      const reply: ServerTerminalReplayBody = {
        object: 'artemis.terminal.replay',
        id: terminalId,
        data: tail.data,
        truncated: tail.truncated,
      };
      return ok(reply);
    }

    if (method !== 'POST') return methodNotAllowed('Terminal actions are POSTs.');

    switch (action) {
      case 'write': {
        if (typeof body['data'] !== 'string') {
          return fail(400, 'invalid_request_error', 'invalid_body', '`data` must be a string.');
        }
        // Keystrokes, so no length floor: an empty write is a no-op rather than
        // an error, which is what a paste of nothing should be.
        const info = terminals.write(connection, terminalId, body['data']);
        return ok({ object: 'artemis.terminal', terminal: info } satisfies ServerTerminalBody);
      }

      case 'resize': {
        const cols = readDimension(body['cols']);
        const rows = readDimension(body['rows']);
        if (cols === undefined || rows === undefined) {
          return fail(
            400,
            'invalid_request_error',
            'invalid_body',
            '`cols` and `rows` must be positive integers.',
          );
        }
        const info = terminals.resize(connection, terminalId, cols, rows);
        return ok({ object: 'artemis.terminal', terminal: info } satisfies ServerTerminalBody);
      }

      case 'close': {
        // The one route that ends a shell, and it exists because the ✕ does.
        // Nothing else on this surface — not a dropped stream, not a disposed
        // run — reaches it. See `terminals.ts`.
        const info = terminals.close(connection, terminalId);
        return ok({ object: 'artemis.terminal', terminal: info } satisfies ServerTerminalBody);
      }

      default:
        return fail(
          404,
          'invalid_request_error',
          'unknown_endpoint',
          `No terminal action "${action}".`,
        );
    }
  } catch (error) {
    return terminalFailure(error);
  }
}

/** A column or row count: a positive integer, and sane for a screen. */
function readDimension(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  if (raw < 1 || raw > 10_000) return undefined;
  return raw;
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
      recheckMs: context.remoteStream?.recheckMs ?? AUTHORISATION_RECHECK_MS,
      stillAuthorised: authorisationCheck(context, connection),
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(context.guard === undefined ? {} : { guard: context.guard }),
    }),
  };
}

/**
 * Is this connection still one the server would let in?
 *
 * Built once per stream, asked repeatedly while it is open. Reads through
 * {@link ServerContext.connectionsNow} so it sees revocations and expiries that
 * happened *after* the stream attached — the request-time gate cannot, because
 * it ran once, hours ago.
 */
function authorisationCheck(
  context: ServerContext,
  connection: ServerConnection,
): () => RemoteClosedPayload | undefined {
  const now = context.connectionsNow;
  return () => {
    // No live reader: fall back to the request's snapshot, which at least
    // catches an expiry that passed while the stream was open.
    const current = (now === undefined ? context.connections : now()).find(
      (candidate) => candidate.id === connection.id,
    );
    if (current === undefined) {
      return {
        reason: 'revoked',
        message: 'This connection was revoked on the serving machine.',
      };
    }
    if (connectionHasExpired(current, Date.now())) {
      return {
        reason: 'expired',
        message: 'This connection has expired. Expiry cannot be extended — ask for a new token.',
      };
    }
    return undefined;
  };
}

/**
 * How long a stream may go without re-asking whether its token is still good.
 *
 * The bound on how long a revoked or expired credential keeps receiving data.
 * Well under the default heartbeat, so a quiet stream is checked on its
 * heartbeat tick and a busy one is checked on this schedule instead of once per
 * event — the check walks the connection list, and a stream carrying PTY bytes
 * at sixty frames a second should not walk it sixty times a second.
 */
const AUTHORISATION_RECHECK_MS = 5_000;

async function* streamFeed(input: {
  readonly feed: PushFeed;
  readonly connection: ServerConnection;
  readonly version: string;
  readonly heartbeatMs: number;
  readonly afterSeq?: number;
  readonly signal?: { readonly aborted: boolean };
  readonly guard?: import('./guard.js').RemoteRunGuard;
  readonly recheckMs?: number;
  readonly stillAuthorised?: () => RemoteClosedPayload | undefined;
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
    const opening = input.stillAuthorised?.();
    if (opening !== undefined) {
      yield sseMessage({ event: REMOTE_STREAM_CLOSED, data: JSON.stringify(opening) });
      return;
    }
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

    let checkedAt = Date.now();
    while (!aborted()) {
      /*
       * Re-asked here rather than only on the heartbeat, so that a stream busy
       * enough never to idle is still cut off. The `finally` below detaches the
       * guard on the way out, which arms the grace timer — so a revoked token's
       * runs are interrupted rather than left running with nobody watching.
       */
      if (Date.now() - checkedAt >= (input.recheckMs ?? AUTHORISATION_RECHECK_MS)) {
        checkedAt = Date.now();
        const closed = input.stillAuthorised?.();
        if (closed !== undefined) {
          yield sseMessage({ event: REMOTE_STREAM_CLOSED, data: JSON.stringify(closed) });
          return;
        }
      }

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
