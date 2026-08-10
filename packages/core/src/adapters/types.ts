/**
 * The provider-adapter seam.
 *
 * This is the single most important design element in `@apollo/core`. Apollo
 * drives *agentic coding CLIs*, and the three we plan to support have three
 * completely unrelated transports:
 *
 * | Provider   | Transport                                             |
 * | ---------- | ----------------------------------------------------- |
 * | `claude`   | in-process Node library (`@anthropic-ai/claude-agent-sdk`) |
 * | `codex`    | a subprocess speaking JSONL over stdio                |
 * | `opencode` | a local HTTP server                                   |
 *
 * So the seam must not be Claude-shaped. Two rules keep it honest:
 *
 *  1. **Everything a provider produces is normalized before it crosses the
 *     seam.** An adapter's only output is the nine-variant
 *     {@link import('@apollo/protocol').AgentEvent} union. Nothing
 *     provider-specific — no SDK message, no JSONL line, no HTTP body — is
 *     visible above this file.
 *  2. **Everything a provider *cannot* do is declared up front.** Adapters
 *     publish a static {@link Capabilities} descriptor and the UI degrades
 *     against it. Every optional method on {@link ProviderAdapter} and every
 *     conditional behaviour on {@link Run} is paired with a capability flag,
 *     and each is documented below with what an adapter that cannot support it
 *     must do instead.
 *
 * Note what is *not* here. `ProviderAdapter` and `Run` describe live objects —
 * async iterables, deferred permission prompts, disposal semantics — which is
 * exactly why they live in core rather than in `@apollo/protocol`: they never
 * cross the Electron IPC boundary. Protocol supplies every type they are built
 * from; this file assembles those into an interface an adapter implements.
 *
 * ## Secrets
 *
 * {@link ResolvedRunInput.env} is the *only* channel through which a credential
 * reaches a provider, and it is populated in the Electron main process from a
 * `Profile`. Core never reads a secret store, and an adapter must never write
 * an env value into an event, an error message or a log line. See
 * {@link scrubSecrets}.
 */

import type {
  AgentError,
  AgentErrorCode,
  AgentEvent,
  Capabilities,
  PermissionDecision,
  PermissionRequestId,
  PlanUsage,
  ProfileId,
  ProviderAuthModeOption,
  ProviderBackendOption,
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderId,
  ProviderModelOption,
  RunId,
  RunInput,
  RunStatus,
  SessionId,
  SessionSummary,
} from '@apollo/protocol';

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An environment-variable bundle.
 *
 * `undefined` values mean "explicitly unset", which matters when composing a
 * child environment on top of an inherited one — see
 * {@link import('./env.js').composeProviderEnv}.
 */
export type EnvBundle = Readonly<Record<string, string | undefined>>;

/**
 * Which on-disk configuration layers a run is allowed to inherit.
 *
 * Named after the Claude Agent SDK's `SettingSource`, but the concept is
 * general: every provider we plan to support reads *some* ambient config from
 * the user's home directory, and a distributed desktop app must not silently
 * pick it up.
 *
 * - `user`    — the user's global config (`~/.claude/settings.json`).
 * - `project` — the checked-in project config (`.claude/settings.json`). Also
 *               what enables `CLAUDE.md` loading for the Claude provider.
 * - `local`   — the machine-local project overrides (`.claude/settings.local.json`).
 *
 * **The default is the empty list.** Apollo ships as a third-party app; running
 * with the user's personal agent configuration silently merged in would make
 * behaviour unreproducible and could pull in hooks, MCP servers and permission
 * rules the user never intended to grant to *this* app. Opting in is an
 * explicit, per-run decision made above core.
 *
 * An adapter whose provider has no such concept ignores this field.
 */
export type ConfigSource = 'user' | 'project' | 'local';

/** Inherit nothing. The default value of {@link ResolvedRunInput.settingSources}. */
export const NO_CONFIG_SOURCES: readonly ConfigSource[] = [];

/* -------------------------------------------------------------------------- */
/* Run input                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A {@link RunInput} with everything the main process had to resolve on its
 * behalf already resolved.
 *
 * The renderer sends a `RunInput` carrying a {@link ProfileId}. It never sends
 * credentials, paths or environment variables — it does not have them. The main
 * process turns the profile into {@link env} and hands *this* to the adapter.
 * The extra fields are all things a renderer must not be able to choose.
 */
export interface ResolvedRunInput extends RunInput {
  /**
   * Required at the seam. Core mints the id before calling `createRun` so the
   * adapter can stamp it on every event, including events emitted before
   * `createRun` returns.
   */
  readonly runId: RunId;

  /**
   * The provider's environment, resolved from the run's profile: the API key
   * or backend flag, the isolated config directory, and the profile's
   * `publicEnv`.
   *
   * Whether this *replaces* or *extends* the host environment is decided by
   * {@link inheritHostEnv}. Adapters must treat every value here as a secret:
   * never log it, never echo it into an {@link AgentError}, never put it in an
   * event.
   */
  readonly env: EnvBundle;

