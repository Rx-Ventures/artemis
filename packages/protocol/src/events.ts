/**
 * The normalized event union.
 *
 * This is the narrow waist of the whole application. Every provider maps its
 * native stream onto exactly these nine event types, and every consumer — the
 * session store, the transcript renderer, the usage readout — reads only
 * these. If something cannot be expressed here, it does not reach the UI.
 *
 * Rules for adapter authors:
 *
 *  1. **Order is the contract.** `session.started` is always first. `run.end`
 *     is always last and always emitted, including on failure and on dispose.
 *     Nothing follows `run.end`.
 *  2. **`seq` is dense and monotonic** within a run, starting at 0. Consumers
 *     use it to detect drops and to sort after an IPC round-trip.
 *  3. **Deltas are additive.** Concatenating every `text.delta` for a
 *     `(messageId, blockIndex)` pair must reproduce the `text` of the matching
 *     `text.complete`. Never re-send text already sent as a delta.
 *  4. **Non-streaming providers skip the deltas.** If
 *     {@link import('./provider.js').Capabilities.partialMessages} is false,
 *     emit `text.complete` only. A provider that cannot stream *thinking*
 *     separately should emit one `thinking.delta` carrying the whole block
 *     rather than inventing a completion event.
 *  5. **Every `tool.start` gets a `tool.end`.** Including when the run is
 *     interrupted — emit `tool.end` with `status: 'cancelled'` before
 *     `run.end`. The UI must never be left with a spinner it cannot clear.
 */

import type {
  AgentId,
  MessageId,
  PermissionRequestId,
  RunId,
  SessionId,
  ToolCallId,
} from './ids.js';
import type { AgentError } from './errors.js';
import type { JsonObject, JsonValue } from './json.js';
import type { PermissionMode, PermissionRequest, QuestionAnswer } from './permissions.js';
import type { ProviderId } from './provider.js';
import type { UsageSnapshot } from './usage.js';

/** Discriminator values of {@link AgentEvent}. */
export type AgentEventType =
  | 'session.started'
  | 'text.delta'
  | 'text.complete'
  | 'thinking.delta'
  | 'tool.start'
  | 'tool.end'
  | 'permission.request'
  | 'permission.resolved'
  | 'usage'
  | 'run.end';

/** Every {@link AgentEventType}. Useful for validation at the IPC boundary. */
export const AGENT_EVENT_TYPES = [
  'session.started',
  'text.delta',
  'text.complete',
  'thinking.delta',
  'tool.start',
  'tool.end',
  'permission.request',
  'permission.resolved',
  'usage',
  'run.end',
] as const satisfies readonly AgentEventType[];

/** Fields carried by every event. */
export interface AgentEventBase {
  readonly type: AgentEventType;
  /** The run this event belongs to. Required — the renderer multiplexes runs. */
  readonly runId: RunId;
  /** Dense, monotonically increasing per run, starting at 0. */
  readonly seq: number;
  /** Emission time, ms since epoch, as measured in the main process. */
  readonly ts: number;
}

/* -------------------------------------------------------------------------- */
/* session.started                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The provider has accepted the run and told us who it is.
 *
 * Always the first event. Carries the {@link SessionId} the provider assigned,
 * which is what later resume/fork calls and `sessions:list` results key on.
 */
export interface SessionStartedEvent extends AgentEventBase {
  readonly type: 'session.started';
  readonly sessionId: SessionId;
  readonly providerId: ProviderId;
  /** Working directory the agent is operating in. */
  readonly cwd: string;
  /** Model actually in use, which may differ from the one requested. */
  readonly model?: string;
  /** Tool names available to the agent this run. */
  readonly tools?: readonly string[];
  /** Slash commands the provider exposes, for the composer's autocomplete. */
  readonly slashCommands?: readonly string[];
  /** Permission mode the run actually started in. */
  readonly permissionMode?: PermissionMode;
  /** Set when this run resumed or forked an existing session. */
  readonly resumedFrom?: SessionId;
  /** True when {@link resumedFrom} was forked rather than continued. */
  readonly forked?: boolean;
  /** Provider version string, for the diagnostics pane. */
  readonly providerVersion?: string;
}

