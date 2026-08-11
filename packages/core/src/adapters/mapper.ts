/**
 * Claude ⇄ Artemis translation, as pure functions.
 *
 * Everything in this file is deterministic and free of I/O: no process is
 * spawned, no clock is read (the clock is injected), no SDK function is called.
 * It imports the Agent SDK for **types only**, so importing this module does
 * not even load `@anthropic-ai/claude-agent-sdk`. That is deliberate — the
 * mapping is the part of the adapter most likely to be wrong and most worth
 * testing, so it must be testable without a subprocess.
 *
 * `./claude.ts` is the plumbing (the SDK query, the input pump, permission
 * deferreds, disposal). This file is the meaning.
 *
 * ## What the mapping has to guarantee
 *
 * The rules on protocol's `AgentEvent` are a contract, not advice:
 *
 *  1. `session.started` first, `run.end` last, exactly once each, nothing after
 *     `run.end`.
 *  2. `seq` is dense and monotonic from 0. Every event is stamped through
 *     {@link stamp}, including events the adapter emits out of band (permission
 *     prompts arrive from `canUseTool`, not from the message stream), which is
 *     why the counter lives on {@link ClaudeMapperState} rather than inside a
 *     closure here.
 *  3. Deltas are additive and never re-sent. `text.complete` still carries the
 *     whole block, so a consumer that ignores deltas renders correctly.
 *  4. Every `tool.start` gets a `tool.end` — including on interrupt, where
 *     {@link flushOpenToolCalls} closes the stragglers as `cancelled` before
 *     `run.end`.
 *
 * ## Dropped messages
 *
 * The SDK emits ~38 message variants; the protocol union has 9 events. Most of
 * the difference is host-CLI presentation state (status spinners, hook
 * progress, task bookkeeping, notifications) with no place in a normalized
 * transcript. Every one of those is dropped **explicitly**, with a comment
 * saying why, in {@link mapSdkMessage}'s switch. Nothing is dropped by falling
 * through a `default` that nobody thought about, and no unrecognised message
 * ever throws.
 */