  /**
   * Spread the host process environment underneath {@link env}, so the provider
   * inherits `PATH`, `HOME`, `TMPDIR` and friends. Defaults to `true`, because
   * a provider that cannot find `git` or a shell is useless.
   *
   * Inheriting the host environment does **not** mean inheriting the host's
   * credentials: adapters scrub provider-credential variables out of the
   * inherited base so a profile can never be contaminated by whatever the
   * user happens to have exported. See {@link import('./env.js').composeProviderEnv}.
   */
  readonly inheritHostEnv?: boolean;

  /**
   * On-disk configuration layers this run may inherit. **Defaults to `[]`.**
   * See {@link ConfigSource} for why.
   */
  readonly settingSources?: readonly ConfigSource[];

  /**
   * Cancels the run from the outside — app shutdown, window close, a global
   * "stop everything". Aborting is equivalent to calling {@link Run.dispose}:
   * the adapter still emits `run.end` before the stream completes.
   */
  readonly abortSignal?: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/** Result of {@link Run.send}. Mirrors protocol's `RunsSendResponse`. */
export interface SendResult {
  /**
   * True when the text was steered into the turn that is already in flight.
   * False when the provider could only queue it for a later turn — the case
   * for providers without {@link Capabilities.midRunSteering}.
   */
  readonly deliveredImmediately: boolean;
}

/** Result of {@link Run.interrupt}. Mirrors protocol's `RunsInterruptResponse`. */
export interface InterruptResult {
  /**
   * Messages the provider has accepted but not yet executed, and which will
   * still run unless separately cancelled. Empty for providers that stop
   * cleanly.
   */
  readonly stillQueued: readonly string[];
}

/**
 * One live run: a prompt, the normalized event stream it produces, and the
 * control surface available while it is alive.
 *
 * ## Lifetime
 *
 * A run is **one turn cycle**. It starts with a prompt and ends when the
 * provider finishes that cycle, or when it is interrupted, disposed or fails.
 * Exactly one `run.end` is emitted, it is always last, and the {@link RunId} is
 * retired after it: calling {@link send}, {@link interrupt} or
 * {@link respondToPermission} on an ended run is an error.
 *
 * A *conversation* is not a run. To continue one, start a new run with
 * `resumeSessionId` set to the {@link SessionId} the previous run reported. That
 * is why `run.end` carries `sessionId`.
 */
export interface Run {
  readonly runId: RunId;
  readonly providerId: ProviderId;

  /**
   * The capabilities of the adapter that created this run, copied onto the run
   * so a caller holding only a `Run` can degrade correctly, and so a run keeps
   * its capability set even if the user switches providers underneath it.
   */
  readonly capabilities: Capabilities;

  /** Live lifecycle state, for building a `RunHandle` on demand. */
  readonly status: RunStatus;

  /** The provider session this run is writing to. Set once `session.started` arrives. */
  readonly sessionId: SessionId | undefined;

  /**
   * The normalized event stream.
   *
   * Contract, in addition to the ordering rules documented on `AgentEvent`:
   *
   *  - **Consumable exactly once.** Calling `[Symbol.asyncIterator]()` a second
   *    time throws. Multiplexing to several consumers is the caller's job (the
   *    main process fans out to renderer windows); doing it here would mean
   *    guessing at buffering policy for consumers we cannot see.
   *  - **Lossless.** Events are buffered without bound. A consumer slower than
   *    the provider falls behind but never misses an event, and the provider is
   *    never blocked on the consumer.
   *  - **Terminating.** The iterable completes immediately after `run.end`, and
   *    `run.end` is emitted for *every* exit path: success, provider error,
   *    interrupt, dispose, and abort-signal cancellation. It never rejects —
   *    failures arrive as `run.end` with `reason: 'error'`, because an
   *    exception cannot be rendered in a transcript.
   *  - **Abandonable.** Breaking out of a `for await` closes the iterator and
   *    discards the buffer. It does *not* dispose the run; call {@link dispose}.
   */
  readonly events: AsyncIterable<AgentEvent>;

  /**
   * Send more text into the live run.
   *
   * With {@link Capabilities.midRunSteering}, this steers the turn already in
   * flight. Without it, an adapter has two honest options: queue the text and
   * return `deliveredImmediately: false`, or reject with an
   * `invalid_request` {@link AdapterError}. It must not silently drop the text.
   */
  send(text: string): Promise<SendResult>;

  /**
   * Ask the provider to stop what it is doing.
   *
   * The run does not end synchronously: the adapter still emits `tool.end`
   * (`status: 'cancelled'`) for every open tool call and then `run.end`
   * (`reason: 'interrupted'`). Calling this on an already-ended run resolves
   * with an empty {@link InterruptResult} rather than throwing, because
   * "stop" is idempotent by nature.
   *
   * A provider with no interrupt channel should fall back to disposing the
   * transport and report `reason: 'interrupted'` all the same.
   */
  interrupt(): Promise<InterruptResult>;