/* -------------------------------------------------------------------------- */
/* text.delta / text.complete                                                 */
/* -------------------------------------------------------------------------- */

/**
 * An incremental chunk of assistant text.
 *
 * Only emitted when the provider advertises `partialMessages`. `text` is the
 * *new* fragment, never the accumulated string.
 */
export interface TextDeltaEvent extends AgentEventBase {
  readonly type: 'text.delta';
  readonly messageId: MessageId;
  /** Index of the content block within the message. Deltas interleave. */
  readonly blockIndex: number;
  /** The fragment to append. May be empty; never undefined. */
  readonly text: string;
  /** Set when the text came from a subagent rather than the main agent. */
  readonly agentId?: AgentId;
}

/** Why the model stopped generating. */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | 'pause_turn'
  | 'other';

/**
 * A finished text block.
 *
 * Emitted for assistant output and, when a provider echoes them, for user
 * messages that Artemis did not originate — replayed history, and output an
 * adapter deliberately attributes to the user side. `text` is the complete
 * block: a consumer that ignored every delta and read only `text.complete`
 * would still render the full transcript.
 */
export interface TextCompleteEvent extends AgentEventBase {
  readonly type: 'text.complete';
  readonly messageId: MessageId;
  readonly role: 'assistant' | 'user';
  /** The whole block, not a fragment. */
  readonly text: string;
  /** Matches the deltas' `blockIndex` when the block was streamed. */
  readonly blockIndex?: number;
  readonly stopReason?: StopReason;
  /** True when this is a replay of history rather than new generation. */
  readonly replay?: boolean;
  /**
   * True for text an adapter generated rather than relayed from the model or
   * the person — a refusal notice, the output of a locally-run slash command.
   *
   * Not a general "the user did not type this" marker: a user-role turn the
   * *harness* wrote (an injected skill body, an auto-continuation, a system
   * reminder) is dropped rather than flagged, because a user row is a record of
   * what someone said. See `isHumanTurn` in the Claude mapper.
   */
  readonly synthetic?: boolean;
  readonly agentId?: AgentId;
}

/* -------------------------------------------------------------------------- */
/* thinking.delta                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A chunk of extended-thinking output.
 *
 * There is deliberately no `thinking.complete`: thinking is presentational and
 * nothing downstream needs a completion signal for it. A provider that only
 * hands over thinking in one piece emits a single event with the whole text.
 *
 * `redacted` marks thinking the provider encrypted or withheld — render a
 * placeholder, and expect {@link text} to be empty.
 *
 * Empty {@link text} is otherwise not a valid event. A thinking block that is
 * neither text nor redaction has nothing to show, and the model does think
 * without handing back the plaintext: roughly half the `thinking` blocks in a
 * stored Claude transcript are an empty string beside a full signature, which
 * is the provider keeping the block's identity while withholding its content.
 * Emitting those produced a transcript of empty "thinking…" folds, so a mapper
 * that finds no text drops the event rather than passing the emptiness on.
 */
export interface ThinkingDeltaEvent extends AgentEventBase {
  readonly type: 'thinking.delta';
  readonly messageId: MessageId;
  readonly blockIndex: number;
  readonly text: string;
  readonly redacted?: boolean;
  readonly agentId?: AgentId;
}

/* -------------------------------------------------------------------------- */
/* tool.start / tool.end                                                      */
/* -------------------------------------------------------------------------- */

