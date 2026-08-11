/**
 * The slice of the Codex app-server protocol Artemis actually speaks.
 *
 * ## Why this is hand-written when the CLI can generate it
 *
 * `codex app-server generate-ts --out ./schemas` emits the complete protocol —
 * roughly 170 files covering ~100 client methods, 69 notifications and 10
 * server-initiated requests. Almost none of that is reachable from Artemis:
 * there is no plugin marketplace here, no realtime audio, no Windows sandbox
 * setup, no fuzzy file search.
 *
 * Vendoring the generated tree would mean carrying all of it, regenerating it
 * on every CLI bump, and reviewing diffs dominated by surface we never call.
 * Worse, it would hide the interesting question — *which* fields does Artemis
 * depend on? — inside a wall of generated code.
 *
 * So this file declares only what the adapter reads, and every type here was
 * transcribed from generated output rather than from prose documentation.
 * **The generated schema remains the source of truth**: when the protocol
 * moves, regenerate it and diff against this file.
 *
 * Transcribed from `codex-cli 0.142.3`.
 *
 * ## Structural typing is doing real work here
 *
 * These are `interface`s over data that arrives as untyped JSON. Nothing
 * validates them at runtime beyond the narrow guards at the bottom of this
 * file, which is a deliberate trade: the mapper treats every field as
 * potentially absent and drops what it cannot understand, exactly as the Claude
 * mapper does for unrecognised SDK messages. A protocol that gains a field
 * should not break a running app, and one that removes a field should degrade
 * to a missing event rather than a crash.
 */

import type { JsonValue } from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Method names                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Client → server methods.
 *
 * Only the stable ones. Everything gated behind `capabilities.experimentalApi`
 * is deliberately absent: opting in would let a CLI upgrade change behaviour
 * under a shipped Artemis build.
 */
export const CODEX_METHOD = {
  initialize: 'initialize',
  getAuthStatus: 'getAuthStatus',
  modelList: 'model/list',
  accountRateLimitsRead: 'account/rateLimits/read',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  threadRead: 'thread/read',
  threadList: 'thread/list',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;

/** Server → client notifications the adapter acts on. */
export const CODEX_NOTIFICATION = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  error: 'error',
} as const;

/** Server → client requests. Each one parks the turn until answered. */
export const CODEX_SERVER_REQUEST = {
  commandExecutionApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
} as const;

/* -------------------------------------------------------------------------- */
/* Handshake                                                                  */
/* -------------------------------------------------------------------------- */

export interface CodexClientInfo {
  readonly name: string;
  readonly title?: string;
  readonly version?: string;
}

export interface CodexInitializeParams {
  readonly clientInfo: CodexClientInfo;
  /**
   * Left empty on purpose. `experimentalApi` would unlock methods whose shape
   * the server is free to change between patch releases.
   */
  readonly capabilities: Record<string, never>;
}

export interface CodexInitializeResponse {
  readonly userAgent?: string;
  /** The config directory actually in effect — the echo of `CODEX_HOME`. */
  readonly codexHome?: string;
  readonly platformFamily?: string;
  readonly platformOs?: string;
}

/* -------------------------------------------------------------------------- */
/* Turn configuration                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How much the agent asks before acting.
 *
 * Codex's first axis. `granular` exists on the wire but is not modelled: it
 * takes five independent booleans, which is a richer surface than Artemis's
 * single `PermissionMode` can express without inventing UI for it.
 */
export type CodexAskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';

/**
 * What the agent may touch.
 *
 * Codex's second axis, and the one with no Claude analogue — Claude's
 * permission modes fold "may it write?" into the same knob as "must it ask?".
 * See `toCodexPermissions` in `codex.ts` for how the two axes are recovered
 * from one Artemis mode.
 */
export type CodexSandboxPolicy =
  | { readonly type: 'dangerFullAccess' }
  | { readonly type: 'readOnly'; readonly networkAccess: boolean }
  | {
      readonly type: 'workspaceWrite';
      readonly writableRoots: readonly string[];
      readonly networkAccess: boolean;
      readonly excludeTmpdirEnvVar: boolean;
      readonly excludeSlashTmp: boolean;
    };

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * One piece of user input.
 *
 * `text_elements` is snake_case where every sibling field is camelCase, and it
 * is **required** rather than optional — omitting it fails the whole request
 * with `Invalid request: missing field \`type\``, an error that names the wrong
 * field and sends you looking in the wrong place. Always send `[]`.
 */
