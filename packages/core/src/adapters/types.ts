/**
 * The provider-adapter seam.
 *
 * This is the single most important design element in `@rx-artemis/core`. Artemis
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
 *     {@link import('@rx-artemis/protocol').AgentEvent} union. Nothing
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
 * exactly why they live in core rather than in `@rx-artemis/protocol`: they never
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
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderId,
  ProviderModelOption,
  RunId,
  RunInput,
  RunStatus,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';

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
 * **The default is the empty list.** Artemis ships as a third-party app; running
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

/* -------------------------------------------------------------------------- */
/* Session titles                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What naming a session from its opening message needs.
 *
 * The {@link model} is chosen by the caller rather than left to the provider's
 * default, and that is the whole point of the feature: this is a throwaway
 * sentence, so it runs on the smallest model the account has
 * (`lowestTierModel`) instead of the one the user picked for real work.
 */
export interface SessionTitleQuery {
  /** The user's opening message. Adapters may truncate it before sending. */
  readonly prompt: string;
  /** Model id to name with, as the provider spells it. Never omitted. */
  readonly model: string;
  /**
   * The profile's resolved environment. Credential-bearing, unlike the read
   * paths above: this one contacts the model.
   */
  readonly env: EnvBundle;
  /** Somewhere real to run. See {@link ModelListQuery.cwd}. */
  readonly cwd: string;
  /** See {@link ResolvedRunInput.inheritHostEnv}. */
  readonly inheritHostEnv?: boolean;
  /** Abandon the naming call — app shutdown, or the run it belongs to ending. */
  readonly abortSignal?: AbortSignal;
}

/**
 * What writing a title onto a stored session needs.
 *
 * Separate from {@link SessionTitleQuery} because the two halves are separate
 * capabilities: a provider may be able to run a cheap completion and have
 * nowhere to put the answer, or the reverse. The environment here is the
 * *store* environment — writing a title touches the session file and nothing
 * that needs a credential.
 */
export interface SessionTitleUpdate {
  readonly sessionId: SessionId;
  /** Already cleaned and length-capped by the caller. */
  readonly title: string;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
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
 * How the user signs a profile in, in the provider's own vocabulary.
 *
 * Artemis does not perform the login. It composes a command, shows it to the
 * user, and polls the status probe until the answer changes — so every string
 * here ends up either in a terminal the user pastes into or in a subprocess
 * Artemis spawns to read a boolean back.
 *
 * Naming the argv here rather than in the sign-in module is the same seam
 * {@link Capabilities} draws: `['auth', 'login']` is Claude's spelling, and a
 * second provider will spell it differently or not have one at all.
 */
export interface ProviderSignInSpec {
  /**
   * The executable, resolved on `PATH`. Also what the generated command names,
   * so it has to be the thing a user can actually type.
   */
  readonly executable: string;
  /** Arguments for the interactive login **the user runs themselves**. */
  readonly loginArgs: readonly string[];
  /**
   * Arguments for a status probe. Must be cheap and free of side effects: this
   * is polled while the user is signing in, and called again whenever the UI
   * needs to know.
   */
  readonly statusArgs: readonly string[];
  /** Arguments that clear the credential from a config directory. */
  readonly logoutArgs: readonly string[];
  /**
   * One or two sentences telling the user what the command will do. Published
   * to the renderer as `ProviderDescriptor.signInHowTo` and shown next to it.
   */
  readonly howTo: string;

  /**
   * Read {@link statusArgs}' output into an {@link AuthStatus}.
   *
   * Omit for a CLI that prints the JSON object `parseAuthStatus` expects —
   * `loggedIn`, `authMethod`, `email`, `orgName`, `subscriptionType` — which is
   * what Claude does.
   *
   * This hook exists because that turned out to be Claude's convention rather
   * than a universal one: `codex login status` prints a sentence
   * (`Logged in using ChatGPT`) and has no `--json` flag at all. Without a per-
   * provider parser the shared polling path reports a perfectly signed-in
   * profile as signed out, and the user is told to run a login they have
   * already run.
   *
   * **Must not throw**, for the same reason `checkAuthStatus` does not: every
   * caller is UI that has to render something. Report trouble as
   * `{ loggedIn: false, error }`.
   */
  readonly parseStatus?: (result: ProbeResult) => AuthStatus;
}

/** What a status probe produced. Handed to {@link ProviderSignInSpec.parseStatus}. */
export interface ProbeResult {
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the process was killed or never started. */
  readonly exitCode: number | null;
}

/**
 * What a CLI reports about a config directory's authentication.
 *
 * Lives here rather than in `signIn.ts` because it is part of the seam's
 * vocabulary: {@link ProviderSignInSpec.parseStatus} is an adapter's to
 * implement, so the type it returns has to be visible wherever a
 * {@link ProviderCredentialSpec} is written.
 */
export interface AuthStatus {
  readonly loggedIn: boolean;
  /** How the profile is authenticated, in the provider's own words. */
  readonly authMethod?: string;
  /** Present when signed in. Shown so a user can tell two accounts apart. */
  readonly email?: string;
  readonly orgName?: string;
  /** Plan tier, when the provider reports one. Absent on metered billing. */
  readonly subscriptionType?: string;
  /** Set when the status could not be read at all, rather than read as "signed out". */
  readonly error?: string;
}

/**
 * How a provider's environment is scoped to a profile.
 *
 * Once, this described how a *credential* became an environment: which variable
 * to write an API key into, which flag selected a hosting backend, which of
 * several modes was being billed. Artemis held the credential, and the spec
 * existed to get it into the right variable for the right provider.
 *
 * Artemis holds no credential now, so what is left is the one variable that
 * matters and the list of variables that must not be allowed to interfere. The
 * seam is unchanged and still load-bearing: nothing outside an adapter names
 * `CLAUDE_CONFIG_DIR`, so a second provider is still a one-line registration
 * rather than an edit to the environment resolver.
 */
export interface ProviderCredentialSpec {
  /**
   * Variable pointing the provider at this profile's config/state directory.
   * For Claude that is `CLAUDE_CONFIG_DIR`, which buys an isolated credential
   * *and* isolated session history in one move.
   */
  readonly configDirVar: string;