import type {
  AgentError,
  AgentErrorCode,
  AgentEvent,
  JsonObject,
  JsonValue,
  MessageId,
  PermissionDecision,
  PermissionRequest,
  PermissionRequestId,
  PermissionRuleUpdate,
  PermissionScope,
  ProfileId,
  RunEndReason,
  RunId,
  SessionId,
  SessionSummary,
  StopReason,
  ToolCallId,
  ToolEndStatus,
  UsageScope,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import { isPermissionMode } from '@rx-artemis/protocol';

import type {
  ModelUsage,
  PermissionResult,
  PermissionUpdate,
  PermissionUpdateDestination,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKPermissionDeniedMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKSystemMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from '@anthropic-ai/claude-agent-sdk';

/** The provider id every event from this adapter carries. */
export const CLAUDE_PROVIDER_ID = 'claude' as const;

/**
 * Sent to the model when the user denies a tool call without saying why.
 *
 * The SDK's `PermissionResult` requires a non-empty `message` on the deny
 * branch, while protocol's `DenyPermissionDecision.message` is optional — so
 * something always has to be substituted, and it should read as a refusal the
 * model can adapt to rather than as an error.
 */
export const DEFAULT_DENY_MESSAGE = 'The user declined this tool call.';

/** Sent when a run is torn down with a permission prompt still unanswered. */
export const DISPOSED_DENY_MESSAGE =
  'The run was closed before this tool call could be approved.';

/* -------------------------------------------------------------------------- */
/* JSON coercion                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Coerce arbitrary provider data into something that survives structured
 * clone.
 *
 * Tool inputs and tool results arrive as `unknown` / `Record<string, unknown>`
 * and go straight into events that cross the Electron IPC boundary. A function,
 * a `Symbol`, a `BigInt` or a cycle in there does not throw at the adapter — it
 * throws inside `webContents.send`, at which point the event is simply gone and
 * the transcript is silently wrong. So it is normalized here, once.
 *
 * Lossy on purpose: functions and symbols become absent, non-finite numbers and
 * cycles become `null`, `Date` becomes an ISO string, `BigInt` becomes a
 * decimal string.
 */
export function toJsonValue(value: unknown): JsonValue {
  return coerce(value, new WeakSet<object>());
}

/** {@link toJsonValue}, narrowed to an object. Non-objects become `{}`. */
export function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  return json as JsonObject;
}

function coerce(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      // function, symbol — no JSON representation.
      return null;
  }

  const object = value as object;
  if (seen.has(object)) return null;
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      return object.map((entry) => coerce(entry, seen));
    }
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? null : object.toISOString();
    }

    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(object)) {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      out[key] = coerce(entry, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/* -------------------------------------------------------------------------- */
/* Mapper state                                                               */
/* -------------------------------------------------------------------------- */

/** A tool call we have emitted `tool.start` for and not yet closed. */
export interface OpenToolCall {
  readonly name: string;
  /** ms since epoch, from the injected clock, for `tool.end.durationMs`. */
  readonly startedAt: number;
  readonly agentId?: string;
  readonly parentToolCallId?: ToolCallId;
}

/**
 * Everything the mapping needs to remember between messages.
 *
 * Handed to {@link mapSdkMessage} and mutated by it. That is the one impurity,
 * and it is the accumulator pattern rather than hidden state: the same
 * `(message, state)` pair always produces the same events and the same next
 * state, and a test can inspect the state directly.
 *
 * The adapter shares this object with its permission and teardown paths so that
 * `seq` stays dense across *all* emitted events, not just the ones derived from
 * SDK messages.
 */
export interface ClaudeMapperState {
  readonly runId: RunId;
  /** Next `seq` to hand out. Dense and monotonic from 0. */
  seq: number;
  /** Injected clock. Tests pass a deterministic one. */
  readonly now: () => number;

  /** Guards against a second `session.started` after `reinitialize()`. */
  sessionStarted: boolean;
  sessionId: SessionId | undefined;
  model: string | undefined;

  /** True once `run.end` has been emitted. Nothing may be emitted after. */
  ended: boolean;

  /** Set by `Run.interrupt()` so the terminal event reports the real cause. */
  interruptRequested: boolean;
  /** Set by `Run.dispose()`, likewise. */
  disposeRequested: boolean;
  /** Set when a denial carried `interrupt: true`, which ends the run. */
  permissionDenyInterrupted: boolean;

  /** Last provider-reported error, used to classify a failing `run.end`. */
  lastError: AgentError | undefined;

  /** Echoed onto `session.started` from the run's input. */
  readonly resumedFrom: SessionId | undefined;
  readonly forked: boolean;

  readonly openToolCalls: Map<ToolCallId, OpenToolCall>;
  /**
   * Tool calls that have already received their one terminal event.
   *
   * `openToolCalls` cannot answer "has this ended?" — an id is deleted from it
   * both when the call ends and when it is closed some other way, so a second
   * terminal event for the same id looks exactly like a first one for an id
   * that was never opened. The protocol promises exactly one `tool.end` per
   * `tool.start`, and the CLI makes that easy to violate: a denied call is
   * closed by a `permission_denied` message *and* gets a `tool_result` block
   * fed back to the model, which arrives here as a second close. Without this
   * set the denial is overwritten by a nameless generic error.
   */
  readonly closedToolCalls: Set<ToolCallId>;
  /** `messageId` → content-block indices already delivered as deltas. */
  readonly streamedBlocks: Map<MessageId, Set<number>>;
  /** Message id of the assistant message currently streaming. */
  streamMessageId: MessageId | undefined;
}

/** Options for {@link createClaudeMapperState}. */
export interface ClaudeMapperStateOptions {
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** From `RunInput.resumeSessionId`; echoed onto `session.started`. */
  readonly resumedFrom?: SessionId;
  /** From `RunInput.forkSession`; echoed onto `session.started`. */
  readonly forked?: boolean;
  /** First `seq` to hand out. Defaults to 0. */
  readonly startSeq?: number;
}

/** Create the per-run mapping state. */
export function createClaudeMapperState(
  runId: RunId,
  options?: ClaudeMapperStateOptions,
): ClaudeMapperState {
  return {
    runId,
    seq: options?.startSeq ?? 0,
    now: options?.now ?? Date.now,
    sessionStarted: false,
    sessionId: undefined,
    model: undefined,
    ended: false,
    interruptRequested: false,
    disposeRequested: false,
    permissionDenyInterrupted: false,
    lastError: undefined,
    resumedFrom: options?.resumedFrom,
    forked: options?.forked ?? false,
    openToolCalls: new Map(),
    closedToolCalls: new Set(),
    streamedBlocks: new Map(),
    streamMessageId: undefined,
  };
}

/**
 * Stamp the fields every event carries, consuming one `seq`.
 *
 * Exported because the adapter emits `permission.request` out of band — it
 * comes from the SDK's `canUseTool` callback, not from the message stream — and
 * that event still has to take its turn in the same dense sequence.
 */
export function nextEventEnvelope(state: ClaudeMapperState): {
  runId: RunId;
  seq: number;
  ts: number;
} {
  return { runId: state.runId, seq: state.seq++, ts: state.now() };
}

const stamp = nextEventEnvelope;

function markStreamed(state: ClaudeMapperState, messageId: MessageId, blockIndex: number): void {
  let set = state.streamedBlocks.get(messageId);
  if (set === undefined) {
    set = new Set<number>();
    state.streamedBlocks.set(messageId, set);
  }
  set.add(blockIndex);
}

function wasStreamed(state: ClaudeMapperState, messageId: MessageId, blockIndex: number): boolean {
  return state.streamedBlocks.get(messageId)?.has(blockIndex) === true;
}

/* -------------------------------------------------------------------------- */
/* The mapper                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Translate one SDK message into zero or more normalized events.
 *
 * Returns them in emission order. Returning an array rather than emitting via a
 * callback is what makes this testable: a test drives a sequence of fixture
 * messages through it and asserts on the resulting event list.
 *
 * Never returns events after `state.ended` — once `run.end` has gone out, later
 * SDK messages (a straggling `result`, teardown chatter) are dropped.
 */
export function mapSdkMessage(
  message: SDKMessage,
  state: ClaudeMapperState,
): readonly AgentEvent[] {
  if (state.ended) return [];

  switch (message.type) {
    case 'assistant':
      return mapAssistantMessage(message, state);

    case 'user':
      return mapUserMessage(message, state);

    case 'stream_event':
      return mapStreamEvent(message, state);

    case 'result':
      return mapResultMessage(message, state);

    case 'system':
      return mapSystemMessage(message, state);

    // ---- deliberately dropped, top level ----------------------------------
    case 'tool_progress':
      // Elapsed-time heartbeats for a running tool. The protocol union has no
      // `tool.progress` and inventing a tenth event type to carry a spinner is
      // exactly the Claude-shaped leak the seam exists to prevent. The UI shows
      // "running" from `tool.start` until `tool.end`.
      return [];

    case 'tool_use_summary':
      // A prose summary of several preceding tool calls. Presentational; the
      // individual `tool.start`/`tool.end` pairs already carry the facts.
      return [];

    case 'rate_limit_event':
      // A standing rate-limit *status* (window, resets-at), not a failure. There
      // is no protocol event for provider health, and turning it into an
      // `AgentError` would falsely imply the run had failed. Rate-limit
      // *errors* still arrive as `run.end` with `code: 'rate_limit'`.
      return [];

    case 'conversation_reset':
      // The provider started a fresh conversation id underneath us. Nothing in
      // the union expresses "your transcript was replaced"; the run is left to
      // finish and the new id surfaces on `run.end.sessionId`.
      return [];

    case 'prompt_suggestion':
      // Autocomplete hints for the composer, not transcript content.
      return [];

    case 'auth_status':
      // Interactive-login progress. Every credential Artemis uses — API key or
      // subscription token — is one the user obtained themselves and pasted in,
      // so Artemis never drives an interactive auth flow and this should not fire
      // at all; if it does, it is not something to render.
      return [];

    default:
      // A message variant added by a future SDK release. Dropping beats
      // throwing: an unknown message must never break a live transcript.
      return [];
  }
}

/* ---------------------------------- system -------------------------------- */

function mapSystemMessage(
  message: Extract<SDKMessage, { type: 'system' }>,
  state: ClaudeMapperState,
): readonly AgentEvent[] {
  switch (message.subtype) {
    case 'init':
      return mapInit(message, state);

    case 'permission_denied':
      return mapPermissionDenied(message, state);

    case 'model_refusal_no_fallback':
    case 'model_refusal_fallback':
      // The model refused. `content` is the provider's own explanation and is
      // the only thing the user will see, so it is surfaced as a synthetic
      // assistant block rather than dropped.
      return [
        {
          type: 'text.complete',
          ...stamp(state),
          messageId: message.uuid,
          role: 'assistant',
          text: message.content,
          synthetic: true,
          stopReason: 'refusal',
        },
      ];

    case 'local_command_output':
      // Output of a locally-executed slash command. The user asked for it, so it
      // belongs in the transcript — attributed to the user side, because no
      // model produced it.
      return [
        {
          type: 'text.complete',
          ...stamp(state),
          messageId: message.uuid,
          role: 'user',
          text: message.content,
          synthetic: true,
        },
      ];

    // ---- deliberately dropped, system subtypes ----------------------------
    case 'compact_boundary':
      // Context was compacted. Meaningful, but there is no event for it and
      // faking an assistant message would put words in the model's mouth.
      return [];

    case 'status':
    case 'session_state_changed':
      // Spinner state ("compacting", "requesting", idle/running). The UI derives
      // its own state from the event stream.
      return [];

    case 'api_retry':
    case 'control_request_progress':
      // Transient retry bookkeeping. A retry that ultimately fails surfaces as
      // `run.end` with an error; a retry that succeeds is not the user's
      // problem.
      return [];

    case 'hook_started':
    case 'hook_progress':
    case 'hook_response':
      // Hooks come from settings files. Artemis runs with `settingSources: []` by
      // default, so these normally never fire; when a user opts in, hook output
      // is their own tooling's business, not transcript content.
      return [];

    case 'task_started':
    case 'task_updated':
    case 'task_progress':
    case 'task_notification':
    case 'background_tasks_changed':
      // Subagent/background task bookkeeping. Subagent work is already visible:
      // the spawning Task tool produces `tool.start`/`tool.end`, and nested
      // events carry `agentId`/`parentToolCallId`.
      return [];

    case 'thinking_tokens':
      // A deliberately lossy display estimate, documented by the SDK as not
      // billable. Emitting it as `usage` would corrupt the token readout.
      return [];

    case 'commands_changed':
      // Updated slash-command list. `session.started` carries the initial set
      // and the union has no way to revise it.
      return [];

    case 'notification':
    case 'informational':
      // Host-CLI notices and toasts.
      return [];

    case 'memory_recall':
    case 'files_persisted':
    case 'plugin_install':
    case 'elicitation_complete':
    case 'mirror_error':
    case 'worker_shutting_down':
      // Infrastructure telemetry with no user-facing meaning in Artemis.
      return [];

    default:
      // Unknown future subtype — dropped, never fatal.
      return [];
  }
}

function mapInit(message: SDKSystemMessage, state: ClaudeMapperState): readonly AgentEvent[] {
  // `reinitialize()` re-emits init. `session.started` is defined to be first and
  // to happen once, so later inits only refresh state.
  state.sessionId = message.session_id;
  state.model = message.model;
  if (state.sessionStarted) return [];
  state.sessionStarted = true;

  return [
    {
      type: 'session.started',
      ...stamp(state),
      sessionId: message.session_id,
      providerId: CLAUDE_PROVIDER_ID,
      cwd: message.cwd,
      model: message.model,
      tools: message.tools,
      slashCommands: message.slash_commands,
      permissionMode: isPermissionMode(message.permissionMode) ? message.permissionMode : undefined,
      resumedFrom: state.resumedFrom,
      forked: state.resumedFrom === undefined ? undefined : state.forked,
      providerVersion: message.claude_code_version,
    },
  ];
}

function mapPermissionDenied(
  message: SDKPermissionDeniedMessage,
  state: ClaudeMapperState,
): readonly AgentEvent[] {
  const record = state.openToolCalls.get(message.tool_use_id);
  state.openToolCalls.delete(message.tool_use_id);
  // The denial is the call's terminal event. The `tool_result` the CLI feeds
  // back to the model arrives here shortly afterwards for the same id; marking
  // the call closed is what stops that from overwriting the denial with a
  // generic error.
  if (state.closedToolCalls.has(message.tool_use_id)) return [];
  state.closedToolCalls.add(message.tool_use_id);

  return [
    {
      type: 'tool.end',
      ...stamp(state),
      toolCallId: message.tool_use_id,
      name: message.tool_name || record?.name,
      status: 'denied',
      error: {
        code: 'permission_denied',
        message: message.message || 'The tool call was denied.',
        providerCode: message.decision_reason_type,
      },
      resultText: message.message,
      durationMs: record === undefined ? undefined : state.now() - record.startedAt,
      agentId: message.agent_id ?? record?.agentId,
      parentToolCallId: record?.parentToolCallId,
    },
  ];
}

/* --------------------------------- assistant ------------------------------ */

type AssistantContentBlock = SDKAssistantMessage['message']['content'][number];

function mapAssistantMessage(
  message: SDKAssistantMessage,
  state: ClaudeMapperState,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  // Identity has to agree with whatever the stream already published, because
  // the renderer keys blocks by (messageId, blockIndex): disagree, and the
  // completed message opens a *second* block instead of finalising the one the
  // deltas built, and the user reads the answer twice. `message.id` is the
  // shared anchor when present; when it is missing, the streamed id is the
  // right fallback and `uuid` — which the stream never saw — is the last
  // resort, for turns that were never streamed at all.
  const messageId: MessageId = message.message.id || state.streamMessageId || message.uuid;
  // Claude does not hand out a subagent id on assistant messages, but the tool
  // call that spawned the subagent identifies it uniquely and stably — which is
  // exactly what protocol's `AgentId` is for ("nest a subagent's work under the
  // tool call that spawned it").
  const agentId = message.parent_tool_use_id ?? undefined;
  const content = message.message.content ?? [];
  const lastIndex = content.length - 1;

  if (message.error !== undefined) {
    // No event carries a non-fatal assistant error, but the terminal `run.end`
    // should be able to say *why* it failed rather than "unknown".
    state.lastError = {
      code: mapAssistantErrorCode(message.error),
      message: `The provider reported "${message.error}" while generating a response.`,
      providerCode: message.error,
    };
  }

  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block = content[blockIndex];
    if (block === undefined) continue;

    switch (block.type) {
      case 'text': {
        events.push({
          type: 'text.complete',
          ...stamp(state),
          messageId,
          role: 'assistant',
          text: block.text,
          blockIndex,
          // The stop reason belongs to the message, so it is attached to the
          // final block rather than repeated on every one.
          stopReason:
            blockIndex === lastIndex ? mapStopReason(message.message.stop_reason) : undefined,
          agentId,
        });
        break;
      }

      case 'thinking': {
        // There is no `thinking.complete` in the union — thinking is
        // presentational. When it was streamed, the deltas already carry it;
        // when it was not, one delta carries the whole block.
        if (!wasStreamed(state, messageId, blockIndex)) {
          events.push({
            type: 'thinking.delta',
            ...stamp(state),
            messageId,
            blockIndex,
            text: block.thinking,
            agentId,
          });
        }
        break;
      }

      case 'redacted_thinking': {
        if (!wasStreamed(state, messageId, blockIndex)) {
          events.push({
            type: 'thinking.delta',
            ...stamp(state),
            messageId,
            blockIndex,
            text: '',
            redacted: true,
            agentId,
          });
        }
        break;
      }

      case 'tool_use':
      case 'server_tool_use': {
        events.push(startToolCall(state, block.id, block.name, block.input, messageId, agentId));
        break;
      }

      default: {
        // Everything else in an assistant turn is either a server-side tool
        // *result* embedded in the content (web search, code execution, MCP) or
        // a block with no transcript meaning (container uploads, compaction
        // markers). Detect the former structurally, so a new server tool maps
        // itself without a code change here.
        const toolUse = readToolUseBlock(block);
        if (toolUse !== null) {
          events.push(
            startToolCall(state, toolUse.id, toolUse.name, toolUse.input, messageId, agentId),
          );
          break;
        }
        const toolResult = readToolResultBlock(block);
        if (toolResult !== null) {
          const ended = endToolCall(state, {
            toolCallId: toolResult.toolUseId,
            status: toolResult.isError ? 'error' : 'ok',
            content: toolResult.content,
            structured: undefined,
          });
          if (ended !== undefined) events.push(ended);
          break;
        }
        // Deliberately dropped: no transcript meaning.
        break;
      }
    }
  }

  const usage = mapTokenUsage(message.message.usage);
  if (usage !== undefined) {
    // Per-request usage, so the readout moves during a long run. Scope is
    // `delta`: these add up. The authoritative totals arrive as `final`
    // alongside `run.end` and replace whatever the deltas accumulated.
    const contextTokens =
      usage.inputTokens +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0);
    events.push({
      type: 'usage',
      ...stamp(state),
      usage: { scope: 'delta', tokens: usage, contextTokens },
    });
  }

  // The streamed id belongs to the turn that just closed. Leaving it set would
  // let a *later* message with no id of its own inherit it and merge into this
  // message's blocks — the same duplication bug wearing the opposite mask.
  state.streamMessageId = undefined;

  return events;
}

