/**
 * The composition root: where Electron's resources meet `@rx-artemis/core`.
 *
 * Core is deliberately incapable of doing this itself. It must never import
 * `electron` — it has to run in a plain Node process and under vitest — so
 * everything Electron-shaped is injected: the `safeStorage`-backed credential
 * store, the `userData` directory, a logger. Core supplies the parts
 * (`ProfileStore`, `RunRegistry`, the provider registry, the Claude adapter);
 * this file wires them together and presents the result as one interface the
 * IPC layer can call.
 *
 * ### Why the imports are static
 *
 * An earlier revision resolved core's exports dynamically by name, so that a
 * broken core build would degrade instead of crashing. That traded a loud
 * compile error for a silent runtime one, and it cost us three real defects
 * that the compiler would have caught immediately: the provider registry was
 * built with no adapters registered, `RunRegistry` was constructed without its
 * two required options, and every constructor was handed an options bag that
 * did not match its signature. The seam between main and core is exactly where
 * type checking earns its keep, so it is checked.
 *
 * The "a failed engine must not stop Artemis from launching" property is
 * preserved where it actually belongs — in {@link EngineHost.start}, which
 * catches construction failures and reports them through
 * {@link EngineHost.failureMessage}.
 *
 * ### The secret boundary, restated
 *
 * `ProfileStore.create()` and `.update()` return a full `Profile` — which
 * carries `secretRef`, `configDirName` and `publicEnv`. None of that may reach
 * the renderer, so this file never returns what those methods return: it takes
 * the id and asks the store to `describe()` it, which yields `ProfileMetadata`.
 * The IPC layer's leak scanner would catch a mistake here, but the correct
 * shape is produced deliberately rather than left to the tripwire.
 *
 * Credentials reach a provider through exactly one path: {@link RunRegistry}'s
 * `resolveRun` callback below. It calls `resolveEnv` and hands the bundle
 * straight to an adapter; neither this file nor the registry retains it.
 * Session listing looks similar but is deliberately *not* on that path — it
 * uses `resolveStoreEnv`, which yields the profile's config directory and no
 * credential at all, because a read has no business decrypting a key.
 */

import type {
  AgentEvent,
  Attachment,
  PermissionDecision,
  PermissionRequestId,
  Profile,
  ProfileDraft,
  ProfileId,
  ProfileMetadata,
  ProfilePatch,
  ProviderDescriptor,
  ProviderId,
  ProviderModelOption,
  RunHandle,
  RunId,
  SessionId,
  RunInput,
  SessionSummary,
  Unsubscribe,
  PlanUsage,
  AuthStatusResponse,
} from '@rx-artemis/protocol';

import {
  attributeSession,
  checkAuthStatus,
  createDefaultProviderRegistry,
  managedEnvKeys,
  ProfileStore,
  profileConfigDir,
  resolveEnv,
  resolveStoreEnv,
  RunRegistry,
  SessionNamer,
  SessionOwners,
  signInCommand,
  signOut as cliSignOut,
  type EnvBundle,
  type ProviderCredentialSpec,
  type ProviderRegistry,
  type SessionListScope,
  type SessionNamingPlan,
} from '@rx-artemis/core';
import { lowestTierModel } from '@rx-artemis/protocol';

import { EngineUnavailableError, ValidationError } from './errors.js';
import { createLogger } from './log.js';

const log = createLogger('engine');

/**
 * Longest session title Artemis will store.
 *
 * A cap rather than a rejection: someone pasting a paragraph into the rename
 * field wants a name, and truncating gives them one, whereas an error over a
 * character count they cannot see is a puzzle. Generous enough that no title a
 * person would type reaches it, small enough that the value stays a *label* —
 * it is appended to the transcript and read back into a one-line row.
 */
const MAX_SESSION_TITLE = 200;

/* -------------------------------------------------------------------------- */
/* The interface the IPC layer calls                                          */
/* -------------------------------------------------------------------------- */

/** What Electron injects into core. */
export interface EngineOptions {
  /**
   * Electron's per-app user data directory.
   *
   * Profile records live here, and so do the config directories Artemis
   * *suggests* (`<userData>/profiles/<name>`). A profile's actual `configDir`
   * is an absolute path the user chose and need not be under this one at all —
   * pointing a profile at `~/.claude` is a supported and common thing to do.
   */
  readonly userDataDir: string;
  /** Artemis's version, for any provider that wants a user-agent string. */
  readonly appVersion: string;
  /**
   * Real-filesystem path to the Claude Agent SDK's bundled CLI binary, when
   * the host had to resolve it around a virtual filesystem.
   *
   * Packaged Electron is that host: the SDK's own sibling-package resolution
   * yields an `app.asar/...` path, and spawning through the archive file
   * fails with `ENOTDIR`. `index.ts` resolves the `app.asar.unpacked` twin
   * and passes it here; in dev it stays unset and the SDK resolves itself.
   */
  readonly sdkExecutablePath?: string;
}

