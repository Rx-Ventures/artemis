/**
 * The headless composition root: core's parts, assembled without a window.
 *
 * The desktop app's `engine.ts` wires the same parts and then keeps going —
 * terminals, browsers, updaters, session naming, a prompt library, an IPC
 * surface. None of that exists here, and the absence is the design: this
 * process serves HTTP turns and stored history, so it composes exactly the
 * six calls the server's `RunSource` and `SessionSource` make, plus the
 * catalogue those calls are routed by.
 *
 * What a headless deployment gives up, stated rather than implied:
 *
 *  - **No session naming.** The desktop titles new conversations with a model
 *    call; here a session lists under its first prompt. Cosmetic.
 *  - **No plan-usage polling, no update checks, no notifications.** All
 *    window furniture.
 *  - **Permission prompts are auto-denied**, exactly as they are for the
 *    desktop-hosted server — nobody is present to answer. Serve profiles
 *    whose settings pre-authorize what their work needs.
 */

import type { ProfileId, ProviderId, RunId } from '@rx-artemis/protocol';
import {
  createCatalogue,
  createDefaultProviderRegistry,
  createPushFeed,
  createSessionLedger,
  createWorkspaceResolver,
  managedEnvKeys,
  ProfileStore,
  resolveEnv,
  RunRegistry,
  type Catalogue,
  type ProviderRegistry,
  type PushFeed,
  type RunSource,
  type SessionLedger,
  type SessionSource,
  type WorkspaceResolver,
} from '@rx-artemis/core';

import { createFileProfileSecrets } from './secrets.js';

export interface HeadlessHost {
  readonly profiles: ProfileStore;
  readonly providers: ProviderRegistry;
  readonly runs: RunRegistry;
  readonly catalogue: Catalogue;
  readonly workspaces: WorkspaceResolver;
  readonly ledger: SessionLedger;
  readonly runSource: RunSource;
  readonly sessionSource: SessionSource;
  /** Every push the server can stream to a remote client. See `server/feed.ts`. */
  readonly feed: PushFeed;
  dispose(): Promise<void>;
}

export function createHeadlessHost(dataDir: string): HeadlessHost {
  const providers = createDefaultProviderRegistry({});
  const managed = [...new Set(providers.list().flatMap((adapter) => managedEnvKeys(adapter.credentials)))];

  const profiles = new ProfileStore({
    userDataDir: dataDir,
    managedEnvKeys: managed,
    secrets: createFileProfileSecrets(dataDir),
  });

  const credentialsFor = (providerId: ProviderId) => {
    const adapter = providers.get(providerId);
    if (adapter === undefined) throw new Error(`No adapter for provider "${providerId}".`);
    return adapter.credentials;
  };

  const envFor = async (profileId: ProfileId, providerId: ProviderId) => {
    const profile = await profiles.require(profileId);
    const apiKey = await profiles.readApiKey(profileId);
    return resolveEnv(profile, {
      credentials: credentialsFor(providerId),
      ...(apiKey === null ? {} : { apiKey }),
    });
  };

  const runs = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    resolveRun: async ({ profileId, providerId }) => ({ env: await envFor(profileId, providerId) }),
  });

  const catalogue = createCatalogue({
    source: {
      listProfiles: () => profiles.listMetadata(),
      // The registry's own describe(), which probes availability the same way
      // the desktop's engine does — a serving machine without a provider's
      // CLI reports it unavailable rather than publishing routes that 500.
      listProviders: () => providers.describe({ includeUnregistered: false }),
      listModels: async ({ providerId, profileId }) => {
        const adapter = providers.get(providerId);
        if (adapter?.listModels === undefined) {
          return { models: providers.get(providerId)?.models ?? [], live: false };
        }
        return adapter.listModels({
          env: await envFor(profileId, providerId),
          cwd: dataDir,
        });
      },
    },
  });

  const workspaces = createWorkspaceResolver();
  const ledger = createSessionLedger(dataDir);

  /*
   * The push feed: every agent event, stamped with the account its run bills
   * so the routes can filter per connection. Subscribed once, here, because
   * the feed's sequence numbers are the remote client's replay cursor and a
   * second subscription would number every event twice. `runs.get` covers
   * live and recently-ended runs, so even a run's own `run.end` still finds
   * its profile.
   */
  const feed = createPushFeed();
  runs.subscribe((event) => {
    const profileId = runs.get(event.runId)?.profileId;
    feed.publish(
      'artemis:push:agent-event',
      event,
      profileId === undefined ? {} : { profileId: String(profileId) },
    );
  });

  const runSource: RunSource = {
    startRun: (input) =>
      runs.start({
        providerId: input.providerId as ProviderId,
        profileId: input.profileId as ProfileId,
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
        ...(input.ultracode === undefined ? {} : { ultracode: input.ultracode }),
        ...(input.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: input.resumeSessionId as never }),
      } as never),
    subscribe: (listener) => runs.subscribe(listener),
    interrupt: async (runId) => {
      await runs.interrupt(runId as RunId);
    },
    respondToPermission: async (runId, requestId, decision) => {
      await runs.respondToPermission(runId as RunId, requestId as never, decision as never);
    },
    disposeRun: async (runId) => {
      await runs.dispose(runId as RunId);
    },

    // The observation surface (ADR 0004). No `liveWork`: the headless host
    // keeps no background-work ledger, and the route's contract makes the
    // empty answer it degrades to an honest one.
    listRuns: async (query) => runs.list(query.cwd),
    getRun: async (runId) => runs.get(runId as RunId),
    runEvents: async (query) => {
      const after = query.afterSeq ?? -1;
      const events = runs.eventsSince(query.runId as RunId, after);
      // The buffer drops from the front, so a first event that is not the one
      // immediately after `after` is the only evidence that something was
      // lost — the same derivation the desktop's engine makes.
      const first = events[0];
      return { events, truncated: first !== undefined && first.seq > after + 1 };
    },
  };

  const sessionSource: SessionSource = {
    list: async (query) => {
      const adapter = providers.get(query.providerId as ProviderId);
      if (adapter?.listSessions === undefined) return { sessions: [], hasMore: false };
      return adapter.listSessions({
        profileId: query.profileId as ProfileId,
        cwd: query.cwd,
        env: await envFor(query.profileId as ProfileId, query.providerId as ProviderId),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },
    messages: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.getSessionMessages === undefined) return { events: [], hasMore: false };
      return adapter.getSessionMessages({
        profileId: query.profileId as ProfileId,
        sessionId: query.sessionId as never,
        runId: query.runId as never,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },
  };

  return {
    profiles,
    providers,
    runs,
    catalogue,
    workspaces,
    ledger,
    runSource,
    sessionSource,
    feed,
    dispose: async () => {
      await runs.disposeAll();
      await ledger.flush();
      await workspaces.disposeAll();
    },
  };
}
