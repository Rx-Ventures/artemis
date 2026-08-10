/**
 * Providers and their capability descriptors.
 *
 * The whole point of this file is that Libra's UI must never assume every
 * provider can do everything. Three planned providers have three completely
 * different transports:
 *
 *  - `claude`   — in-process Node library (`@anthropic-ai/claude-agent-sdk`)
 *  - `codex`    — subprocess speaking JSONL over stdio
 *  - `opencode` — a local HTTP server
 *
 * so the seam cannot be Claude-shaped. Every adapter publishes a
 * {@link Capabilities} descriptor up front, and the UI *degrades* against it:
 * hide the fork button when `forkSession` is false, fall back to
 * whole-message rendering when `partialMessages` is false, and so on.
 */

import type { PermissionMode } from './permissions.js';

/**
 * The set of agent backends Libra can drive.
 *
 * Only `claude` is implemented today; the other two are declared here so the
 * seam is designed against three transports rather than retrofitted to them.
 */
export type ProviderId = 'claude' | 'codex' | 'opencode';

/** Every {@link ProviderId}, in display order. */
export const PROVIDER_IDS = ['claude', 'codex', 'opencode'] as const satisfies readonly ProviderId[];

/** Runtime type guard for {@link ProviderId}. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * What a provider can actually do.
 *
 * Adapters return this from `ProviderAdapter.capabilities`. It is a *static*
 * descriptor: it must not change over the lifetime of an adapter instance, so
 * the renderer can cache it and render a stable UI.
 *
 * The first six fields are the contract every provider must answer. The
 * remaining fields are additive and exist because the UI provably needs them
 * to degrade correctly; adapters must still fill them in explicitly.
 */
export interface Capabilities {
  /**
   * The provider can pause mid-run and ask the user to approve a tool call,
   * emitting `permission.request` and waiting for `respondToPermission()`.
   *
   * When false the UI must not render an approval surface at all — the
   * provider decides on its own and the run never blocks.
   */
  readonly interactivePermissions: boolean;

  /**
   * The provider streams token-level deltas (`text.delta` / `thinking.delta`)
   * as the model produces them.
   *
   * When false the adapter emits only `text.complete`, and the UI should show
   * a working indicator instead of a typewriter.
   */
  readonly partialMessages: boolean;

  /**
   * `Run.send()` may be called while the run is still working, queueing the
   * text into the in-flight turn.
   *
   * When false the composer must be disabled until `run.end` arrives.
   */
  readonly midRunSteering: boolean;

  /**
   * A past session can be branched into a new one, leaving the original
   * transcript intact.
   */
  readonly forkSession: boolean;

  /**
   * `ProviderAdapter.listSessions()` is implemented. When false the adapter's
   * `listSessions` property is absent and the history pane is hidden for this
   * provider.
   */
  readonly listSessions: boolean;

  /**
   * The provider can delegate to nested subagents, so tool events may carry
   * `agentId` / `parentToolCallId` and the UI should render nesting.
   */
  readonly subagents: boolean;

  /**
   * Permission modes this provider accepts in {@link RunInput.permissionMode}
   * and (if `midRunSteering`) mid-run. Empty means the concept does not apply.
   *
   * The mode picker must be built from this list, never from the full
   * {@link PermissionMode} union — providers support different subsets.
   */
  readonly permissionModes: readonly PermissionMode[];

  /**
   * A previous session can be continued in place (as opposed to forked).
   * Distinct from {@link forkSession}: a provider may support one, both or
   * neither.
   */
  readonly resumeSession: boolean;

  /**
   * The provider reports token usage, so `usage` events carry meaningful
   * numbers and the UI can show a usage readout.
   */
  readonly usageReporting: boolean;

  /**
   * The provider reports monetary cost. Implies {@link usageReporting} in
   * practice, but is separate because API-key billing and gateway billing
   * differ in whether a price is knowable client-side.
   */
  readonly costReporting: boolean;

