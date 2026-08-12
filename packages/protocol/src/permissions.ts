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

/* -------------------------------------------------------------------------- */
/* Questions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Asking the user something is not asking the user for permission.
 * ============================================================================
 *
 * Some provider tools exist only to put a question in front of a person —
 * Claude's `AskUserQuestion` is the one implemented today. They park the run
 * exactly the way a permission prompt does, over the same callback, because
 * that callback is the only place a provider can hand control back mid-turn.
 * So a question arrives on {@link PermissionRequest} and is answered with a
 * {@link PermissionDecision}: same wire, same queue, same "the run is stopped
 * until you deal with this" lifetime.
 *
 * What is *not* the same is what the user is being asked. Approving a tool call
 * is a judgement about risk, and the honest rendering of it is the verbatim
 * arguments plus Approve/Deny. A question is a choice between options the model
 * wrote down, and rendering it as an approval asks the wrong thing twice over:
 * it invites the user to "Approve" a JSON blob instead of picking an answer,
 * and the model gets back a permission verdict where it expected a decision.
 *
 * So {@link PermissionRequest.question} carries the decoded question, and the
 * UI branches on it. Adapters decode it; nothing downstream re-parses provider
 * input.
 */
export interface QuestionOption {
  /** The choice itself, a few words long. What the user picks. */
  readonly label: string;
  /** What choosing it means — trade-offs, consequences. */
  readonly description: string;
  /**
   * Longer sample content for this option: a mock-up, a snippet, a diff.
   *
   * **Model-authored text with no trust attached.** Providers may describe it
   * as markdown or as an HTML fragment; render it as neither. It is shown as
   * plain text, because the alternative is letting a tool argument inject
   * markup into the app's own chrome.
   */
  readonly preview?: string;
}

/** One question, with the choices the model is willing to accept. */
export interface Question {
  /**
   * The question as asked. Also its identity: answers are keyed by this string,
   * which is why providers require the texts in a prompt to be distinct.
   */
  readonly question: string;
  /** Two or three words naming the topic, for a chip or a column header. */
  readonly header: string;
  /** The offered choices. At least two, or there is no decision to make. */
  readonly options: readonly QuestionOption[];
  /** Whether more than one option may be chosen. */
  readonly multiSelect: boolean;
}

/**
 * A decoded interview: everything the provider wants answered in one park.
 *
 * Answered as a unit. A prompt with three questions resolves once, with all
 * three answers, because the provider is blocked on the single tool call that
 * carried them.
 */
export interface QuestionPrompt {
  readonly questions: readonly Question[];
}

/**
 * What the user said about one question.
 *
 * Every field is optional-in-effect: an answer with no chosen options and no
 * note means the user skipped this question, and the provider is told so rather
 * than being left to infer it from a gap.
 */
export interface QuestionAnswer {
  /** The {@link Question.question} being answered, verbatim. */
  readonly question: string;
  /**
   * Chosen {@link QuestionOption.label}s. At most one unless the question is
   * `multiSelect`; empty when the user answered only in prose.
   */
  readonly options: readonly string[];
  /**
   * Free text the user added — a caveat on the option they picked, or a whole
   * answer the options did not offer.
   */
  readonly notes?: string;
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A plan the agent wants signed off before it starts work.
 *
 * The third thing that rides the permission wire, for the same reason the
 * second one does (see {@link QuestionOption}): parking is the only way a
 * provider hands control back mid-turn. Claude's `ExitPlanMode` is the one
 * implemented today — a tool whose entire body of work is already finished by
 * the time it is called, and whose "arguments" are a document.
 *
 * Rendering that as an approval gets everything wrong at once. The plan is
 * markdown — headings, tables, code — and the verbatim-arguments card shows it
 * JSON-escaped in a four-line scroller, which is unreadable exactly when
 * reading it is the entire point. The buttons are wrong too: nobody is
 * authorising a risk here, they are saying "yes, do that" or "no, think again",
 * and "allow for this session" means nothing at all about a document.
 *
 * So the plan is decoded here and the UI branches on it, the same way it
 * branches on {@link Question}. Adapters decode; nothing downstream re-parses
 * provider input.
 */
export interface PlanProposal {
  /**
   * The plan as written, in markdown.
   *
   * **Model-authored text with no trust attached**, like every other stretch of
   * agent prose. It is rendered as markdown because that is what it is and what
   * the reader needs, on the same terms as an agent's answer in the transcript:
   * markdown only, no embedded HTML.
   */
  readonly plan: string;
  /**
   * Where the provider saved it, when it says.
   *
   * Shown, not read: the file is the provider's copy, and Artemis renders the
   * plan it was handed. Its value is that the user can open the plan after the
   * run, in an editor, without going hunting.
   */
  readonly planPath?: string;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

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
   * Set when this park is an interview rather than an approval — see
   * {@link QuestionOption} for why the two share a wire.
   *
   * Present only when the adapter could decode the tool's arguments into
   * well-formed questions. A malformed `AskUserQuestion` leaves this undefined
   * on purpose: the request degrades to an ordinary approval showing the raw
   * arguments, which is ugly but answerable, rather than rendering a question
   * card built from input that did not parse.
   */
  readonly question?: QuestionPrompt;

  /**
   * Set when this park is a plan awaiting sign-off — see {@link PlanProposal}.
   *
   * Present only when the adapter could decode the tool's arguments into a
   * plan, on the same terms as {@link question}: arguments that do not parse
   * leave this undefined and the request degrades to the verbatim-arguments
   * card, which is ugly but answerable.
   *
   * Mutually exclusive with {@link question} in practice — one tool call is one
   * kind of ask — but the UI should still pick a branch rather than assume it.
   */
  readonly plan?: PlanProposal;

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
   * The user's answers, when the request carried a {@link QuestionPrompt}.
   *
   * Answering *is* allowing: the tool's whole job is to carry the answers back,
   * so there is no third verdict to invent. An allow with no answers is a skip
   * — the provider is told the questions went unanswered and continues on its
   * own judgement, which is the outcome a person who does not want to choose
   * actually wants. A denial, by contrast, hands the model a refusal.
   *
   * Encoded into the provider's own argument shape by the adapter, never by the
   * UI: the mapping (how multi-select is joined, where notes live, what an
   * unanswered question looks like) is Claude's wire format, and a renderer
   * that knew it would have to be edited for the next provider that asks
   * questions. Adapters whose requests never carry a question ignore this.
   */
  readonly answers?: readonly QuestionAnswer[];
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