/** The agent has begun a tool call. */
export interface ToolStartEvent extends AgentEventBase {
  readonly type: 'tool.start';
  readonly toolCallId: ToolCallId;
  /** Tool name as the provider reports it, e.g. `"Read"`, `"Bash"`. */
  readonly name: string;
  /** Arguments the tool was called with. */
  readonly input: JsonObject;
  /** The assistant message this call was issued from, when known. */
  readonly messageId?: MessageId;
  /** Set when this call was made by a subagent. */
  readonly agentId?: AgentId;
  /** The tool call that spawned the subagent making this call. */
  readonly parentToolCallId?: ToolCallId;
  /** One-line summary for compact rendering, e.g. `"Read src/index.ts"`. */
  readonly title?: string;
}

/**
 * How a tool call finished.
 *
 * - `ok`        — completed; {@link ToolEndEvent.result} holds its output.
 * - `error`     — the tool ran and failed; `error` explains why.
 * - `denied`    — the user refused it at a permission prompt.
 * - `cancelled` — the run was interrupted or disposed before it finished.
 */
export type ToolEndStatus = 'ok' | 'error' | 'denied' | 'cancelled';

/** A tool call has finished, one way or another. */
export interface ToolEndEvent extends AgentEventBase {
  readonly type: 'tool.end';
  readonly toolCallId: ToolCallId;
  /** Repeated from `tool.start` so late subscribers can render standalone. */
  readonly name?: string;
  readonly status: ToolEndStatus;
  /** Structured output, when the tool produced any. */
  readonly result?: JsonValue;
  /**
   * Flattened text of the result for display. Adapters fill this in when the
   * structured result is a content-block array, so the UI never has to know
   * about provider-specific block shapes.
   */
  readonly resultText?: string;
  /** Present when `status` is `'error'`. */
  readonly error?: AgentError;
  /** Wall-clock duration of the call in milliseconds. */
  readonly durationMs?: number;
  readonly agentId?: AgentId;
  readonly parentToolCallId?: ToolCallId;
}

/* -------------------------------------------------------------------------- */
/* permission.request                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The run is parked waiting for the user to approve a tool call.
 *
 * Only emitted by providers advertising `interactivePermissions`. The run makes
 * no further progress until `respondToPermission()` is called with the matching
 * {@link PermissionRequestId}.
 */
export interface PermissionRequestEvent extends AgentEventBase {
  readonly type: 'permission.request';
  /** Convenience copy of `request.id` so consumers can key without unwrapping. */
  readonly requestId: PermissionRequestId;
  readonly request: PermissionRequest;
}

/* -------------------------------------------------------------------------- */
/* permission.resolved                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A parked request is no longer parked.
 *
 * ## Why the stream has to say so
 *
 * Answering a prompt is an IPC *call*, and a call is invisible to anyone who was
 * not the caller. The event stream is the only account of a run that survives
 * the caller — it is what a second window reads, and what a reloaded renderer
 * replays. Without this event that account is missing its second half: every
 * `permission.request` in the history reads as still open, forever.
 *
 * That is not hypothetical. `⌘R` reloads the renderer without touching the main
 * process, and the re-attach path replays the retained events through the
 * ordinary handlers. A request whose answer was never written down came back
 * *pending* — so the user was asked to approve something they had already
 * approved, and answering the ghost failed, because the registry had long since
 * settled it. Emitting the resolution is what makes the replay agree with the
 * run.
 *
 * ## Emitted for every way a request can end
 *
 * The user answering is only one of them. The provider can withdraw a request
 * (the turn was interrupted, the tool became moot) and adapters settle
 * everything outstanding on dispose. Those paths never reach
 * `respondToPermission`, so a consumer that inferred resolution from its own
 * calls would keep waiting on them — which is the bug one level up from the one
 * above. Adapters emit this for all three.
 *
 * Always follows the matching `permission.request`, and never appears without
 * one. Consumers key on {@link requestId} and must tolerate an id they do not
 * know: the retained history is bounded, so a long run can drop the request and
 * keep the resolution.
 */