/**
 * The engine as the main process uses it.
 *
 * Every method takes and returns renderer-safe protocol types, because each one
 * is a single step from an IPC response. Nothing here returns a `Profile`.
 */
export interface ArtemisEngine {
  listProviders(options: { readonly refresh?: boolean }): Promise<readonly ProviderDescriptor[]>;

  /**
   * One provider's model catalogue, read from the installed CLI where it can
   * be, from the adapter's static list where it cannot.
   *
   * Separate from {@link listProviders} because it spawns a subprocess and
   * takes a credential, exactly like {@link refreshPlanUsage} is separate from
   * {@link cachedPlanUsage}. Descriptors must stay instant; this one is allowed
   * to be slow.
   *
   * Takes both ids for the same reason {@link listSessions} does: the provider
   * decides *which* adapter answers, and the profile decides *as whom*. Never
   * throws for a provider that cannot enumerate models — that is an answer
   * (`live: false`), not a fault.
   */
  listProviderModels(options: {
    readonly providerId: ProviderId;
    readonly profileId: ProfileId;
    readonly cwd?: string;
  }): Promise<{ readonly models: readonly ProviderModelOption[]; readonly live: boolean }>;

  listProfiles(options: { readonly providerId?: ProviderId }): Promise<readonly ProfileMetadata[]>;
  createProfile(draft: ProfileDraft): Promise<ProfileMetadata>;
  updateProfile(id: ProfileId, patch: ProfilePatch): Promise<ProfileMetadata>;
  deleteProfile(
    id: ProfileId,
    options: { readonly deleteConfigDir?: boolean },
  ): Promise<{ readonly id: ProfileId; readonly configDirDeleted: boolean }>;
  /** A config-directory path to prefill the create form with. Creates nothing. */
  suggestConfigDir(label: string): Promise<string>;

