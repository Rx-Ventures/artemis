/**
 * Identifier aliases.
 *
 * These are deliberately plain `string` aliases rather than branded types.
 * Branding would buy a little safety at the cost of friction in every adapter,
 * every reducer and every test fixture; the names alone carry the intent.
 */

/**
 * Identifies one Libra run: a single `createRun()` call and the event stream
 * that comes out of it. Minted by core, never by a provider. A run may span
 * several provider "turns" and may outlive several provider session ids.
 */
export type RunId = string;

/**
 * Identifies a conversation as the *provider* knows it — for Claude this is the
 * uuid naming `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl`.
 * Resuming or forking is done with this id, not with {@link RunId}.
 */
export type SessionId = string;

/** Identifies a stored {@link import('./profile.js').Profile}. Minted by core. */
export type ProfileId = string;

/**
 * Identifies one assistant or user message within a session. Providers that do
 * not expose stable message ids must synthesise them; the UI relies on
 * `messageId` to attach `text.delta` events to the block they belong to.
 */
export type MessageId = string;

/**
 * Identifies a single tool invocation. Pairs `tool.start` with its `tool.end`,
 * and links a `permission.request` back to the call it is gating.
 */
export type ToolCallId = string;

/**
 * Identifies one outstanding permission prompt. Unique per run; this is the
 * value passed back to `Run.respondToPermission()`.
 */
export type PermissionRequestId = string;

/**
 * Identifies a subagent within a run, when a provider supports them. Present on
 * tool events so the UI can nest a subagent's work under the tool call that
 * spawned it.
 */
export type AgentId = string;