export interface PermissionResolvedEvent extends AgentEventBase {
  readonly type: 'permission.resolved';
  /** The {@link PermissionRequestEvent.requestId} this settles. */
  readonly requestId: PermissionRequestId;
  /**
   * How it ended.
   *
   * - `allowed`   — the user approved it; the tool ran.
   * - `denied`    — the user refused it.
   * - `withdrawn` — nobody answered: the provider took the request back, or the
   *                 run was disposed with it still open. Rendered as "the choice
   *                 was taken away" rather than as a decision the user made,
   *                 because they did not make one.
   */
  readonly outcome: 'allowed' | 'denied' | 'withdrawn';
  /**
   * One sentence for the transcript's record of it — the denial message the
   * user typed, or why the request was withdrawn.
   */
  readonly note?: string;
  /**
   * The answers, when the request carried a `QuestionPrompt`.
   *
   * Carried so a replayed interview can be shown as it was answered — the
   * questions with the chosen options marked — rather than collapsing to
   * "allowed", which is not even the right word for answering a question. The
   * consumer that sent the decision already has these; this is for every
   * consumer that did not.
   */
  readonly answers?: readonly QuestionAnswer[];
}

/* -------------------------------------------------------------------------- */
/* usage                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A token/cost report.
 *
 * Read {@link UsageSnapshot.scope} before doing arithmetic: `delta` events add
 * up, `cumulative` and `final` events replace.
 */
export interface UsageEvent extends AgentEventBase {
  readonly type: 'usage';
  readonly usage: UsageSnapshot;
}

/* -------------------------------------------------------------------------- */
/* run.end                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a run stopped.
 *
 * - `completed`         — the agent finished its turn normally.
 * - `interrupted`       — `interrupt()` was called.
 * - `disposed`          — `dispose()` tore the run down.
 * - `max_turns`         — hit the configured turn ceiling.
 * - `budget_exceeded`   — hit a cost or token ceiling.
 * - `permission_denied` — a denial with `interrupt: true` ended the run.
 * - `error`             — anything else; {@link RunEndEvent.error} is set.
 */
export type RunEndReason =
  | 'completed'
  | 'interrupted'
  | 'disposed'
  | 'max_turns'
  | 'budget_exceeded'
  | 'permission_denied'
  | 'error';

/**
 * Terminal event. Always emitted exactly once, always last.
 *
 * After this the run's `events` iterable completes and the {@link RunId} is
 * retired — sending to it, interrupting it or answering a permission request on
 * it is an error.
 */
export interface RunEndEvent extends AgentEventBase {
  readonly type: 'run.end';
  readonly reason: RunEndReason;
  /** Set when `reason` is `'error'`. */
  readonly error?: AgentError;
  /** The provider session this run wrote to, for resuming later. */
  readonly sessionId?: SessionId;
  /** Authoritative totals for the run, equivalent to a `final`-scope usage. */
  readonly usage?: UsageSnapshot;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
  /** Number of assistant turns the run took. */
  readonly numTurns?: number;
  /** The provider's own final text, when it summarises one. */
  readonly result?: string;
}

/* -------------------------------------------------------------------------- */
/* union                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything a run can emit. Discriminated on `type`; switch over it with a
 * `default: assertNever(event)` branch so new variants cannot be silently
 * ignored.
 */
export type AgentEvent =
  | SessionStartedEvent
  | TextDeltaEvent
  | TextCompleteEvent
  | ThinkingDeltaEvent
  | ToolStartEvent
  | ToolEndEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | UsageEvent
  | RunEndEvent;

/** Look up an event variant by its `type`, e.g. `AgentEventOf<'tool.end'>`. */
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

/** Narrowing helper, handy in `filter` callbacks and tests. */
export function isAgentEventOf<T extends AgentEventType>(
  event: AgentEvent,
  type: T,
): event is AgentEventOf<T> {
  return event.type === type;
}

/** True for the one event type that terminates a run. */
export function isTerminalEvent(event: AgentEvent): event is RunEndEvent {
  return event.type === 'run.end';
}