  /**
   * Answer an outstanding `permission.request`.
   *
   * Only meaningful with {@link Capabilities.interactivePermissions}. Adapters
   * that advertise `false` never emit `permission.request`, so this method is
   * unreachable for them and must reject with `invalid_request`.
   *
   * Adapters that advertise `true` are **blocked** until this is called. There
   * is no deadline and no default answer: an unanswered request parks the run
   * forever. Two obligations follow, and the Claude adapter honours both:
   *
   *  - {@link dispose} must resolve every outstanding request (as a denial) so
   *    the provider is never left waiting on a promise nobody will settle.
   *  - Answering an id that is unknown or already answered must reject with
   *    `invalid_request`, never silently succeed — a double answer usually
   *    means the UI has lost track of which prompt it is showing.
   */
  respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void>;

  /**
   * Tear the run down and release everything it holds: subprocesses, sockets,
   * file handles, the input pump, and any promise the provider is parked on.
   *
   * **Must be idempotent.** Concurrent and repeated calls share one teardown
   * and resolve together. **Must not reject** on a provider that is already
   * dead. If `run.end` has not been emitted yet, dispose emits it with
   * `reason: 'disposed'` before completing the stream.
   */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Session listing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A request for a page of historical sessions.
 *
 * Session storage is per-profile *and* per-cwd. For Claude that falls out of
 * the design for free: each profile gets its own `CLAUDE_CONFIG_DIR`, and
 * transcripts live at `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<id>.jsonl`.
 * Other providers must reproduce the same scoping, deriving it from
 * {@link env} rather than from ambient state.
 */
export interface SessionListQuery {
  /** Whose history to read. Stamped onto every returned {@link SessionSummary}. */
  readonly profileId: ProfileId;
  /** Absolute path whose sessions to list. */
  readonly cwd: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
  /** Page size. Omit for the provider's default. */
  readonly limit?: number;
  /** Page offset. Defaults to 0. */
  readonly offset?: number;
}

/**
 * What a plan-usage read needs.
 *
 * Deliberately the same shape as the session queries: a profile identity plus
 * its resolved environment. The environment is what selects the account, so a
 * plan reading is per-profile by construction rather than by convention.
 */
export interface PlanUsageQuery {
  /** Whose plan to report on. */
  readonly profileId: ProfileId;
  /** The profile's resolved environment — this is what selects the account. */
  readonly env: EnvBundle;
  /**
   * Where to run the probe. Any readable directory works; the provider may
   * refuse to start in one that does not exist, so callers should pass
   * somewhere known-good rather than the user's possibly-unset workspace.
   */
  readonly cwd: string;
}

/**
 * What a live model-catalogue read needs.
 *
 * The same shape as {@link PlanUsageQuery} minus the profile id, and for the
 * same reason it has an environment at all: the catalogue is a property of the
 * *account*, so the credential is what selects the answer. The profile id is
 * absent because nothing is stamped with it — unlike a session summary or a
 * usage reading, a model list is not attributed back to whoever asked.
 *
 * {@link inheritHostEnv} is here rather than assumed because the adapter's own
 * host-environment merge is what scrubs credential variables out of the
 * launching shell. Passing the run's setting through means the query reaches
 * the same account the next run will, instead of a differently-configured one.
 */
export interface ModelListQuery {
  /** The profile's resolved environment — this is what selects the account. */
  readonly env: EnvBundle;
  /**
   * Where to run the query. Providers resolve configuration relative to a
   * working directory, so this can change the answer; it must exist, so
   * callers pass somewhere known-good rather than an unset workspace.
   */
  readonly cwd: string;
  /** See {@link ResolvedRunInput.inheritHostEnv}. */
  readonly inheritHostEnv?: boolean;
}

/**
 * A model catalogue, plus whether the provider actually confirmed it.
 *
 * The flag is not decoration. {@link ProviderAdapter.listModels} is required to
 * resolve rather than reject, so a machine with no CLI, no credential or no
 * network produces a perfectly well-formed result that happens to be a guess.
 * Without `live`, the UI has no way to distinguish that from a lineup the
 * account really reported, and would present a hard-coded list as fact.
 */
export interface ModelCatalogue {
  /** In display order, first = default. Never empty. */
  readonly models: readonly ProviderModelOption[];
  /**
   * True only when this came back from the provider itself. False for every
   * fallback path, including ones that failed for benign reasons.
   */
  readonly live: boolean;
}

/** What reading one session's stored messages needs. */
export interface SessionMessagesQuery {
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
  /** The run id to stamp replayed events with, so they join one transcript. */
  readonly runId: RunId;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A stored session, replayed as events.
 *
 * Deliberately `AgentEvent[]` rather than a separate "historical message"
 * shape: history and live output then share one rendering path, so a replayed
 * tool call collapses and diffs exactly like a live one.
 */
export interface SessionTranscript {
  readonly events: readonly AgentEvent[];
  readonly hasMore: boolean;
}

/** One page of history. Mirrors protocol's `SessionsListResponse`. */
export interface SessionListPage {
  readonly sessions: readonly SessionSummary[];
  /** True when more results exist past `offset + sessions.length`. */
  readonly hasMore: boolean;
}

/**
 * One profile's slice of an aggregated listing: whose history, and where it is.
 *
 * The same two fields {@link SessionListQuery} carries, minus the cwd — because
 * enumerating *every* project is the point.
 */
export interface SessionListScope {
  /** Whose history to read. Stamped onto every {@link SessionSummary} it yields. */
  readonly profileId: ProfileId;
  /**
   * The profile's resolved environment — this is what locates the store.
   *
   * Populate it with `resolveStoreEnv`, not `resolveEnv`: listing is a read and
   * has no business decrypting a credential, and a profile with no key stored
   * must still show its history.
   */
  readonly env: EnvBundle;
}

/**
 * A request for every session across a set of profiles.
 *
 * Deliberately unpaginated. Sessions are partitioned by (profile × project),
 * and an ordering across the whole set only exists once every partition has
 * been read — so slicing has to happen after the merge, in the caller that owns
 * the merge. Paginating per profile here would silently drop the oldest
 * sessions of one profile in favour of the newest of another.
 */
export interface AllSessionsQuery {
  /** Every profile to walk. An empty list is legal and yields nothing. */
  readonly profiles: readonly SessionListScope[];
}

/**
 * Every session an adapter could find, newest first.
 *
 * ## Partial success is the contract
 *
 * A profile whose store is missing, unreadable or empty contributes nothing and
 * is named in {@link unreadableProfiles}; it does **not** fail the query. One
 * profile with a deleted config directory must not blank the entire history
 * sidebar, which is what a single rejected promise would do.
 */
export interface AggregatedSessionList {
  readonly sessions: readonly SessionSummary[];
  /**
   * Profiles whose store could not be read at all. Their sessions are simply
   * absent from {@link sessions}. Useful for a log line or a "1 profile's
   * history could not be read" note; never a reason to show an error page.
   */
  readonly unreadableProfiles: readonly ProfileId[];
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether a provider can actually be used on this machine right now.
 *
 * Distinct from capabilities: capabilities are static facts about a provider's
 * design, availability is a fact about this installation. A missing binary, an
 * unsupported platform and a provider that is registered but not yet
 * implemented are all availability problems.
 */
export interface AdapterAvailability {
  readonly available: boolean;
  /**
   * Short, user-facing, actionable. Required when `available` is false; the UI
   * shows the provider greyed out with this text rather than hiding it, so the
   * user learns what to fix. Must never contain a secret or a full credential
   * path.
   */
  readonly unavailableReason?: string;
}

/* -------------------------------------------------------------------------- */
/* ProviderAdapter                                                            */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One hosting backend, plus the environment flag that selects it.
 *
 * Extends the renderer-facing {@link ProviderBackendOption} with the part the
 * renderer must never see: which variable to set. `envFlag` is `null` for the
 * backend that is selected by the *absence* of the others — Claude's
 * first-party API works that way — and otherwise names a flag set to `"1"`
 * when the backend is active and omitted (never `"0"`) when it is not.
 */
export interface ProviderBackendSpec extends ProviderBackendOption {
  readonly envFlag: string | null;
}

/**
 * One authentication mode, plus the variable its secret is emitted as.
 *
 * Extends the renderer-facing {@link ProviderAuthModeOption} with the part the
 * renderer must never see: which variable carries the credential.
 *
 * The mode axis is separate from the backend axis because for Claude the two
 * are genuinely independent questions — *where the models are hosted* versus
 * *what the credential is and what it bills*. It also has a sharp edge the
 * backend axis does not: `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are
 * both credentials the CLI accepts, and when both are present the API key wins
 * and the user is billed for metered usage they did not ask for. Naming the
 * variable here is what lets `resolveEnv` emit exactly one of them and remove
 * every other mode's variable from the environment.
 */
export interface ProviderAuthModeSpec extends ProviderAuthModeOption {
  /**
   * Variable the profile's stored secret is written into when this mode is
   * selected. Every mode's variable is managed by Apollo, so a mode that is
   * *not* selected has its variable stripped rather than merely left unset.
   *
   * **Omitted for a mode that stores no secret.** Some credentials are not
   * Apollo's to hold: a provider CLI can own its own login, scoped to the
   * profile's config directory, in which case there is no value to emit and no
   * variable to emit it as. Emitting one anyway would be worse than useless —
   * an explicitly-set credential variable *overrides* whatever the config
   * directory holds, so a stale value would silently beat a good login.
   */
  readonly secretEnvVar?: string;
}

/**
 * How a provider's credential becomes an environment.
 *
 * This is the piece of the seam that used to be missing, and its absence was
 * not cosmetic: `resolveEnv` dispatched on the profile's backend and wrote
 * `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_*` and `CLAUDE_CONFIG_DIR` for *every*
 * provider, never once reading `providerId`. A Codex adapter would have been
 * handed an OpenAI key in a variable called `ANTHROPIC_API_KEY` and no
 * `OPENAI_API_KEY` at all, so "adding a provider is one line" was false for the
 * single most security-sensitive step in the system.
 *
 * Declaring it here puts the mapping next to the adapter that owns it, the way
 * `CLAUDE_ENV_SCRUB_KEYS` already lives next to the Claude adapter.
 */
export interface ProviderCredentialSpec {
  /**
   * Variable carrying the plaintext API key, set only for backends whose
   * {@link ProviderBackendSpec.requiresApiKey} is true.
   *
   * This is the *default* credential variable: it is what a provider that
   * declares no {@link authModes} writes its secret into. A provider with an
   * auth-mode axis names the variable on each mode instead, and its `api-key`
   * mode will normally repeat this value.
   */
  readonly apiKeyVar: string;

