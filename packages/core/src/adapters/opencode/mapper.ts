/**
 * ACP ⇄ Artemis translation for OpenCode, as pure functions.
 *
 * The counterpart to `codexMapper.ts`, written to the same rule: everything
 * here is deterministic and free of I/O — no subprocess, no socket, no clock
 * except the injected one. `opencode.ts` is the plumbing; this file is the
 * meaning.
 *
 * ## What the mapping has to guarantee
 *
 * The rules on protocol's `AgentEvent` are a contract, not advice:
 *
 *  1. `session.started` first, `run.end` last, exactly once each, nothing after
 *     `run.end`.
 *  2. `seq` is dense and monotonic from 0. Every event is stamped through
 *     {@link stampOpencodeEvent}, including the ones the adapter emits out of
 *     band — an approval arrives as a JSON-RPC *request*, not as a
 *     `session/update`, so it never passes through {@link mapOpencodeUpdate}.
 *  3. Deltas are additive and never re-sent. `text.complete` still carries the
 *     whole block, so a consumer that ignores deltas renders correctly.
 *  4. Every `tool.start` gets a `tool.end` — including on interrupt, where
 *     {@link flushOpencodeToolCalls} closes the stragglers as `cancelled`.
 *
 * ## Three things learned by driving the real agent
 *
 * Every one of these would have been guessed wrong from the schema alone, and
 * each is the reason for a piece of state below. Verified against
 * `opencode acp` 1.18.18 on 2026-08-17.
 *
 * **A `tool_call` arrives before its arguments do.** The first notification
 * carries `status: "pending"` and an *empty* `rawInput`; the real arguments
 * land on the `in_progress` update that follows. Artemis's union has no
 * "tool updated" event — `tool.start` carries the input and there is no second
 * chance — so emission is deferred until the arguments exist (or the call ends,
 * whichever happens first). A row that appears a beat later is a far smaller
 * defect than a row that permanently claims the tool was called with `{}`.
 *
 * **`title` is overwritten mid-call, and means two different things.** The
 * first title is the tool's name (`"write"`); the last is a display summary
 * (the file path it wrote). Both are wanted, in different fields, so the first
 * is kept as `name` and the newest as `title`.
 *
 * **`usage_update` is not in the ACP spec.** OpenCode extends `sessionUpdate`
 * with `{ used, size, cost: { amount, currency } }`, which is exactly Artemis's
 * context-tokens / context-window / cost triple. That extension is why this
 * provider satisfies the seam's usage requirement over the transport instead of
 * needing a second subprocess to ask.
 *
 * ## Dropped updates
 *
 * `plan`, `available_commands_update` and `current_mode_update` are dropped
 * **explicitly** in {@link mapOpencodeUpdate}'s switch, never by falling through
 * a `default` nobody thought about. Artemis has no todo surface for a plan, and
 * slash commands belong to the provider's own composer. An unknown
 * `sessionUpdate` is dropped without throwing, the same rule the Claude mapper
 * follows for unrecognised SDK messages.
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

import type {
  AcpPromptUsage,
  AcpSessionNotification,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallStatus,
} from '../acp/protocol.js';
import { isTerminalToolStatus } from '../acp/protocol.js';

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** A tool call seen but not yet closed. */
interface OpenToolCall {
  /** The provider's first title, which is the tool's name. */
  readonly name: string;
  /** The newest title, which is a display summary. */
  title: string;
  input: JsonObject;
  status: AcpToolCallStatus | undefined;
  /** True once `tool.start` has been emitted for this id. */
  started: boolean;
  readonly startedAt: number;
}

/** One in-flight text or thinking block. */
interface OpenTextBlock {
  readonly blockIndex: number;
  text: string;
}

/** Everything the mapper has to remember between updates. */
export interface OpencodeMapperState {
  readonly runId: RunId;
  /** Next `seq` to hand out. Dense and monotonic from 0. */
  seq: number;
  /** Injected clock. Tests pass a deterministic one. */
  readonly now: () => number;

