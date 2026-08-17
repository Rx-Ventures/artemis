/**
 * The slice of the Agent Client Protocol Artemis actually speaks.
 *
 * ## Why a shared module rather than a second adapter's private types
 *
 * ACP is the first transport in Artemis with more than one provider behind it.
 * Codex's app-server protocol is Codex's alone, so `codexProtocol.ts` lives
 * beside the adapter that speaks it. ACP is the vendor-recommended machine
 * surface for OpenCode (`opencode acp`, verified live against 1.18.18),
 * for Kimi Code (`kimi acp`) and for xAI's Grok Build — three providers, one
 * dialect. The vocabulary therefore belongs one directory up from any of them,
 * so the second and third adapters are a mapper and a credential spec rather
 * than a second transcription of this file.
 *
 * ## Source of truth
 *
 * Transcribed from `@zed-industries/agent-client-protocol` 0.4.5 — its
 * generated `dist/schema.d.ts` and `schema/schema.json`, not the prose docs.
 * The same rule `codexProtocol.ts` follows applies here: **the published schema
 * remains the source of truth**; when the protocol moves, diff the generated
 * output against this file rather than editing from a changelog.
 *
 * Only what an adapter reads is declared. ACP's terminal methods
 * (`terminal/create` and friends) and `fs/read_text_file` are deliberately
 * absent: those are things a *client* implements for the agent's benefit, and
 * Artemis declines both. See {@link ACP_CLIENT_CAPABILITIES} for why that is a
 * safety decision and not an omission.
 *
 * ## Structural typing over runtime validation
 *
 * These are `interface`s over untyped JSON, narrowed by the small guards at the
 * bottom of this file and nothing else. That is the same trade the Claude and
 * Codex mappers make: a protocol that gains a field must not break a running
 * app, and one that removes a field should degrade to a missing event rather
 * than a crash. Every consumer treats every field as potentially absent.
 */

import type { JsonValue } from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Version                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The protocol version Artemis initializes with.
 *
 * ACP negotiates: the client proposes, and the agent answers with the version
 * it will actually speak. `1` is what the 0.4.5 schema defines and what
 * OpenCode 1.18.18 answers with. {@link AcpInitializeResponse.protocolVersion}
 * is the one that matters — an agent answering with something else is telling
 * us it speaks a dialect this module was not written against.
 */
export const ACP_PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Method names                                                               */
/* -------------------------------------------------------------------------- */

/** Client → agent requests. */
export const ACP_METHOD = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionSetMode: 'session/set_mode',
  /** Marked UNSTABLE in the schema; only sent when an agent advertised models. */
  sessionSetModel: 'session/set_model',

  /**
   * Beyond the 0.4.5 schema, and gated on {@link AcpAgentCapabilities.sessionCapabilities}.
   *
   * `sessionCapabilities` is itself a spec field, and agents use it to advertise
   * history operations the schema does not yet name: OpenCode 1.18.18 answers
   * `{ close, fork, list, resume }`, and Moonshot's Kimi Code was recorded
   * advertising the same family in the previous research round. So the
   * *capability* is a shared convention while the *method names* below are
   * verified against OpenCode only.
   *
   * Anything here must be called behind its capability flag. An agent that
   * advertises nothing gets asked nothing, and the UI degrades on the flag
   * rather than on a `METHOD_NOT_FOUND` the user would see as a crash.
   */
  sessionList: 'session/list',
  sessionFork: 'session/fork',
} as const;

/** Client → agent notifications. */
export const ACP_NOTIFICATION = {
  sessionCancel: 'session/cancel',
} as const;

/**
 * Agent → client requests and notifications.
 *
 * `session/request_permission` is the reason this transport can support
 * `Capabilities.interactivePermissions` at all: it is a *request*, so the turn
 * parks until Artemis answers, exactly like Codex's approval request. The
 * others are things Artemis declines to implement — listed here so an adapter
 * can answer them deliberately rather than let them fall through to
 * `METHOD_NOT_FOUND` by accident.
 */