  /**
   * Variable pointing the provider at this profile's isolated config/state
   * directory. For Claude that is `CLAUDE_CONFIG_DIR`, which buys isolated
   * credentials *and* isolated session history in one move.
   */
  readonly configDirVar: string;

  /** Backends this provider offers, in display order. The first is the default. */
  readonly backends: readonly ProviderBackendSpec[];

  /**
   * Auth modes this provider offers, in display order. The first is the
   * default.
   *
   * Empty is legitimate and means "this provider has one implicit way of
   * authenticating": the secret goes into {@link apiKeyVar} and a profile that
   * names an auth mode is rejected. Required rather than optional so that
   * adding a provider is a decision about this axis rather than a silent
   * inheritance of Claude's.
   */
  readonly authModes: readonly ProviderAuthModeSpec[];

  /**
   * Extra variables Apollo owns outright for this provider, beyond
   * {@link apiKeyVar}, {@link configDirVar}, the backend flags and every auth
   * mode's {@link ProviderAuthModeSpec.secretEnvVar}.
   *
   * These are stripped from the inherited environment and rejected in
   * `publicEnv`, so a profile's credentials are decided by the profile and by
   * nothing else. Claude lists the credential variables Apollo does *not*
   * support here, which is what makes "Apollo cannot be authenticated by
   * accident" structural rather than merely unimplemented.
   */
  readonly extraManagedEnvKeys: readonly string[];
}

/**
 * Every variable a provider's credential spec owns.
 *
 * The union of the key variable, the config-directory variable, each backend
 * flag, **each auth mode's secret variable**, and anything the adapter named
 * explicitly. Callers use it both to scrub the inherited environment and to
 * reject `publicEnv` entries that would override Apollo's own choices.
 *
 * Every mode's variable is in the union, not just the selected one, and that is
 * the point: a profile in subscription mode must have `ANTHROPIC_API_KEY`
 * removed from its environment, because an inherited API key would otherwise
 * take precedence over the subscription token and bill metered usage instead.
 * The selected mode then writes exactly one of these back in — see
 * `resolveEnv`.
 */
export function managedEnvKeys(spec: ProviderCredentialSpec): readonly string[] {
  return [
    spec.apiKeyVar,
    spec.configDirVar,
    ...spec.extraManagedEnvKeys,
    // A mode that stores no secret contributes no variable — but every *other*
    // mode's variable still has to be stripped, which is what stops a stale
    // `CLAUDE_CODE_OAUTH_TOKEN` in the shell from overriding a CLI login.
    ...spec.authModes.flatMap((mode) => (mode.secretEnvVar === undefined ? [] : [mode.secretEnvVar])),
    ...spec.backends.flatMap((backend) => (backend.envFlag === null ? [] : [backend.envFlag])),
  ];
}

/** Project a credential spec down to the renderer-safe backend list. */
export function backendOptions(spec: ProviderCredentialSpec): readonly ProviderBackendOption[] {
  return spec.backends.map(({ id, label, note, requiresApiKey }) => ({
    id,
    label,
    note,
    requiresApiKey,
  }));
}

/**
 * Project a credential spec down to the renderer-safe auth-mode list.
 *
 * Drops {@link ProviderAuthModeSpec.secretEnvVar}. Not because the name of an
 * environment variable is itself sensitive, but because the renderer has no use
 * for it and every field it does not receive is one it cannot leak back.
 */
export function authModeOptions(spec: ProviderCredentialSpec): readonly ProviderAuthModeOption[] {
  return spec.authModes.map(({ id, label, note, requiresSecret, backends, secretHowTo }) => ({
    id,
    label,
    note,
    requiresSecret,
    ...(backends === undefined ? {} : { backends }),
    ...(secretHowTo === undefined ? {} : { secretHowTo }),
  }));
}

/**
 * The implicit mode used by a provider that declares no {@link
 * ProviderCredentialSpec.authModes}: one credential, in {@link
 * ProviderCredentialSpec.apiKeyVar}, valid on every backend.
 *
 * Exists so credential resolution has exactly one code path rather than a
 * "modes or no modes" branch.
 */
export function defaultAuthMode(spec: ProviderCredentialSpec): ProviderAuthModeSpec {
  return {
    id: 'api-key',
    label: 'API key',
    note: `Uses ${spec.apiKeyVar}.`,
    requiresSecret: true,
    secretEnvVar: spec.apiKeyVar,
  };
}

/**
 * A provider Apollo can drive.
 *
 * Adapters are **stateless singletons with respect to runs**: one adapter
 * instance serves every run for its provider, and all per-run state lives on
 * the {@link Run} it returns. That is what makes the registry a plain map.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;

  /** Human-readable name for menus, e.g. `"Claude"`. */
  readonly label: string;

