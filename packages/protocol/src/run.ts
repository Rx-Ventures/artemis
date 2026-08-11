/**
 * Run inputs and run state.
 *
 * A *run* is one `createRun()` call: a prompt, the stream of events it
 * produces, and the handful of control operations available while it is alive.
 * It is Apollo's unit of work, and it is not the same thing as a provider
 * session — one session can be resumed by many runs over its lifetime.
 */

import type { Capabilities, ProviderId } from './provider.js';
import type { JsonObject } from './json.js';
import type { PermissionMode } from './permissions.js';
import type { ProfileId, RunId, SessionId } from './ids.js';

/**
 * What to do with the provider's built-in system prompt.
 *
 * - `default` — use the provider's own prompt untouched.
 * - `append`  — keep it and add {@link text} after it. The safe way to add
 *               project conventions without losing tool instructions.
 * - `replace` — discard it and use {@link text} instead. Expect degraded tool
 *               use; providers rely on their prompt to describe their tools.
 */
export type SystemPromptSpec =
  | { readonly kind: 'default' }
  | { readonly kind: 'append'; readonly text: string }
  | { readonly kind: 'replace'; readonly text: string };

/**
 * How much reasoning effort a run should ask the model for.
 *
 * **Deliberately opaque**, exactly like `ProviderPermissionMode`. The levels
 * Apollo ships today are Claude's (`low`…`max`), and naming them here would
 * make one provider's scale a universal fact. Each adapter declares its own
 * and publishes them as
 * {@link import('./provider.js').ProviderDescriptor.effortLevels}; the UI
 * builds its picker from that.
 *
 * Absent means "the provider's default effort" — never "none".
 */
export type ProviderEffort = string;

/** An effort id: lower-case, short, and safe to use as an object key. */
const EFFORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Shape check for a {@link ProviderEffort}.
 *
 * Answers "could this be an effort id?", not "does this provider have one by
 * that name?" — the second question needs the adapter, which this package
 * cannot see. The authoritative check happens in the adapter, which rejects a
 * level it does not declare rather than silently dropping it.
 */
export function isProviderEffort(value: unknown): value is ProviderEffort {
  return typeof value === 'string' && EFFORT_ID_PATTERN.test(value);
}

/**
 * Everything needed to start a run.
 *
 * Note what is *not* here: no API key, no environment variables, no config
 * directory. Those are resolved in the main process from
 * {@link RunInput.profileId} and never travel with the request. A renderer
 * cannot start a run with credentials of its own choosing, and cannot read the
 * ones that get used.
 */
export interface RunInput {
  readonly providerId: ProviderId;
  /**
   * Which profile supplies credentials, backend selection and config isolation.
   * The main process turns this into an env bundle; the renderer only ever
   * holds the id.
   */
  readonly profileId: ProfileId;
  /** Working directory for the agent. Must be an absolute path. */
  readonly cwd: string;
  /** The user's message. For a resumed session this is the next turn. */
  readonly prompt: string;

  /**
   * Caller-supplied run id. Omit and core mints one. Supplying it lets the
   * renderer create optimistic UI before the IPC round-trip returns.
   */
  readonly runId?: RunId;

  /**
   * Continue an existing provider session. Requires
   * {@link Capabilities.resumeSession}.
   */
  readonly resumeSessionId?: SessionId;
  /**
   * Branch {@link resumeSessionId} into a new session instead of continuing it,
   * leaving the original transcript untouched. Requires
   * {@link Capabilities.forkSession}, and is ignored without `resumeSessionId`.
   */
  readonly forkSession?: boolean;

  /**
   * Model identifier, as the provider names it. Omit for the provider default.
   *
   * {@link import('./provider.js').ProviderDescriptor.models} is what the UI
   * *offers*, not an exhaustive allow-list: providers accept dated snapshot ids
   * and aliases beyond the handful worth putting in a picker, so an id outside
   * that list is passed through rather than rejected. The picker builds itself
   * from the descriptor; the field stays open.
   */
  readonly model?: string;
  /** Model to retry with if {@link model} is unavailable or overloaded. */
  readonly fallbackModel?: string;

