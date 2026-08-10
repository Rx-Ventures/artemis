/**
 * Tool-permission prompting.
 *
 * When a provider wants to run a tool it is not already allowed to run, the
 * adapter emits a `permission.request` event carrying a
 * {@link PermissionRequest} and blocks. The renderer eventually calls
 * `respondToPermission(id, decision)` with a {@link PermissionDecision}, and
 * the adapter unblocks the provider.
 *
 * Providers that answer `interactivePermissions: false` never take this path.
 */

import type { AgentId, PermissionRequestId, RunId, ToolCallId } from './ids.js';
import type { JsonObject } from './json.js';

/**
 * How aggressively the agent should ask before acting.
 *
 * These names come from the Claude Agent SDK's `PermissionMode`, which is the
 * only implemented provider today. Other providers map onto the subset they
 * support and advertise it via {@link import('./provider.js').Capabilities.permissionModes};
 * the UI must build its picker from that list rather than from this union.
 *
 * - `default`           — prompt for anything not already allowed.
 * - `acceptEdits`       — auto-approve file edits, prompt for everything else.
 * - `plan`              — research and propose only; no mutations.
 * - `auto`              — provider-side classifier decides; prompts on risk.
 * - `dontAsk`           — never prompt; denies instead of asking.
 * - `bypassPermissions` — approve everything. Dangerous; the UI must make the
 *                         danger obvious and must never make it the default.
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

/** Every {@link PermissionMode}, in increasing order of autonomy. */
export const PERMISSION_MODES = [
  'plan',
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const satisfies readonly PermissionMode[];

/** Runtime type guard for {@link PermissionMode}. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * A single permission rule: a tool, optionally narrowed to a pattern.
 *
 * `ruleContent` is provider-defined — for Claude it is the argument matcher in
 * `Bash(git commit:*)` — so it is an opaque string here.
 */
export interface PermissionRule {
  readonly toolName: string;
  readonly ruleContent?: string;
}

/** Whether a rule allows, denies, or forces a prompt. */
export type PermissionRuleBehavior = 'allow' | 'deny' | 'ask';

/**
 * Where a permission change is remembered.
 *
 * - `once`    — do not remember it at all; applies to this call only.
 * - `session` — for the rest of this run, in memory.
 * - `local`   — this machine + this project, not shared with the team.
 * - `project` — this project, intended to be committed and shared.
 * - `user`    — everywhere, for this user.
 *
 * Claude adapter mapping to the SDK's `PermissionUpdateDestination`:
 * `session` → `'session'`, `local` → `'localSettings'`,
 * `project` → `'projectSettings'`, `user` → `'userSettings'`.
 * `once` has no destination — it produces no `PermissionUpdate` at all.
 */
export type PermissionScope = 'once' | 'session' | 'local' | 'project' | 'user';

/**
 * A durable change to the permission configuration, offered alongside a
 * request ("Allow always") or sent back with a decision.
 *
 * Mirrors the Claude SDK's `PermissionUpdate` union but is provider-neutral:
 * `destination` is replaced by {@link PermissionScope}.
 */
export type PermissionRuleUpdate =
  | {
      readonly type: 'addRules';
      readonly behavior: PermissionRuleBehavior;
      readonly rules: readonly PermissionRule[];
      readonly scope: PermissionScope;
    }
  | {
      readonly type: 'replaceRules';
      readonly behavior: PermissionRuleBehavior;
      readonly rules: readonly PermissionRule[];
      readonly scope: PermissionScope;
    }
  | {
      readonly type: 'removeRules';
      readonly behavior: PermissionRuleBehavior;
      readonly rules: readonly PermissionRule[];
      readonly scope: PermissionScope;
    }
  | {
      readonly type: 'setMode';
      readonly mode: PermissionMode;
      readonly scope: PermissionScope;
    }
  | {
      readonly type: 'addDirectories';
      readonly directories: readonly string[];
      readonly scope: PermissionScope;
    }
  | {
      readonly type: 'removeDirectories';
      readonly directories: readonly string[];
      readonly scope: PermissionScope;
    };

/**
 * An outstanding request for the user to approve a tool call.
 *
 * The adapter is blocked while this is pending. There is no deadline: if the
 * renderer never answers, the run stays parked until it is interrupted or
 * disposed. Treat every open request as something the UI owes the user.
 */
export interface PermissionRequest {
  /** Answer with this id. Unique within the run. */
  readonly id: PermissionRequestId;
  readonly runId: RunId;
  /** The tool the provider wants to run, e.g. `"Bash"`. */
  readonly toolName: string;
  /** The arguments it wants to run it with. Render these; they are the ask. */
  readonly input: JsonObject;
  /** The tool call this gates, when the provider exposes one. */
  readonly toolCallId?: ToolCallId;
  /** Set when the request came from inside a subagent. */
  readonly agentId?: AgentId;

  /**
   * Full prompt sentence rendered by the provider, e.g. "Claude wants to read
   * foo.txt". Prefer this over reconstructing text from `toolName` + `input`.
   */
  readonly title?: string;
  /** Short noun phrase for compact UI and button labels, e.g. "Read file". */
  readonly displayName?: string;
  /** Human-readable subtitle expanding on the consequences. */
  readonly description?: string;
  /** Why this prompt fired at all — a rule, a sandbox escape, a risk check. */
  readonly reason?: string;
  /** The path that triggered the prompt, when the tool touches the filesystem. */
  readonly blockedPath?: string;

  /**
   * Rule changes the provider suggests, for rendering an "always allow"
   * affordance. When the user picks that affordance, echo this whole array
   * back as {@link AllowPermissionDecision.updatedPermissions}.
   */
  readonly suggestions?: readonly PermissionRuleUpdate[];

  /** When the request was raised, ms since epoch. */
  readonly requestedAt: number;
}

/** Approve the tool call. */
export interface AllowPermissionDecision {
  readonly behavior: 'allow';
  /**
   * Replacement arguments. Present only when the user edited them — omit to
   * run the tool exactly as requested.
   */
  readonly updatedInput?: JsonObject;
  /**
   * Rule changes to persist, so this prompt does not reappear. Usually the
   * verbatim {@link PermissionRequest.suggestions} array.
   */
  readonly updatedPermissions?: readonly PermissionRuleUpdate[];
  /** How long the approval should stick. Defaults to `'once'`. */
  readonly scope?: PermissionScope;
}

/** Refuse the tool call. */
export interface DenyPermissionDecision {
  readonly behavior: 'deny';
  /**
   * Explanation handed back to the model so it can adapt. Adapters substitute
   * a neutral default when this is omitted — the Claude SDK requires a string
   * here, so something is always sent.
   */
  readonly message?: string;
  /**
   * Stop the whole run rather than letting the model try something else.
   * Providers without a mid-run interrupt ignore this.
   */
  readonly interrupt?: boolean;
  /** Rule changes to persist, e.g. "never allow this". */
  readonly updatedPermissions?: readonly PermissionRuleUpdate[];
}

/**
 * The user's answer to a {@link PermissionRequest}. Discriminated on
 * `behavior`.
 */
export type PermissionDecision = AllowPermissionDecision | DenyPermissionDecision;