  startRun(input: RunInput): Promise<RunHandle>;
  sendToRun(
    runId: RunId,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<{ readonly deliveredImmediately: boolean }>;
  interruptRun(runId: RunId): Promise<{ readonly stillQueued?: readonly string[] }>;
  /** Stop one delegated task, leaving the run and its other tasks alone. */
  stopTask(runId: RunId, taskId: string): Promise<void>;
  respondToPermission(
    runId: RunId,
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void>;
  disposeRun(runId: RunId): Promise<void>;
  listRuns(options: { readonly cwd?: string }): Promise<readonly RunHandle[]>;

  /**
   * A run's retained events, for a window that reloaded out from under it.
   *
   * Synchronous in the registry and kept synchronous here: it is a read of an
   * in-memory buffer, and the reload path calls it once per live run before the
   * first paint. `truncated` is computed rather than inferred by the caller —
   * only the registry knows whether the events it dropped were ones this caller
   * asked for.
   */
  runEvents(options: {
    readonly runId: RunId;
    readonly afterSeq?: number;
  }): { readonly events: readonly AgentEvent[]; readonly truncated: boolean };

  /**
   * Last-known plan usage, or null if never fetched. Synchronous and free.
   *
   * Paired with {@link refreshPlanUsage} so the UI can render instantly from
   * cache and swap in fresh data when it lands, instead of blocking a popover
   * on a subprocess spawn.
   */
  cachedPlanUsage(profileId: ProfileId): PlanUsage | null;

  /**
   * Fetch plan usage from the provider and cache it. Costs no model tokens.
   *
   * Takes only a profile id: a profile already names its provider, and making
   * the caller supply both invites the two disagreeing.
   */
  refreshPlanUsage(options: { readonly profileId: ProfileId }): Promise<PlanUsage>;

  /**
   * Per-profile authentication, delegated entirely to the provider's own CLI.
   *
   * This is the only way a profile is authenticated, and there is deliberately
   * no method here that accepts a key or a token — nor one that *performs* a
   * login. The user runs the provider's command themselves against the
   * profile's config directory; Artemis reads the result back. No credential is
   * ever handled by, stored by, or reachable from Artemis, and the config
   * directory *is* the account boundary, which is what makes multiple accounts
   * work.
   */
  authStatus(profileId: ProfileId): Promise<AuthStatusResponse>;
  signOut(profileId: ProfileId): Promise<AuthStatusResponse>;

  listSessions(options: {
    readonly providerId: ProviderId;
    readonly profileId: ProfileId;
    readonly cwd: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{ readonly sessions: readonly SessionSummary[]; readonly hasMore: boolean }>;

  /**
   * One session's stored messages, replayed as events.
   *
   * Returns the same `AgentEvent`s a live run emits, stamped with `runId`, so
   * the renderer feeds them through the transcript it already has rather than
   * growing a second path for history.
   */
  getSessionMessages(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly runId: RunId;
    readonly cwd?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{ readonly events: readonly AgentEvent[]; readonly hasMore: boolean }>;

  /**
   * One subagent's stored messages, replayed as events.
   *
   * The parent session names the conversation that delegated; `agentId` — which
   * is the task id — names the work. `consumed` counts stored messages rather
   * than events, so a caller following a running agent can page from where it
   * left off; see the protocol's `SessionsSubagentMessagesResponse`.
   */
  getSubagentMessages(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly agentId: string;
    readonly runId: RunId;
    readonly cwd?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly hasMore: boolean;
    readonly consumed: number;
  }>;

  /**
   * Every profile's history, across every project.
   *
   * Same read as {@link listSessions} with both of its scopes removed. Returns
   * entries carrying `cwd` and `profileId`, which is what a sidebar needs to
   * group by project and label by profile.
   */
  listAllSessions(options: {
    readonly providerId?: ProviderId;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{ readonly sessions: readonly SessionSummary[]; readonly hasMore: boolean }>;

  /**
   * Give a stored session a user-chosen title, in the provider's own store.
   *
   * Resolves to the title as written, so the caller renders what was stored
   * rather than what it hoped would be.
   */
  renameSession(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly cwd?: string;
    readonly title: string;
  }): Promise<{ readonly title: string }>;

  /**
   * Destroy a stored session's transcript. Irreversible.
   *
   * Resolves `false` when there was nothing left to delete, which is a success
   * — see the protocol's `SessionsDeleteResponse`.
   */
  deleteSession(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly cwd?: string;
  }): Promise<{ readonly deleted: boolean }>;

  /**
   * Subscribe to every run's events.
   *
   * One firehose rather than a subscription per run: the renderer multiplexes
   * on `event.runId`, and a per-run channel would mean building channel names
   * out of renderer-supplied strings in the preload — exactly the dynamic
   * channel pattern the preload is forbidden to have.
   */
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe;

  /** Tear down every live run. Called on quit. */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the engine.
 *
 * @throws {EngineUnavailableError} — but only through {@link EngineHost.start},
 *         which is the sole caller and catches everything.
 */
function createEngine(options: EngineOptions): ArtemisEngine {
  const { userDataDir } = options;

  // `createDefaultProviderRegistry` — not `createProviderRegistry` — is what
  // actually registers the Claude adapter. An empty registry typechecks
  // perfectly and then reports every provider as unavailable at runtime.
  const providers: ProviderRegistry = createDefaultProviderRegistry({
    claude: {
      ...(options.sdkExecutablePath === undefined
        ? {}
        : { sdkExecutablePath: options.sdkExecutablePath }),
      /*
       * The provider started a turn nobody asked for — register it.
       *
       * It does that when background work settles (it is told the task finished
       * and answers), and a subagent that outlived its own turn can park on a
       * permission prompt the same way. The adapter builds the run because only
       * it can; the registry is what gives that run an id, a replay buffer and
       * an audience, so this line is the whole of the connection between them.
       *
       * `runs` is declared below and captured, not called, until a process is
       * live — which is necessarily long after both exist.
       *
       * Failures are logged and swallowed. This is called from inside the
       * adapter's own event pump: throwing would take down the stream carrying
       * the very work being rescued, to complain that it could not be displayed.
       * The turn still runs and the provider still writes it to the session
       * file, so the cost of the refusal is a live transcript that catches up
       * when the conversation is reopened.
       */
      onContinuation: (run, context) => {
        try {
          runs.adopt(run, context);
        } catch (error) {
          log.error(`Could not adopt the provider's own turn on run ${run.runId}`, error);
        }
      },
    },
  });

  /**
   * Every variable any registered provider sets for itself.
   *
   * The store uses this as a denylist for `publicEnv`, so a union across
   * providers is the right shape: over-rejecting a name costs a user nothing,
   * under-rejecting one silently breaks account isolation. Built from the
   * adapters rather than written out here, so a new provider's variables are
   * covered the moment it is registered.
   */
  const managed = [
    ...new Set(providers.list().flatMap((adapter) => managedEnvKeys(adapter.credentials))),
  ];

  const profiles = new ProfileStore({ userDataDir, managedEnvKeys: managed });

  /** The credential vocabulary of the provider a request names. */
  const credentialsFor = (providerId: ProviderId): ProviderCredentialSpec =>
    providers.require(providerId).credentials;

  /**
   * Profile → the environment a provider executes with.
   *
   * `baseEnv` is deliberately left at its default (`{}`): this bundle carries
   * only profile-owned variables — `CLAUDE_CONFIG_DIR` and the profile's
   * `publicEnv`. The adapter is what merges the host environment in, and it
   * scrubs inherited credential variables while doing so, so a key in the
   * launching shell can never contaminate a profile. Pre-spreading
   * `process.env` here would duplicate that work against a second, separately
   * maintained list of managed keys.
   */
  const envFor = async (profileId: ProfileId, providerId: ProviderId): Promise<EnvBundle> =>
    resolveEnv(await profiles.require(profileId), {
      credentials: credentialsFor(providerId),
    });

  /**
   * Profile → just enough environment to *find* its history.
   *
   * Listing is a read. It needs the config directory and nothing else, and it
   * must not create that directory on a path that only reads — which is the
   * one behaviour that separates it from `envFor`.
   */
  const storeEnvFor = async (profileId: ProfileId, providerId: ProviderId): Promise<EnvBundle> =>
    resolveStoreEnv(await profiles.require(profileId), {
      credentials: credentialsFor(providerId),
    });

  /**
   * Everything the sign-in helpers need about one profile.
   *
   * Both the status probe and the generated command are built from the same
   * pair — the provider's vocabulary and the profile's directory — so they are
   * resolved once. Reading the status against one directory while telling the
   * user to sign a different one in is the failure this shape rules out.
   */
  const authOptionsFor = async (
    profileId: ProfileId,
  ): Promise<{ readonly credentials: ProviderCredentialSpec; readonly configDir: string; readonly hostEnv: NodeJS.ProcessEnv }> => {
    const profile = await profiles.require(profileId);
    return {
      credentials: credentialsFor(profile.providerId),
      configDir: profileConfigDir(profile),
      hostEnv: process.env,
    };
  };

  const runs = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    // The only path a credential takes into a run. `providerId` is read, not
    // discarded: it selects which variable names the credential is written
    // into, so a non-Claude provider receives its own vocabulary rather than
    // an Anthropic-shaped bundle.
    resolveRun: async ({ profileId, providerId }) => ({
      env: await envFor(profileId, providerId),
    }),
    onError: (error, context) => {
      log.error(`Run ${context.runId} reported a swallowed error during ${context.phase}`, error);
    },
  });

  /** Last plan-usage reading per profile. In-memory by design — see below. */
  const planUsageCache = new Map<ProfileId, PlanUsage>();

  /**
   * The last *live* model catalogue read for a (provider, profile) pair.
   *
   * Written by `listProviderModels` when the account confirmed the list, and
   * read by the session namer, which needs to know which model is the smallest
   * one this account actually has. Only live answers are stored: a fallback
   * list cached here would be indistinguishable from a confirmed one the next
   * time it was read, which is the exact confusion `ModelCatalogue.live` exists
   * to prevent.
   *
   * In-memory, and never fetched on demand. The renderer already reads this on
   * boot and on every profile switch, so by the time anyone sends a first
   * message the entry is almost always there — and when it is not, the namer
   * falls back to the adapter's static list rather than spawning a subprocess
   * on the path of a run that is starting.
   */
  const modelCatalogues = new Map<string, readonly ProviderModelOption[]>();
  const catalogueKey = (providerId: ProviderId, profileId: ProfileId): string =>
    `${providerId}:${profileId}`;

  /**
   * Names each new session from its opening message.
   *
   * Wired as a subscriber rather than folded into `startRun`, so that naming
   * cannot delay, fail or otherwise touch the run it is named after. See
   * `SessionNamer` for what it costs and when it declines.
   */
  const namer = new SessionNamer({
    resolveAdapter: (id) => providers.get(id),

    /**
     * Which model names the session, and with which environments.
     *
     * The catalogue read is live-first, static-fallback, and it never fetches:
     * the answer is "the smallest model this account has" where that is known,
     * and "the smallest model this provider ships" where it is not. A provider
     * whose models declare no tier yields `null` and nothing is named — see
     * `lowestTierModel` for why that is better than guessing.
     *
     * Two environments, because the two halves of naming need different
     * things. The completion is billed to the account, so it takes the
     * credential-bearing bundle a run gets. The rename only locates a file, so
     * it takes the store bundle a listing gets and decrypts nothing.
     */
    plan: async ({ profileId, providerId }): Promise<SessionNamingPlan | null> => {
      const adapter = providers.get(providerId);
      if (adapter === undefined) return null;

      const model =
        lowestTierModel(modelCatalogues.get(catalogueKey(providerId, profileId))) ??
        lowestTierModel(adapter.models);
      if (model === undefined) return null;

      return {
        model: model.id,
        env: await envFor(profileId, providerId),
        storeEnv: await storeEnvFor(profileId, providerId),
      };
    },

    onError: (error, context) => {
      // Deliberately a warning. Every failure here costs a nicer label and
      // nothing else — the session still exists, still resumes, and still
      // lists under the title it would have had before this feature.
      log.warn(`Could not name the session for run ${context.runId}`, error);
    },
  });

  /**
   * Remembers which account each session ran under.
   *
   * The second subscriber, wired exactly like the namer and for the same
   * reason: it must never delay, fail or touch the run it learns from.
   *
   * It exists because of the shared-config feature. Once `projects/` is
   * symlinked across profiles, every profile enumerates one store and the
   * directory a transcript was found in stops identifying an account — the
   * adapter then has to pick one, and says so with
   * `SessionSummary.profileIsUnknown`. Nothing on disk can settle it: the
   * transcript records a session, a directory and a branch, and no account. The
   * only component that ever knows is this process, at the moment it starts a
   * run, which is the moment this writes it down. See `SessionOwners`.
   */
  const owners = new SessionOwners({
    userDataDir,
    onError: (error, context) => {
      // A warning, like the namer's, and for a smaller cost still: every
      // failure here loses a label on a sidebar row. The session exists,
      // resumes and lists exactly as it did before this feature.
      log.warn(`Session ownership ledger failed during ${context.stage}`, error);
    },
  });

  runs.subscribe((event) => {
    namer.handleEvent(event);
    owners.handleEvent(event);
  });

  return {
    listProviders: (query) => providers.describe({ refresh: query.refresh }),

    /**
     * Ask a provider what models this account really has.
     *
     * The credential-bearing `envFor` — the same resolution a run gets — is
     * deliberate and not interchangeable with `storeEnvFor`. A catalogue is a
     * property of the account, so a bundle with no key in it would either be
     * refused or would answer for whatever account the CLI finds on its own,
     * which is precisely the cross-profile leak the isolated config directory
     * exists to prevent.
     *
     * Every branch resolves. A provider Artemis cannot drive, an adapter that
     * cannot enumerate, or a fetch that failed are all "here is the built-in
     * list, and no, the account did not confirm it" — the caller renders a
     * picker either way and labels it from `live`.
     */
    listProviderModels: async (query) => {
      const adapter = providers.get(query.providerId);
      // Not registered at all: there is no static list to fall back *to*, so
      // the honest answer is nothing rather than another provider's models.
      if (adapter === undefined) return { models: [], live: false };

      const fallback = adapter.models ?? [];
      if (adapter.listModels === undefined) return { models: fallback, live: false };

      try {
        // `live` comes back from the adapter rather than being inferred here.
        // `listModels` resolves on failure by contract, so a fallback is
        // indistinguishable from a real answer by inspection — the adapter is
        // the only party that knows which it returned, so it is the only party
        // that can say. See `ProviderAdapter.listModels`.
        const catalogue = await adapter.listModels({
          env: await envFor(query.profileId, query.providerId),
          // The query has to start somewhere that exists. userData always does;
          // the user's chosen workspace may not be set yet.
          cwd: query.cwd ?? userDataDir,
        });
        // Only the confirmed list is worth remembering; see `modelCatalogues`.
        if (catalogue.live) {
          modelCatalogues.set(
            catalogueKey(query.providerId, query.profileId),
            catalogue.models,
          );
        }
        return catalogue;
      } catch (error) {
        // The contract says it should not reject; if one does, that is a bug in
        // the adapter and not a reason to leave the picker empty.
        log.error(`Provider "${query.providerId}" threw while listing models`, error);
        return { models: fallback, live: false };
      }
    },

    listProfiles: (query) => profiles.listMetadata(query.providerId),

    // `create` resolves a full `Profile`. Narrowing it to its id here means the
    // secret-bearing fields are not even visible to the rest of this function;
    // the renderer-safe projection comes from `describe`.
    createProfile: async (draft) => {
      const created: { readonly id: ProfileId } = await profiles.create(draft);
      return profiles.describe(created.id);
    },
    updateProfile: async (id, patch) => {
      const updated: { readonly id: ProfileId } = await profiles.update(id, patch);
      return profiles.describe(updated.id);
    },
    deleteProfile: async (id, query) => {
      const result = await profiles.delete(id, { deleteConfigDir: query.deleteConfigDir });
      // The ledger's claims for a deleted account are dropped rather than left
      // to rot. Harmless on their own — nothing resolves these ids back into
      // accounts except by matching against profiles that exist — but a config
      // directory reused by a new profile would otherwise inherit them.
      // Awaited only for its errors, which `SessionOwners` reports rather than
      // throws, so this cannot fail a deletion that already happened.
      await owners.forget([id]);
      return result;
    },

    /**
     * Start a run, and — if it opens a new session — have that session named
     * and its account recorded.
     *
     * Both subscribers are told the registry's id rather than the input's,
     * because `RunInput.runId` is optional and core mints one when it is
     * absent. Both return immediately and start nothing; each is triggered by
     * the `session.started` event they are subscribed to above.
     *
     * `owners.noteRun` is called for every run and `namer.noteRun` is not —
     * the namer filters resumes and forks out because they are not first
     * messages, whereas a resume is precisely when a session whose account was
     * never recorded acquires one. Each filters at its own call site rather
     * than here, so neither rule has to be restated in the composition root.
     */
    startRun: async (input) => {
      const handle = await runs.start(input);
      namer.noteRun(input, handle.runId);
      owners.noteRun(input, handle.runId);
      return handle;
    },
    sendToRun: (runId, text, attachments) => runs.send(runId, text, attachments),
    interruptRun: (runId) => runs.interrupt(runId),
    stopTask: (runId, taskId) => runs.stopTask(runId, taskId),
    respondToPermission: async (runId, requestId, decision) => {
      await runs.respondToPermission(runId, requestId, decision);
    },
    disposeRun: async (runId) => {
      await runs.dispose(runId);
    },
    listRuns: (query) => Promise.resolve(runs.list(query.cwd)),

    runEvents: (query) => {
      const afterSeq = query.afterSeq ?? -1;
      const events = runs.eventsSince(query.runId, afterSeq);
      // The buffer drops from the front, so a first event that is not the one
      // immediately after `afterSeq` is the only evidence that something was
      // lost. Derived here because `eventsSince` returns a plain slice and the
      // renderer has no way to tell a short run from a trimmed one.
      const first = events[0];
      return { events, truncated: first !== undefined && first.seq > afterSeq + 1 };
    },

    /**
     * Read a profile's session history.
     *
     * This does not go through the run registry. Listing needs a resolved
     * environment (for Claude, the profile's isolated `CLAUDE_CONFIG_DIR` is
     * what locates `projects/<encoded-cwd>/*.jsonl`) but it starts no run, so
     * routing it through the registry would mean the registry resolving
     * credentials for a query it otherwise has no part in.
     *
     * Providers without `capabilities.listSessions` simply do not implement the
     * method; that is reported as a plain failure rather than an empty list, so
     * the UI can say "this provider has no session history" instead of showing
     * a history pane that is silently always empty.
     */
    /**
     * Last-known plan usage, served without touching the provider.
     *
     * Deliberately a plain in-memory map rather than a persisted cache. A
     * utilization percentage is only meaningful for minutes, and a figure
     * restored from disk after a week would be actively misleading — worse
     * than showing nothing, because it looks authoritative. Losing it on quit
     * is the correct behaviour, not a limitation.
     */
    cachedPlanUsage: (profileId) => planUsageCache.get(profileId) ?? null,

    refreshPlanUsage: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.fetchPlanUsage === undefined) {
        // Capability-off is an answer, not a fault: the picker still opens and
        // explains itself rather than erroring at the user.
        return {
          available: false,
          unavailableReason: `${adapter.label} does not report plan usage.`,
          windows: [],
          fetchedAt: Date.now(),
        };
      }

      const usage = await adapter.fetchPlanUsage({
        profileId: query.profileId,
        // A credential-bearing environment: unlike history, this read is
        // *about* the account, so it needs the account's credential.
        env: await envFor(query.profileId, profile.providerId),
        // The probe has to start somewhere that exists. userData always does,
        // and the user's chosen workspace may not be set yet.
        cwd: userDataDir,
      });

      planUsageCache.set(query.profileId, usage);
      return usage;
    },

    suggestConfigDir: (label) => profiles.suggestConfigDir(label),

    authStatus: async (profileId) => {
      const options = await authOptionsFor(profileId);
      return {
        status: await checkAuthStatus(options),
        signInCommand: signInCommand(options),
      };
    },

    signOut: async (profileId) => {
      const options = await authOptionsFor(profileId);
      // `signOut` re-reads the directory afterwards rather than assuming the
      // logout took: a failed sign-out rendered as signed-out would leave the
      // real credential in place while the UI claimed otherwise.
      return {
        status: await cliSignOut(options),
        signInCommand: signInCommand(options),
      };
    },

    getSessionMessages: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.getSessionMessages === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot open a stored session.`);
      }
      // Read-only, like listing: `resolveStoreEnv` yields the config directory
      // and no credential, so opening history never decrypts a key.
      return adapter.getSessionMessages({
        profileId: query.profileId,
        sessionId: query.sessionId,
        runId: query.runId,
        env: await storeEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },

    getSubagentMessages: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.getSubagentMessages === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot open a subagent's transcript.`);
      }
      // Read-only, exactly as `getSessionMessages` is: the store environment
      // carries the config directory and no credential.
      return adapter.getSubagentMessages({
        profileId: query.profileId,
        sessionId: query.sessionId,
        agentId: query.agentId,
        runId: query.runId,
        env: await storeEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },

    renameSession: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      /*
       * The same adapter method `SessionNamer` uses to store a generated name.
       *
       * Deliberately not a second one. A user-typed title and a model-written
       * one are the same fact about a session — its own name, as opposed to a
       * summary the provider derived — and they belong in the same field. Two
       * write paths into one store would eventually disagree about which of
       * them `titleIsCustom` describes.
       */
      if (adapter.setSessionTitle === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot rename a stored session.`);
      }

      /*
       * Normalised here rather than at the edge, because the caller is told
       * what was *stored* and that answer has to be produced by whoever does
       * the storing. Trimming at the IPC boundary and returning the untrimmed
       * string would leave the sidebar showing a title with whitespace the
       * transcript does not have.
       */
      const title = query.title.trim().slice(0, MAX_SESSION_TITLE);
      if (title.length === 0) {
        // A title that trims to nothing is a bad request, not a broken engine:
        // `EngineUnavailableError` maps to `provider_not_found`, which reached
        // the user as "Artemis's engine is unavailable: A session title cannot
        // be empty" — a sentence about the wrong thing entirely.
        throw new ValidationError('title', 'cannot be empty');
      }

      await adapter.setSessionTitle({
        sessionId: query.sessionId,
        title,
        env: await storeEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
      return { title };
    },

    deleteSession: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.deleteSession === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot delete a stored session.`);
      }

      const deleted = await adapter.deleteSession({
        sessionId: query.sessionId,
        env: await storeEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
      return { deleted };
    },

    listSessions: async (query) => {
      const adapter = providers.get(query.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(`No adapter is registered for provider "${query.providerId}".`);
      }
      if (adapter.listSessions === undefined) {
        throw new EngineUnavailableError(`${adapter.label} does not support listing session history.`);
      }
      return adapter.listSessions({
        profileId: query.profileId,
        cwd: query.cwd,
        env: await storeEnvFor(query.profileId, query.providerId),
        limit: query.limit,
        offset: query.offset,
      });
    },

    /**
     * Read every profile's history, across every project.
     *
     * Three properties are load-bearing here, and each one is a bug that was
     * easy to write instead:
     *
     *  1. **Read-only.** Environments come from `resolveStoreEnv`, which emits
     *     the config-directory variable and no credential. A history pane must
     *     not decrypt a key, and profiles with no key stored — a state the
     *     protocol models deliberately — must still list their transcripts.
     *  2. **Partial success.** A profile whose config directory is missing or
     *     unreadable, or whose environment cannot even be resolved (a
     *     hand-edited `configDirName`, say), contributes nothing and is logged.
     *     One broken profile blanking the whole sidebar would be a far worse
     *     failure than one profile's history being absent.
     *  3. **Merge, then slice.** Every provider and profile is read in full
     *     before the sort, because an ordering across the whole set does not
     *     exist until every partition has answered. Paginating per profile
     *     would drop one profile's older sessions in favour of another's newer
     *     ones before the two were ever compared.
     */
    listAllSessions: async (query) => {
      const records = await profiles.list(query.providerId);

      // Group by provider so each adapter is asked once, with all of its
      // profiles. `providerId` is read from the profile rather than assumed,
      // so a future Codex profile is routed to the Codex adapter.
      const byProvider = new Map<ProviderId, Profile[]>();
      for (const profile of records) {
        const group = byProvider.get(profile.providerId);
        if (group === undefined) byProvider.set(profile.providerId, [profile]);
        else group.push(profile);
      }

      const collected: SessionSummary[] = [];

      for (const [providerId, group] of byProvider) {
        const adapter = providers.get(providerId);
        // A provider that is not registered, or that cannot enumerate history,
        // simply has none to contribute. Unlike `listSessions` this is not
        // reported as an error: the caller asked for "everything", and
        // everything legitimately excludes providers that cannot answer.
        if (adapter?.listAllSessions === undefined) continue;

        const scopes: SessionListScope[] = [];
        for (const profile of group) {
          try {
            scopes.push({
              profileId: profile.id,
              env: await resolveStoreEnv(profile, { credentials: adapter.credentials }),
            });
          } catch (error) {
            log.warn(`Skipping profile ${profile.id} while listing all sessions`, error);
          }
        }
        if (scopes.length === 0) continue;

        try {
          const page = await adapter.listAllSessions({ profiles: scopes });
          if (page.unreadableProfiles.length > 0) {
            log.warn(
              `${String(page.unreadableProfiles.length)} ${providerId} profile(s) had no readable session store: ${page.unreadableProfiles.join(', ')}`,
            );
          }
          collected.push(...page.sessions);
        } catch (error) {
          // The adapter is contracted to degrade per profile rather than
          // throw, but a bug there must still not take the sidebar down.
          log.error(`Provider ${providerId} failed to list all sessions`, error);
        }
      }

      /*
       * Put the real account back on the rows an adapter could only pick one for.
       *
       * `profileIsUnknown` marks a session in a store several profiles reach —
       * the shared-config arrangement, where `projects/` is symlinked into
       * every profile — and on those rows `profileId` is the first sharer
       * rather than an answer. Left alone, every shared row in the sidebar
       * carries the same arbitrary account label, which is the one question the
       * label exists to answer, answered wrongly and confidently.
       *
       * The ledger settles it for every session this install started or
       * resumed. A session it has never seen keeps the flag and the pick, and
       * the sidebar shows no account for it rather than inventing one.
       *
       * Done here rather than in the adapter because the adapter is the wrong
       * component to know it: it reads a provider's store, and this is Artemis's
       * own bookkeeping about runs it drove. The ledger is only opened when a
       * row actually needs it, so an install with no shared store never touches
       * the file.
       */
      if (collected.some((summary) => summary.profileIsUnknown === true)) {
        const recorded = await owners.all();
        for (const [index, summary] of collected.entries()) {
          collected[index] = attributeSession(summary, recorded);
        }
      }

      collected.sort((a, b) =>
        a.updatedAt !== b.updatedAt
          ? b.updatedAt - a.updatedAt
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );

      const offset = query.offset ?? 0;
      const limit = query.limit;
      const sessions =
        limit === undefined ? collected.slice(offset) : collected.slice(offset, offset + limit);
      const hasMore = limit === undefined ? false : collected.length > offset + limit;

      return { sessions, hasMore };
    },

    subscribe: (listener) => runs.subscribe(listener),

    // All three, and in parallel: a half-written title is not worth delaying
    // quit for, and `SessionNamer.dispose` aborts rather than waits.
    //
    // `owners.flush` is the one that genuinely waits, and it is cheap — a write
    // already in flight, or nothing. Skipping it would drop the account for
    // whichever session was started last, which is exactly the session the user
    // will look for first when they reopen.
    dispose: async () => {
      await Promise.all([runs.disposeAll(), namer.dispose(), owners.flush()]);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Host                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A handle to the engine that is safe to hold before — and after — it fails.
 *
 * IPC handlers call {@link require}, which either returns a live engine or
 * throws {@link EngineUnavailableError}. That is normalized into a
 * `provider_not_found` result, so the UI can say "Artemis's engine failed to
 * start" instead of waiting on a promise that never settles.
 */
export class EngineHost {
  #engine: ArtemisEngine | null = null;
  #failure: EngineUnavailableError | null = null;

  /** The live engine, or a descriptive throw. */
  require(): ArtemisEngine {
    if (this.#engine) return this.#engine;
    throw this.#failure ?? new EngineUnavailableError('the engine has not been started yet.');
  }

  /** True when the engine is running. */
  get ready(): boolean {
    return this.#engine !== null;
  }

  /** Why the engine is not running, for the startup dialog. */
  get failureMessage(): string | null {
    return this.#failure?.message ?? null;
  }

  /**
   * Assemble the engine.
   *
   * Never throws: a failure is recorded and reported through {@link require} so
   * that window creation and the rest of startup carry on. An app that refuses
   * to launch cannot explain itself.
   */
  async start(options: EngineOptions): Promise<void> {
    try {
      this.#engine = await Promise.resolve(createEngine(options));
      this.#failure = null;
      log.info('Engine started.');
    } catch (error) {
      const failure =
        error instanceof EngineUnavailableError
          ? error
          : new EngineUnavailableError(error instanceof Error ? error.message : String(error));
      this.#engine = null;
      this.#failure = failure;
      log.error('Engine failed to start', failure);
    }
  }

  /** Tear the engine down. Safe to call when it never started. */
  async stop(): Promise<void> {
    const engine = this.#engine;
    this.#engine = null;
    if (!engine) return;
    try {
      await engine.dispose();
    } catch (error) {
      log.error('Engine disposal failed', error);
    }
  }
}