function startToolCall(
  state: ClaudeMapperState,
  toolCallId: ToolCallId,
  name: string,
  input: unknown,
  messageId: MessageId,
  agentId: string | undefined,
): AgentEvent {
  state.openToolCalls.set(toolCallId, {
    name,
    startedAt: state.now(),
    agentId,
    parentToolCallId: agentId,
  });
  return {
    type: 'tool.start',
    ...stamp(state),
    toolCallId,
    name,
    input: toJsonObject(input),
    messageId,
    agentId,
    parentToolCallId: agentId,
  };
}

interface EndToolCallParams {
  readonly toolCallId: ToolCallId;
  readonly status: ToolEndStatus;
  /** The tool_result block's `content`, whatever shape it came in. */
  readonly content: unknown;
  /** The SDK's richer `tool_use_result`, when it unambiguously belongs here. */
  readonly structured: unknown;
  readonly name?: string;
}

/**
 * Close a tool call, or return `undefined` if something already closed it.
 *
 * The `undefined` case is not defensive padding: the CLI reliably produces it.
 * A denied call is closed by `permission_denied` and *then* has a `tool_result`
 * block delivered for the same `tool_use_id`, because the model has to be told
 * the call failed. Emitting for both would put two terminal events against one
 * `tool.start` and, worse, let the second one — which knows nothing about the
 * denial — relabel it as a nameless `unknown` error.
 */