  /**
   * How this provider's credential reaches it. **Static**, like
   * {@link capabilities}. `resolveEnv` reads this instead of hard-coding one
   * vendor's variable names, which is what keeps registering a provider a
   * one-line change.
   */
  readonly credentials: ProviderCredentialSpec;

  /**
   * What this provider can do. **Static** — it must be the same object for the
   * lifetime of the adapter, because the renderer caches it and builds a stable
   * UI from it. Build it by spreading `NO_CAPABILITIES` and switching on what
   * you support, so a capability added to the protocol later defaults to "off"
   * instead of breaking your build.
   */
  readonly capabilities: Capabilities;

  /**
   * Models this provider can be pointed at, in display order, first = default.
   * **Static**, like {@link capabilities}.
   *
   * Republished verbatim as `ProviderDescriptor.models` so the model picker is
   * built from the selected provider rather than a literal in the renderer —
   * the same rule that already governs backends, auth modes and permission
   * modes. Omit (or leave empty) for a provider with no model choice.
   */
  readonly models?: readonly ProviderModelOption[];

  /**
   * Reasoning-effort levels this provider accepts, least to most. **Static.**
   *
   * Republished as `ProviderDescriptor.effortLevels`. Omit for a provider where
   * the concept does not exist; the picker then renders disabled with that as
   * its reason rather than disappearing.
   */
  readonly effortLevels?: readonly ProviderEffortOption[];