  sessionStarted: boolean;
  sessionId: SessionId | undefined;
  model: string | undefined;
  cwd: string | undefined;

  /** True once `run.end` has been emitted. Nothing may be emitted after. */
  ended: boolean;

  interruptRequested: boolean;
  disposeRequested: boolean;

  /** Last error seen, used to classify a failing `run.end`. */
  lastError: AgentError | undefined;

  readonly resumedFrom: SessionId | undefined;
  readonly forked: boolean;

  readonly openToolCalls: Map<ToolCallId, OpenToolCall>;
  /**
   * Ids that have already received their one terminal event.
   *
   * `openToolCalls` cannot answer "has this ended?" — an id leaves that map
   * both when the call ends and when it is cancelled, so a late update for an
   * id closed by {@link flushOpencodeToolCalls} would look exactly like a first
   * close and emit a second `tool.end`.
   */
  readonly closedToolCalls: Set<ToolCallId>;

  /** Live text blocks, keyed by the provider's message id. */
  readonly textBlocks: Map<MessageId, OpenTextBlock>;
  /** Live thinking blocks. Separate from text: one message can carry both. */
  readonly thinkingBlocks: Map<MessageId, OpenTextBlock>;
  /** Next block index to hand out within a message. */
  readonly nextBlockIndex: Map<MessageId, number>;

  /** Latest usage reading, republished on `run.end` as the run's totals. */
  usage: UsageSnapshot | undefined;
}

/** Options for {@link createOpencodeMapperState}. */
export interface OpencodeMapperStateOptions {
  readonly now?: () => number;
  readonly resumedFrom?: SessionId;
  readonly forked?: boolean;
  readonly startSeq?: number;
}

/** Create the per-run mapping state. */
export function createOpencodeMapperState(
  runId: RunId,
  options?: OpencodeMapperStateOptions,
): OpencodeMapperState {
  return {
    runId,
    seq: options?.startSeq ?? 0,
    now: options?.now ?? Date.now,
    sessionStarted: false,
    sessionId: undefined,
    model: undefined,
    cwd: undefined,
    ended: false,
    interruptRequested: false,
    disposeRequested: false,
    lastError: undefined,
    resumedFrom: options?.resumedFrom,
    forked: options?.forked ?? false,
    openToolCalls: new Map(),
    closedToolCalls: new Set(),
    textBlocks: new Map(),
    thinkingBlocks: new Map(),
    nextBlockIndex: new Map(),
    usage: undefined,
  };
}

/**
 * Stamp the fields every event carries, consuming one `seq`.
 *
 * Exported because the adapter emits `permission.request` and
 * `permission.resolved` out of band — they arrive as a server-initiated
 * JSON-RPC request rather than a `session/update` — and those events must share
 * this run's counter or `seq` stops being dense.
 */
