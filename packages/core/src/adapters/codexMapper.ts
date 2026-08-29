/**
 * Codex ⇄ Artemis translation, as pure functions.
 *
 * The counterpart to `mapper.ts`, and written to the same rule: everything here
 * is deterministic and free of I/O — no subprocess, no socket, no clock except
 * the injected one. `codex.ts` is the plumbing; this file is the meaning.
 *
 * ## What the mapping has to guarantee
 *
 * The rules on protocol's `AgentEvent` are a contract, not advice:
 *
 *  1. `session.started` first, `run.end` last, exactly once each, nothing after
 *     `run.end`.
 *  2. `seq` is dense and monotonic from 0. Every event is stamped through
 *     {@link stamp}, including the ones the adapter emits out of band — a
 *     permission prompt arrives as a JSON-RPC *request*, not as a notification,
 *     so it never passes through {@link mapCodexNotification} at all. That is
 *     why the counter lives on {@link CodexMapperState}.
 *  3. Deltas are additive and never re-sent. `text.complete` still carries the
 *     whole block, so a consumer that ignores deltas renders correctly.
 *  4. Every `tool.start` gets a `tool.end` — including on interrupt, where
 *     {@link flushCodexToolCalls} closes the stragglers as `cancelled`.
 *
 * ## Items, not messages
 *
 * Codex models a turn as a list of *items* with `item/started` and
 * `item/completed` bracketing each one, rather than as a stream of messages.
 * That is a better fit for Artemis than it first appears: `tool.start`/`tool.end`
 * fall straight out of the bracket, and an item id is a natural `toolCallId`.
 * The mismatch is on the text side, where Codex brackets an `agentMessage` item
 * whose deltas arrive in between — so `item/started` for text emits nothing and
 * `item/completed` carries the whole block.
 *
 * ## Dropped notifications
 *
 * The protocol has 69 notification variants; Artemis acts on 10. The rest are
 * host-CLI presentation state (MCP startup progress, hook lifecycle, remote
 * control status, realtime audio) with no place in a normalized transcript.
 * Every one is dropped **explicitly** in {@link mapCodexNotification}'s switch,
 * never by falling through a `default` nobody thought about, and no unknown
 * notification throws.
 */

import type {
  AgentError,
  AgentEvent,
  JsonObject,
  JsonValue,
  MessageId,
  RunEndReason,
  RunId,
  SessionId,
  ToolCallId,
  ToolEndStatus,
  UsageSnapshot,
} from '@rx-artemis/protocol';

import {
  CODEX_NOTIFICATION,
  asRecord,
  readNumber,
  readString,
} from './codexProtocol.js';
import type {
  CodexThread,
  CodexThreadItem,
  CodexTokenUsageBreakdown,
  CodexTurn,
} from './codexProtocol.js';

/** The provider id every event from this adapter carries. */
export const CODEX_PROVIDER_ID = 'codex' as const;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** A tool call that has started and not yet ended. */
interface OpenToolCall {
  readonly name: string;
  readonly startedAt: number;
}

/**
 * Per-run mapping state.
 *
 * Handed to {@link mapCodexNotification} and mutated by it — the accumulator
 * pattern rather than hidden state: the same `(notification, state)` pair always
 * produces the same events and the same next state, and a test can inspect the
 * state directly.
 *
 * The adapter shares this object with its approval and teardown paths so `seq`
 * stays dense across *all* emitted events, not just the ones derived from
 * notifications.
 */
export interface CodexMapperState {
  readonly runId: RunId;
  /** Next `seq` to hand out. Dense and monotonic from 0. */
  seq: number;
  /** Injected clock. Tests pass a deterministic one. */
  readonly now: () => number;

  sessionStarted: boolean;
  sessionId: SessionId | undefined;
  /**
   * The live turn's id.
   *
   * Load-bearing rather than informational: `turn/steer` requires an
   * `expectedTurnId` and the server rejects a steer that names the wrong one,
   * so `Run.send()` cannot work without this.
   */
  turnId: string | undefined;
  model: string | undefined;
  cwd: string | undefined;

  /** True once `run.end` has been emitted. Nothing may be emitted after. */
  ended: boolean;

  interruptRequested: boolean;
  disposeRequested: boolean;
  permissionDenyInterrupted: boolean;