function endToolCall(
  state: ClaudeMapperState,
  params: EndToolCallParams,
): AgentEvent | undefined {
  if (state.closedToolCalls.has(params.toolCallId)) return undefined;

  const record = state.openToolCalls.get(params.toolCallId);
  state.openToolCalls.delete(params.toolCallId);
  state.closedToolCalls.add(params.toolCallId);

  const resultText = flattenResultText(params.content);
  return {
    type: 'tool.end',
    ...stamp(state),
    toolCallId: params.toolCallId,
    name: params.name ?? record?.name,
    status: params.status,
    result: toJsonValue(params.structured !== undefined ? params.structured : params.content),
    resultText,
    error:
      params.status === 'error'
        ? { code: 'unknown', message: resultText || 'The tool call failed.' }
        : undefined,
    durationMs: record === undefined ? undefined : state.now() - record.startedAt,
    agentId: record?.agentId,
    parentToolCallId: record?.parentToolCallId,
  };
}

/* ----------------------------------- user --------------------------------- */

type UserMessage = SDKUserMessage | SDKUserMessageReplay;

function mapUserMessage(message: UserMessage, state: ClaudeMapperState): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  const isReplay = 'isReplay' in message && message.isReplay === true;
  const agentId = message.parent_tool_use_id ?? undefined;
  const messageId: MessageId = message.uuid ?? `${state.runId}:user:${String(state.seq)}`;
  const content = message.message.content;

  if (typeof content === 'string') {
    // A plain string user turn. Artemis's own prompts come back this way; the
    // renderer already rendered those, so only replayed history and
    // provider-synthesised turns are surfaced.
    if (isReplay || message.isSynthetic === true) {
      events.push({
        type: 'text.complete',
        ...stamp(state),
        messageId,
        role: 'user',
        text: content,
        replay: isReplay ? true : undefined,
        synthetic: message.isSynthetic === true ? true : undefined,
        agentId,
      });
    }
    return events;
  }

  // `tool_use_result` is per *message*, not per block, so it can only be
  // attributed when the message closes exactly one tool call.
  const toolResultCount = content.filter((block) => block.type === 'tool_result').length;

  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block = content[blockIndex];
    if (block === undefined) continue;

    if (block.type === 'tool_result') {
      const ended = endToolCall(state, {
        toolCallId: block.tool_use_id,
        status: block.is_error === true ? 'error' : 'ok',
        content: block.content,
        structured: toolResultCount === 1 ? message.tool_use_result : undefined,
      });
      if (ended !== undefined) events.push(ended);
      continue;
    }

    if (block.type === 'text' && (isReplay || message.isSynthetic === true)) {
      events.push({
        type: 'text.complete',
        ...stamp(state),
        messageId,
        role: 'user',
        text: block.text,
        blockIndex,
        replay: isReplay ? true : undefined,
        synthetic: message.isSynthetic === true ? true : undefined,
        agentId,
      });
      continue;
    }

    // Images, documents, thinking echoes and other attachments are dropped:
    // the union carries text and tool traffic, and a base64 image has no
    // business crossing IPC on every replay.
  }

  return events;
}