  /**
   * Ask the installed provider what models it *actually* offers, right now.
   *
   * The live counterpart to the static {@link models} list, and the reason the
   * two are separate properties rather than one: {@link models} is a constant
   * the registry can republish in a descriptor without touching a subprocess,
   * while this contacts the provider with a real credential and can take
   * seconds. A UI that needs a list immediately reads the descriptor; a UI that
   * wants the truth calls this and swaps.
   *
   * Present **iff** the provider can enumerate its own catalogue. A provider
   * that cannot omits the property entirely — it does not implement it as a
   * stub returning {@link models}, because the caller reports *which* list the
   * user is looking at (`ProvidersModelsResponse.live`) and a stub would make
   * the built-in list claim to be confirmed by the account. With the method
   * absent, the static list stands and is labelled as such.
   *
   * Deliberately not paired with a {@link Capabilities} flag, unlike
   * {@link listSessions}. A capability flag exists so the UI can degrade
   * *before* calling — hide a history pane, disable a picker. There is nothing
   * to degrade here: the model picker renders from the descriptor either way,
   * and the only difference this makes is whether a background refresh
   * improves it. `typeof adapter.listModels === 'function'` is the whole test,
   * and it is made in exactly one place.
   *
   * Two obligations:
   *
   *  1. **Must not consume model tokens.** This runs on a boot path and may run
   *     again whenever a profile changes. Implementations use a control channel
   *     or a metadata call, never a turn.
   *  2. **Must resolve rather than reject.** No binary, no credential, no
   *     network — all of those are ordinary states of a desktop machine, and a
   *     model picker that renders empty is worse than one that renders slightly
   *     stale. Return the provider's own fallback list instead of throwing; the
   *     caller cannot tell a rejection apart from a crash and has no better
   *     list to substitute than the one you already have.
   *
   * ### Say which list you returned
   *
   * Obligation 2 has a consequence: because failure resolves, the caller cannot
   * otherwise tell a catalogue the account confirmed from one the adapter
   * guessed. So the return is a {@link ModelCatalogue} carrying an explicit
   * `live` flag rather than a bare array.
   *
   * An earlier draft signalled this with *reference identity* — fall back by
   * returning the very same array instance as {@link models}, and let the
   * caller compare. It worked, and it was one line shorter. It was also a trap:
   * `return [...FALLBACK]` is an utterly reasonable edit that would have
   * silently relabelled the built-in list as account-confirmed, with no test
   * failing and no way to notice from the UI. A flag whose correctness depends
   * on nobody ever copying an array is not a flag, it is a landmine. This is
   * the mechanism by which the settings screen tells the user "this is the
   * built-in list, Apollo could not reach the CLI" — it has to be robust, or it
   * is worse than absent.
   */
  listModels?(query: ModelListQuery): Promise<ModelCatalogue>;