export const ACP_CLIENT_METHOD = {
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  readTextFile: 'fs/read_text_file',
  writeTextFile: 'fs/write_text_file',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalRelease: 'terminal/release',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill',
} as const;

/**
 * The JSON-RPC error code an agent returns when a session needs a login.
 *
 * ACP defines `auth_required` as a distinct failure of `session/new`, which is
 * exactly the signal Artemis's sign-in flow wants: it answers "is this profile
 * signed in" over the transport, without a second probe process. Kimi's CLI was
 * verified emitting this in the previous research round, and it is why the
 * seam's transport-based auth probe is worth having.
 */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/* -------------------------------------------------------------------------- */
/* Initialization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What Artemis tells an agent it can do for it.
 *
 * **Everything is off, and that is a security decision rather than a backlog.**
 * ACP lets a client offer the agent a filesystem (`fs/read_text_file`,
 * `fs/write_text_file`) and a terminal (`terminal/create`). Accepting either
 * would mean Artemis executing the agent's file writes and shell commands in
 * the main process, *outside* the permission flow that mediates every tool call
 * today — a second, unmediated path to the user's disk.
 *
 * Declining costs nothing: the agents Artemis targets run locally with their
 * own filesystem and shell access, so they read and write directly and report
 * it as ordinary tool calls, which is what the transcript already renders. The
 * capability exists for *remote* agents that have no disk of their own, which
 * is not a shape Artemis serves.
 */
export const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

/** `initialize` params. */
export interface AcpInitializeRequest {
  readonly protocolVersion: number;
  readonly clientCapabilities: typeof ACP_CLIENT_CAPABILITIES;
}

/** One way an agent can be signed in, as advertised by `initialize`. */
export interface AcpAuthMethod {
  readonly id: string;
  readonly name: string;
  /**
   * Human-readable, and unusually useful: OpenCode answers "Run `opencode auth
   * login` in the terminal", which is precisely the instruction Artemis's
   * profile screen already shows for every provider. An agent that describes
   * its own sign-in in those terms is one that fits the CLI-owned-auth model
   * without adaptation.
   */
  readonly description?: string;
}

/**
 * What an agent says it can do, from `initialize`.
 *
 * Maps almost one-to-one onto Artemis's `Capabilities`, which is the single
 * biggest reason ACP is a good fit for the seam: `sessionCapabilities` answers
 * fork/list/resume, `promptCapabilities.image` answers `imageInput`, and
 * `loadSession` answers whether a stored conversation can be re-opened. An
 * adapter builds its descriptor from this rather than from a constant.
 */
export interface AcpAgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: {
    readonly image?: boolean;
    readonly audio?: boolean;
    readonly embeddedContext?: boolean;
  };
  /**
   * Present-key-means-supported, and the values are empty objects rather than
   * booleans — `{ "fork": {}, "list": {} }` is what OpenCode 1.18.18 sends.
   * Test with {@link hasSessionCapability}, never for truthiness of a boolean
   * that is not there.
   */
  readonly sessionCapabilities?: Readonly<Record<string, unknown>>;
  readonly mcpCapabilities?: {
    readonly http?: boolean;
    readonly sse?: boolean;
  };
}

/** `initialize` result. */
export interface AcpInitializeResponse {
  readonly protocolVersion: number;
  readonly agentCapabilities?: AcpAgentCapabilities;
  readonly authMethods?: readonly AcpAuthMethod[];
  readonly agentInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A displayable piece of content.
 *
 * Deliberately open at the end: the schema defines five variants (`text`,
 * `image`, `audio`, `resource_link`, `resource`) and a mapper that switches on
 * `type` must not fall over when a sixth appears. Only the ones Artemis renders
 * are given fields.
 */
export type AcpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string; readonly uri?: string | null }
  | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name: string;
      readonly mimeType?: string | null;
    }
  | { readonly type: 'resource'; readonly resource: JsonValue }
  | { readonly type: string };