/* -------------------------------- stream_event ---------------------------- */

function mapStreamEvent(
  message: SDKPartialAssistantMessage,
  state: ClaudeMapperState,
): readonly AgentEvent[] {
  const event = message.event;
  const agentId = message.parent_tool_use_id ?? undefined;

  switch (event.type) {
    case 'message_start': {
      // Anchors every following delta to the id the completed assistant message
      // will carry, so the UI can attach deltas to the right block.
      state.streamMessageId = event.message.id;
      return [];
    }

    case 'content_block_start': {
      const block = event.content_block;
      if (block.type === 'redacted_thinking' && state.streamMessageId !== undefined) {
        markStreamed(state, state.streamMessageId, event.index);
        return [
          {
            type: 'thinking.delta',
            ...stamp(state),
            messageId: state.streamMessageId,
            blockIndex: event.index,
            text: '',
            redacted: true,
            agentId,
          },
        ];
      }
      // `tool_use` block starts are ignored on purpose: the completed assistant
      // message carries the whole, parsed input, and emitting `tool.start` from
      // a partial block would either duplicate it or publish a half-built
      // argument object.
      return [];
    }

    case 'content_block_delta': {
      const messageId = state.streamMessageId;
      if (messageId === undefined) {
        // A delta before `message_start` — nothing to attach it to. Dropped
        // rather than guessed at; the completed message still carries the text.
        return [];
      }

      const delta = event.delta;
      if (delta.type === 'text_delta') {
        markStreamed(state, messageId, event.index);
        return [
          {
            type: 'text.delta',
            ...stamp(state),
            messageId,
            blockIndex: event.index,
            text: delta.text,
            agentId,
          },
        ];
      }

      if (delta.type === 'thinking_delta') {
        markStreamed(state, messageId, event.index);
        return [
          {
            type: 'thinking.delta',
            ...stamp(state),
            messageId,
            blockIndex: event.index,
            text: delta.thinking,
            agentId,
          },
        ];
      }

      // Dropped: `signature_delta` is a cryptographic trailer, `input_json_delta`
      // is a partial tool argument (see `content_block_start`), `citations_delta`
      // and compaction deltas have no place in the union.
      return [];
    }

    case 'content_block_stop':
    case 'message_delta':
    case 'message_stop':
      // Frame bookkeeping. The completed assistant message and the result
      // message carry everything these would tell us.
      return [];

    default:
      return [];
  }
}

/* ---------------------------------- result -------------------------------- */

function mapResultMessage(
  message: SDKResultMessage,
  state: ClaudeMapperState,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];

  // Rule 5: nothing may be left spinning. Anything still open when the turn
  // ends was cut short.
  events.push(...flushOpenToolCalls(state));

  const usage = mapResultUsage(message, state);
  if (usage !== undefined) {
    events.push({ type: 'usage', ...stamp(state), usage });
  }

  const reason = resolveRunEndReason(message, state);
  const error = reason === 'error' ? resolveResultError(message, state) : undefined;

  events.push(
    ...finalizeRun(state, reason, {
      error,
      usage,
      sessionId: message.session_id,
      durationMs: message.duration_ms,
      numTurns: message.num_turns,
      result: message.subtype === 'success' ? message.result : undefined,
    }),
  );

  return events;
}

function resolveRunEndReason(message: SDKResultMessage, state: ClaudeMapperState): RunEndReason {
  // Artemis's own intent wins: if we asked the provider to stop, "interrupted" is
  // the truthful reason even though the SDK reports an execution error.
  if (state.disposeRequested) return 'disposed';
  if (state.interruptRequested) return 'interrupted';
  if (state.permissionDenyInterrupted) return 'permission_denied';

  switch (message.terminal_reason) {
    case 'max_turns':
      return 'max_turns';
    case 'budget_exhausted':
      return 'budget_exceeded';
    default:
      break;
  }

  switch (message.subtype) {
    case 'success':
      return message.is_error ? 'error' : 'completed';
    case 'error_max_turns':
      return 'max_turns';
    case 'error_max_budget_usd':
      return 'budget_exceeded';
    default:
      return 'error';
  }
}