  /** Last provider-reported error, used to classify a failing `run.end`. */
  lastError: AgentError | undefined;

  readonly resumedFrom: SessionId | undefined;
  readonly forked: boolean;

  readonly openToolCalls: Map<ToolCallId, OpenToolCall>;
  /**
   * Tool calls that have already received their one terminal event.
   *
   * `openToolCalls` cannot answer "has this ended?" — an id leaves that map
   * both when the call ends and when it is cancelled, so a late `item/completed`
   * for an id closed by {@link flushCodexToolCalls} would look exactly like a
   * first close and emit a second `tool.end`.
   */
  readonly closedToolCalls: Set<ToolCallId>;
  /** Item ids that have streamed at least one text delta. */
  readonly streamedItems: Set<MessageId>;

  /**
   * Running total of every `last` breakdown seen this run.
   *
   * Codex reports usage per *model request*, and a turn is many requests. The
   * per-request numbers go out as `delta` events; this accumulates them so
   * `run.end` can carry an authoritative `final` total without the consumer
   * having to re-add them.
   */
  usageTotal: MutableTokenTotals;
  /** Context window of the model in use, from the most recent usage report. */
  contextWindow: number | undefined;
}

interface MutableTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** True once any usage at all has been reported, so zero is distinguishable. */
  seen: boolean;
}

/** Options for {@link createCodexMapperState}. */
export interface CodexMapperStateOptions {
  readonly now?: () => number;
  readonly resumedFrom?: SessionId;
  readonly forked?: boolean;
  readonly startSeq?: number;
}

/** Create the per-run mapping state. */
export function createCodexMapperState(
  runId: RunId,
  options?: CodexMapperStateOptions,
): CodexMapperState {
  return {
    runId,
    seq: options?.startSeq ?? 0,
    now: options?.now ?? Date.now,
    sessionStarted: false,
    sessionId: undefined,
    turnId: undefined,
    model: undefined,
    cwd: undefined,
    ended: false,
    interruptRequested: false,
    disposeRequested: false,
    permissionDenyInterrupted: false,
    lastError: undefined,
    resumedFrom: options?.resumedFrom,
    forked: options?.forked ?? false,
    openToolCalls: new Map(),
    closedToolCalls: new Set(),
    streamedItems: new Set(),
    usageTotal: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      seen: false,
    },
    contextWindow: undefined,
  };
}

/**
 * Stamp the fields every event carries, consuming one `seq`.
 *
 * Exported because the adapter emits `permission.request` out of band — it
 * arrives as a server-initiated JSON-RPC request rather than a notification —
 * and that event still has to take its turn in the same dense sequence.
 */
export function nextCodexEventEnvelope(state: CodexMapperState): {
  runId: RunId;
  seq: number;
  ts: number;
} {
  return { runId: state.runId, seq: state.seq++, ts: state.now() };
}

const stamp = nextCodexEventEnvelope;

/* -------------------------------------------------------------------------- */
/* Notification mapping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Translate one server notification into zero or more {@link AgentEvent}s.
 *
 * Returns an array rather than a single event because one notification can
 * legitimately produce none (a dropped variant) or several (a `turn/completed`
 * that has to cancel open tool calls before ending the run).
 *
 * **Never throws.** An unrecognised notification, a payload missing the field
 * it is supposed to have, an item type from a newer CLI — all of them produce
 * `[]`. The transport keeps running; the transcript is missing one entry
 * instead of dying.
 */