export interface CodexTextInput {
  readonly type: 'text';
  readonly text: string;
  readonly text_elements: readonly never[];
}

export interface CodexThreadStartParams {
  readonly cwd?: string;
}

export interface CodexThreadResumeParams {
  readonly threadId: string;
  readonly cwd?: string;
}

export interface CodexTurnStartParams {
  readonly threadId: string;
  readonly input: readonly CodexTextInput[];
  readonly cwd?: string;
  readonly approvalPolicy?: CodexAskForApproval;
  readonly sandboxPolicy?: CodexSandboxPolicy;
  readonly model?: string;
  readonly effort?: CodexReasoningEffort;
}

export interface CodexTurnSteerParams {
  readonly threadId: string;
  /** The server rejects the steer if this does not match the live turn. */
  readonly expectedTurnId: string;
  readonly input: readonly CodexTextInput[];
}

/* -------------------------------------------------------------------------- */
/* Threads and turns                                                          */
/* -------------------------------------------------------------------------- */

export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface CodexTurnError {
  readonly message: string;
  readonly codexErrorInfo?: { readonly httpStatusCode?: number | null } | null;
  readonly additionalDetails?: string | null;
}

export interface CodexTurn {
  readonly id: string;
  readonly status: CodexTurnStatus;
  readonly error?: CodexTurnError | null;
  readonly durationMs?: number | null;
  readonly items?: readonly CodexThreadItem[];
}

/**
 * A conversation.
 *
 * `cwd` is a real field rather than something recovered from the storage path,
 * which is the whole reason `listAllSessions` is straightforward for this
 * provider — see the note on `ProviderAdapter.listAllSessions` about Claude's
 * lossy project-directory encoding.
 */
export interface CodexThread {
  readonly id: string;
  readonly sessionId: string;
  readonly forkedFromId?: string | null;
  readonly preview?: string;
  readonly modelProvider?: string;
  /** Unix seconds, not milliseconds. */
  readonly createdAt?: number;
  /** Unix seconds, not milliseconds. */
  readonly updatedAt?: number;
  readonly path?: string | null;
  readonly cwd?: string;
  readonly cliVersion?: string;
  readonly name?: string | null;
  readonly turns?: readonly CodexTurn[];
}

export interface CodexThreadListParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly cwd?: string;
}

export interface CodexThreadListResponse {
  readonly data?: readonly CodexThread[];
  readonly nextCursor?: string | null;
}

export interface CodexThreadReadParams {
  readonly threadId: string;
  readonly includeTurns?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

export type CodexCommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | string;

/**
 * One entry in a turn's transcript.
 *
 * Modelled as a partial union: the eight variants Artemis renders are declared,
 * and everything else (realtime audio, image generation, collab agents, review
 * mode) falls into {@link CodexUnknownItem} and is dropped explicitly by the
 * mapper rather than by a `default` nobody thought about.
 */
export type CodexThreadItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexUnknownItem;

export interface CodexUserMessageItem {
  readonly type: 'userMessage';
  readonly id: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
}

export interface CodexAgentMessageItem {
  readonly type: 'agentMessage';
  readonly id: string;
  readonly text: string;
}

export interface CodexReasoningItem {
  readonly type: 'reasoning';
  readonly id: string;
  readonly summary?: readonly string[];
  readonly content?: readonly string[];
}

export interface CodexCommandExecutionItem {
  readonly type: 'commandExecution';
  readonly id: string;
  readonly command: string;
  readonly cwd?: string;
  readonly status?: CodexCommandExecutionStatus;
  readonly aggregatedOutput?: string | null;
  readonly exitCode?: number | null;
  readonly durationMs?: number | null;
}

export interface CodexFileUpdateChange {
  readonly path?: string;
  readonly kind?: string;
  readonly diff?: string;
}

export interface CodexFileChangeItem {
  readonly type: 'fileChange';
  readonly id: string;
  readonly changes?: readonly CodexFileUpdateChange[];
  readonly status?: string;
}

export interface CodexMcpToolCallItem {
  readonly type: 'mcpToolCall';
  readonly id: string;
  readonly server: string;
  readonly tool: string;
  readonly status?: string;
  readonly arguments?: JsonValue;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly durationMs?: number | null;
}

export interface CodexWebSearchItem {
  readonly type: 'webSearch';
  readonly id: string;
  readonly query: string;
}

/** Any item variant this build does not model. */
export interface CodexUnknownItem {
  readonly type: string;
  readonly id: string;
}

/* -------------------------------------------------------------------------- */
/* Notification payloads                                                      */
/* -------------------------------------------------------------------------- */

export interface CodexThreadStartedNotification {
  readonly thread: CodexThread;
}

export interface CodexTurnStartedNotification {
  readonly threadId: string;
  readonly turn: CodexTurn;
}

export interface CodexTurnCompletedNotification {
  readonly threadId: string;
  readonly turn: CodexTurn;
}

export interface CodexItemNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: CodexThreadItem;
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
}

export interface CodexAgentMessageDeltaNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly delta: string;
}

export interface CodexReasoningDeltaNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly delta: string;
}

/** Absolute counts, not increments — see the note on `usageScope` in the mapper. */
export interface CodexTokenUsageBreakdown {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface CodexTokenUsageNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly tokenUsage?: {
    readonly total?: CodexTokenUsageBreakdown;
    readonly last?: CodexTokenUsageBreakdown;
    readonly modelContextWindow?: number | null;
  };
}

export interface CodexErrorNotification {
  readonly message?: string;
  readonly threadId?: string;
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

export interface CodexCommandApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly approvalId?: string | null;
  readonly reason?: string | null;
  readonly command?: string | null;
  readonly cwd?: string | null;
  readonly startedAtMs?: number;
}

export interface CodexFileChangeApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly reason?: string | null;
  /** The directory the agent wants write access to for the rest of the session. */
  readonly grantRoot?: string | null;
  readonly startedAtMs?: number;
}

export interface CodexPermissionsApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly reason?: string | null;
  readonly permissions?: JsonValue;
}

/**
 * The three decision vocabularies.
 *
 * They overlap but are not the same type on the wire, and command execution
 * carries two structured variants the other two do not. Artemis's
 * `PermissionDecision` is a single allow/deny, so the adapter translates per
 * request kind rather than assuming one shape fits all — see
 * `toApprovalResponse`.
 */
export type CodexFileChangeDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type CodexCommandDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

export interface CodexModelEntry {
  readonly id?: string;
  readonly model?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly isDefault?: boolean;
  readonly supportedReasoningEfforts?: readonly {
    readonly reasoningEffort?: string;
    readonly description?: string;
  }[];
  readonly defaultReasoningEffort?: string;
}

export interface CodexModelListResponse {
  readonly data?: readonly CodexModelEntry[];
}

export interface CodexRateLimitWindow {
  readonly usedPercent?: number | null;
  readonly windowDurationMins?: number | null;
  /** Unix **seconds**, unlike every `*AtMs` field in this protocol. */
  readonly resetsAt?: number | null;
}

export interface CodexRateLimits {
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
  readonly planType?: string | null;
}

export interface CodexRateLimitsResponse {
  readonly rateLimits?: CodexRateLimits | null;
}

export interface CodexAuthStatusResponse {
  /** `chatgpt` for a subscription, `apikey` for metered billing, absent when signed out. */
  readonly authMethod?: string | null;
  readonly requiresOpenaiAuth?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Narrowing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read an unknown JSON value as a record.
 *
 * Every notification payload goes through this before anything is pulled off
 * it, so a payload that is null, an array or a bare string produces "no fields"
 * rather than a `TypeError` from the first property access.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Read a string field, treating an empty string as absent. */
export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Read a finite number field. Rejects `NaN` and `Infinity`, which JSON permits. */
export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