function resolveResultError(
  message: SDKResultMessage,
  state: ClaudeMapperState,
): AgentError | undefined {
  if (message.subtype !== 'success') {
    const detail = message.errors.filter((entry) => entry.length > 0).join('; ');
    return {
      code: state.lastError?.code ?? mapTerminalReasonCode(message.terminal_reason),
      message: detail || state.lastError?.message || 'The run failed.',
      providerCode: message.terminal_reason ?? message.subtype,
      httpStatus: undefined,
    };
  }

  if (state.lastError !== undefined) return state.lastError;

  return {
    code: mapTerminalReasonCode(message.terminal_reason),
    message: 'The run finished with an error.',
    providerCode: message.terminal_reason,
    httpStatus: message.api_error_status ?? undefined,
  };
}

/* ------------------------------- termination ------------------------------ */

/**
 * Close every tool call that is still open, as `cancelled`.
 *
 * Called on every terminal path. Without it an interrupted run leaves the UI
 * with a spinner it has no event to clear — which protocol's event rules call
 * out explicitly as the thing not to do.
 */
export function flushOpenToolCalls(state: ClaudeMapperState): readonly AgentEvent[] {
  if (state.openToolCalls.size === 0) return [];

  const events: AgentEvent[] = [];
  for (const [toolCallId, record] of state.openToolCalls) {
    state.closedToolCalls.add(toolCallId);
    events.push({
      type: 'tool.end',
      ...stamp(state),
      toolCallId,
      name: record.name,
      status: 'cancelled',
      durationMs: state.now() - record.startedAt,
      agentId: record.agentId,
      parentToolCallId: record.parentToolCallId,
    });
  }
  state.openToolCalls.clear();
  return events;
}

/** Extra facts to attach to the terminal event. */
export interface FinalizeRunOptions {
  readonly error?: AgentError;
  readonly usage?: UsageSnapshot;
  readonly sessionId?: SessionId;
  readonly durationMs?: number;
  readonly numTurns?: number;
  readonly result?: string;
}

/**
 * Emit the terminal `run.end`, flushing any open tool call first.
 *
 * Idempotent: a second call returns `[]`. That is what lets the adapter call it
 * from several places that all race to be last — the pump's `catch`, the
 * pump's normal exit, and `dispose()` — without ever emitting two terminal
 * events or emitting anything after one.
 */
export function finalizeRun(
  state: ClaudeMapperState,
  reason: RunEndReason,
  options?: FinalizeRunOptions,
): readonly AgentEvent[] {
  if (state.ended) return [];

  const events: AgentEvent[] = [...flushOpenToolCalls(state)];
  state.ended = true;

  events.push({
    type: 'run.end',
    ...stamp(state),
    reason,
    error: options?.error,
    sessionId: options?.sessionId ?? state.sessionId,
    usage: options?.usage,
    durationMs: options?.durationMs,
    numTurns: options?.numTurns,
    result: options?.result,
  });

  return events;
}

/* ---------------------------------- usage --------------------------------- */

/** The subset of the Anthropic usage payload the mapper reads. */
interface RawUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly server_tool_use?: { readonly web_search_requests?: number | null } | null;
}

/** Translate the SDK's snake_case usage into protocol's camelCase `TokenUsage`. */
export function mapTokenUsage(usage: RawUsage | null | undefined): UsageSnapshot['tokens'] | undefined {
  if (usage === null || usage === undefined) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;

  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? undefined,
  };
}

/** Build the authoritative `final`-scope snapshot that accompanies `run.end`. */
export function mapResultUsage(
  message: SDKResultMessage,
  state: ClaudeMapperState,
  scope: UsageScope = 'final',
): UsageSnapshot | undefined {
  const tokens = mapTokenUsage(message.usage);
  if (tokens === undefined) return undefined;

  const byModel = mapModelUsage(message.modelUsage);
  // `contextWindow` is a property of the model, so prefer the model this run
  // actually used before falling back to whichever the provider listed first.
  const contextWindow =
    byModel.find((entry) => entry.model === state.model)?.contextWindow ?? byModel[0]?.contextWindow;

  return {
    scope,
    tokens,
    costUsd: message.total_cost_usd,
    byModel: byModel.length > 0 ? byModel : undefined,
    // `contextTokens` is deliberately absent: the result's token counts are run
    // totals, not the size of the final prompt, so reporting them as context
    // occupancy would show a context window many times over-full.
    contextWindow,
  };
}

function mapModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): readonly NonNullable<UsageSnapshot['byModel']>[number][] {
  if (modelUsage === undefined) return [];
  return Object.entries(modelUsage).map(([model, usage]) => ({
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    webSearchRequests: usage.webSearchRequests,
    costUsd: usage.costUSD,
    contextWindow: usage.contextWindow,
  }));
}

/* --------------------------------- mapping -------------------------------- */

/**
 * Map the provider's stop reason onto protocol's `StopReason`.
 *
 * The SDK types this as `string | null`, not a closed union, so it is mapped
 * defensively — an unrecognised value becomes `'other'` rather than being cast.
 */
export function mapStopReason(stopReason: string | null | undefined): StopReason | undefined {
  if (stopReason === null || stopReason === undefined) return undefined;
  switch (stopReason) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'refusal':
    case 'pause_turn':
      return stopReason;
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'other';
  }
}

/** Map the SDK's assistant-error enum onto protocol's error taxonomy. */
export function mapAssistantErrorCode(error: string | undefined): AgentErrorCode {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'auth';
    case 'billing_error':
      return 'billing';
    case 'rate_limit':
      return 'rate_limit';
    case 'overloaded':
    case 'server_error':
      return 'provider_unavailable';
    case 'invalid_request':
      return 'invalid_request';
    case 'model_not_found':
      return 'model_unavailable';
    case 'max_output_tokens':
      return 'limit_exceeded';
    default:
      return 'unknown';
  }
}

function mapTerminalReasonCode(reason: string | null | undefined): AgentErrorCode {
  switch (reason) {
    case 'api_error':
    case 'model_error':
      return 'provider_unavailable';
    case 'prompt_too_long':
    case 'max_turns':
    case 'budget_exhausted':
      return 'limit_exceeded';
    case 'blocking_limit':
    case 'rapid_refill_breaker':
      return 'rate_limit';
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'cancelled';
    case 'hook_stopped':
    case 'stop_hook_prevented':
      return 'permission_denied';
    default:
      return 'unknown';
  }
}

/* ------------------------------- permissions ------------------------------ */