export function mapCodexNotification(
  method: string,
  params: JsonValue | undefined,
  state: CodexMapperState,
): readonly AgentEvent[] {
  if (state.ended) return [];

  /*
   * Nothing precedes `session.started` — the contract's first rule, enforced
   * rather than assumed. This case is real on 0.147, not defensive:
   * `thread/resume` replays the thread's token usage in the same flush as its
   * response, ahead of the session announcement the adapter synthesizes from
   * that response. Mapping the replay would both put `usage` before
   * `session.started` and count previous turns' tokens — already paid for —
   * into this run's final total.
   */
  if (!state.sessionStarted && method !== CODEX_NOTIFICATION.threadStarted) return [];

  const payload = asRecord(params);

  switch (method) {
    case CODEX_NOTIFICATION.threadStarted:
      return mapThreadStarted(payload, state);

    case CODEX_NOTIFICATION.turnStarted: {
      // Emits nothing. Its only job is to record the turn id, without which
      // `turn/steer` cannot name the turn it means to steer.
      const turn = asRecord(payload['turn']);
      const id = readString(turn, 'id');
      if (id !== undefined) state.turnId = id;
      return [];
    }

    case CODEX_NOTIFICATION.turnCompleted:
      return mapTurnCompleted(payload, state);

    case CODEX_NOTIFICATION.itemStarted:
      return mapItemStarted(payload, state);

    case CODEX_NOTIFICATION.itemCompleted:
      return mapItemCompleted(payload, state);

    case CODEX_NOTIFICATION.agentMessageDelta:
      return mapTextDelta(payload, state);

    case CODEX_NOTIFICATION.reasoningTextDelta:
    case CODEX_NOTIFICATION.reasoningSummaryTextDelta:
      return mapThinkingDelta(payload, state);

    case CODEX_NOTIFICATION.tokenUsageUpdated:
      return mapTokenUsage(payload, state);

    case CODEX_NOTIFICATION.error: {
      // Recorded, not emitted. An error notification is the *reason* a turn
      // fails, and the turn's own `turn/completed` is what ends the run — so
      // this is held until then rather than producing an event of its own.
      const message = readString(payload, 'message');
      if (message !== undefined) {
        state.lastError = { code: 'unknown', message, retryable: false };
      }
      return [];
    }

    /*
     * Everything below is dropped on purpose. Each line is a notification the
     * app server really sends and Artemis really has no use for; listing them
     * means a future reader can tell "considered and rejected" from "never
     * seen".
     *
     * Host-CLI presentation state:
     *   mcpServer/startupStatus/updated, remoteControl/status/changed,
     *   thread/status/changed, model/safetyBuffering/updated, model/rerouted,
     *   configWarning, warning, guardianWarning, deprecationNotice
     * Lifecycle bookkeeping Artemis derives from items instead:
     *   hook/started, hook/completed, serverRequest/resolved,
     *   thread/name/updated, thread/compacted
     * Surfaces Artemis does not expose:
     *   turn/diff/updated, turn/plan/updated, item/commandExecution/outputDelta,
     *   thread/realtime/*, process/*, fuzzyFileSearch/*, app/list/updated
     *
     * `turn/diff/updated` and `item/commandExecution/outputDelta` are the two
     * worth revisiting: the first would drive a live diff pane, the second a
     * streaming terminal. Both need UI that does not exist yet, and emitting
     * them into a transcript that cannot render them would be noise.
     */
    default:
      return [];
  }
}

function mapThreadStarted(
  payload: Record<string, unknown>,
  state: CodexMapperState,
): readonly AgentEvent[] {
  // Guard rather than assert: `thread/started` also fires for threads Artemis
  // did not open, and a second `session.started` would break the ordering
  // contract.
  if (state.sessionStarted) return [];

  const thread = asRecord(payload['thread']) as unknown as CodexThread;
  const sessionId = readString(asRecord(thread), 'id');
  if (sessionId === undefined) return [];

  state.sessionStarted = true;
  state.sessionId = sessionId as SessionId;
  const cwd = readString(asRecord(thread), 'cwd');
  if (cwd !== undefined) state.cwd = cwd;

  return [
    {
      type: 'session.started',
      ...stamp(state),
      sessionId: sessionId as SessionId,
      providerId: CODEX_PROVIDER_ID,
      cwd: state.cwd ?? '',
      ...(state.model === undefined ? {} : { model: state.model }),
      ...(state.resumedFrom === undefined ? {} : { resumedFrom: state.resumedFrom }),
      ...(state.forked ? { forked: true } : {}),
      ...(readString(asRecord(thread), 'cliVersion') === undefined
        ? {}
        : { providerVersion: readString(asRecord(thread), 'cliVersion') }),
    },
  ];
}

