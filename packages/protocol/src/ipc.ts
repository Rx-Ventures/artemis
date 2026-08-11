/**
 * The IPC contract.
 *
 * Channel names, a typed request/response map, and the shape the preload script
 * exposes on `window.artemis`. Main and renderer both compile against this file,
 * so a mismatch is a build error rather than a runtime surprise.
 *
 * Two structural decisions worth understanding before you extend this:
 *
 *  1. **Everything is request/response over `invoke`, except agent events.**
 *     Agent events are high-frequency and one-directional, so they get a single
 *     push channel ({@link IPC_PUSH.agentEvent}) instead of a round-trip.
 *
 *  2. **Handlers never reject.** Every handler resolves an {@link IpcResult}.
 *     An `ipcRenderer.invoke` rejection loses the error's type and stringifies
 *     its stack into the renderer, which is both lossy and a small information
 *     leak. Returning a discriminated result keeps failures typed and keeps
 *     stack traces in the main process where they belong.
 *
 * And one rule that overrides both: **no secret crosses into the renderer.**
 * Responses carry {@link ProfileMetadata}, never `Profile`. The only secret in
 * this file travels the other way — {@link ProfileDraft.apiKey} on its way to
 * encrypted storage.
 */

import type { AgentEvent } from './events.js';
import type { AgentError } from './errors.js';
import type { Attachment } from './attachment.js';
import type { PermissionDecision } from './permissions.js';
import type { PermissionRequestId, ProfileId, RunId, SessionId } from './ids.js';
import type { ProfileDraft, ProfileMetadata, ProfilePatch } from './profile.js';
import type { ProviderDescriptor, ProviderId, ProviderModelOption } from './provider.js';
import type { RunHandle, RunInput } from './run.js';
import type { SessionSummary } from './session.js';
import type { PlanUsage } from './usage.js';

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Request/response channels, used with `ipcMain.handle` / `ipcRenderer.invoke`.
 *
 * Names are namespaced under `artemis:` so they cannot collide with anything
 * Electron or a dependency registers.
 */
export const IPC = {
  /** List profiles as renderer-safe metadata. */
  profilesList: 'artemis:profiles:list',
  /** Create a profile. */
  profilesCreate: 'artemis:profiles:create',
  /** Update a profile's label, config directory or env. */
  profilesUpdate: 'artemis:profiles:update',
  /** Delete a profile and (where Artemis owns it) its config dir. */
  profilesDelete: 'artemis:profiles:delete',
  /** Propose an unused config-directory path for a profile about to be created. */
  profilesSuggestDir: 'artemis:profiles:suggest-dir',

  /** Enumerate providers and their capability descriptors. */
  providersList: 'artemis:providers:list',
  /** Ask one provider's installed CLI what models it actually offers. */
  providersModels: 'artemis:providers:models',

  /** Start a run. */
  runsStart: 'artemis:runs:start',
  /** Send another message into a live run. */
  runsSend: 'artemis:runs:send',
  /** Ask a live run to stop what it is doing. */
  runsInterrupt: 'artemis:runs:interrupt',
  /** Answer an outstanding permission request. */
  runsRespondPermission: 'artemis:runs:respond-permission',
  /** Tear a run down and release its resources. */
  runsDispose: 'artemis:runs:dispose',
  /** Re-sync live runs after a renderer reload. */
  runsList: 'artemis:runs:list',

  /** List historical sessions for a provider + profile + cwd. */
  sessionsList: 'artemis:sessions:list',
  /** List historical sessions across every profile and every project. */
  sessionsListAll: 'artemis:sessions:list-all',

  /** Ask the OS for a directory, via a native picker. */
  workspacePickDirectory: 'artemis:workspace:pick-directory',
  /** Name a directory: its own name, and its repository's when it has one. */
  workspaceDescribe: 'artemis:workspace:describe',

  /** One stored session's messages, replayed as events. */
  sessionsMessages: 'artemis:sessions:messages',

  /** Give a stored session a user-chosen title. */
  sessionsRename: 'artemis:sessions:rename',
  /**
   * Destroy a stored session's transcript. Irreversible, and outside Artemis:
   * see {@link SessionsDeleteRequest}.
   */
  sessionsDelete: 'artemis:sessions:delete',

  /** Last-known plan usage for a profile, served from cache without fetching. */
  usagePlanCached: 'artemis:usage:plan-cached',
  /** Fetch fresh plan usage for a profile. Costs a subprocess, not tokens. */
  usagePlanRefresh: 'artemis:usage:plan-refresh',

  /**
   * Read a profile's login state from its own config directory.
   *
   * The only auth channel. There is no `sign-in` counterpart: the user runs the
   * provider's login themselves, in their own terminal, and this is polled
   * until it reports success. Artemis used to spawn that login itself and had to
   * hold a five-minute subprocess open around a browser flow it could not see —
   * a command the user can read, run and re-run beats a spinner that can only
   * time out.
   */
  authStatus: 'artemis:auth:status',
  /** Sign a profile out, clearing the credentials in its config directory. */
  authSignOut: 'artemis:auth:sign-out',
} as const;