/** Content produced *by* a tool call, as opposed to content sent to one. */
export type AcpToolCallContent =
  | { readonly type: 'content'; readonly content: AcpContentBlock }
  /**
   * The variant that makes a real diff view possible without parsing prose:
   * the agent hands over the path, the old text and the new text, which is
   * exactly what `DiffView` already renders for Claude's `Edit` tool.
   */
  | {
      readonly type: 'diff';
      readonly path: string;
      readonly newText: string;
      readonly oldText?: string | null;
    }
  | { readonly type: 'terminal'; readonly terminalId: string }
  | { readonly type: string };

/** Categories of tool, for icon selection. */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/** Where a tool call's execution has got to. */
export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A file (and optionally a line) a tool call touched. */
export interface AcpToolCallLocation {
  readonly path: string;
  readonly line?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Session updates                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The streamed body of a turn, discriminated by `sessionUpdate`.
 *
 * This is the union an adapter's mapper switches on, and the shape of Artemis's
 * own event union is visible in it: `agent_message_chunk` → `text.delta`,
 * `agent_thought_chunk` → `thinking.delta`, `tool_call` → `tool.start`,
 * `tool_call_update` at a terminal status → `tool.end`.
 *
 * Two variants have no Artemis event today and are declared anyway so a mapper
 * can drop them deliberately: `plan` (the agent's task list, which Artemis has
 * no todo surface for) and `available_commands_update` (slash commands, which
 * belong to the provider's own UI).
 */
export type AcpSessionUpdate =
  | { readonly sessionUpdate: 'user_message_chunk'; readonly content: AcpContentBlock }
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: AcpContentBlock }
  | { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: AcpContentBlock }
  | {
      readonly sessionUpdate: 'tool_call';
      readonly toolCallId: string;
      readonly title: string;
      readonly kind?: AcpToolKind;
      readonly status?: AcpToolCallStatus;
      readonly content?: readonly AcpToolCallContent[];
      readonly locations?: readonly AcpToolCallLocation[];
      readonly rawInput?: Readonly<Record<string, unknown>>;
      readonly rawOutput?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly sessionUpdate: 'tool_call_update';
      readonly toolCallId: string;
      /**
       * Every field is nullable *and* optional, with a specific meaning:
       * absent means "unchanged", and the client is expected to hold the tool
       * call's state and patch it. A mapper that rebuilt a tool row from each
       * update alone would lose the title on the update that only carries a
       * status.
       */
      readonly title?: string | null;
      readonly kind?: AcpToolKind | null;
      readonly status?: AcpToolCallStatus | null;
      readonly content?: readonly AcpToolCallContent[] | null;
      readonly locations?: readonly AcpToolCallLocation[] | null;
      readonly rawInput?: Readonly<Record<string, unknown>>;
      readonly rawOutput?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly sessionUpdate: 'plan';
      readonly entries: readonly {
        readonly content: string;
        readonly priority: 'high' | 'medium' | 'low';
        readonly status: 'pending' | 'in_progress' | 'completed';
      }[];
    }
  | { readonly sessionUpdate: 'available_commands_update'; readonly availableCommands: readonly JsonValue[] }
  | { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string }
  | { readonly sessionUpdate: string };

/** The `session/update` notification envelope. */
export interface AcpSessionNotification {
  readonly sessionId: string;
  readonly update: AcpSessionUpdate;
}

/* -------------------------------------------------------------------------- */
/* Sessions and turns                                                         */
/* -------------------------------------------------------------------------- */

/** `session/new` params. `mcpServers` is required by the schema, even when empty. */
export interface AcpNewSessionRequest {
  readonly cwd: string;
  readonly mcpServers: readonly JsonValue[];
}

/** `session/new` result. */
export interface AcpNewSessionResponse {
  readonly sessionId: string;
  /**
   * Spec-defined model and mode state. OpenCode 1.18.18 instead answers with
   * {@link configOptions} carrying the same information — an extension, not a
   * violation, since ACP allows unknown fields. An adapter reads whichever its
   * agent sends and treats both as absent-able.
   */
  readonly models?: JsonValue | null;
  readonly modes?: JsonValue | null;
  /** OpenCode's form of the above. See {@link AcpConfigOption}. */
  readonly configOptions?: readonly AcpConfigOption[];
}

/** `session/load` params — same shape as `session/new` plus the id to reopen. */
export interface AcpLoadSessionRequest extends AcpNewSessionRequest {
  readonly sessionId: string;
}

/** `session/prompt` params. */
export interface AcpPromptRequest {
  readonly sessionId: string;
  readonly prompt: readonly AcpContentBlock[];
}

/**
 * Why a turn ended.
 *
 * `cancelled` is the one an adapter must not treat as failure: it is the
 * documented answer to a `session/cancel` notification, and it maps onto
 * `run.end` with `reason: 'interrupted'`.
 */
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/**
 * Token accounting for a finished turn.
 *
 * Not in the 0.4.5 schema — OpenCode attaches it to the `session/prompt`
 * result, and it is strictly better than what the streamed `usage_update`
 * carries: that one reports how full the context window is, which is a
 * different quantity from what the turn actually spent. A turn that reads a
 * large file has high occupancy and modest output, and reporting the former as
 * the latter would overstate consumption on every subsequent turn.
 */
export interface AcpPromptUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** Reasoning tokens. Billed inside `outputTokens`, reported separately. */
  readonly thoughtTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
}

