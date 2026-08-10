/**
 * The composition root: where Electron's resources meet `@libra/core`.
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
 * The "a failed engine must not stop Libra from launching" property is
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
  PermissionDecision,
  PermissionRequestId,
  Profile,
  ProfileDraft,
  ProfileId,
  ProfileMetadata,
  ProfilePatch,
  ProviderDescriptor,
  ProviderId,
  RunHandle,
  RunId,
  SessionId,
  RunInput,
  SessionSummary,
  Unsubscribe,
  PlanUsage,
  AuthMode,
  AuthStatusInfo,
} from '@libra/protocol';

import {
  checkAuthStatus,
  createDefaultProviderRegistry,
  managedEnvKeys,
  ProfileStore,
  profileConfigDir,
  resolveEnv,
  resolveStoreEnv,
  RunRegistry,
  signIn as cliSignIn,
  signOut as cliSignOut,
  type EnvBundle,
  type ProviderCredentialSpec,
  type ProviderRegistry,
  type SessionListScope,
} from '@libra/core';

import { EngineUnavailableError } from './errors.js';
import { createLogger } from './log.js';
import type { SecretStore } from './secrets.js';

const log = createLogger('engine');

/* -------------------------------------------------------------------------- */
/* The interface the IPC layer calls                                          */
/* -------------------------------------------------------------------------- */

/** What Electron injects into core. */
export interface EngineOptions {
  /**
   * Encrypted credential storage, owned by the main process.
   *
   * Satisfies core's own `SecretStore` seam (`get` / `set` / `delete`). Core
   * never sees the ciphertext, the file, or the OS keychain.
   */
  readonly secrets: SecretStore;
  /**
   * Electron's per-app user data directory.
   *
   * Profile records live here, and so do the per-profile `CLAUDE_CONFIG_DIR`s
   * that core derives from it (`<userData>/profiles/<configDirName>`) — which
   * is why a profile record stores a bare directory name rather than a path.
   */
  readonly userDataDir: string;
  /** Libra's version, for any provider that wants a user-agent string. */
  readonly appVersion: string;
}

/**
 * The engine as the main process uses it.
 *
 * Every method takes and returns renderer-safe protocol types, because each one
 * is a single step from an IPC response. Nothing here returns a `Profile`.
 */
export interface LibraEngine {
  listProviders(options: { readonly refresh?: boolean }): Promise<readonly ProviderDescriptor[]>;

  listProfiles(options: { readonly providerId?: ProviderId }): Promise<readonly ProfileMetadata[]>;
  createProfile(draft: ProfileDraft): Promise<ProfileMetadata>;
  updateProfile(id: ProfileId, patch: ProfilePatch): Promise<ProfileMetadata>;
  deleteProfile(
    id: ProfileId,
    options: { readonly deleteConfigDir?: boolean },
  ): Promise<{ readonly id: ProfileId; readonly configDirDeleted: boolean }>;