  /**
   * Credential variables Artemis strips from the inherited environment and
   * refuses in `publicEnv` — **and never sets**.
   *
   * Every one of these is a way to authenticate the provider without going
   * through the profile's config directory, and each of them *outranks* that
   * directory when present. An `ANTHROPIC_API_KEY` exported in the user's shell
   * beats the subscription the user just signed this profile into, and bills
   * metered usage instead. Since Artemis emits none of them, the entire list is
   * strip-only: there is no "selected" variable to spare.
   *
   * This is what makes "Artemis cannot be authenticated by accident" structural
   * rather than merely unimplemented.
   */
  readonly credentialEnvKeys: readonly string[];

  /** How the user authenticates a profile against {@link configDirVar}. */
  readonly signIn: ProviderSignInSpec;
}

/**
 * Every variable a provider's credential spec owns.
 *
 * The config-directory variable plus every credential variable. Callers use it
 * both to scrub the inherited environment and to reject `publicEnv` entries
 * that would override Artemis's own choices.
 *
 * Note that Artemis writes exactly one of these — the config directory — and
 * strips the rest unconditionally. There is no case in which a credential
 * variable is stripped and then written back.
 */
export function managedEnvKeys(spec: ProviderCredentialSpec): readonly string[] {
  return [spec.configDirVar, ...spec.credentialEnvKeys];
}

/**
 * The command a user runs to sign a profile in, as argv.
 *
 * Returned as an array rather than a string so the caller decides how to render
 * it — a shell needs quoting the user's clipboard should carry, a subprocess
 * needs none and must never be handed a quoted path.
 */
export function signInArgv(spec: ProviderCredentialSpec): readonly string[] {
  return [spec.signIn.executable, ...spec.signIn.loginArgs];
}

/**
 * A provider Artemis can drive.
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
   * built-in list, Artemis could not reach the CLI" — it has to be robust, or it
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
   * Name a session from its opening message, using the model the caller names.
   *
   * Present **iff** the provider can run a completion that is not a turn of the
   * user's conversation. Paired with {@link setSessionTitle}: naming a session
   * takes both, and `SessionNamer` skips a provider missing either.
   *
   * Deliberately not paired with a {@link Capabilities} flag, on the same
   * reasoning as {@link listModels}: a flag exists so the UI can degrade
   * *before* calling, and there is nothing here to degrade. Nothing is
   * rendered, nothing is offered, and a provider that cannot do it simply has
   * sessions named the way they were named before — by the provider's own
   * summary, or by the first prompt.
   *
   * Four obligations:
   *
   *  1. **It is not a run.** No tools, no filesystem settings, no permission
   *     prompts, and — where the provider can express it — no transcript
   *     written to the session store. A naming call that leaves a session
   *     behind would put a phantom row in the very list it exists to label.
   *  2. **Bounded.** One turn, a short output, and a timeout. This is spending
   *     the user's account on chrome; it must be small and it must end.
   *  3. **Resolve rather than reject.** No credential, no network, a model the
   *     account cannot use — all ordinary states, and none of them worth an
   *     error path in the caller. Return `null`, which reads as "no name",
   *     and the session keeps the title it would have had anyway.
   *  4. **Return a title or nothing.** Adapters clean their own output with
   *     `cleanSessionTitle`; a caller must never have to strip quotes,
   *     preambles or a stray code fence off a value from this method.
   */
  suggestSessionTitle?(query: SessionTitleQuery): Promise<string | null>;

  /**
   * Store a title against a past session, as if the user had renamed it.
   *
   * Present **iff** the provider's own session store has a title field Artemis
   * can write. That is what makes this the right place to keep a generated
   * name: it is the same field a rename writes, so the name survives, appears
   * in the provider's own tooling, and is read back by
   * {@link listSessions} without a second store to merge in.
   *
   * The consequence is deliberate and worth naming: `SessionSummary.titleIsCustom`
   * becomes true for a title Artemis generated rather than one the user typed.
   * The flag means "this session has a name of its own, not a summary the
   * provider derived", which is exactly what a generated name is — and it is
   * why naming happens **once, on a session's first turn**, where there is no
   * user-set title to overwrite.
   *
   * Unlike {@link suggestSessionTitle} this one may reject: it is a write, the
   * caller has already paid for the title, and "the store refused" is worth a
   * log line rather than silence.
   */
  setSessionTitle?(update: SessionTitleUpdate): Promise<void>;

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
 * The set of providers this Artemis build can drive. See `./registry.ts` for the
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