  /**
   * Start a run.
   *
   * Rejects with an {@link AdapterError} for anything it cannot honour, and it
   * must be strict about this rather than degrading:
   *
   *  - a `permissionMode` outside {@link Capabilities.permissionModes} →
   *    `invalid_request`. Silently downgrading a permission mode is how you end
   *    up more permissive than the user asked for.
   *  - `resumeSessionId` without {@link Capabilities.resumeSession}, or
   *    `forkSession` without {@link Capabilities.forkSession} →
   *    `invalid_request`.
   *  - a relative `cwd` → `invalid_request`.
   *  - no provider binary / unsupported platform → `provider_not_found`.
   *
   * Resolving does **not** mean the provider has started. Events, including
   * `session.started`, may already be flowing before this promise settles —
   * subscribe to {@link Run.events} before awaiting anything else.
   */
  createRun(input: ResolvedRunInput): Promise<Run>;

  /**
   * List historical sessions.
   *
   * Present **iff** {@link Capabilities.listSessions} is true. A provider that
   * cannot enumerate history omits this property entirely rather than
   * implementing it as a stub that returns `[]` — the empty array is
   * indistinguishable from "no sessions yet", and the UI hides the history pane
   * on the capability flag, not on the result.
   */
  listSessions?(query: SessionListQuery): Promise<SessionListPage>;

  /**
   * List historical sessions across **every project**, for a set of profiles.
   *
   * Present only alongside {@link listSessions} — it answers the same question
   * without the cwd, so a provider that cannot enumerate history at all omits
   * both. Sessions are partitioned by (profile × project), and this walks the
   * whole partition space: it is what lets a sidebar show all past work grouped
   * by project and labelled by profile.
   *
   * Two obligations, both learned the hard way:
   *
   *  1. **`cwd` comes from the session data, never from the storage layout.**
   *     Claude's project directories are named by replacing every
   *     non-alphanumeric character in the path with `-`, which is lossy and
   *     ambiguous for any path containing a real hyphen. Decoding that name
   *     would confidently produce the wrong directory; the session record
   *     itself is authoritative. A session with no recoverable cwd is dropped
   *     rather than guessed at — it cannot be grouped, and it cannot be resumed
   *     into a directory nobody knows.
   *  2. **One bad profile must not fail the query.** See
   *     {@link AggregatedSessionList}.
   */
  listAllSessions?(query: AllSessionsQuery): Promise<AggregatedSessionList>;

  /**
   * Read one session's stored messages, replayed as events.
   *
   * Present alongside {@link listSessions}: a provider that can enumerate
   * history should be able to open it. Without this, selecting a session
   * resumes it against an empty transcript — the agent holds the whole
   * conversation in context while the user sees none of it.
   *
   * Returns the same {@link AgentEvent}s a live run emits, so the transcript
   * needs no second code path. Events are stamped with `query.runId` so
   * replayed history and anything sent next land in one continuous view.
   */
  getSessionMessages?(query: SessionMessagesQuery): Promise<SessionTranscript>;

  /**
   * Probe whether this provider is usable on this machine.
   *
   * Must be cheap and must not throw — report trouble as
   * `{ available: false, unavailableReason }`. Omit the method entirely if the
   * provider is always available once registered; the registry then treats it
   * as available.
   */
  checkAvailability?(): Promise<AdapterAvailability>;

  /**
   * How much of a plan's capacity this profile has consumed.
   *
   * Present **iff** {@link Capabilities.planUsageReporting} is true. Distinct
   * from the per-run counts on `usage` events: this describes the *account*.
   *
   * Three obligations:
   *
   *  1. **Must not consume model tokens.** Reading a gauge that costs money to
   *     read is a gauge nobody will open. Implementations should use a control
   *     channel, not a turn.
   *  2. **Must not throw for a profile that simply has no plan.** API-key,
   *     Bedrock and Vertex billing is metered rather than capped, so "no plan
   *     limits here" is a correct answer, not a failure: return
   *     `{ available: false, unavailableReason }`. Reserve rejection for a
   *     genuine fault, such as an unusable credential.
   *  3. **Must tolerate the provider withdrawing the underlying API.** The
   *     surface this is built on may be experimental; if it disappears, report
   *     it unavailable rather than breaking every caller.
   */
  fetchPlanUsage?(input: PlanUsageQuery): Promise<PlanUsage>;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The set of providers this Apollo build can drive. See `./registry.ts` for the
 * implementation and for the one-line registration point.
 */
export interface ProviderRegistry {
  /** Register an adapter. Throws on a duplicate id unless `replace` is set. */
  register(adapter: ProviderAdapter, options?: { readonly replace?: boolean }): void;
  /** Remove an adapter. Returns whether one was actually removed. */
  unregister(id: ProviderId): boolean;
  has(id: ProviderId): boolean;
  get(id: ProviderId): ProviderAdapter | undefined;
  /** Like {@link get}, but throws a `provider_not_found` {@link AdapterError}. */
  require(id: ProviderId): ProviderAdapter;
  /** Registered adapters, in `PROVIDER_IDS` display order. */
  list(): readonly ProviderAdapter[];
  /**
   * Renderer-safe descriptors for the `providers:list` IPC call.
   *
   * By default this includes providers that are *not* registered, marked
   * unavailable with a reason, so the UI can show "Codex — not yet supported"
   * instead of pretending the concept does not exist.
   */
  describe(options?: {
    /** Re-probe availability instead of returning the cached answer. */
    readonly refresh?: boolean;
    /** Include known-but-unregistered providers. Defaults to true. */
    readonly includeUnregistered?: boolean;
  }): Promise<readonly ProviderDescriptor[]>;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The error type the seam throws.
 *
 * A JavaScript `Error` does not survive structured clone with its type intact,
 * so everything that leaves the main process is reported as protocol's
 * {@link AgentError}. `AdapterError` is the throwable carrier for one: the IPC
 * layer catches it and puts {@link AdapterError.agentError} straight into an
 * `IpcFail`.
 */
export class AdapterError extends Error {
  /** The normalized, already-scrubbed error to report. */
  readonly agentError: AgentError;