  startRun(input: RunInput): Promise<RunHandle>;
  sendToRun(runId: RunId, text: string): Promise<{ readonly deliveredImmediately: boolean }>;
  interruptRun(runId: RunId): Promise<{ readonly stillQueued?: readonly string[] }>;
  respondToPermission(
    runId: RunId,
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void>;
  disposeRun(runId: RunId): Promise<void>;
  listRuns(options: { readonly cwd?: string }): Promise<readonly RunHandle[]>;

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
   * This is the only way a profile is authenticated. There is deliberately no
   * method here that accepts a key or a token: the provider's login writes
   * credentials into the profile's isolated config directory, so no credential
   * is ever handled by, stored by, or reachable from Libra. That is also what
   * makes multiple accounts work — the config directory *is* the account
   * boundary.
   */
  authStatus(profileId: ProfileId): Promise<AuthStatusInfo>;
  /** Long-running: the user completes this in a browser. */
  signIn(options: { readonly profileId: ProfileId; readonly mode?: AuthMode }): Promise<AuthStatusInfo>;
  signOut(profileId: ProfileId): Promise<AuthStatusInfo>;

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
function createEngine(options: EngineOptions): LibraEngine {
  const { secrets, userDataDir } = options;

  // `createDefaultProviderRegistry` — not `createProviderRegistry` — is what
  // actually registers the Claude adapter. An empty registry typechecks
  // perfectly and then reports every provider as unavailable at runtime.
  const providers: ProviderRegistry = createDefaultProviderRegistry();

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

  const profiles = new ProfileStore({ userDataDir, secrets, managedEnvKeys: managed });

  /** The credential vocabulary of the provider a request names. */
  const credentialsFor = (providerId: ProviderId): ProviderCredentialSpec =>
    providers.require(providerId).credentials;

  /**
   * Profile → the environment a provider executes with.
   *
   * `baseEnv` is deliberately left at its default (`{}`): this bundle carries
   * only profile-owned variables — the credential, the backend flag and
   * `CLAUDE_CONFIG_DIR`. The adapter is what merges the host environment in,
   * and it scrubs inherited credential variables while doing so, so a key in
   * the launching shell can never contaminate a profile. Pre-spreading
   * `process.env` here would duplicate that work against a second, separately
   * maintained list of managed keys.
   */
  const envFor = async (profileId: ProfileId, providerId: ProviderId): Promise<EnvBundle> =>
    resolveEnv(await profiles.require(profileId), secrets, {
      userDataDir,
      credentials: credentialsFor(providerId),
    });

  /**
   * Profile → just enough environment to *find* its history.
   *
   * Listing is a read. It needs the isolated config directory and no
   * credential, so it must not go through `envFor`: that one refuses to resolve
   * an `anthropic` profile with no key stored, which would make the history
   * pane show an auth error for a profile the protocol explicitly models as
   * valid-but-needing-setup. It also would not create a directory on a path
   * that only reads.
   */
  const storeEnvFor = async (profileId: ProfileId, providerId: ProviderId): Promise<EnvBundle> =>
    resolveStoreEnv(await profiles.require(profileId), {
      userDataDir,
      credentials: credentialsFor(providerId),
    });

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

  return {
    listProviders: (query) => providers.describe({ refresh: query.refresh }),

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
    deleteProfile: (id, query) => profiles.delete(id, { deleteConfigDir: query.deleteConfigDir }),

    startRun: (input) => runs.start(input),
    sendToRun: (runId, text) => runs.send(runId, text),
    interruptRun: (runId) => runs.interrupt(runId),
    respondToPermission: async (runId, requestId, decision) => {
      await runs.respondToPermission(runId, requestId, decision);
    },
    disposeRun: async (runId) => {
      await runs.dispose(runId);
    },
    listRuns: (query) => Promise.resolve(runs.list(query.cwd)),

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

    authStatus: async (profileId) => {
      const profile = await profiles.require(profileId);
      return checkAuthStatus({ configDir: profileConfigDir(userDataDir, profile), hostEnv: process.env });
    },

    signIn: async (options) => {
      const profile = await profiles.require(options.profileId);
      return cliSignIn({
        configDir: profileConfigDir(userDataDir, profile),
        hostEnv: process.env,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
    },

    signOut: async (profileId) => {
      const profile = await profiles.require(profileId);
      const configDir = profileConfigDir(userDataDir, profile);
      await cliSignOut({ configDir, hostEnv: process.env });
      // Report what the directory *actually* says afterwards rather than
      // assuming the logout took: a failed sign-out that renders as signed-out
      // would leave the user's real credential in place while the UI claims
      // otherwise.
      return checkAuthStatus({ configDir, hostEnv: process.env });
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
              env: await resolveStoreEnv(profile, {
                userDataDir,
                credentials: adapter.credentials,
              }),
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
    dispose: () => runs.disposeAll(),
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
 * `provider_not_found` result, so the UI can say "Libra's engine failed to
 * start" instead of waiting on a promise that never settles.
 */
export class EngineHost {
  #engine: LibraEngine | null = null;
  #failure: EngineUnavailableError | null = null;

  /** The live engine, or a descriptive throw. */
  require(): LibraEngine {
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