export function stampOpencodeEvent<T extends Record<string, unknown>>(
  state: OpencodeMapperState,
  event: T,
): AgentEvent {
  return {
    ...event,
    runId: state.runId,
    seq: state.seq++,
    ts: state.now(),
  } as unknown as AgentEvent;
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

/** What the adapter knows when the session opens. */
export interface OpencodeSessionStart {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly model?: string;
  readonly providerVersion?: string;
}

/**
 * The mandatory first event.
 *
 * Emitted by the adapter rather than by an update, because ACP answers
 * `session/new` with a request *result*: nothing streams to announce a session,
 * so nothing here could observe one.
 */
export function openSession(
  state: OpencodeMapperState,
  start: OpencodeSessionStart,
): readonly AgentEvent[] {
  if (state.sessionStarted || state.ended) return [];
  state.sessionStarted = true;
  state.sessionId = start.sessionId;
  state.cwd = start.cwd;
  state.model = start.model;

  return [
    stampOpencodeEvent(state, {
      type: 'session.started',
      sessionId: start.sessionId,
      providerId: 'opencode',
      cwd: start.cwd,
      ...(start.model === undefined ? {} : { model: start.model }),
      ...(state.resumedFrom === undefined ? {} : { resumedFrom: state.resumedFrom }),
      ...(state.forked ? { forked: true } : {}),
      ...(start.providerVersion === undefined ? {} : { providerVersion: start.providerVersion }),
    }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Updates                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Translate one `session/update` notification.
 *
 * Returns zero or more events; never throws. An update that means nothing to
 * Artemis produces an empty array rather than an exception, because the agent
 * is a separate process whose vocabulary we do not control.
 */
export function mapOpencodeUpdate(
  state: OpencodeMapperState,
  notification: AcpSessionNotification,
): readonly AgentEvent[] {
  if (state.ended) return [];

  const update = notification.update as Record<string, unknown> & { sessionUpdate: string };

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return mapTextChunk(state, update, 'text');

    case 'agent_thought_chunk':
      return mapTextChunk(state, update, 'thinking');

    case 'user_message_chunk':
      // Only ever seen while `session/load` replays history: a live turn's user
      // message is the prompt Artemis itself sent. Emitted as a completed block
      // rather than a delta, and marked as a replay so the transcript can tell
      // recovered history from new generation.
      return mapUserChunk(state, update);

    case 'tool_call':
      return mapToolCall(state, update);

    case 'tool_call_update':
      return mapToolCallUpdate(state, update);

    case 'usage_update':
      return mapUsageUpdate(state, update);

    // Dropped on purpose, each for its own reason:
    case 'plan':
      // Artemis has no todo surface; a plan would render nowhere.
      return [];
    case 'available_commands_update':
      // Slash commands belong to the provider's own composer.
      return [];
    case 'current_mode_update':
      // Artemis owns permission mode; echoing the agent's would fight it.
      return [];

    default:
      return [];
  }
}

/* --------------------------------- text ----------------------------------- */

function mapTextChunk(
  state: OpencodeMapperState,
  update: Record<string, unknown>,
  kind: 'text' | 'thinking',
): readonly AgentEvent[] {
  const text = readContentText(update['content']);
  if (text === undefined || text === '') return [];

  const messageId = readString(update['messageId']) ?? 'msg';
  const blocks = kind === 'text' ? state.textBlocks : state.thinkingBlocks;

  const events: AgentEvent[] = [];
  let block = blocks.get(messageId);
  if (block === undefined) {
    // A new message means the previous one is finished. Completing it here
    // rather than only at `run.end` is what lets a long turn's earlier
    // paragraphs settle while later ones are still streaming.
    if (kind === 'text') events.push(...completeOtherTextBlocks(state, messageId));
    block = { blockIndex: takeBlockIndex(state, messageId), text: '' };
    blocks.set(messageId, block);
  }
  block.text += text;

  events.push(
    stampOpencodeEvent(state, {
      type: kind === 'text' ? 'text.delta' : 'thinking.delta',
      messageId,
      blockIndex: block.blockIndex,
      text,
    }),
  );
  return events;
}

function mapUserChunk(
  state: OpencodeMapperState,
  update: Record<string, unknown>,
): readonly AgentEvent[] {
  const text = readContentText(update['content']);
  if (text === undefined || text === '') return [];

  return [
    stampOpencodeEvent(state, {
      type: 'text.complete',
      messageId: readString(update['messageId']) ?? `user-${String(state.seq)}`,
      role: 'user',
      text,
      replay: true,
    }),
  ];
}

/** Complete every open text block except the one just started. */
function completeOtherTextBlocks(
  state: OpencodeMapperState,
  exceptMessageId: MessageId,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const [messageId, block] of state.textBlocks) {
    if (messageId === exceptMessageId) continue;
    state.textBlocks.delete(messageId);
    if (block.text === '') continue;
    events.push(
      stampOpencodeEvent(state, {
        type: 'text.complete',
        messageId,
        role: 'assistant',
        text: block.text,
        blockIndex: block.blockIndex,
      }),
    );
  }
  return events;
}

function takeBlockIndex(state: OpencodeMapperState, messageId: MessageId): number {
  const next = state.nextBlockIndex.get(messageId) ?? 0;
  state.nextBlockIndex.set(messageId, next + 1);
  return next;
}

/* --------------------------------- tools ---------------------------------- */

function mapToolCall(
  state: OpencodeMapperState,
  update: Record<string, unknown>,
): readonly AgentEvent[] {
  const toolCallId = readString(update['toolCallId']);
  if (toolCallId === undefined) return [];
  if (state.closedToolCalls.has(toolCallId)) return [];

  const title = readString(update['title']) ?? 'tool';
  const call: OpenToolCall = {
    // The first title is the tool's name; later ones are display summaries.
    name: title,
    title,
    input: readObject(update['rawInput']) ?? {},
    status: readToolStatus(update['status']),
    started: false,
    startedAt: state.now(),
  };
  state.openToolCalls.set(toolCallId, call);

  // Deliberately may emit nothing: a `pending` call with no arguments yet is
  // not something Artemis can render honestly. See the header.
  return maybeStartToolCall(state, toolCallId, call);
}

function mapToolCallUpdate(
  state: OpencodeMapperState,
  update: Record<string, unknown>,
): readonly AgentEvent[] {
  const toolCallId = readString(update['toolCallId']);
  if (toolCallId === undefined) return [];
  if (state.closedToolCalls.has(toolCallId)) return [];

  let call = state.openToolCalls.get(toolCallId);
  if (call === undefined) {
    // An update for a call we never saw start. Synthesising the row is better
    // than dropping the work silently.
    call = {
      name: readString(update['title']) ?? 'tool',
      title: readString(update['title']) ?? 'tool',
      input: readObject(update['rawInput']) ?? {},
      status: readToolStatus(update['status']),
      started: false,
      startedAt: state.now(),
    };
    state.openToolCalls.set(toolCallId, call);
  }

  // Patch, never rebuild: an update carries only what changed, and `null` means
  // "unchanged" just as absence does.
  const nextTitle = readString(update['title']);
  if (nextTitle !== undefined) call.title = nextTitle;
  const nextInput = readObject(update['rawInput']);
  if (nextInput !== undefined && Object.keys(nextInput).length > 0) call.input = nextInput;
  const nextStatus = readToolStatus(update['status']);
  if (nextStatus !== undefined) call.status = nextStatus;

  const events: AgentEvent[] = [...maybeStartToolCall(state, toolCallId, call)];

  if (isTerminalToolStatus(call.status)) {
    state.openToolCalls.delete(toolCallId);
    state.closedToolCalls.add(toolCallId);

    const resultText = readToolContentText(update['content']);
    const failed = call.status === 'failed';
    events.push(
      stampOpencodeEvent(state, {
        type: 'tool.end',
        toolCallId,
        name: call.name,
        status: (failed ? 'error' : 'ok') satisfies ToolEndStatus,
        ...(update['rawOutput'] === undefined ? {} : { result: update['rawOutput'] as JsonValue }),
        ...(resultText === undefined ? {} : { resultText }),
        ...(failed
          ? {
              error: {
                code: 'unknown',
                message: resultText ?? `${call.name} failed.`,
              } satisfies AgentError,
            }
          : {}),
        durationMs: Math.max(0, state.now() - call.startedAt),
      }),
    );
  }

  return events;
}

/**
 * Emit `tool.start` once the call is worth showing.
 *
 * "Worth showing" means the arguments have arrived, or the call has already
 * finished — the two moments after which no better input is coming.
 */
function maybeStartToolCall(
  state: OpencodeMapperState,
  toolCallId: ToolCallId,
  call: OpenToolCall,
): readonly AgentEvent[] {
  if (call.started) return [];
  const hasInput = Object.keys(call.input).length > 0;
  if (!hasInput && !isTerminalToolStatus(call.status)) return [];

  call.started = true;
  return [
    stampOpencodeEvent(state, {
      type: 'tool.start',
      toolCallId,
      name: call.name,
      input: call.input,
      ...(call.title === call.name ? {} : { title: call.title }),
    }),
  ];
}

/**
 * Close every open tool call with one terminal event.
 *
 * Called on interrupt, on dispose, and before `run.end`, because the contract
 * is that every `tool.start` gets a `tool.end` — a spinner the UI can never
 * clear is worse than a row marked cancelled.
 */
export function flushOpencodeToolCalls(
  state: OpencodeMapperState,
  status: ToolEndStatus = 'cancelled',
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const [toolCallId, call] of state.openToolCalls) {
    state.closedToolCalls.add(toolCallId);
    // A call that never emitted `tool.start` must not emit a bare `tool.end`:
    // the UI would have no row to close.
    if (!call.started) {
      call.started = true;
      events.push(
        stampOpencodeEvent(state, {
          type: 'tool.start',
          toolCallId,
          name: call.name,
          input: call.input,
          ...(call.title === call.name ? {} : { title: call.title }),
        }),
      );
    }
    events.push(
      stampOpencodeEvent(state, {
        type: 'tool.end',
        toolCallId,
        name: call.name,
        status,
        durationMs: Math.max(0, state.now() - call.startedAt),
      }),
    );
  }
  state.openToolCalls.clear();
  return events;
}

/* --------------------------------- usage ---------------------------------- */

function mapUsageUpdate(
  state: OpencodeMapperState,
  update: Record<string, unknown>,
): readonly AgentEvent[] {
  const used = readNumber(update['used']);
  const size = readNumber(update['size']);
  const cost = readObject(update['cost']);
  const amount = cost === undefined ? undefined : readNumber(cost['amount']);
  const currency = cost === undefined ? undefined : readString(cost['currency']);

  // OpenCode reports context occupancy, not a token bill: `used` is what is in
  // the window right now, which is not the same as tokens generated. Reporting
  // it as `inputTokens` would overstate consumption on every subsequent turn,
  // so the token counts stay zero and the honest fields carry the reading.
  const usage: UsageSnapshot = {
    scope: 'cumulative',
    tokens: { inputTokens: 0, outputTokens: 0 },
    ...(amount === undefined || currency !== 'USD' ? {} : { costUsd: amount }),
    ...(used === undefined ? {} : { contextTokens: used }),
    ...(size === undefined ? {} : { contextWindow: size }),
  };
  state.usage = usage;

  return [stampOpencodeEvent(state, { type: 'usage', usage })];
}

/**
 * Record the token accounting a finished turn reported.
 *
 * This is the *authoritative* reading, and it arrives on the `session/prompt`
 * result rather than in the stream. It measures a different quantity from
 * `usage_update`: that one says how full the context window is, this one says
 * what the turn spent. Both are wanted — the window drives the context meter,
 * the tokens drive usage reporting — so the two are merged rather than one
 * overwriting the other.
 */
export function applyPromptUsage(
  state: OpencodeMapperState,
  usage: AcpPromptUsage | undefined,
): readonly AgentEvent[] {
  if (state.ended || usage === undefined) return [];

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return [];

  const merged: UsageSnapshot = {
    scope: 'cumulative',
    tokens: {
      inputTokens,
      outputTokens,
      ...(usage.cachedReadTokens === undefined
        ? {}
        : { cacheReadInputTokens: usage.cachedReadTokens }),
      ...(usage.cachedWriteTokens === undefined
        ? {}
        : { cacheCreationInputTokens: usage.cachedWriteTokens }),
    },
    // Carried over from the streamed reading, which is the only source for them.
    ...(state.usage?.costUsd === undefined ? {} : { costUsd: state.usage.costUsd }),
    ...(state.usage?.contextTokens === undefined
      ? {}
      : { contextTokens: state.usage.contextTokens }),
    ...(state.usage?.contextWindow === undefined
      ? {}
      : { contextWindow: state.usage.contextWindow }),
  };
  state.usage = merged;

  return [stampOpencodeEvent(state, { type: 'usage', usage: merged })];
}

/* -------------------------------------------------------------------------- */
/* Ending                                                                     */
/* -------------------------------------------------------------------------- */

/** Map ACP's stop reason onto Artemis's. */
export function mapStopReason(stopReason: AcpStopReason): RunEndReason {
  switch (stopReason) {
    case 'end_turn':
      return 'completed';
    case 'cancelled':
      return 'interrupted';
    case 'max_tokens':
      return 'budget_exceeded';
    case 'max_turn_requests':
      return 'max_turns';
    case 'refusal':
      // The turn ran and the model declined. That is an outcome, not a failure
      // of the run, and the refusal text is already in the transcript.
      return 'completed';
    default:
      return 'completed';
  }
}

/** How a run finished, as the adapter sees it. */
export interface OpencodeRunEnd {
  readonly reason: RunEndReason;
  readonly error?: AgentError;
  readonly durationMs?: number;
}

/**
 * Close the run: settle open blocks and tool calls, then emit `run.end`.
 *
 * Idempotent by way of {@link OpencodeMapperState.ended} — a run that fails
 * while being disposed must still emit exactly one terminal event.
 */
export function finishOpencodeRun(
  state: OpencodeMapperState,
  end: OpencodeRunEnd,
): readonly AgentEvent[] {
  if (state.ended) return [];

  const events: AgentEvent[] = [];

  // Tool calls first: a row left open past `run.end` can never be closed.
  events.push(
    ...flushOpencodeToolCalls(state, end.reason === 'completed' ? 'cancelled' : 'cancelled'),
  );

  // Then any text still accumulating, so the transcript is whole for a consumer
  // that reads only completions.
  for (const [messageId, block] of state.textBlocks) {
    if (block.text === '') continue;
    events.push(
      stampOpencodeEvent(state, {
        type: 'text.complete',
        messageId,
        role: 'assistant',
        text: block.text,
        blockIndex: block.blockIndex,
      }),
    );
  }
  state.textBlocks.clear();

  state.ended = true;
  events.push(
    stampOpencodeEvent(state, {
      type: 'run.end',
      reason: end.reason,
      ...(end.error === undefined ? {} : { error: end.error }),
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      ...(state.usage === undefined ? {} : { usage: { ...state.usage, scope: 'final' as const } }),
      ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs }),
    }),
  );

  return events;
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function readToolStatus(value: unknown): AcpToolCallStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed'
    ? value
    : undefined;
}

/** Pull display text out of an ACP content block. */
function readContentText(value: unknown): string | undefined {
  const content = readObject(value);
  if (content === undefined) return undefined;
  return content['type'] === 'text' ? readString(content['text']) : undefined;
}

/**
 * Flatten a tool call's content array into display text.
 *
 * `diff` blocks are deliberately summarised rather than inlined: the structured
 * result already carries the old and new text, and Artemis renders a real diff
 * from it. Pasting the whole new file into `resultText` would duplicate the
 * diff view in plain prose above it.
 */
function readToolContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  const parts: string[] = [];
  for (const entry of value as readonly AcpToolCallContent[]) {
    const record = readObject(entry);
    if (record === undefined) continue;

    if (record['type'] === 'content') {
      const text = readContentText(record['content']);
      if (text !== undefined) parts.push(text);
      continue;
    }
    if (record['type'] === 'diff') {
      const path = readString(record['path']);
      parts.push(path === undefined ? 'Edited a file.' : `Edited ${path}.`);
      continue;
    }
    // `terminal` and anything newer: nothing useful to flatten.
  }

  return parts.length === 0 ? undefined : parts.join('\n');
}