function mapTurnCompleted(
  payload: Record<string, unknown>,
  state: CodexMapperState,
): readonly AgentEvent[] {
  const turn = asRecord(payload['turn']) as unknown as CodexTurn;
  const turnRecord = asRecord(turn);
  const status = readString(turnRecord, 'status');

  if (status === 'failed') {
    const error = asRecord(turnRecord['error']);
    const message = readString(error, 'message');
    if (message !== undefined) {
      const httpStatus = readNumber(asRecord(error['codexErrorInfo']), 'httpStatusCode');
      state.lastError = {
        code: classifyHttpStatus(httpStatus),
        message,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        retryable: httpStatus !== undefined && (httpStatus === 429 || httpStatus >= 500),
      };
    }
  }

  const reason: RunEndReason =
    status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'error' : 'completed';

  return finalizeCodexRun(state, reason, {
    ...(state.lastError === undefined ? {} : { error: state.lastError }),
    ...(readNumber(turnRecord, 'durationMs') === undefined
      ? {}
      : { durationMs: readNumber(turnRecord, 'durationMs') }),
  });
}

function mapItemStarted(
  payload: Record<string, unknown>,
  state: CodexMapperState,
): readonly AgentEvent[] {
  const item = asRecord(payload['item']);
  const type = readString(item, 'type');
  const id = readString(item, 'id');
  if (type === undefined || id === undefined) return [];

  const tool = toolDescriptor(type, item);
  // Text and reasoning items are brackets around deltas, not tool calls: the
  // start carries no content, so there is nothing to emit until the deltas
  // arrive. `userMessage` is skipped too — Artemis sent it, and echoing it back
  // would double it in the transcript.
  if (tool === undefined) return [];

  const toolCallId = id as ToolCallId;
  // A duplicate `item/started` for an id already open would produce a second
  // `tool.start` with no matching end.
  if (state.openToolCalls.has(toolCallId) || state.closedToolCalls.has(toolCallId)) return [];

  state.openToolCalls.set(toolCallId, { name: tool.name, startedAt: state.now() });

  return [
    {
      type: 'tool.start',
      ...stamp(state),
      toolCallId,
      name: tool.name,
      input: tool.input,
      ...(tool.title === undefined ? {} : { title: tool.title }),
    },
  ];
}