/**
 * Main → renderer push channels, used with `webContents.send` /
 * `ipcRenderer.on`.
 */
export const IPC_PUSH = {
  /** Carries a single {@link AgentEvent}. The renderer's whole live feed. */
  agentEvent: 'artemis:push:agent-event',
} as const;

/** Union of every request/response channel name. */
export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Union of every push channel name. */
export type IpcPushChannel = (typeof IPC_PUSH)[keyof typeof IPC_PUSH];

/** All request/response channel names, for registering handlers in a loop. */
export const IPC_CHANNELS = Object.values(IPC) as readonly IpcChannel[];

/* -------------------------------------------------------------------------- */
/* Result envelope                                                            */
/* -------------------------------------------------------------------------- */

/** Failure detail returned across IPC. Reuses the normalized error taxonomy. */
export interface IpcError extends AgentError {
  /** The channel that failed, filled in by the main-process dispatcher. */
  readonly channel?: IpcChannel;
}

/** A successful response. */
export interface IpcOk<T> {
  readonly ok: true;
  readonly value: T;
}

/** A failed response. Never a rejected promise. */
export interface IpcFail {
  readonly ok: false;
  readonly error: IpcError;
}

/**
 * What every handler resolves. Narrow on `ok` before touching `value`.
 *
 * @example
 * ```ts
 * const res = await window.artemis.profiles.list({})
 * if (!res.ok) return showError(res.error.message)
 * setProfiles(res.value.profiles)
 * ```
 */
export type IpcResult<T> = IpcOk<T> | IpcFail;

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProfilesListRequest {
  /** Restrict to one provider. Omit for all profiles. */
  readonly providerId?: ProviderId;
}

export interface ProfilesListResponse {
  /** Renderer-safe metadata only. */
  readonly profiles: readonly ProfileMetadata[];
}

export interface ProfilesCreateRequest {
  readonly draft: ProfileDraft;
}

export interface ProfilesCreateResponse {
  readonly profile: ProfileMetadata;
}

export interface ProfilesUpdateRequest {
  readonly id: ProfileId;
  readonly patch: ProfilePatch;
}

export interface ProfilesUpdateResponse {
  readonly profile: ProfileMetadata;
}

export interface ProfilesDeleteRequest {
  readonly id: ProfileId;
  /**
   * Also delete the profile's config directory, discarding its session history.
   * Defaults to false: deleting an account should not silently destroy
   * transcripts.
   *
   * **Honoured only for a directory Artemis created**, i.e. one inside its own
   * user-data directory. The config directory is a path the user picked and may
   * well be their own `~/.claude`, or another profile's; asking Artemis to
   * recursively delete one of those is a request it declines rather than
   * performs. See {@link ProfilesDeleteResponse.configDirDeleted}.
   */
  readonly deleteConfigDir?: boolean;
}

export interface ProfilesDeleteResponse {
  readonly id: ProfileId;
  /**
   * True when the config directory was removed as well.
   *
   * False whenever it was not — because it was not asked for, because it did
   * not exist, or because it sits outside Artemis's own directory and is
   * therefore not Artemis's to delete. The caller is told which happened rather
   * than left to assume the deletion took.
   */
  readonly configDirDeleted: boolean;
}

export interface ProfilesSuggestDirRequest {
  /** The label the user has typed so far. Used to make the path recognisable. */
  readonly label: string;
}