  constructor(agentError: AgentError, options?: { cause?: unknown }) {
    super(agentError.message, options);
    this.name = 'AdapterError';
    this.agentError = agentError;
  }
}

/** True for an {@link AdapterError}, including across module realms. */
export function isAdapterError(value: unknown): value is AdapterError {
  return (
    value instanceof AdapterError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'AdapterError' &&
      typeof (value as { agentError?: unknown }).agentError === 'object')
  );
}

/** Convenience constructor for {@link AdapterError}. */
export function adapterError(
  code: AgentErrorCode,
  message: string,
  extra?: Omit<AgentError, 'code' | 'message'> & { readonly cause?: unknown },
): AdapterError {
  const { cause, ...rest } = extra ?? {};
  return new AdapterError(
    { code, message: scrubSecrets(message), ...rest },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Patterns that look like a credential in free text.
 *
 * A heuristic, not a proof. Adapters are supposed to keep secrets out of error
 * messages in the first place; this is the backstop for the case where a
 * provider echoes its own configuration into a failure string.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret)["'\s]*[:=]["'\s]*[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Redact anything credential-shaped from text that is about to be shown or logged. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const head = match.slice(0, Math.min(6, match.length));
      return `${head}…[redacted]`;
    });
  }
  return out;
}

/**
 * Normalize anything thrown into an {@link AgentError}.
 *
 * Used on every path where a provider's failure has to become something the UI
 * can render: adapter internals, the IPC dispatcher, and the run pump's
 * `catch`. Classification is best-effort — the taxonomy is deliberately small,
 * and detail belongs in `message`, not in a new code.
 */
export function toAgentError(error: unknown, fallbackCode: AgentErrorCode = 'unknown'): AgentError {
  if (isAdapterError(error)) return error.agentError;

  if (error instanceof Error) {
    const name = error.name;
    const message = scrubSecrets(error.message || name || 'Unknown error');

    if (name === 'AbortError' || /\baborted\b/i.test(message)) {
      return { code: 'cancelled', message, retryable: false };
    }

    const status = readHttpStatus(error);
    const code = classify(message, status) ?? fallbackCode;
    return {
      code,
      message,
      httpStatus: status,
      retryable: code === 'rate_limit' || code === 'network' || code === 'provider_unavailable',
    };
  }

  if (typeof error === 'string') {
    const message = scrubSecrets(error);
    return { code: classify(message, undefined) ?? fallbackCode, message };
  }

  return { code: fallbackCode, message: 'Unknown error' };
}

function readHttpStatus(error: Error): number | undefined {
  const candidate =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' ? candidate : undefined;
}

function classify(message: string, status: number | undefined): AgentErrorCode | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'billing';
  if (status !== undefined && status >= 500) return 'provider_unavailable';
  if (status === 400 || status === 422) return 'invalid_request';

  if (/\b(ENOENT|command not found|is not recognized)\b/i.test(message)) return 'provider_not_found';
  if (/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network)\b/i.test(message)) {
    return 'network';
  }
  if (/\b(EPIPE|closed unexpectedly|exited with code|stdio)\b/i.test(message)) return 'transport';
  if (/\brate limit|too many requests\b/i.test(message)) return 'rate_limit';
  if (/\b(unauthorized|invalid api key|authentication)\b/i.test(message)) return 'auth';
  if (/\b(credit balance|billing|payment)\b/i.test(message)) return 'billing';
  if (/\bmodel .*(not found|unavailable)|unknown model\b/i.test(message)) return 'model_unavailable';
  return undefined;
}