  /**
   * The provider can report consumption against a *plan's* limits, as opposed
   * to the per-run counts {@link usageReporting} covers.
   *
   * This says the provider has the capability at all. Whether a given profile
   * actually has plan limits is a separate, runtime question — API-key,
   * Bedrock and Vertex billing is metered rather than capped, so the same
   * adapter answers differently per profile. That answer arrives as
   * `PlanUsage.available`, and the UI needs both: this flag decides whether to
   * offer the control, `available` decides what the control says.
   */
  readonly planUsageReporting: boolean;
}

/**
 * A capability descriptor with everything switched off.
 *
 * Adapters should spread this and then turn on what they support, so that a
 * capability added to {@link Capabilities} later defaults to "unsupported"
 * rather than breaking every adapter's build.
 */
export const NO_CAPABILITIES: Capabilities = {
  interactivePermissions: false,
  partialMessages: false,
  midRunSteering: false,
  forkSession: false,
  listSessions: false,
  subagents: false,
  permissionModes: [],
  resumeSession: false,
  usageReporting: false,
  costReporting: false,
  planUsageReporting: false,
};

/**
 * One hosting backend a provider can authenticate against.
 *
 * Backends are **provider-scoped**. Claude offers the first-party Anthropic API
 * plus Bedrock, Vertex and Foundry; another provider will offer a different set
 * or none at all. Publishing them here is what lets the profile editor build
 * its backend picker from the selected provider instead of from a hard-coded
 * list — the same pattern as {@link Capabilities.permissionModes}.
 */
export interface ProviderBackendOption {
  /** Stored in `Profile.backend`. See `ProviderBackend`. */
  readonly id: string;
  /** Human-readable name for the picker, e.g. "AWS Bedrock". */
  readonly label: string;
  /** One sentence on how this backend authenticates, shown under the picker. */
  readonly note: string;
  /**
   * Whether a profile on this backend must carry an API key. False for
   * backends that authenticate from an ambient credential chain, which is what
   * lets the editor stop demanding a key it will never use.
   */
  readonly requiresApiKey: boolean;
}

/**
 * One way of authenticating with a provider, as the renderer sees it.
 *
 * Distinct from {@link ProviderBackendOption}: a backend says *where the models
 * are hosted*, an auth mode says *what the credential is and how the work is
 * billed*. Claude has both axes — the first-party API can be paid for with a
 * metered API key or against a subscription plan — and they are independent
 * enough that collapsing them into one picker would produce a list of
 * combinations rather than a list of choices.
 *
 * Like backends, auth modes are **provider-scoped**. Nothing in this package
 * names a mode: the adapter declares its own list, publishes it on
 * {@link ProviderDescriptor.authModes}, and the profile editor builds its
 * picker from that, the same way it builds the backend picker.
 */
export interface ProviderAuthModeOption {
  /** Stored in `Profile.authMode`. See `ProviderAuthMode`. */
  readonly id: string;
  /** Human-readable name for the picker, e.g. "API key". */
  readonly label: string;
  /** One sentence on what this mode authenticates as and how it bills. */
  readonly note: string;
  /**
   * Whether a profile in this mode must carry a stored credential. A mode that
   * authenticates from an ambient credential chain sets this false, which is
   * what lets the editor stop demanding a secret it will never use.
   */
  readonly requiresSecret: boolean;
  /**
   * Backend ids this mode is valid on. Omit for "every backend this provider
   * offers".
   *
   * Real constraint, not decoration: Claude's subscription billing exists only
   * on the first-party Anthropic API, so a subscription profile pointed at
   * Bedrock is a contradiction the editor should not let a user express and the
   * credential resolver refuses outright.
   */
  readonly backends?: readonly string[];
  /**
   * How the user obtains the credential for this mode, in one or two sentences.
   * Shown next to the secret field. Absent when the mode needs no secret.
   *
   * Libra never runs an interactive login of its own, so for anything other
   * than a pasted API key this is the *only* instruction the user gets.
   */
  readonly secretHowTo?: string;
}