export interface ProfilesSuggestDirResponse {
  /**
   * An absolute path inside Artemis's user-data directory that no existing
   * profile uses. A suggestion, not a reservation: nothing is created, and the
   * user is free to replace it with a directory of their own.
   */
  readonly configDir: string;
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

export interface ProvidersListRequest {
  /** Re-probe availability instead of returning a cached answer. */
  readonly refresh?: boolean;
}

export interface ProvidersListResponse {
  readonly providers: readonly ProviderDescriptor[];
}

/**
 * Ask a provider for its *live* model catalogue.
 *
 * Separate from {@link ProvidersListRequest} because it is a different kind of
 * read. `providers:list` is a description of what Artemis can drive — static,
 * cheap, and answered out of the registry. This one contacts the installed CLI
 * with a profile's credential to find out which models that account actually
 * has, which costs a subprocess and can fail. Folding it into the descriptor
 * call would make opening any provider menu wait on a spawn.
 *
 * It names a profile rather than only a provider for the same reason
 * {@link UsagePlanRequest} does: the answer is a property of the *account*.
 * Two profiles on the same provider can be on different plans and see
 * different lineups.
 */
export interface ProvidersModelsRequest {
  readonly providerId: ProviderId;
  /** Whose credential to ask with. Decides which account the CLI answers as. */
  readonly profileId: ProfileId;
  /**
   * An absolute directory to run the query in. Optional: providers resolve
   * their configuration relative to a working directory, so the answer can
   * differ per project, but the user may not have chosen one yet — main
   * substitutes a directory that always exists rather than failing.
   */
  readonly cwd?: string;
}

export interface ProvidersModelsResponse {
  /** In display order, first = default — the same contract as `ProviderDescriptor.models`. */
  readonly models: readonly ProviderModelOption[];
  /**
   * True when this came off the installed CLI, false when it is the provider's
   * built-in fallback list.
   *
   * The handler never fails — a missing binary, a missing credential or an
   * offline machine all resolve with the fallback — so `ok: true` alone does
   * not tell the renderer whether it is looking at reality. This does, which is
   * what lets the settings screen label a stale list instead of presenting a
   * hard-coded lineup as though the account had confirmed it.
   */
  readonly live: boolean;
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export interface RunsStartRequest {
  readonly input: RunInput;
}

export interface RunsStartResponse {
  /**
   * The accepted run. Events for it begin arriving on
   * {@link IPC_PUSH.agentEvent} and may start before this response resolves —
   * subscribe before you invoke, or buffer by `runId`.
   */
  readonly run: RunHandle;
}

export interface RunsSendRequest {
  readonly runId: RunId;
  readonly text: string;
  /**
   * Images to send with {@link text}. Same contract as
   * {@link import('./run.js').RunInput.attachments}, for the mid-run case.
   */
  readonly attachments?: readonly Attachment[];
}

export interface RunsSendResponse {
  readonly runId: RunId;
  /**
   * False when the provider queued the text for the next turn rather than
   * steering the current one — the case for providers without
   * {@link import('./provider.js').Capabilities.midRunSteering}.
   */
  readonly deliveredImmediately: boolean;
}

export interface RunsInterruptRequest {
  readonly runId: RunId;
}

export interface RunsInterruptResponse {
  readonly runId: RunId;
  /**
   * Ids of messages that were queued and will still run unless cancelled.
   * Empty for providers that stop cleanly.
   */
  readonly stillQueued?: readonly string[];
}

export interface RunsRespondPermissionRequest {
  readonly runId: RunId;
  readonly requestId: PermissionRequestId;
  readonly decision: PermissionDecision;
}

export interface RunsRespondPermissionResponse {
  readonly requestId: PermissionRequestId;
}

export interface RunsDisposeRequest {
  readonly runId: RunId;
}

export interface RunsDisposeResponse {
  readonly runId: RunId;
}

export interface RunsListRequest {
  /** Restrict to runs in one working directory. */
  readonly cwd?: string;
}

export interface RunsListResponse {
  /** Runs the main process still considers live. */
  readonly runs: readonly RunHandle[];
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export interface SessionsListRequest {
  readonly providerId: ProviderId;
  /**
   * Whose history to read. Required: session storage is per-profile, because
   * each profile has its own `CLAUDE_CONFIG_DIR`.
   */
  readonly profileId: ProfileId;
  /** Absolute path whose sessions to list. */
  readonly cwd: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SessionsListResponse {
  readonly sessions: readonly SessionSummary[];
  /** True when more results exist past `offset + sessions.length`. */
  readonly hasMore: boolean;
}

/**
 * Every past session, across every profile and every project.
 *
 * The query {@link SessionsListRequest} cannot answer: it is scoped to one
 * profile *and* one working directory, which is right for "show me this
 * project's history" and useless for a sidebar that lists everything the user
 * has ever worked on.
 *
 * No new bookkeeping backs this. Sessions are partitioned by
 * (profile × project) on disk — each profile has its own provider config
 * directory, and the provider stores transcripts per project inside it — so a
 * session's profile is simply *which* directory it was found in, and its
 * project is the `cwd` recorded in the session itself.
 */
export interface SessionsListAllRequest {
  /**
   * Restrict to one provider. Omit for every provider that can list history;
   * providers that cannot are skipped rather than reported as errors.
   */
  readonly providerId?: ProviderId;
  /**
   * Page size, applied **after** every profile's sessions have been merged and
   * sorted newest-first. Omit for everything, which is what a sidebar wants.
   */
  readonly limit?: number;
  readonly offset?: number;
}

export interface SessionsListAllResponse {
  /**
   * Newest first, across all profiles and projects. Group by
   * {@link SessionSummary.cwd} for projects and label with
   * {@link SessionSummary.profileId}; both fields are already on every entry.
   *
   * `id` is unique per profile, not globally — the same session id could in
   * principle appear under two profiles — so key list rows on
   * `profileId + id`.
   */
  readonly sessions: readonly SessionSummary[];
  /** True when more results exist past `offset + sessions.length`. */
  readonly hasMore: boolean;
}

/**
 * Retitle a stored session.
 *
 * The title is written into the transcript itself, not into bookkeeping of
 * Artemis's own, which is what makes it survive: the same name shows up in the
 * provider's own CLI, and a session renamed here is still renamed after Artemis
 * is uninstalled. It is the write counterpart to
 * {@link SessionSummary.titleIsCustom} — that flag is how a listing reports
 * that this channel has been used on a session.
 */
export interface SessionsRenameRequest {
  /**
   * Whose history holds it. Session storage is per-profile.
   *
   * No `providerId` alongside it, matching {@link SessionsMessagesRequest}: the
   * profile already names its provider, so a second field could only ever
   * agree with it or be wrong. The main process reads the provider off the
   * profile record.
   */
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  /**
   * The session's project directory. Optional, and purely a narrowing hint —
   * omitting it makes the provider search every project it knows about, which
   * is correct but slower.
   */
  readonly cwd?: string;
  /** The new title. Trimmed and length-capped by the main process. */
  readonly title: string;
}

export interface SessionsRenameResponse {
  /**
   * The title as actually stored, after trimming and capping.
   *
   * Echoed rather than assumed: the renderer shows this string, and showing
   * the string it *sent* would leave the list disagreeing with the transcript
   * whenever the two differ.
   */
  readonly title: string;
}

/**
 * Destroy a stored session. There is no undo, and no tombstone.
 *
 * This deletes the transcript **on disk** — the provider's file, not a record
 * Artemis keeps — so the session also stops existing for the provider's own
 * CLI. That is the intended meaning of the menu item, and it is the reason the
 * UI puts a confirmation in front of it rather than an undo behind it: there is
 * nothing left to restore from.
 *
 * Hiding a session without destroying it is a separate, renderer-side concept
 * (archiving), which deliberately does not come through this channel.
 */
export interface SessionsDeleteRequest {
  /** Whose history holds it. See {@link SessionsRenameRequest.profileId}. */
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  /** Narrowing hint, exactly as in {@link SessionsRenameRequest}. */
  readonly cwd?: string;
}

export interface SessionsDeleteResponse {
  /**
   * True when this call removed the transcript, false when there was nothing
   * left to remove.
   *
   * A session that is already gone is a *success*, not an error: the caller
   * asked for it to not exist and it does not exist. Two clicks on a delete
   * button, or a transcript removed in a terminal since the sidebar last read
   * it, both land here, and neither deserves an error dialog. The flag is kept
   * so the UI can stay quiet in the second case instead of claiming a deletion
   * it did not perform.
   */
  readonly deleted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Workspace                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Open the OS's own directory picker.
 *
 * Exists because a typed path is the single most error-prone input in Artemis: a
 * directory that does not exist reaches `spawn`, and `spawn`'s `ENOENT` for a
 * bad *cwd* is indistinguishable from its `ENOENT` for a missing *binary* —
 * which is how a folder typo ends up reported as a libc mismatch. A picker
 * cannot produce a path that is not there.
 *
 * The dialog's title and button text are the main process's to choose. The
 * renderer supplies no user-visible copy for a native OS window.
 */
export interface WorkspacePickDirectoryRequest {
  /**
   * Where the picker opens. Must be absolute. Ignored by the OS when it does
   * not exist, so passing the current working directory is always safe.
   */
  readonly defaultPath?: string;
}

export interface WorkspacePickDirectoryResponse {
  /**
   * The chosen directory, absolute and verified to exist, or `null` when the
   * user cancelled. Cancelling is an ordinary outcome, not an error: the result
   * is still `ok`.
   */
  readonly path: string | null;
}

/**
 * What is this directory, in the terms a person names it by?
 *
 * The sidebar heads its session list with the name of the thing being worked
 * on, and for anyone who works in repositories that name is the repository's,
 * not the directory's: sitting in `~/code/artemis/apps/desktop` you are working
 * on *artemis*, and a header reading "desktop" answers a question nobody asked.
 * The renderer cannot work this out — it has no `fs` and no way to look upward
 * from a path — so it asks.
 *
 * Cheap by construction: it walks parent directories looking for `.git` and
 * stops. No subprocess, no `git` on the PATH required, no repository parsing.
 */
export interface WorkspaceDescribeRequest {
  /** Absolute path to describe. */
  readonly path: string;
}

export interface WorkspaceDescribeResponse {
  /** The path as asked about, echoed so a late reply can be matched to it. */
  readonly path: string;
  /**
   * The directory's own name — its last segment. Always present, and the
   * fallback the UI uses when there is no repository.
   */
  readonly name: string;
  /**
   * Absolute path to the root of the repository containing {@link path}, when
   * there is one. Equal to `path` when it is itself the root.
   */
  readonly repoRoot?: string;
  /**
   * What to call that repository: the last segment of {@link repoRoot}.
   *
   * The directory name rather than a remote's — an `origin` URL is a fact about
   * where the code is *pushed*, which is neither what the user calls the
   * project nor reliably present, and a fork would make every sibling checkout
   * read as the upstream. A linked worktree therefore reports its own name,
   * which is the useful answer: two checkouts of one repository are two
   * different things to be working in, and the sidebar is naming a place.
   */
  readonly repoName?: string;
}

/** Open one stored session. */
export interface SessionsMessagesRequest {
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  /** Run id to stamp replayed events with, so they join one transcript. */
  readonly runId: RunId;
  readonly cwd?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SessionsMessagesResponse {
  /** The same event shape a live run emits — one rendering path, not two. */
  readonly events: readonly AgentEvent[];
  readonly hasMore: boolean;
}

/** Which profile's plan to report on. Plan limits belong to an account. */
/**
 * A profile's login state, as reported by the provider's own CLI.
 *
 * Artemis never sees a credential: the provider's login writes into the profile's
 * isolated config directory, and this is the only view of what landed there.
 * Every field past `loggedIn` is optional because a signed-out directory has
 * none of them, and because which ones appear depends on the login method.
 */
export interface AuthStatusInfo {
  readonly loggedIn: boolean;
  /** `claude.ai` for a subscription, `console` for API billing, `none` signed out. */
  readonly authMethod?: string;
  /** Shown so two accounts can be told apart. */
  readonly email?: string;
  readonly orgName?: string;
  /** `pro`, `max`, `team`, `enterprise` — absent on Console logins. */
  readonly subscriptionType?: string;
  /**
   * Set when the status could not be read *at all*.
   *
   * Distinct from `loggedIn: false`, which is a successful read of a signed-out
   * directory. Collapsing the two would report a broken CLI as "signed out" and
   * send the user to a login that cannot work.
   */
  readonly error?: string;
}

export interface AuthStatusRequest {
  readonly profileId: ProfileId;
}

export interface AuthSignOutRequest {
  readonly profileId: ProfileId;
}

/** Every auth channel answers with the resulting state, so the UI never guesses. */
export interface AuthStatusResponse {
  readonly status: AuthStatusInfo;
  /**
   * The shell command that signs this profile in, ready to copy.
   *
   * Carried on the *status* response rather than fetched separately because the
   * screen needs both answers at once — "are you signed in, and if not, what do
   * I run?" — and because composing it requires the provider's argv and its
   * config-directory variable, neither of which the renderer can see.
   *
   * Present even when signed in: it is what a user re-runs to switch the
   * account behind an existing profile.
   */
  readonly signInCommand: string;
}

export interface UsagePlanRequest {
  readonly profileId: ProfileId;
}

export interface UsagePlanResponse {
  /**
   * The snapshot, or `null` when nothing has been fetched for this profile yet.
   *
   * `null` from `cached` is the ordinary cold-start case, not a failure — the
   * UI should show a loading state and wait for `refresh`. A snapshot whose
   * `available` is false is a different thing again: the fetch succeeded and
   * the answer is "this profile has no plan limits".
   */
  readonly usage: PlanUsage | null;
}

/* -------------------------------------------------------------------------- */
/* Channel → payload maps                                                     */
/* -------------------------------------------------------------------------- */

/** Request payload for each channel. */
export type IpcRequestMap = {
  [IPC.profilesList]: ProfilesListRequest;
  [IPC.profilesCreate]: ProfilesCreateRequest;
  [IPC.profilesUpdate]: ProfilesUpdateRequest;
  [IPC.profilesDelete]: ProfilesDeleteRequest;
  [IPC.profilesSuggestDir]: ProfilesSuggestDirRequest;
  [IPC.providersList]: ProvidersListRequest;
  [IPC.providersModels]: ProvidersModelsRequest;
  [IPC.runsStart]: RunsStartRequest;
  [IPC.runsSend]: RunsSendRequest;
  [IPC.runsInterrupt]: RunsInterruptRequest;
  [IPC.runsRespondPermission]: RunsRespondPermissionRequest;
  [IPC.runsDispose]: RunsDisposeRequest;
  [IPC.runsList]: RunsListRequest;
  [IPC.sessionsList]: SessionsListRequest;
  [IPC.sessionsListAll]: SessionsListAllRequest;
  [IPC.workspacePickDirectory]: WorkspacePickDirectoryRequest;
  [IPC.workspaceDescribe]: WorkspaceDescribeRequest;
  [IPC.sessionsMessages]: SessionsMessagesRequest;
  [IPC.sessionsRename]: SessionsRenameRequest;
  [IPC.sessionsDelete]: SessionsDeleteRequest;
  [IPC.usagePlanCached]: UsagePlanRequest;
  [IPC.usagePlanRefresh]: UsagePlanRequest;
  [IPC.authStatus]: AuthStatusRequest;
  [IPC.authSignOut]: AuthSignOutRequest;
};

/** Success payload for each channel — the `value` inside {@link IpcOk}. */
export type IpcResponseMap = {
  [IPC.profilesList]: ProfilesListResponse;
  [IPC.profilesCreate]: ProfilesCreateResponse;
  [IPC.profilesUpdate]: ProfilesUpdateResponse;
  [IPC.profilesDelete]: ProfilesDeleteResponse;
  [IPC.profilesSuggestDir]: ProfilesSuggestDirResponse;
  [IPC.providersList]: ProvidersListResponse;
  [IPC.providersModels]: ProvidersModelsResponse;
  [IPC.runsStart]: RunsStartResponse;
  [IPC.runsSend]: RunsSendResponse;
  [IPC.runsInterrupt]: RunsInterruptResponse;
  [IPC.runsRespondPermission]: RunsRespondPermissionResponse;
  [IPC.runsDispose]: RunsDisposeResponse;
  [IPC.runsList]: RunsListResponse;
  [IPC.sessionsList]: SessionsListResponse;
  [IPC.sessionsListAll]: SessionsListAllResponse;
  [IPC.workspacePickDirectory]: WorkspacePickDirectoryResponse;
  [IPC.workspaceDescribe]: WorkspaceDescribeResponse;
  [IPC.sessionsMessages]: SessionsMessagesResponse;
  [IPC.sessionsRename]: SessionsRenameResponse;
  [IPC.sessionsDelete]: SessionsDeleteResponse;
  [IPC.usagePlanCached]: UsagePlanResponse;
  [IPC.usagePlanRefresh]: UsagePlanResponse;
  [IPC.authStatus]: AuthStatusResponse;
  [IPC.authSignOut]: AuthStatusResponse;
};

/** Request type for a channel. */
export type IpcRequest<C extends IpcChannel> = IpcRequestMap[C];

/** Success payload type for a channel. */
export type IpcResponse<C extends IpcChannel> = IpcResponseMap[C];

/** What a handler resolves for a channel. */
export type IpcHandlerResult<C extends IpcChannel> = IpcResult<IpcResponseMap[C]>;

/**
 * Signature of a main-process handler.
 *
 * Deliberately has no `IpcMainInvokeEvent` parameter: `@rx-artemis/protocol` has
 * zero dependencies and must never import electron. The main process wraps
 * these when it registers them.
 */
export type IpcHandler<C extends IpcChannel> = (
  request: IpcRequestMap[C],
) => Promise<IpcHandlerResult<C>>;

/** A full set of handlers, one per channel. Use it to prove none was forgotten. */
export type IpcHandlerMap = { [C in IpcChannel]: IpcHandler<C> };

/** Payload carried by each push channel. */
export type IpcPushMap = {
  [IPC_PUSH.agentEvent]: AgentEvent;
};

/** Payload type for a push channel. */
export type IpcPush<C extends IpcPushChannel> = IpcPushMap[C];

/* -------------------------------------------------------------------------- */
/* The preload bridge                                                         */
/* -------------------------------------------------------------------------- */

/** Removes a previously registered listener. */
export type Unsubscribe = () => void;

/**
 * The object the preload script exposes as `window.artemis`.
 *
 * This is the renderer's entire view of the outside world. If a capability is
 * not on this interface, the renderer does not have it — no `require`, no
 * `ipcRenderer`, no `process`. `contextIsolation` stays on and
 * `nodeIntegration` stays off.
 *
 * The renderer declares the global itself, so that main-process code compiling
 * against this package does not acquire a bogus `Window`:
 *
 * ```ts
 * // apps/desktop/renderer/src/global.d.ts
 * import type { ArtemisBridge } from '@rx-artemis/protocol'
 * declare global {
 *   interface Window { readonly artemis: ArtemisBridge }
 * }
 * ```
 */
export interface ArtemisBridge {
  /** Artemis's version, for the about panel and bug reports. */
  readonly version: string;
  /** Host platform, so the UI can render the right modifier keys. */
  readonly platform: 'darwin' | 'win32' | 'linux';

  readonly profiles: {
    list(request: ProfilesListRequest): Promise<IpcResult<ProfilesListResponse>>;
    create(request: ProfilesCreateRequest): Promise<IpcResult<ProfilesCreateResponse>>;
    update(request: ProfilesUpdateRequest): Promise<IpcResult<ProfilesUpdateResponse>>;
    remove(request: ProfilesDeleteRequest): Promise<IpcResult<ProfilesDeleteResponse>>;
    /**
     * A config-directory path to prefill the create form with.
     *
     * Exists so the renderer never has to know how Artemis lays out its own
     * user-data directory — a layout it cannot see and should not encode.
     */
    suggestDir(
      request: ProfilesSuggestDirRequest,
    ): Promise<IpcResult<ProfilesSuggestDirResponse>>;
  };

  readonly providers: {
    list(request: ProvidersListRequest): Promise<IpcResult<ProvidersListResponse>>;
    /**
     * The live model catalogue for one profile, with the built-in list as a
     * fallback.
     *
     * Kept off {@link list} because it spawns a provider subprocess: the
     * descriptor call must stay instant. Resolves `{ live: false }` rather
     * than failing when the provider cannot be reached, so the model picker
     * always has something to render — check `value.live`, not `res.ok`, to
     * find out whether the account confirmed the list.
     */
    models(request: ProvidersModelsRequest): Promise<IpcResult<ProvidersModelsResponse>>;
  };

  readonly runs: {
    start(request: RunsStartRequest): Promise<IpcResult<RunsStartResponse>>;
    send(request: RunsSendRequest): Promise<IpcResult<RunsSendResponse>>;
    interrupt(request: RunsInterruptRequest): Promise<IpcResult<RunsInterruptResponse>>;
    respondToPermission(
      request: RunsRespondPermissionRequest,
    ): Promise<IpcResult<RunsRespondPermissionResponse>>;
    dispose(request: RunsDisposeRequest): Promise<IpcResult<RunsDisposeResponse>>;
    list(request: RunsListRequest): Promise<IpcResult<RunsListResponse>>;
    /**
     * Subscribe to the live event feed for every run. Call this before
     * {@link start}; events can arrive before the start response resolves.
     */
    onEvent(listener: (event: AgentEvent) => void): Unsubscribe;
  };

  readonly sessions: {
    /** One profile's history in one working directory. */
    list(request: SessionsListRequest): Promise<IpcResult<SessionsListResponse>>;
    /**
     * Every profile's history, in every project it has ever run in. Entries
     * carry `cwd` and `profileId`, which is everything a grouped, labelled
     * sidebar needs.
     */
    listAll(request: SessionsListAllRequest): Promise<IpcResult<SessionsListAllResponse>>;
    /**
     * Open a stored session, replayed as events.
     *
     * Without this, selecting a session resumes it against an empty
     * transcript: the agent holds the whole conversation, the user sees none.
     */
    messages(request: SessionsMessagesRequest): Promise<IpcResult<SessionsMessagesResponse>>;
    /**
     * Retitle a stored session, in the transcript itself.
     *
     * Gated on the `renameSession` capability — a provider that cannot write
     * titles will reject this rather than silently doing nothing.
     */
    rename(request: SessionsRenameRequest): Promise<IpcResult<SessionsRenameResponse>>;
    /**
     * Destroy a stored session's transcript on disk. Irreversible.
     *
     * Gated on the `deleteSession` capability. See
     * {@link SessionsDeleteRequest} for what this does and does not cover.
     */
    delete(request: SessionsDeleteRequest): Promise<IpcResult<SessionsDeleteResponse>>;
  };

  readonly workspace: {
    /**
     * Open the OS directory picker.
     *
     * Resolves `{ path: null }` when the user cancels — that is a success, not
     * a failure, so check `res.value.path` rather than `res.ok` for it.
     */
    pickDirectory(
      request: WorkspacePickDirectoryRequest,
    ): Promise<IpcResult<WorkspacePickDirectoryResponse>>;

    /**
     * Name a directory — its own name, and its repository's when it is in one.
     *
     * A read with no side effects and no subprocess, so the renderer may call
     * it whenever the working directory changes.
     */
    describe(request: WorkspaceDescribeRequest): Promise<IpcResult<WorkspaceDescribeResponse>>;
  };

  /**
   * Plan usage, split into a cheap read and an expensive refresh.
   *
   * The split is the whole point: a refresh spawns a provider subprocess and
   * takes a second or two, which is far too slow to block a popover on. The UI
   * renders {@link cached} immediately and swaps in {@link refresh} when it
   * lands, so opening the meter is instant and never shows an empty frame.
   */
  readonly usagePlan: {
    /** Last stored snapshot, or null if this profile has never been fetched. */
    cached(request: UsagePlanRequest): Promise<IpcResult<UsagePlanResponse>>;
    /** Fetch from the provider and store the result. Costs no tokens. */
    refresh(request: UsagePlanRequest): Promise<IpcResult<UsagePlanResponse>>;
  };

  /**
   * Per-profile authentication — two reads and no write.
   *
   * There is no `signIn` here, and its absence is the design. The user runs the
   * provider's own login in their own terminal, against the config directory
   * this profile names; Artemis's entire part is to hand them the command and
   * poll {@link status} until it changes. Nothing on this surface accepts a key
   * or a token, because nothing in Artemis has anywhere to put one.
   */
  readonly auth: {
    /** Read the profile's current login state. Cheap; safe to poll on mount. */
    status(request: AuthStatusRequest): Promise<IpcResult<AuthStatusResponse>>;
    /** Clear the credentials in this profile's config directory. */
    signOut(request: AuthSignOutRequest): Promise<IpcResult<AuthStatusResponse>>;
  };
}

/* -------------------------------------------------------------------------- */
/* Envelope helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Wrap a value as a successful result. */
export function ipcOk<T>(value: T): IpcOk<T> {
  return { ok: true, value };
}

/** Wrap an error as a failed result. */
export function ipcFail(error: IpcError): IpcFail {
  return { ok: false, error };
}