/**
 * `session/prompt` result.
 *
 * The request resolves **when the whole turn is over**, not when the prompt is
 * accepted — minutes later, for real work. `JsonRpcConnection.request` has no
 * timeout for exactly this reason.
 */
export interface AcpPromptResponse {
  readonly stopReason: AcpStopReason;
  /** Present on agents that report it; see {@link AcpPromptUsage}. */
  readonly usage?: AcpPromptUsage;
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One stored conversation, as `session/list` reports it.
 *
 * `cwd` is the load-bearing field: the seam requires a session's working
 * directory to come from session *data* and never from the storage layout,
 * because decoding a directory name is lossy and would confidently resume into
 * the wrong folder. This answer carries it, so nothing has to be decoded.
 */
export interface AcpSessionListEntry {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly title?: string;
  /** ISO-8601 in OpenCode; parsed defensively rather than assumed. */
  readonly updatedAt?: string;
  readonly createdAt?: string;
}

/** `session/list` result. */
export interface AcpSessionListResponse {
  readonly sessions: readonly AcpSessionListEntry[];
}

/** `session/fork` params. The cwd is required, as the agent's own error says. */
export interface AcpForkSessionRequest {
  readonly sessionId: string;
  readonly cwd: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration options                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One knob an agent offers for a session, from `session/new`, `session/load`
 * and `session/fork`.
 *
 * OpenCode's answer to "what models does this account have" and "what modes can
 * this session run in", delivered as a side effect of opening a session rather
 * than through a catalogue endpoint. That is why the adapter can publish a live
 * model list without spending a token: it already opened a session.
 */
export interface AcpConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string;
  readonly options?: readonly {
    readonly value: string;
    readonly name?: string;
    readonly description?: string;
  }[];
}

/** `session/cancel` params. A notification: there is no answer to wait for. */
export interface AcpCancelNotification {
  readonly sessionId: string;
}

/* -------------------------------------------------------------------------- */
/* Permission                                                                 */
/* -------------------------------------------------------------------------- */

/** What kind of answer an option represents. */
export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/**
 * One button on the approval prompt.
 *
 * The agent supplies the options rather than the client inventing them, which
 * is a better fit for Artemis than it first appears: `optionId` is opaque and
 * must be echoed back verbatim, so an adapter maps Artemis's allow/deny
 * decision onto whichever option carries the matching `kind` instead of
 * guessing at a string.
 */
export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: AcpPermissionOptionKind;
}

/** `session/request_permission` params, sent by the agent. */
export interface AcpRequestPermissionRequest {
  readonly sessionId: string;
  readonly options: readonly AcpPermissionOption[];
  /** The same shape as a `tool_call_update`, minus the discriminant. */
  readonly toolCall: {
    readonly toolCallId: string;
    readonly title?: string | null;
    readonly kind?: AcpToolKind | null;
    readonly status?: AcpToolCallStatus | null;
    readonly content?: readonly AcpToolCallContent[] | null;
    readonly locations?: readonly AcpToolCallLocation[] | null;
    readonly rawInput?: Readonly<Record<string, unknown>>;
  };
}