  /**
   * Reasoning effort for this run. Must be one of the provider's
   * {@link import('./provider.js').ProviderDescriptor.effortLevels}, and one
   * the selected {@link model} accepts. Omit for the provider's default.
   *
   * Ignored — not rejected — by providers that publish no levels, so a stored
   * preference does not become an error when the user switches provider.
   */
  readonly effort?: ProviderEffort;

  /**
   * Trade reasoning depth for latency on models that offer it.
   *
   * Only meaningful when the selected model advertises
   * {@link import('./provider.js').ProviderModelOption.supportsFastMode}.
   * Ignored — not rejected — otherwise, for the same reason {@link effort} is:
   * a stored preference must not become an error when the user switches model.
   *
   * Whether it actually engaged is a *separate* fact from whether it was asked
   * for. A provider may decline (no entitlement, a model that does not allow
   * it, a cooldown after heavy use), so the UI must report the state the run
   * comes back with rather than echoing the request.
   */
  readonly fastMode?: boolean;

  /**
   * Spend materially more compute on this run: maximum reasoning effort plus,
   * on providers that have it, standing multi-agent orchestration.
   *
   * The inverse of {@link fastMode}, and mutually exclusive with it in spirit
   * though not by contract — a provider that is handed both is free to resolve
   * the conflict, and Apollo's UI does not offer them together.
   *
   * Only meaningful when the selected model advertises
   * {@link import('./provider.js').ProviderModelOption.supportsUltracode}.
   * Providers may impose further preconditions of their own (Claude requires an
   * xhigh-capable model with workflows enabled); those are the provider's to
   * enforce, and this flag being set is a request rather than a guarantee.
   */
  readonly ultracode?: boolean;

  /**
   * Permission mode to start in. Must be one of the provider's
   * {@link Capabilities.permissionModes}; adapters reject anything else rather
   * than silently downgrading, because silently downgrading a permission mode
   * is how you end up more permissive than the user asked for.
   */
  readonly permissionMode?: PermissionMode;

  /** Allow-list of tool names. Omit for the provider's default tool set. */
  readonly allowedTools?: readonly string[];
  /** Deny-list of tool names. Applied after {@link allowedTools}. */
  readonly disallowedTools?: readonly string[];
  /** Extra directories the agent may read/write beyond {@link cwd}. */
  readonly additionalDirectories?: readonly string[];

  /** Stop after this many assistant turns. */
  readonly maxTurns?: number;
  /** Stop once the run has cost this much, in US dollars. */
  readonly maxBudgetUsd?: number;

  readonly systemPrompt?: SystemPromptSpec;

  /** Human-readable title for the session, shown in the history pane. */
  readonly title?: string;

  /**
   * Request token-level streaming. Only meaningful when the provider advertises
   * {@link Capabilities.partialMessages}; ignored otherwise. Defaults to on.
   */
  readonly includePartialMessages?: boolean;

  /**
   * Opaque data echoed back on {@link RunHandle}. For correlating a run with
   * renderer-side state. Must not contain secrets — it crosses back into the
   * renderer.
   */
  readonly metadata?: JsonObject;
}

/**
 * Lifecycle state of a run, as far as the renderer is concerned.
 *
 * - `starting`            — accepted, no `session.started` yet.
 * - `running`             — producing events.
 * - `awaiting_permission` — parked on at least one open permission request.
 * - `ended`               — `run.end` has been emitted; the id is retired.
 */
export type RunStatus = 'starting' | 'running' | 'awaiting_permission' | 'ended';

/**
 * Renderer-safe description of a live run.
 *
 * Returned when a run starts and whenever the renderer needs to re-sync (a
 * window reload should not orphan a running agent). Contains no credentials.
 */
export interface RunHandle {
  readonly runId: RunId;
  readonly providerId: ProviderId;
  readonly profileId: ProfileId;
  readonly cwd: string;
  readonly status: RunStatus;
  /**
   * Capabilities of the adapter driving this run. Copied onto the handle so the
   * UI can degrade without a second lookup, and so a run started under one
   * provider keeps its capability set even if the user switches providers.
   */
  readonly capabilities: Capabilities;
  /** Assigned once `session.started` arrives. */
  readonly sessionId?: SessionId;
  /** Start time, ms since epoch. */
  readonly startedAt: number;
  /** Echoed from {@link RunInput.metadata}. */
  readonly metadata?: JsonObject;
}