/**
 * One model a provider can be pointed at, as the renderer sees it.
 *
 * The third list on this descriptor built to the same rule as
 * {@link ProviderBackendOption} and {@link ProviderAuthModeOption}, and for the
 * same reason: model identifiers are a provider's vocabulary, not a universal
 * one. `claude-sonnet-5` means nothing to Codex. Nothing in this package names
 * a model; the adapter declares its own list and the model picker is built from
 * {@link ProviderDescriptor.models}.
 *
 * An empty or absent list means "this provider does not offer a model choice",
 * and the picker renders disabled with that as its reason rather than
 * disappearing.
 */
export interface ProviderModelOption {
  /** Sent as `RunInput.model`. Opaque to everything above the adapter. */
  readonly id: string;
  /** Human-readable name for the picker, e.g. "Sonnet". */
  readonly label: string;
  /** One line on what this model is for, shown under the picker. */
  readonly note: string;
  /**
   * Effort levels valid on *this* model, as ids from
   * {@link ProviderDescriptor.effortLevels}. Omit for "every level the provider
   * offers"; an empty array means this model takes no effort setting at all.
   *
   * A real constraint rather than decoration: providers ship models that do not
   * accept a reasoning-effort parameter, and offering one for them would send a
   * setting the run silently ignores.
   */
  readonly effortLevels?: readonly string[];
}

/**
 * One reasoning-effort level, as the renderer sees it.
 *
 * "How hard should the model think before answering" is a knob several
 * providers expose under different names and with different scales, so the
 * levels are declared by the adapter rather than enumerated here. Ordered
 * least-to-most effort by the adapter, so the picker can render them as a
 * scale.
 */
export interface ProviderEffortOption {
  /** Sent as `RunInput.effort`. See `ProviderEffort`. */
  readonly id: string;
  /** Human-readable name for the picker, e.g. "High". */
  readonly label: string;
  /** One line on what this level trades away, shown next to it. */
  readonly note: string;
}

/**
 * A provider as the renderer sees it: identity, capabilities, and whether it
 * can actually be used right now.
 *
 * Returned by the `providers:list` IPC call. Carries no secrets and no paths.
 */
export interface ProviderDescriptor {
  readonly id: ProviderId;
  /** Human-readable name for menus, e.g. "Claude". */
  readonly label: string;
  readonly capabilities: Capabilities;
  /**
   * Hosting backends this provider offers, in display order. The first entry is
   * the default. Empty for a provider with no backend concept — and for one
   * that is not registered in this build.
   */
  readonly backends: readonly ProviderBackendOption[];
  /**
   * Authentication modes this provider offers, in display order. The first
   * entry is the default.
   *
   * Optional so that a descriptor assembled before this axis existed still
   * satisfies the contract; the registry populates it for every registered
   * provider. Absent or empty both mean "this provider has one implicit way of
   * authenticating", and the editor renders no picker.
   */
  readonly authModes?: readonly ProviderAuthModeOption[];
  /**
   * Models this provider offers, in display order. The first entry is the
   * default — what a run gets when {@link RunInput.model} is omitted.
   *
   * Optional for the same reason {@link authModes} is: a descriptor assembled
   * before this axis existed still satisfies the contract. Absent or empty both
   * mean "no model choice", and the picker says so rather than vanishing.
   */
  readonly models?: readonly ProviderModelOption[];
  /**
   * Reasoning-effort levels this provider offers, least to most. Absent or
   * empty mean the concept does not apply and the picker renders disabled with
   * that as its reason — the same treatment
   * {@link Capabilities.permissionModes} gets when it is empty.
   */
  readonly effortLevels?: readonly ProviderEffortOption[];
  /**
   * False when the provider is registered but unusable — no binary on PATH, no
   * profile configured, unsupported platform. The UI should show it greyed out
   * with {@link unavailableReason} rather than hiding it, so the user learns
   * what to fix.
   */
  readonly available: boolean;
  /** Short user-facing explanation, present only when `available` is false. */
  readonly unavailableReason?: string;
}