/** `session/request_permission` result. */
export interface AcpRequestPermissionResponse {
  readonly outcome:
    | { readonly outcome: 'selected'; readonly optionId: string }
    /**
     * The required answer when the client cancels the turn while a prompt is
     * outstanding. An adapter's `dispose` uses this rather than picking a
     * rejection option: "the user never answered" is not the same as "the user
     * said no", and only one of them should teach an agent anything.
     */
    | { readonly outcome: 'cancelled' };
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when an agent advertised a named session capability.
 *
 * The values are empty objects — `{ "fork": {} }` — so presence is the whole
 * test and truthiness is not. Written as a helper because getting it wrong
 * silently reports every capability as absent, which would degrade the UI to a
 * provider that cannot fork, list or resume while the agent happily does all
 * three.
 */
export function hasSessionCapability(
  capabilities: AcpAgentCapabilities | undefined,
  name: string,
): boolean {
  const session = capabilities?.sessionCapabilities;
  if (!isRecord(session)) return false;
  return Object.hasOwn(session, name) && session[name] !== false;
}

/** Narrow an `initialize` result. */
export function isInitializeResponse(value: unknown): value is AcpInitializeResponse {
  return isRecord(value) && typeof value['protocolVersion'] === 'number';
}

/** Narrow a `session/new` result. */
export function isNewSessionResponse(value: unknown): value is AcpNewSessionResponse {
  return isRecord(value) && typeof value['sessionId'] === 'string';
}

/** Narrow a `session/prompt` result. */
export function isPromptResponse(value: unknown): value is AcpPromptResponse {
  return isRecord(value) && typeof value['stopReason'] === 'string';
}

/** Narrow a `session/update` notification's params. */
export function isSessionNotification(value: unknown): value is AcpSessionNotification {
  if (!isRecord(value)) return false;
  if (typeof value['sessionId'] !== 'string') return false;
  const update = value['update'];
  return isRecord(update) && typeof update['sessionUpdate'] === 'string';
}

/** Narrow a `session/request_permission` request's params. */
export function isRequestPermissionRequest(
  value: unknown,
): value is AcpRequestPermissionRequest {
  if (!isRecord(value)) return false;
  if (typeof value['sessionId'] !== 'string') return false;
  if (!Array.isArray(value['options'])) return false;
  return isRecord(value['toolCall']);
}

/**
 * True when a `session/new` failure means "this profile is not signed in".
 *
 * Checks the code *and* the message, because the code alone is
 * `-32000` — JSON-RPC's "implementation-defined server error", which an agent
 * may reuse for other failures. Treating an unrelated server error as
 * "signed out" would send the user to run a login that fixes nothing.
 */
export function isAuthRequiredError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error['code'] !== ACP_AUTH_REQUIRED_CODE) return false;
  const message = error['message'];
  return typeof message === 'string' && /auth/i.test(message);
}

/** Terminal statuses, where a tool row stops being live. */
export function isTerminalToolStatus(status: AcpToolCallStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

/** Narrow a `session/list` result. */
export function isSessionListResponse(value: unknown): value is AcpSessionListResponse {
  return isRecord(value) && Array.isArray(value['sessions']);
}

/**
 * Pull one config option out of whatever a session-opening call answered with.
 *
 * Tolerant by design: the same information arrives as `configOptions` from
 * OpenCode and as `models`/`modes` from a spec-conformant agent, and an adapter
 * that demanded either shape would break on the other.
 */
export function readConfigOption(
  value: unknown,
  id: string,
): AcpConfigOption | undefined {
  if (!isRecord(value)) return undefined;
  const options = value['configOptions'];
  if (!Array.isArray(options)) return undefined;

  for (const entry of options) {
    if (isRecord(entry) && entry['id'] === id) return entry as unknown as AcpConfigOption;
  }
  return undefined;
}