function mapItemCompleted(
  payload: Record<string, unknown>,
  state: CodexMapperState,
): readonly AgentEvent[] {
  const item = asRecord(payload['item']);
  const type = readString(item, 'type');
  const id = readString(item, 'id');
  if (type === undefined || id === undefined) return [];

  if (type === 'agentMessage') {
    const text = readString(item, 'text') ?? '';
    return [
      {
        type: 'text.complete',
        ...stamp(state),
        messageId: id as MessageId,
        role: 'assistant',
        text,
        // Only claim a block index when the text actually streamed, so a
        // consumer can tell "this was assembled from deltas" from "this arrived
        // whole".
        ...(state.streamedItems.has(id as MessageId) ? { blockIndex: 0 } : {}),
      },
    ];
  }

  // Reasoning has no completion event by design — see the note on
  // `ThinkingDeltaEvent`. The item's final `content` was already delivered as
  // deltas, so re-emitting it here would duplicate the whole block.
  if (type === 'reasoning' || type === 'userMessage') return [];

  const tool = toolDescriptor(type, item);
  if (tool === undefined) return [];

  const toolCallId = id as ToolCallId;
  if (state.closedToolCalls.has(toolCallId)) return [];

  const open = state.openToolCalls.get(toolCallId);
  state.openToolCalls.delete(toolCallId);
  state.closedToolCalls.add(toolCallId);

  const outcome = toolOutcome(type, item);
  const durationMs = readNumber(item, 'durationMs') ?? (open === undefined ? undefined : state.now() - open.startedAt);

  return [
    {
      type: 'tool.end',
      ...stamp(state),
      toolCallId,
      name: open?.name ?? tool.name,
      status: outcome.status,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.resultText === undefined ? {} : { resultText: outcome.resultText }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  ];
}

function mapTextDelta(
  payload: Record<string, unknown>,
  state: CodexMapperState,
): readonly AgentEvent[] {
  const itemId = readString(payload, 'itemId');
  const delta = payload['delta'];
  if (itemId === undefined || typeof delta !== 'string' || delta === '') return [];

  state.streamedItems.add(itemId as MessageId);

  return [
    {
      type: 'text.delta',
      ...stamp(state),
      messageId: itemId as MessageId,
      // Codex has no sub-message block structure: one agentMessage item is one
      // block, so the index is always 0.
      blockIndex: 0,
      text: delta,
    },
  ];
}

function mapThinkingDelta(
  payload: Record<string, unknown>,
  state: CodexMapperState,
): readonly AgentEvent[] {
  const itemId = readString(payload, 'itemId');
  const delta = payload['delta'];
  if (itemId === undefined || typeof delta !== 'string' || delta === '') return [];

  return [
    {
      type: 'thinking.delta',
      ...stamp(state),
      messageId: itemId as MessageId,
      blockIndex: 0,
      text: delta,
    },
  ];
}

/**
 * Turn a usage report into a `delta`-scoped event.
 *
 * ## Why `delta` and not `cumulative`
 *
 * `thread/tokenUsage/updated` carries two breakdowns: `total` for the whole
 * *thread* and `last` for the most recent model request. Measured against the
 * real app server, a turn containing two shell commands produced three usage
 * notifications — one per model request — whose `last` values summed exactly to
 * the final `total` (13563 + 13673 + 13724 = 40960).
 *
 * So `last` is a true delta, and `total` is thread-scoped rather than
 * run-scoped. That distinction is the whole argument: a run is one turn, but a
 * *thread* outlives it, so on a resumed session `total` opens at whatever the
 * previous turns spent. Reporting it as this run's cumulative usage would show
 * the user a number that starts high and belongs to work they already paid for.
 * Summing `last` is correct for a fresh thread and a resumed one alike.
 *
 * `contextTokens` comes from `last.totalTokens` rather than the running total,
 * because it answers a different question — how full the window is right now,
 * not how much has been billed.
 *
 * ## Only the live turn's reports count
 *
 * A resumed thread replays its most recent turn's usage right after the
 * `thread/resume` response, before this run's turn begins — tokens the run
 * that spent them already reported. The replay names the turn it belongs to,
 * so a report for a turn this run is not running is someone else's bill and
 * is dropped rather than summed.
 */
function mapTokenUsage(
  payload: Record<string, unknown>,
  state: CodexMapperState,
): readonly AgentEvent[] {
  const reportedTurnId = readString(payload, 'turnId');
  if (reportedTurnId !== undefined && reportedTurnId !== state.turnId) return [];

  const usage = asRecord(payload['tokenUsage']);
  const last = asRecord(usage['last']) as unknown as CodexTokenUsageBreakdown;
  const lastRecord = asRecord(last);
  if (Object.keys(lastRecord).length === 0) return [];

  const contextWindow = readNumber(usage, 'modelContextWindow');
  if (contextWindow !== undefined) state.contextWindow = contextWindow;

  const inputTokens = readNumber(lastRecord, 'inputTokens') ?? 0;
  const outputTokens = readNumber(lastRecord, 'outputTokens') ?? 0;
  const cacheReadInputTokens = readNumber(lastRecord, 'cachedInputTokens') ?? 0;

  state.usageTotal.inputTokens += inputTokens;
  state.usageTotal.outputTokens += outputTokens;
  state.usageTotal.cacheReadInputTokens += cacheReadInputTokens;
  state.usageTotal.seen = true;

  const contextTokens = readNumber(lastRecord, 'totalTokens');

  return [
    {
      type: 'usage',
      ...stamp(state),
      usage: {
        scope: 'delta',
        tokens: { inputTokens, outputTokens, cacheReadInputTokens },
        ...(contextTokens === undefined ? {} : { contextTokens }),
        ...(state.contextWindow === undefined ? {} : { contextWindow: state.contextWindow }),
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Termination                                                                */
/* -------------------------------------------------------------------------- */

/** Options for {@link finalizeCodexRun}. */
export interface FinalizeCodexRunOptions {
  readonly error?: AgentError;
  readonly durationMs?: number;
}

/**
 * Close the run: cancel anything still open, then emit exactly one `run.end`.
 *
 * Idempotent. A run can reach here from several directions at once — the
 * server's own `turn/completed`, a dispose racing it, an abort signal — and only
 * the first may produce events.
 */
export function finalizeCodexRun(
  state: CodexMapperState,
  reason: RunEndReason,
  options?: FinalizeCodexRunOptions,
): readonly AgentEvent[] {
  if (state.ended) return [];

  // Artemis's own intent outranks whatever the transport reported: a turn that
  // reports `completed` because the server noticed the interrupt in time is
  // still an interrupt from the user's point of view.
  const effective = effectiveReason(state, reason);

  // Cancel before ending, so no `tool.start` is left without its `tool.end`.
  const events = [...flushCodexToolCalls(state)];

  state.ended = true;

  const error = options?.error ?? state.lastError;
  const usage = finalUsage(state);

  events.push({
    type: 'run.end',
    ...stamp(state),
    reason: effective,
    ...(effective === 'error' && error !== undefined ? { error } : {}),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(usage === undefined ? {} : { usage }),
    ...(options?.durationMs === undefined ? {} : { durationMs: options.durationMs }),
  });

  return events;
}

/** Artemis's own intent outranks whatever the transport reports. */
function effectiveReason(state: CodexMapperState, fallback: RunEndReason): RunEndReason {
  if (state.disposeRequested) return 'disposed';
  if (state.interruptRequested) return 'interrupted';
  if (state.permissionDenyInterrupted) return 'permission_denied';
  return fallback;
}

/**
 * Close every open tool call as `cancelled`.
 *
 * Exported because dispose has to run this even when no `turn/completed` ever
 * arrives — a subprocess that died mid-command leaves the UI with a spinner it
 * can never clear otherwise.
 */
export function flushCodexToolCalls(state: CodexMapperState): readonly AgentEvent[] {
  if (state.openToolCalls.size === 0) return [];

  const events: AgentEvent[] = [];
  for (const [toolCallId, open] of state.openToolCalls) {
    state.closedToolCalls.add(toolCallId);
    events.push({
      type: 'tool.end',
      ...stamp(state),
      toolCallId,
      name: open.name,
      status: 'cancelled',
      durationMs: state.now() - open.startedAt,
    });
  }
  state.openToolCalls.clear();
  return events;
}

/** The authoritative run total, or nothing when the provider never reported any. */
function finalUsage(state: CodexMapperState): UsageSnapshot | undefined {
  if (!state.usageTotal.seen) return undefined;
  return {
    scope: 'final',
    tokens: {
      inputTokens: state.usageTotal.inputTokens,
      outputTokens: state.usageTotal.outputTokens,
      cacheReadInputTokens: state.usageTotal.cacheReadInputTokens,
    },
    ...(state.contextWindow === undefined ? {} : { contextWindow: state.contextWindow }),
  };
}

/* -------------------------------------------------------------------------- */
/* Items → tools                                                              */
/* -------------------------------------------------------------------------- */

/** How one item renders as a tool call, or `undefined` if it is not one. */
interface ToolDescriptor {
  readonly name: string;
  readonly input: JsonObject;
  readonly title?: string;
}

/**
 * Map an item type onto a tool name Artemis can render.
 *
 * Codex names its item types after what they *are*; Artemis's transcript is
 * built around tool names as the provider reports them. These are the names the
 * UI shows, so they are chosen to read like tools rather than like protocol
 * variants — `Shell` rather than `commandExecution`.
 */
function toolDescriptor(type: string, item: Record<string, unknown>): ToolDescriptor | undefined {
  switch (type) {
    case 'commandExecution': {
      const command = readString(item, 'command') ?? '';
      const cwd = readString(item, 'cwd');
      return {
        name: 'Shell',
        input: { command, ...(cwd === undefined ? {} : { cwd }) },
        title: command === '' ? 'Shell' : truncate(command, 120),
      };
    }

    case 'fileChange': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const paths = changes
        .map((change) => readString(asRecord(change), 'path'))
        .filter((path): path is string => path !== undefined);
      return {
        name: 'ApplyPatch',
        input: { paths: paths as unknown as JsonValue } as JsonObject,
        title:
          paths.length === 0
            ? 'Edit files'
            : paths.length === 1
              ? `Edit ${paths[0] as string}`
              : `Edit ${String(paths.length)} files`,
      };
    }

    case 'mcpToolCall': {
      const server = readString(item, 'server') ?? 'mcp';
      const tool = readString(item, 'tool') ?? 'tool';
      const args = item['arguments'];
      return {
        name: `${server}.${tool}`,
        input: (typeof args === 'object' && args !== null && !Array.isArray(args)
          ? (args as JsonObject)
          : {}),
        title: `${server}.${tool}`,
      };
    }

    case 'webSearch': {
      const query = readString(item, 'query') ?? '';
      return {
        name: 'WebSearch',
        input: { query },
        title: query === '' ? 'Web search' : `Search: ${truncate(query, 100)}`,
      };
    }

    default:
      return undefined;
  }
}

/** How a finished item's outcome reads as a `tool.end`. */
interface ToolOutcome {
  readonly status: ToolEndStatus;
  readonly result?: JsonValue;
  readonly resultText?: string;
  readonly error?: AgentError;
}

function toolOutcome(type: string, item: Record<string, unknown>): ToolOutcome {
  if (type === 'commandExecution') {
    const exitCode = readNumber(item, 'exitCode');
    const output = readString(item, 'aggregatedOutput');
    const status = readString(item, 'status');

    // `declined` is what a refused approval looks like on the way back, and it
    // has its own `ToolEndStatus` for a reason: the UI renders a denial
    // differently from a failure, and a command the *user* refused must never
    // read as one that ran and succeeded. Checked before the exit code, which
    // is absent on this path and would otherwise fall through to `ok`.
    if (status === 'declined') {
      return {
        status: 'denied',
        ...(output === undefined ? {} : { resultText: output }),
      };
    }

    // A non-zero exit is a *result*, not an adapter error: the command ran and
    // said no. The model is expected to read the output and adapt, so the
    // transcript shows it as a failed tool rather than a broken run.
    const failed = status === 'failed' || (exitCode !== undefined && exitCode !== 0);
    return {
      status: failed ? 'error' : 'ok',
      ...(exitCode === undefined ? {} : { result: { exitCode } }),
      ...(output === undefined ? {} : { resultText: output }),
      ...(failed
        ? {
            error: {
              code: 'unknown' as const,
              message:
                exitCode === undefined
                  ? 'The command failed.'
                  : `The command exited with code ${String(exitCode)}.`,
              retryable: false,
            },
          }
        : {}),
    };
  }

  if (type === 'fileChange') {
    const status = readString(item, 'status');
    if (status === 'declined') {
      return { status: 'denied', result: { status } };
    }
    return {
      status: status === 'failed' ? 'error' : 'ok',
      ...(status === undefined ? {} : { result: { status } }),
    };
  }

  if (type === 'mcpToolCall') {
    const error = item['error'];
    if (error !== undefined && error !== null) {
      return {
        status: 'error',
        result: error as JsonValue,
        error: {
          code: 'unknown',
          message: readString(asRecord(error), 'message') ?? 'The MCP tool call failed.',
          retryable: false,
        },
      };
    }
    const result = item['result'];
    return {
      status: 'ok',
      ...(result === undefined || result === null ? {} : { result: result as JsonValue }),
    };
  }

  return { status: 'ok' };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function classifyHttpStatus(status: number | undefined): AgentError['code'] {
  if (status === undefined) return 'unknown';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_unavailable';
  if (status === 400 || status === 422) return 'invalid_request';
  return 'unknown';
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/** Read a stored item into the events a live one would have produced. */
export function replayCodexItem(
  item: CodexThreadItem,
  state: CodexMapperState,
): readonly AgentEvent[] {
  const record = asRecord(item);
  const type = readString(record, 'type');
  const id = readString(record, 'id');
  if (type === undefined || id === undefined) return [];

  if (type === 'userMessage') {
    const content = Array.isArray(record['content']) ? (record['content'] as unknown[]) : [];
    const text = content
      .map((part) => readString(asRecord(part), 'text'))
      .filter((part): part is string => part !== undefined)
      .join('');
    if (text === '') return [];
    return [
      {
        type: 'text.complete',
        ...stamp(state),
        messageId: id as MessageId,
        role: 'user',
        text,
        replay: true,
      },
    ];
  }

  if (type === 'agentMessage') {
    return [
      {
        type: 'text.complete',
        ...stamp(state),
        messageId: id as MessageId,
        role: 'assistant',
        text: readString(record, 'text') ?? '',
        replay: true,
      },
    ];
  }

  const tool = toolDescriptor(type, record);
  if (tool === undefined) return [];

  const outcome = toolOutcome(type, record);
  return [
    {
      type: 'tool.start',
      ...stamp(state),
      toolCallId: id as ToolCallId,
      name: tool.name,
      input: tool.input,
      ...(tool.title === undefined ? {} : { title: tool.title }),
    },
    {
      type: 'tool.end',
      ...stamp(state),
      toolCallId: id as ToolCallId,
      name: tool.name,
      status: outcome.status,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.resultText === undefined ? {} : { resultText: outcome.resultText }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    },
  ];
}