/**
 * The fields of the SDK's `canUseTool` options object that become part of a
 * {@link PermissionRequest}.
 *
 * Declared structurally rather than as the SDK's own type so a fixture can be
 * written without conjuring an `AbortSignal`. The SDK's object is assignable to
 * it.
 */
export interface ClaudePermissionPromptInfo {
  /** The SDK's `toolUseID` — the call this prompt gates. */
  readonly toolUseID?: string;
  /** The SDK's `agentID` — set when the request came from inside a subagent. */
  readonly agentID?: string;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly decisionReason?: string;
  readonly blockedPath?: string;
  readonly suggestions?: readonly PermissionUpdate[];
}

/** Arguments to {@link buildPermissionRequest}. */
export interface BuildPermissionRequestParams {
  /** Artemis's own id. Deliberately *not* the SDK's transport `requestId`. */
  readonly id: PermissionRequestId;
  readonly runId: RunId;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly info?: ClaudePermissionPromptInfo;
  readonly requestedAt: number;
}

/**
 * Build the protocol {@link PermissionRequest} for a `canUseTool` callback.
 *
 * The SDK's `requestId` (the control-request envelope id) is *not* used as the
 * protocol id: it is transport plumbing, it must be echoed verbatim on the SDK
 * side, and leaking it into the renderer would couple the UI to Claude's wire
 * protocol. Artemis mints its own id and keeps the pairing adapter-internal.
 */
export function buildPermissionRequest(params: BuildPermissionRequestParams): PermissionRequest {
  const info = params.info;
  const suggestions = (info?.suggestions ?? [])
    .map(fromSdkPermissionUpdate)
    .filter((update): update is PermissionRuleUpdate => update !== null);

  return {
    id: params.id,
    runId: params.runId,
    toolName: params.toolName,
    input: toJsonObject(params.input),
    toolCallId: info?.toolUseID,
    agentId: info?.agentID,
    title: info?.title,
    displayName: info?.displayName,
    description: info?.description,
    reason: info?.decisionReason,
    blockedPath: info?.blockedPath,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
    requestedAt: params.requestedAt,
  };
}

/**
 * Map protocol's {@link PermissionScope} onto the SDK's
 * `PermissionUpdateDestination`.
 *
 * `'once'` has no destination — it means "do not persist anything" — so it maps
 * to `null` and the caller emits no `PermissionUpdate` at all. The SDK's
 * `'cliArg'` destination has no protocol equivalent and Artemis never produces
 * it.
 */
export function mapPermissionScope(scope: PermissionScope): PermissionUpdateDestination | null {
  switch (scope) {
    case 'session':
      return 'session';
    case 'local':
      return 'localSettings';
    case 'project':
      return 'projectSettings';
    case 'user':
      return 'userSettings';
    case 'once':
      return null;
    default:
      return null;
  }
}

function toSdkPermissionUpdate(update: PermissionRuleUpdate): PermissionUpdate | null {
  const destination = mapPermissionScope(update.scope);
  if (destination === null) return null;

  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return {
        type: update.type,
        behavior: update.behavior,
        rules: update.rules.map((rule) => ({
          toolName: rule.toolName,
          ruleContent: rule.ruleContent,
        })),
        destination,
      };
    case 'setMode':
      return { type: 'setMode', mode: update.mode, destination };
    case 'addDirectories':
    case 'removeDirectories':
      return { type: update.type, directories: [...update.directories], destination };
    default:
      return null;
  }
}

function fromSdkPermissionUpdate(update: PermissionUpdate): PermissionRuleUpdate | null {
  const scope = fromSdkDestination(update.destination);
  if (scope === null) return null;

  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return {
        type: update.type,
        behavior: update.behavior,
        rules: update.rules.map((rule) => ({
          toolName: rule.toolName,
          ruleContent: rule.ruleContent,
        })),
        scope,
      };
    case 'setMode':
      return isPermissionMode(update.mode) ? { type: 'setMode', mode: update.mode, scope } : null;
    case 'addDirectories':
    case 'removeDirectories':
      return { type: update.type, directories: [...update.directories], scope };
    default:
      return null;
  }
}

function fromSdkDestination(destination: PermissionUpdateDestination): PermissionScope | null {
  switch (destination) {
    case 'session':
      return 'session';
    case 'localSettings':
      return 'local';
    case 'projectSettings':
      return 'project';
    case 'userSettings':
      return 'user';
    case 'cliArg':
      // No protocol equivalent, and offering it in the UI would suggest Artemis
      // can rewrite its own command line. Dropped.
      return null;
    default:
      return null;
  }
}

/**
 * Translate the user's {@link PermissionDecision} into the SDK's
 * `PermissionResult`.
 *
 * Two mismatches are handled here, both of which would be silent bugs
 * otherwise:
 *
 *  - the SDK **requires** a `message` on the deny branch while protocol makes
 *    it optional, so {@link DEFAULT_DENY_MESSAGE} is substituted;
 *  - the SDK's deny branch has **no** `updatedPermissions` field, so a "never
 *    allow this" rule attached to a denial cannot be forwarded. It is dropped,
 *    and the caller is told via {@link ToPermissionResultOutcome.droppedUpdates}
 *    so the UI can avoid offering an affordance that would not stick.
 */
export interface ToPermissionResultOutcome {
  readonly result: PermissionResult;
  /**
   * Rule updates that could not be delivered to the provider. Non-empty only on
   * the deny path.
   */
  readonly droppedUpdates: readonly PermissionRuleUpdate[];
}

/** Options for {@link toPermissionResult}. */
export interface ToPermissionResultOptions {
  /** The SDK's `toolUseID` for the call being decided, echoed back when known. */
  readonly toolUseID?: string;
  /**
   * The tool being decided. Needed only to synthesise an "allow always" rule
   * when the user picked a durable scope but the UI sent no explicit
   * `updatedPermissions`. Without it, nothing is synthesised — a guess at the
   * tool name would write a permission rule the user never agreed to.
   */
  readonly toolName?: string;
}

export function toPermissionResult(
  decision: PermissionDecision,
  options?: ToPermissionResultOptions,
): ToPermissionResultOutcome {
  if (decision.behavior === 'deny') {
    return {
      result: {
        behavior: 'deny',
        message: decision.message ?? DEFAULT_DENY_MESSAGE,
        interrupt: decision.interrupt,
        toolUseID: options?.toolUseID,
        decisionClassification: 'user_reject',
      },
      droppedUpdates: decision.updatedPermissions ?? [],
    };
  }

  const scope = decision.scope ?? 'once';
  const explicit = decision.updatedPermissions ?? [];
  // "Allow always" with no explicit rule list still has to persist something,
  // or the prompt reappears on the next identical call. Synthesise the minimal
  // rule the scope implies — but only when the tool name is actually known.
  const synthesised: readonly PermissionRuleUpdate[] =
    scope === 'once' || options?.toolName === undefined
      ? []
      : [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: options.toolName }],
            scope,
          },
        ];

  const updates = explicit.length > 0 ? explicit : synthesised;

  const mapped = updates
    .map(toSdkPermissionUpdate)
    .filter((update): update is PermissionUpdate => update !== null);

  return {
    result: {
      behavior: 'allow',
      updatedInput: decision.updatedInput as Record<string, unknown> | undefined,
      updatedPermissions: mapped.length > 0 ? mapped : undefined,
      toolUseID: options?.toolUseID,
      decisionClassification:
        scope === 'once' || scope === 'session' ? 'user_temporary' : 'user_permanent',
    },
    droppedUpdates: [],
  };
}

/* --------------------------------- sessions ------------------------------- */

/** Context {@link mapSessionInfo} needs but `SDKSessionInfo` does not carry. */
export interface MapSessionInfoContext {
  readonly profileId: ProfileId;
  /** Used when the SDK omits `cwd`, which it marks optional. */
  readonly fallbackCwd: string;
}

/**
 * Map an `SDKSessionInfo` onto protocol's {@link SessionSummary}.
 *
 * Every field name differs (`lastModified`/`summary`/`fileSize` versus
 * `updatedAt`/`title`/`sizeBytes`), so this is where that trap is contained.
 * `messageCount` is left undefined on purpose: the SDK's listing does not
 * include it and computing it would mean reading and parsing every transcript.
 */
export function mapSessionInfo(
  info: SDKSessionInfo,
  context: MapSessionInfoContext,
): SessionSummary {
  // `??` is not enough here: the SDK returns an empty `summary` for a session it
  // has not summarised yet, and an empty string would win the chain and put a
  // blank row in the history pane.
  const customTitle = nonBlank(info.customTitle);
  const title =
    customTitle ?? nonBlank(info.summary) ?? nonBlank(info.firstPrompt) ?? '(untitled session)';

  return {
    id: info.sessionId,
    providerId: CLAUDE_PROVIDER_ID,
    profileId: context.profileId,
    cwd: nonBlank(info.cwd) ?? context.fallbackCwd,
    title,
    titleIsCustom: customTitle !== undefined ? true : undefined,
    firstPrompt: info.firstPrompt,
    updatedAt: info.lastModified,
    createdAt: info.createdAt,
    sizeBytes: info.fileSize,
    gitBranch: info.gitBranch,
    tag: info.tag,
  };
}

/**
 * Map an `SDKSessionInfo` that arrived from an *aggregated* listing, where
 * there is no cwd to fall back on.
 *
 * A per-project listing already knows the directory it asked about, so
 * {@link mapSessionInfo} can substitute it. Walking every project has no such
 * answer, and the tempting substitute — decoding the project directory's name —
 * is wrong: Claude names those directories by replacing every non-alphanumeric
 * character in the path with `-`, so `/src/my-app` and `/src/my/app` both
 * become `-src-my-app`. Decoding would hand the UI a plausible, confidently
 * wrong path, and "resume this session" would then start an agent in a
 * directory the user never worked in.
 *
 * The session record carries its own `cwd`, read out of the transcript, and
 * that is authoritative. When even that is missing the session is **dropped**
 * (`null`) rather than guessed at: it cannot be grouped under a project and it
 * cannot be resumed, so a row for it would be a row that does nothing.
 */
export function mapAggregatedSessionInfo(
  info: SDKSessionInfo,
  context: { readonly profileId: ProfileId },
): SessionSummary | null {
  const cwd = nonBlank(info.cwd);
  if (cwd === undefined) return null;
  return mapSessionInfo(info, { profileId: context.profileId, fallbackCwd: cwd });
}

/* --------------------------------- helpers -------------------------------- */

/** A string, unless it is absent or all whitespace. */
function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

/** Structural detector for "this block starts a tool call". */
function readToolUseBlock(
  block: AssistantContentBlock,
): { id: string; name: string; input: unknown } | null {
  if (typeof block !== 'object' || block === null) return null;
  const record = block as unknown as Record<string, unknown>;
  if (!String(record['type'] ?? '').endsWith('tool_use')) return null;
  const id = record['id'];
  const name = record['name'];
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return { id, name, input: record['input'] };
}

/** Structural detector for "this block closes a tool call". */
function readToolResultBlock(
  block: AssistantContentBlock,
): { toolUseId: string; content: unknown; isError: boolean } | null {
  if (typeof block !== 'object' || block === null) return null;
  const record = block as unknown as Record<string, unknown>;
  const toolUseId = record['tool_use_id'];
  if (typeof toolUseId !== 'string') return null;

  const content = record['content'];
  const contentType =
    typeof content === 'object' && content !== null
      ? (content as Record<string, unknown>)['type']
      : undefined;

  return {
    toolUseId,
    content,
    isError:
      record['is_error'] === true ||
      (typeof contentType === 'string' && contentType.endsWith('_error')),
  };
}

/**
 * Flatten a tool result into display text.
 *
 * Providers return results as content-block arrays; the UI must not have to
 * know about provider-specific block shapes, which is exactly what
 * `ToolEndEvent.resultText` is for.
 */
export function flattenResultText(content: unknown): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (typeof entry === 'string') {
        parts.push(entry);
        continue;
      }
      if (typeof entry === 'object' && entry !== null) {
        const text = (entry as Record<string, unknown>)['text'];
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  if (typeof content === 'object') {
    const text = (content as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }

  return undefined;
}
