/**
 * The IPC contract.
 *
 * Channel names, a typed request/response map, and the shape the preload script
 * exposes on `window.artemis`. Main and renderer both compile against this file,
 * so a mismatch is a build error rather than a runtime surprise.
 *
 * Two structural decisions worth understanding before you extend this:
 *
 *  1. **Everything is request/response over `invoke`, except what only main can
 *     observe.** Two things qualify, and both are one-directional: agent
 *     events, which are high-frequency, and the window's own chrome state,
 *     which the renderer cannot see at all. Each gets a push channel
 *     ({@link IPC_PUSH}) instead of a round-trip.
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

import type { AgentPromptsDocument } from './agentPrompts.js';
import type { AgentEvent } from './events.js';
import type { AgentError } from './errors.js';
import type { Attachment } from './attachment.js';
import type { PermissionDecision } from './permissions.js';
import type { PermissionRequestId, ProfileId, RunId, SessionId } from './ids.js';
import type { ProfileDraft, ProfileMetadata, ProfilePatch } from './profile.js';
import type { ProviderDescriptor, ProviderId, ProviderModelOption } from './provider.js';
import type { RunHandle, RunInput } from './run.js';
import type { SessionSummary } from './session.js';
import type { SharedConfigStatus } from './sharedConfig.js';
import type {
  TerminalCloseRequest,
  TerminalCloseResponse,
  TerminalEvent,
  TerminalListRequest,
  TerminalListResponse,
  TerminalReplayRequest,
  TerminalReplayResponse,
  TerminalResizeRequest,
  TerminalResizeResponse,
  TerminalStartRequest,
  TerminalStartResponse,
  TerminalWriteRequest,
  TerminalWriteResponse,
} from './terminal.js';
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
  /** Stop one delegated task, leaving the run alone. */
  runsStopTask: 'artemis:runs:stop-task',
  /** Answer an outstanding permission request. */
  runsRespondPermission: 'artemis:runs:respond-permission',
  /** Tear a run down and release its resources. */
  runsDispose: 'artemis:runs:dispose',
  /** Re-sync live runs after a renderer reload. */
  runsList: 'artemis:runs:list',
  /** Replay one run's retained events, for a window that was not there to hear them. */
  runsEvents: 'artemis:runs:events',

  /** List historical sessions for a provider + profile + cwd. */
  sessionsList: 'artemis:sessions:list',
  /** List historical sessions across every profile and every project. */
  sessionsListAll: 'artemis:sessions:list-all',

  /** Ask the OS for a directory, via a native picker. */
  workspacePickDirectory: 'artemis:workspace:pick-directory',
  /** Name a directory: its own name, and its repository's when it has one. */
  workspaceDescribe: 'artemis:workspace:describe',

  /**
   * Read which of each Claude profile's shared entries are actually symlinked
   * into `~/.claude`.
   *
   * The only channel whose whole purpose is to contradict a stored preference.
   * `sharedClaudeConfig` records that the user asked for the arrangement; the
   * script that performs it runs in a terminal Artemis never sees, so nothing
   * else in the app can tell a share that happened from one that was read and
   * closed. This is `lstat`, and nothing but `lstat` — see
   * {@link SharedConfigStatusRequest} for why it takes no arguments at all.
   */
  sharedConfigStatus: 'artemis:shared-config:status',

  /**
   * Make a file the agent wrote renderable, and say where to render it from.
   *
   * One channel, and no `close` counterpart: closing a preview is the renderer
   * dropping a frame, which needs main's permission for nothing. What main
   * retains it retires on its own — see `preview.ts`.
   */
  previewOpen: 'artemis:preview:open',

  /**
   * A shell in a pseudo-terminal, and the four things you can do to one.
   *
   * Six channels rather than the preview's one, because a terminal is the only
   * thing in this contract that is genuinely *bidirectional and long-lived*: it
   * is opened, written to, resized as its pane changes shape, and eventually
   * killed. Output comes back the other way on {@link IPC_PUSH.terminalEvent}.
   *
   * Every one but `start` names a terminal by an id main issued, and main
   * resolves that id against its own registry before doing anything — see
   * `./terminal.js`.
   */
  terminalStart: 'artemis:terminal:start',
  terminalWrite: 'artemis:terminal:write',
  terminalResize: 'artemis:terminal:resize',
  /** Kill the shell. The only thing that does; see `TerminalCloseRequest`. */
  terminalClose: 'artemis:terminal:close',
  /**
   * The reload pair, matching `runsList`/`runsEvents`.
   *
   * A renderer that has just been recreated has no idea which terminals it was
   * showing, and the shells carried on without it. `list` says what exists;
   * `replay` hands back the retained tail so a reattached tab is not blank.
   */
  terminalList: 'artemis:terminal:list',
  terminalReplay: 'artemis:terminal:replay',

  /** One stored session's messages, replayed as events. */
  sessionsMessages: 'artemis:sessions:messages',

  /**
   * One *subagent's* messages, replayed as events.
   *
   * A separate channel rather than a flag on {@link IPC.sessionsMessages},
   * because it reads a different file: a subagent keeps its own transcript
   * beside its parent's, and the parent's contains almost none of it — the
   * delegating session sees the final report and nothing of the work. That
   * asymmetry is the whole reason this exists, and it is why a `Task` row can
   * be opened into a readable conversation at all.
   */
  sessionsSubagentMessages: 'artemis:sessions:subagent-messages',

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

  /**
   * Window chrome.
   *
   * Artemis draws its own title bar, so the four things a native one would have
   * done have to be reachable from the renderer. Each acts on the window the
   * message came from — see {@link WindowRequest} for why none of them names a
   * window.
   */
  windowMinimize: 'artemis:window:minimize',
  /** Maximize, or restore a maximized window. One channel, because it is one button. */
  windowToggleMaximize: 'artemis:window:toggle-maximize',
  windowClose: 'artemis:window:close',
  /** Read the window's chrome state, for the first paint. */
  windowState: 'artemis:window:state',

  /**
   * App updates.
   *
   * Four channels and no configuration surface: the renderer can read the
   * updater's state, ask it to install what it found, restart into what was
   * installed, and silence one version.
   * Where updates come from, how they are fetched and how the bundle is swapped
   * are the main process's business alone — the renderer never sees a URL, a
   * path or a checksum.
   */
  updatesState: 'artemis:updates:state',
  updatesInstall: 'artemis:updates:install',
  updatesRestart: 'artemis:updates:restart',
  updatesDismiss: 'artemis:updates:dismiss',

  /**
   * Cerebro — the team's shared, agent-maintained memory bank.
   *
   * Six channels and not one of them names a path or a binary: main owns the
   * repo location and the CLI inside it, so the renderer can no more aim these
   * at the filesystem than it can pick the program a terminal runs. Everything
   * here is a thin seam over `bin/cerebro`, the single-file CLI that lives *in*
   * the bank's own repository — reimplementing its logic in Artemis would mean
   * two implementations of one contract drifting apart, and the CLI updates
   * itself with the bank (`sync` fast-forwards the clone the CLI ships in).
   *
   * `setup` is the whole onboarding story: clone if missing, `enable` the
   * profiles, `sync` once. Idempotent, so the pane can offer it without
   * tracking state of its own. The write channels (`draft`, `retire`) do not
   * write to the bank directly — they queue and land changes through the same
   * validated, PR-gated path the agents use, which is why their response is a
   * message rather than data: the outcome is a commit or a pull request, not
   * a mutation the renderer should pretend it can see.
   */
  cerebroStatus: 'artemis:cerebro:status',
  cerebroList: 'artemis:cerebro:list',
  /**
   * Can this machine run the bank at all?
   *
   * Separate from {@link cerebroStatus} because it has to answer *before*
   * there is a bank: status shells out to a CLI that only exists once the
   * repo is cloned, and the interesting failures — no git, no git identity,
   * no access to a private repository — all happen before that. Setup used
   * to discover them by failing halfway through a clone.
   */
  cerebroPreflight: 'artemis:cerebro:preflight',
  cerebroSetup: 'artemis:cerebro:setup',
  cerebroSync: 'artemis:cerebro:sync',
  cerebroDraft: 'artemis:cerebro:draft',
  cerebroRetire: 'artemis:cerebro:retire',
  /**
   * The standing-instruction library.
   *
   * Two channels, and `save` takes the whole document rather than one prompt.
   * The pane edits a *list* — a body retyped, a row reordered, a scope
   * unticked, a prompt deleted — and per-prompt channels would turn each of
   * those into its own request and its own way to leave the stored order
   * disagreeing with the one on screen. One document in, one document out, and
   * the response is what actually landed rather than an echo: main re-derives
   * the library's invariants on write (built-ins present, their text not
   * stored), so the answer can differ from the request and the pane should take
   * the answer.
   */
  agentPromptsList: 'artemis:agent-prompts:list',
  agentPromptsSave: 'artemis:agent-prompts:save',
} as const;

/**
 * Payload for {@link IPC_PUSH.menuOpenSettings}.
 *
 * Carries no data — the ask *is* the whole message. It is an object with a
 * discriminator rather than `undefined` so the preload's guard has something to
 * check: a channel whose validator accepts anything is a channel that cannot
 * tell a real push from a stray one.
 */
export interface MenuOpenSettings {
  readonly kind: 'open-settings';
}

/**
 * Main → renderer push channels, used with `webContents.send` /
 * `ipcRenderer.on`.
 */
export const IPC_PUSH = {
  /** Carries a single {@link AgentEvent}. The renderer's whole live feed. */
  agentEvent: 'artemis:push:agent-event',
  /**
   * Carries a {@link WindowState} whenever the window's chrome state changes.
   *
   * Pushed rather than polled because the renderer has no way to observe any of
   * it. The alternative — re-reading {@link IPC.windowState} on every `resize`
   * — puts an IPC round-trip on each frame of a drag-resize to keep one icon
   * correct, and still lags behind the window.
   */
  windowState: 'artemis:push:window-state',
  /**
   * Carries one profile's {@link PlanUsage} each time the poller re-reads it.
   *
   * Pushed rather than polled from the renderer, and that is the whole reason
   * the channel exists. Every reading spawns the provider's CLI, so a renderer
   * that polled would spawn one subprocess per profile per window — the second
   * Artemis window would double the machine's load to show the same numbers.
   * One poller in main, fanned out to whoever is open.
   *
   * @see PlanUsagePush
   */
  planUsage: 'artemis:push:plan-usage',
  /**
   * Carries an {@link UpdateState} whenever the updater's state changes.
   *
   * Pushed rather than polled because everything interesting happens while the
   * renderer is not asking: the periodic check that finds a new version, the
   * download that finishes, the swap that fails. The pull channel
   * ({@link IPC.updatesState}) exists only for the first paint.
   */
  updateState: 'artemis:push:update-state',
  /**
   * Carries a single {@link TerminalEvent} — output, or a child that has ended.
   *
   * One channel for every terminal, demultiplexed on `event.id`, for exactly the
   * reason {@link agentEvent} gives: a channel per terminal would mean the
   * preload composing channel names from renderer input, and the set of
   * reachable channels would stop being readable in one screen.
   *
   * Pushed rather than polled because this is the one stream in the app the
   * renderer cannot ask for at the right moment — output arrives when a program
   * decides to print, not when a component renders.
   */
  terminalEvent: 'artemis:push:terminal-event',
  /**
   * Asks the renderer to open Settings, because the macOS menu bar was clicked.
   *
   * A push rather than a pull for the reason every item on this list is one:
   * the renderer has no way to observe a click on a menu it does not draw. The
   * menu lives in main because on macOS the application menu is the app's, not
   * the window's — see `main/menu.ts`.
   *
   * Broadcast to every window, like the rest of this list. Two Artemis windows
   * both landing on Settings is the honest reading of an app-level menu item:
   * the click was at the app, not at one window. The alternative — routing to
   * the focused window — would make the item do nothing at all when the click
   * arrives with no window focused, which is exactly when someone reaching for
   * the menu bar needs it.
   */
  menuOpenSettings: 'artemis:push:menu-open-settings',
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

/**
 * Stop one piece of delegated work.
 *
 * Addressed by run *and* task, though the task id is unique on its own: the run
 * is how the main process finds the provider process holding it, and carrying it
 * means a stop cannot be aimed at another window's conversation by guessing an
 * id.
 */
export interface RunsStopTaskRequest {
  readonly runId: RunId;
  readonly taskId: string;
}

export interface RunsStopTaskResponse {
  readonly runId: RunId;
  readonly taskId: string;
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

/**
 * Everything a run has emitted that the registry still holds.
 *
 * The counterpart to {@link RunsListRequest} for a window that reloaded: `list`
 * says *which* runs are still going, this says *what they have said*. Without
 * it a re-attached run streams its next token into an empty transcript, and the
 * work the user was watching is only recoverable by waiting for it to finish
 * and reopening it from history.
 */
export interface RunsEventsRequest {
  readonly runId: RunId;
  /**
   * Only events numbered above this. Omit for everything still retained.
   *
   * A window that already saw the first half of a run passes the highest `seq`
   * it applied, so re-attaching costs one page rather than the whole run.
   */
  readonly afterSeq?: number;
}

export interface RunsEventsResponse {
  readonly runId: RunId;
  /** In `seq` order, oldest first. Empty for a run the registry has forgotten. */
  readonly events: readonly AgentEvent[];
  /**
   * True when the registry's buffer had already dropped events the caller asked
   * for, so the replay starts mid-run.
   *
   * The caller is expected to say so rather than present a partial transcript as
   * a whole one — a conversation that silently begins in the middle is worse
   * than one that admits where it starts.
   */
  readonly truncated: boolean;
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
  /**
   * The project {@link path} belongs to, which is not always the place it is.
   *
   * {@link repoRoot} for an ordinary checkout and for a submodule. For a linked
   * worktree it is the checkout that worktree was split off from: a worktree of
   * Artemis is still Artemis, and the sidebar groups a session by the project it
   * was working on rather than by the directory the work happened in — otherwise
   * splitting a branch off for an afternoon files those sessions under a
   * repository the user has never heard of, and takes them out of the one they
   * belong to.
   *
   * Both answers are wanted at once, by different readers: the header names the
   * *place* (see {@link repoName} on why a worktree is named after itself) and
   * the session list groups by the *project*. Absent only when there is no
   * repository, where the directory itself is already the right answer.
   */
  readonly projectRoot?: string;
  /**
   * Is {@link repoRoot} a linked worktree rather than an ordinary checkout?
   *
   * Absent unless it is one. Nothing about naming turns on this — a worktree is
   * named after itself either way — but the recent-folders menu declines to
   * record one, because a worktree is made for a branch and deleted when that
   * branch lands, and a list of "where have I been lately" full of directories
   * that no longer exist is worse than one that never mentions them.
   *
   * Submodules also have a `.git` file and are deliberately *not* this: they
   * are a permanent place to be working.
   */
  readonly worktree?: boolean;
  /**
   * Is {@link path} inside the machine's temporary directory?
   *
   * Absent unless it is. The same reader and the same reason as
   * {@link worktree}, and reported separately because the two are independent:
   * a scratch checkout is often both, and most temporary directories are no
   * repository at all.
   *
   * Only the main process can answer it — `tmpdir()` is a fact about the
   * machine, and on macOS it names a per-user directory under `/var/folders`
   * rather than anything the renderer could recognise by sight.
   */
  readonly temporary?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Shared Claude config                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What is actually linked?
 *
 * Empty, and that is the interesting part of the design. The renderer does not
 * name a path, a profile, or an entry: the main process derives the directories
 * from the profile store with {@link sharedConfigDirs} and the names from
 * {@link SHARED_ENTRIES}, so this channel cannot be used to `lstat` anything the
 * user has not already registered as a Claude profile. A request that carried a
 * `dirs` array would be a general-purpose filesystem prober wearing a feature's
 * name.
 *
 * It also means the reading always covers exactly what the scripts cover. The
 * pane compares a reading against an intention, and a comparison between two
 * differently-derived lists would be worth nothing.
 *
 * Cheap enough to run on every open of the Advanced pane and behind a refresh
 * button: one `lstat` per shared name per profile, plus one per name on the root,
 * with no directory traversal anywhere. It is deliberately not polled — nothing
 * changes these paths but a script the user runs by hand.
 */
export type SharedConfigStatusRequest = Record<string, never>;

/**
 * The reading. See {@link SharedConfigStatus} — the response *is* the status,
 * flattened rather than nested under a key, the same way
 * {@link WorkspaceDescribeResponse} is.
 */
export type SharedConfigStatusResponse = SharedConfigStatus;

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Show me the page at this path.
 *
 * The renderer cannot read a file and would not be allowed to frame one if it
 * could: a `file:` URL in an iframe is refused by the renderer's own policy, and
 * loosening that policy to permit it would hand every path on the machine to a
 * page rendering model output. So it asks, and gets back a URL that serves
 * exactly one file and nothing else.
 */
export interface PreviewOpenRequest {
  /** Absolute path to an `.html`, `.htm`, `.svg`, `.md` or `.markdown` file. */
  readonly path: string;
}

/** What every preview carries, however it is shown. */
export interface PreviewBase {
  /** The file's own name, for the pane's caption. */
  readonly title: string;
  /** The path as asked about, echoed so the caption can say where it came from. */
  readonly path: string;
  /** Size of the snapshot, for the caption's detail line. */
  readonly bytes: number;
}

/**
 * A page to be framed: HTML or SVG, served from the preview scheme.
 *
 * The renderer never receives the markup. It gets a URL and hands it to a
 * sandboxed frame, which is what keeps a document that executes script out of
 * the renderer's own.
 */
export interface PreviewFrame extends PreviewBase {
  readonly kind: 'frame';
  /**
   * What to put in the frame's `src`. Single-use in spirit — it names a
   * snapshot main is holding, not the path — and stops resolving once enough
   * later previews have pushed it out.
   */
  readonly url: string;
}

/**
 * Markdown, as source, for the renderer's own pipeline.
 *
 * The opposite transport from {@link PreviewFrame}, and deliberately so.
 * Markdown is not a program: there is nothing in it to execute, so there is
 * nothing to sandbox, and sending the text is *stricter* than serving generated
 * HTML into a frame that permits inline script. It also means one markdown
 * renderer in the app rather than two. See `PreviewPane`.
 */
export interface PreviewMarkdown extends PreviewBase {
  readonly kind: 'markdown';
  /** The file's text, verbatim. */
  readonly text: string;
}

/**
 * How a preview arrives. Discriminated on `kind`, because the two are genuinely
 * different deliveries — a URL for a frame, or text to render in place — rather
 * than one shape with an unused field.
 */
export type PreviewOpenResponse = PreviewFrame | PreviewMarkdown;

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

/**
 * Open one subagent's conversation.
 *
 * The same locating fields a session read takes, plus the `agentId` — which is
 * the provider's **task id**, unchanged. That identity is what makes this
 * channel usable from a delegated-work row without any correlation table: the
 * row already carries the id, and the transcript on disk is named after it.
 *
 * `offset` is how a running agent is followed rather than re-read. The caller
 * holds the count it already has, asks for what comes after it, and appends —
 * so watching an agent work costs one page of new messages per poll instead of
 * the whole conversation each time.
 */
export interface SessionsSubagentMessagesRequest {
  readonly profileId: ProfileId;
  /** The *parent* session — the one that delegated. */
  readonly sessionId: SessionId;
  /** The subagent's id, which is the task id from `background.tasks`. */
  readonly agentId: string;
  /** Run id to stamp replayed events with, so they join one transcript. */
  readonly runId: RunId;
  readonly cwd?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SessionsSubagentMessagesResponse {
  /** The same event shape a live run emits — one rendering path, not two. */
  readonly events: readonly AgentEvent[];
  readonly hasMore: boolean;
  /**
   * How many stored messages were consumed to build `events`.
   *
   * Not `events.length`: one stored message becomes several events, or none at
   * all. The caller's next `offset` has to be counted in the provider's units,
   * and computing it from the events would drift out of step the first time a
   * message replayed as two blocks — which is most of them.
   */
  readonly consumed: number;
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

/**
 * One profile's freshly-read plan usage, pushed as the poller collects it.
 *
 * Per profile rather than a whole map, because the poller reads accounts one at
 * a time — batching them into a single message would hold the first result
 * until the last CLI answered, which on a machine with several accounts is the
 * difference between the menu being right now and being right in ten seconds.
 *
 * `usage` is never null here, unlike {@link UsagePlanResponse}: a push happens
 * *because* a reading landed. An account that has no plan limits pushes an
 * `available: false` snapshot, which is a fact worth having — it is what stops
 * the recommendation from ever naming it.
 */
export interface PlanUsagePush {
  readonly profileId: ProfileId;
  readonly usage: PlanUsage;
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
/* Window chrome                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every window channel's request, and deliberately empty.
 *
 * A window is not addressable from the renderer and must not become so. The
 * target is always the window the message arrived from, which the main process
 * reads off the sender — so there is no `windowId` for a compromised renderer to
 * iterate, and a second Artemis window cannot be closed by the first.
 *
 * Typed as `Record<string, never>` rather than an empty interface so that
 * passing a field is a compile error instead of a silently ignored one.
 */
export type WindowRequest = Record<string, never>;

/**
 * What the window's own chrome is doing.
 *
 * Three booleans because three booleans are what the header draws with, not
 * because that is all a window has. `minimized` is absent on purpose: a
 * minimized window is not rendering, so nothing could read it.
 */
export interface WindowState {
  /** True while the window fills its display's work area. Drives the restore icon. */
  readonly maximized: boolean;
  /**
   * True in native full screen.
   *
   * The header cares because macOS takes its traffic lights away in full
   * screen — they move to an overlay that slides down with the menu bar — so
   * the gutter reserved for them has to close, or the bar keeps a 76px hole
   * where three buttons used to be.
   */
  readonly fullScreen: boolean;
  /**
   * True while this is the active window. Chrome in a background window is
   * dimmed, the same way the platform dims its own.
   */
  readonly focused: boolean;
}

/**
 * The answer to every window channel: the state the window is in *now*.
 *
 * Commands reply with the resulting state rather than an acknowledgement, for
 * the reason the auth channels do — the UI is never left to assume its command
 * took. {@link IPC.windowClose} is the exception that proves it: its reply
 * races the window's destruction and will usually never arrive, so nothing
 * should be sequenced behind it.
 */
export interface WindowStateResponse {
  readonly state: WindowState;
}

/* -------------------------------------------------------------------------- */
/* Updates                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The two parameterless update requests. Empty for the reason
 * {@link WindowRequest} is: there is exactly one updater and nothing about it
 * is addressable, so a field here could only ever be a lie.
 */
export type UpdatesStateRequest = Record<string, never>;
/** @see UpdatesStateRequest */
export type UpdatesInstallRequest = Record<string, never>;
/** @see UpdatesStateRequest */
export type UpdatesRestartRequest = Record<string, never>;

/**
 * Silence the banner for one version.
 *
 * Carries the version rather than meaning "whatever is showing" so that a
 * dismiss racing a new offer cannot silence the wrong one: dismissing 0.3.0
 * in the same instant 0.4.0 arrives leaves 0.4.0 offered.
 */
export interface UpdatesDismissRequest {
  readonly version: string;
}

/**
 * Where the updater is in its life.
 *
 * One state object rather than a family of events, so the renderer's banner is
 * a pure function of the latest push and a missed transition costs nothing.
 *
 *  - `idle`        — nothing to say; the banner does not render.
 *  - `available`   — `version` is downloadable. The banner offers it.
 *  - `working`     — download / verify / swap in progress. One phase, because
 *                    the renderer draws all three the same way: a spinner and
 *                    a "don't quit yet". The steps are main's business.
 *  - `ready`       — installed, and *nothing more happens on its own*. The
 *                    swap has landed on disk, but the running process is the
 *                    old version and stays so until the user says restart —
 *                    or quits normally, in which case the next launch is the
 *                    new version anyway. The restart is the user's, never the
 *                    updater's.
 *  - `restarting`  — the user said restart; gone in a moment.
 *  - `error`       — the attempt failed and the app is untouched. `message`
 *                    says why, in words already safe to show.
 */
export interface UpdateState {
  readonly phase: 'idle' | 'available' | 'working' | 'ready' | 'restarting' | 'error';
  /** The version on offer (or being installed / failed), null when idle. */
  readonly version: string | null;
  /** Human-readable failure, null except when `phase` is `error`. */
  readonly message: string | null;
  /**
   * The release page, for the manual path when the in-place update cannot run
   * (no way to reach the feed, an app bundle that cannot be swapped). Null
   * whenever the automatic path is expected to work.
   */
  readonly releaseUrl: string | null;
}

/**
 * The answer to every update channel: the updater's state *now*. The same
 * contract as {@link WindowStateResponse} — commands reply with the resulting
 * state, so the banner never has to assume its command landed.
 */
export interface UpdatesStateResponse {
  readonly state: UpdateState;
}

/* -------------------------------------------------------------------------- */
/* Cerebro                                                                    */
/* -------------------------------------------------------------------------- */

/** The four kinds of memory the bank's own schema accepts. */
export const CEREBRO_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export type CerebroMemoryType = (typeof CEREBRO_MEMORY_TYPES)[number];

/**
 * One memory, as the bank's CLI reports it.
 *
 * `type` is a plain string rather than {@link CerebroMemoryType} on purpose:
 * this is a *reading* of files the bank validates on its own side, and a pane
 * that refused to list a memory because a future bank added a fifth type would
 * be hiding data to satisfy a stale union. The union constrains what Artemis
 * *writes* (see {@link CerebroDraftRequest}), not what it is willing to show.
 */
export interface CerebroMemory {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly body: string;
  /** ISO date the memory was added, when the frontmatter recorded one. */
  readonly added: string | null;
  readonly author: string | null;
}

/** One Artemis profile, as Cerebro sees it: wired in, or not yet. */
export interface CerebroProfileState {
  readonly name: string;
  readonly label: string;
  /** The managed block is present in the profile's CLAUDE.md. */
  readonly enabled: boolean;
  /** The SessionStart sync hook is installed in the profile's settings.json. */
  readonly hook: boolean;
}

/**
 * The bank's condition on this machine, in one reading.
 *
 * `installed: false` is a complete, renderable answer — the repo is not cloned
 * yet and every other field is at its zero value — because "not set up" is the
 * state the settings pane exists to fix, not an error to fail on.
 */
export interface CerebroStatus {
  readonly installed: boolean;
  readonly repoPath: string;
  readonly remote: string | null;
  /** Provenance stamp of the working tree, e.g. `cerebro@52a0a32`. */
  readonly source: string | null;
  readonly memories: number;
  readonly validationErrors: number;
  /** Projects whose Artemis memory currently carries the bank. */
  readonly projects: number;
  readonly profiles: readonly CerebroProfileState[];
}

/**
 * Empty for the same reason {@link SharedConfigStatusRequest} is: main derives
 * the repo path and the profile list itself, so this channel cannot be used to
 * probe a location the user did not already adopt as the team bank.
 */
export type CerebroStatusRequest = Record<string, never>;
export type CerebroStatusResponse = CerebroStatus;

/** Empty; see {@link CerebroStatusRequest}. */
export type CerebroListRequest = Record<string, never>;

/**
 * One thing the bank needs, and whether this machine has it.
 *
 * `remedy` is the whole point: a check that says "git identity: missing" and
 * stops has moved the user's problem, not solved it. Every non-`ok` state
 * carries the command or the action that fixes it.
 */
export interface CerebroCheck {
  readonly id: string;
  readonly label: string;
  /** `warn` is "works, but worse" (no `gh` → a branch to open by hand). `fail` blocks. */
  readonly state: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  readonly remedy: string | null;
}

export interface CerebroPreflight {
  /** No check failed. Setup may proceed; warnings are informational. */
  readonly ready: boolean;
  readonly checks: readonly CerebroCheck[];
}

/** Empty; main probes the machine, the renderer does not aim it. */
export type CerebroPreflightRequest = Record<string, never>;
export type CerebroPreflightResponse = CerebroPreflight;

export interface CerebroListResponse {
  readonly memories: readonly CerebroMemory[];
}

/** Empty; the clone URL and destination are main's alone. */
export type CerebroSetupRequest = Record<string, never>;

/**
 * What a Cerebro action has to say for itself — one line of CLI output.
 *
 * A message rather than structured data, because the interesting outcome
 * happens elsewhere: a commit in the bank's repo, a pull request on its
 * remote, a re-installed memory directory. The pane re-reads `status` and
 * `list` for the facts; this is the receipt.
 */
export interface CerebroActionResponse {
  readonly message: string;
}

export type CerebroSetupResponse = CerebroActionResponse;

/** Empty; syncing takes no aim. */
export type CerebroSyncRequest = Record<string, never>;
export type CerebroSyncResponse = CerebroActionResponse;

/**
 * A memory to queue and land through the bank's own gates.
 *
 * The one place the renderer supplies bank content — and it still lands
 * nothing itself: the CLI validates the draft (schema, secret scan, injection
 * lint) and then commits or opens a PR exactly as it does for an agent.
 * Re-using an existing name is the update path, by the bank's design.
 */
export interface CerebroDraftRequest {
  /** Kebab-case slug; becomes the filename. */
  readonly name: string;
  readonly type: CerebroMemoryType;
  /** One line answering "when is this relevant?". */
  readonly description: string;
  readonly body: string;
}

export type CerebroDraftResponse = CerebroActionResponse;

/** Remove a memory through the same gates a promotion goes through. */
export interface CerebroRetireRequest {
  readonly name: string;
  /** Short reason recorded in the commit message. */
  readonly reason?: string;
}

export type CerebroRetireResponse = CerebroActionResponse;

/* -------------------------------------------------------------------------- */
/* Agent prompts                                                              */
/* -------------------------------------------------------------------------- */

/** Empty; the library is per-machine and main knows where it is. */
export type AgentPromptsListRequest = Record<string, never>;

/**
 * The library as stored.
 *
 * Includes the built-in rows, with their `markdown` empty — the text belongs to
 * {@link BUILT_IN_AGENT_PROMPTS} and the renderer already has it. Sending it
 * over the wire as well would put a second copy in play whose only possible
 * contribution is to be out of date.
 */
export interface AgentPromptsListResponse {
  readonly document: AgentPromptsDocument;
}

/** Replace the library. */
export interface AgentPromptsSaveRequest {
  readonly document: AgentPromptsDocument;
}

/**
 * What landed — not what was asked for. See the channel comment: main restores
 * the library's invariants on the way in, so a save can legitimately answer
 * with a document that differs from the request, and a pane that assumed
 * otherwise would show state the disk does not have.
 */
export type AgentPromptsSaveResponse = AgentPromptsListResponse;

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
  [IPC.runsStopTask]: RunsStopTaskRequest;
  [IPC.runsRespondPermission]: RunsRespondPermissionRequest;
  [IPC.runsDispose]: RunsDisposeRequest;
  [IPC.runsList]: RunsListRequest;
  [IPC.runsEvents]: RunsEventsRequest;
  [IPC.sessionsList]: SessionsListRequest;
  [IPC.sessionsListAll]: SessionsListAllRequest;
  [IPC.workspacePickDirectory]: WorkspacePickDirectoryRequest;
  [IPC.workspaceDescribe]: WorkspaceDescribeRequest;
  [IPC.sharedConfigStatus]: SharedConfigStatusRequest;
  [IPC.previewOpen]: PreviewOpenRequest;
  [IPC.terminalStart]: TerminalStartRequest;
  [IPC.terminalWrite]: TerminalWriteRequest;
  [IPC.terminalResize]: TerminalResizeRequest;
  [IPC.terminalClose]: TerminalCloseRequest;
  [IPC.terminalList]: TerminalListRequest;
  [IPC.terminalReplay]: TerminalReplayRequest;
  [IPC.sessionsMessages]: SessionsMessagesRequest;
  [IPC.sessionsSubagentMessages]: SessionsSubagentMessagesRequest;
  [IPC.sessionsRename]: SessionsRenameRequest;
  [IPC.sessionsDelete]: SessionsDeleteRequest;
  [IPC.usagePlanCached]: UsagePlanRequest;
  [IPC.usagePlanRefresh]: UsagePlanRequest;
  [IPC.authStatus]: AuthStatusRequest;
  [IPC.authSignOut]: AuthSignOutRequest;
  [IPC.windowMinimize]: WindowRequest;
  [IPC.windowToggleMaximize]: WindowRequest;
  [IPC.windowClose]: WindowRequest;
  [IPC.windowState]: WindowRequest;
  [IPC.updatesState]: UpdatesStateRequest;
  [IPC.updatesInstall]: UpdatesInstallRequest;
  [IPC.updatesRestart]: UpdatesRestartRequest;
  [IPC.updatesDismiss]: UpdatesDismissRequest;
  [IPC.cerebroStatus]: CerebroStatusRequest;
  [IPC.cerebroList]: CerebroListRequest;
  [IPC.cerebroPreflight]: CerebroPreflightRequest;
  [IPC.cerebroSetup]: CerebroSetupRequest;
  [IPC.cerebroSync]: CerebroSyncRequest;
  [IPC.cerebroDraft]: CerebroDraftRequest;
  [IPC.cerebroRetire]: CerebroRetireRequest;
  [IPC.agentPromptsList]: AgentPromptsListRequest;
  [IPC.agentPromptsSave]: AgentPromptsSaveRequest;
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
  [IPC.runsStopTask]: RunsStopTaskResponse;
  [IPC.runsRespondPermission]: RunsRespondPermissionResponse;
  [IPC.runsDispose]: RunsDisposeResponse;
  [IPC.runsList]: RunsListResponse;
  [IPC.runsEvents]: RunsEventsResponse;
  [IPC.sessionsList]: SessionsListResponse;
  [IPC.sessionsListAll]: SessionsListAllResponse;
  [IPC.workspacePickDirectory]: WorkspacePickDirectoryResponse;
  [IPC.workspaceDescribe]: WorkspaceDescribeResponse;
  [IPC.sharedConfigStatus]: SharedConfigStatusResponse;
  [IPC.previewOpen]: PreviewOpenResponse;
  [IPC.terminalStart]: TerminalStartResponse;
  [IPC.terminalWrite]: TerminalWriteResponse;
  [IPC.terminalResize]: TerminalResizeResponse;
  [IPC.terminalClose]: TerminalCloseResponse;
  [IPC.terminalList]: TerminalListResponse;
  [IPC.terminalReplay]: TerminalReplayResponse;
  [IPC.sessionsMessages]: SessionsMessagesResponse;
  [IPC.sessionsSubagentMessages]: SessionsSubagentMessagesResponse;
  [IPC.sessionsRename]: SessionsRenameResponse;
  [IPC.sessionsDelete]: SessionsDeleteResponse;
  [IPC.usagePlanCached]: UsagePlanResponse;
  [IPC.usagePlanRefresh]: UsagePlanResponse;
  [IPC.authStatus]: AuthStatusResponse;
  [IPC.authSignOut]: AuthStatusResponse;
  [IPC.windowMinimize]: WindowStateResponse;
  [IPC.windowToggleMaximize]: WindowStateResponse;
  [IPC.windowClose]: WindowStateResponse;
  [IPC.windowState]: WindowStateResponse;
  [IPC.updatesState]: UpdatesStateResponse;
  [IPC.updatesInstall]: UpdatesStateResponse;
  [IPC.updatesRestart]: UpdatesStateResponse;
  [IPC.updatesDismiss]: UpdatesStateResponse;
  [IPC.cerebroStatus]: CerebroStatusResponse;
  [IPC.cerebroList]: CerebroListResponse;
  [IPC.cerebroPreflight]: CerebroPreflightResponse;
  [IPC.cerebroSetup]: CerebroSetupResponse;
  [IPC.cerebroSync]: CerebroSyncResponse;
  [IPC.cerebroDraft]: CerebroDraftResponse;
  [IPC.cerebroRetire]: CerebroRetireResponse;
  [IPC.agentPromptsList]: AgentPromptsListResponse;
  [IPC.agentPromptsSave]: AgentPromptsSaveResponse;
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
  [IPC_PUSH.windowState]: WindowState;
  [IPC_PUSH.planUsage]: PlanUsagePush;
  [IPC_PUSH.updateState]: UpdateState;
  [IPC_PUSH.terminalEvent]: TerminalEvent;
  [IPC_PUSH.menuOpenSettings]: MenuOpenSettings;
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
    stopTask(request: RunsStopTaskRequest): Promise<IpcResult<RunsStopTaskResponse>>;
    respondToPermission(
      request: RunsRespondPermissionRequest,
    ): Promise<IpcResult<RunsRespondPermissionResponse>>;
    dispose(request: RunsDisposeRequest): Promise<IpcResult<RunsDisposeResponse>>;
    list(request: RunsListRequest): Promise<IpcResult<RunsListResponse>>;
    /**
     * What a run has already said, for a window that was not listening.
     *
     * Paired with {@link list} on the reload path: `list` finds the runs that
     * outlived the page, this rebuilds their transcripts. Bounded by the
     * registry's retention, so check `truncated` before presenting the result
     * as the whole run.
     */
    events(request: RunsEventsRequest): Promise<IpcResult<RunsEventsResponse>>;
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
     * Open one subagent's conversation, replayed as events.
     *
     * Rejects on a provider with no subagent transcripts to read — which is
     * every provider but Claude today, and the reason the delegated pane only
     * offers the row as openable when the seam is there.
     */
    subagentMessages(
      request: SessionsSubagentMessagesRequest,
    ): Promise<IpcResult<SessionsSubagentMessagesResponse>>;
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
   * What the shared-`~/.claude` script actually did.
   *
   * One method, and it is a read with no counterpart: there is no `link` or
   * `unlink` here, and there is not going to be. Artemis hands the user a script
   * and the user runs it — see the Advanced pane's header for why a button was
   * refused — so the app's side of this arrangement is writing the shell and
   * then being honest about what came of it.
   *
   * Safe to call whenever the pane opens. `lstat` only, bounded by the number of
   * registered Claude profiles.
   */
  readonly sharedConfig: {
    /** Read every registered Claude profile's shared entries off the disk. */
    status(request: SharedConfigStatusRequest): Promise<IpcResult<SharedConfigStatusResponse>>;
  };

  /**
   * The team memory bank, through the bank's own CLI.
   *
   * Two reads, one bootstrap, three actions — and none of them lets the
   * renderer name a path, a binary, or a git remote. Main resolves the bank's
   * repo on this machine and invokes `bin/cerebro` inside it; the bank's own
   * validation and PR gates decide what actually lands. See the channel
   * comments in {@link IPC} for why the write channels answer with a message
   * rather than data.
   */
  readonly cerebro: {
    /** The bank's condition on this machine. `installed: false` is an answer, not an error. */
    status(request: CerebroStatusRequest): Promise<IpcResult<CerebroStatusResponse>>;
    /** Every memory in the bank, bodies included. */
    list(request: CerebroListRequest): Promise<IpcResult<CerebroListResponse>>;
    /** What this machine is missing, with the fix for each. Answers before the bank exists. */
    preflight(request: CerebroPreflightRequest): Promise<IpcResult<CerebroPreflightResponse>>;
    /** Clone if missing, enable every profile, sync once. Idempotent. */
    setup(request: CerebroSetupRequest): Promise<IpcResult<CerebroSetupResponse>>;
    /** Promote queued drafts, fetch, re-install everywhere. Bypasses the throttle. */
    sync(request: CerebroSyncRequest): Promise<IpcResult<CerebroSyncResponse>>;
    /** Queue a memory and land it through the bank's gates. */
    draft(request: CerebroDraftRequest): Promise<IpcResult<CerebroDraftResponse>>;
    /** Remove a memory through the same gates. */
    retire(request: CerebroRetireRequest): Promise<IpcResult<CerebroRetireResponse>>;
  };
  /**
   * Standing instructions, attached to runs by the main process.
   *
   * Read and write, and nothing that starts a run: the renderer edits the
   * library and never composes it. Composition happens where runs do — see
   * `engine.ts` — which is what keeps "the pane says this prompt is on" and
   * "the model was told it" from being two separately maintained facts.
   */
  readonly agentPrompts: {
    /** The library as stored, built-in rows included. */
    list(request: AgentPromptsListRequest): Promise<IpcResult<AgentPromptsListResponse>>;
    /** Replace the library. Answers with what landed, which may differ. */
    save(request: AgentPromptsSaveRequest): Promise<IpcResult<AgentPromptsSaveResponse>>;
  };

  /**
   * Rendering a page the agent wrote.
   *
   * One method, because the renderer's half of a preview is a frame and a URL:
   * ask for the URL, put it in the frame, drop the frame when done. Nothing has
   * to be closed, and nothing here can name a file main did not agree to serve.
   */
  readonly preview: {
    /** Snapshot the file at `path` and return the URL that serves it. */
    open(request: PreviewOpenRequest): Promise<IpcResult<PreviewOpenResponse>>;
  };

  /**
   * A shell of one's own.
   *
   * The one surface here that hands the user *unmediated* execution: the agent's
   * side of the app puts every tool call through a permission prompt, and this
   * puts none on a keystroke. That is not an oversight — a terminal that asked
   * before each command would not be a terminal — but it is worth being plain
   * about, because it means the containment lives entirely in the two facts
   * below rather than in a policy.
   *
   * **Main chooses the shell.** Nothing on this surface names a binary. The
   * renderer says "a shell, here, this big"; `main/terminal.ts` decides what
   * that means. So the worst a compromised renderer can do is what the user
   * could already do by typing — it cannot pick the program.
   *
   * **Main owns the ids.** {@link start} is the only way to obtain one, and
   * every other method resolves what it is given against main's registry.
   */
  readonly terminal: {
    /** Open a shell in `cwd` at the given size. The id comes back with it. */
    start(request: TerminalStartRequest): Promise<IpcResult<TerminalStartResponse>>;
    /** Send input. Whatever the user typed or pasted, verbatim. */
    write(request: TerminalWriteRequest): Promise<IpcResult<TerminalWriteResponse>>;
    /** Tell the child its window changed shape. Becomes a `SIGWINCH`. */
    resize(request: TerminalResizeRequest): Promise<IpcResult<TerminalResizeResponse>>;
    /** Kill the shell and forget it. Nothing else ends one. */
    close(request: TerminalCloseRequest): Promise<IpcResult<TerminalCloseResponse>>;
    /** Every terminal main is holding — for a renderer that has just reloaded. */
    list(request: TerminalListRequest): Promise<IpcResult<TerminalListResponse>>;
    /** The retained tail of one terminal's output, to repaint a reattached tab. */
    replay(request: TerminalReplayRequest): Promise<IpcResult<TerminalReplayResponse>>;
    /**
     * Output and exits, for every terminal at once.
     *
     * One subscription rather than one per terminal, matching
     * {@link runs.onEvent}: the payload carries its own `id` and the renderer
     * routes on it.
     */
    onEvent(listener: (event: TerminalEvent) => void): Unsubscribe;
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
    /**
     * Readings as the main process's poller collects them, for every profile.
     *
     * Subscribe rather than poll: the readings arrive whether or not anything
     * asked, which is what lets a menu opened at any moment already know which
     * account has room. See {@link IPC_PUSH.planUsage} for why the poll lives
     * in main and not here.
     */
    onChange(listener: (push: PlanUsagePush) => void): Unsubscribe;
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

  /**
   * The window's own chrome, because Artemis draws it.
   *
   * The title bar is hidden and the app's header stands in for it, which buys a
   * bar that can carry real controls — and costs the three actions the native
   * one came with. They live here. On macOS the traffic lights are still the
   * system's own, drawn over the page and handled by AppKit, so
   * {@link minimize}, {@link toggleMaximize} and {@link close} exist for
   * Windows and Linux, where the buttons are Artemis's to draw. {@link state}
   * and {@link onStateChange} are read by every platform: macOS needs
   * `fullScreen` to know whether to leave room for the traffic lights it does
   * not own.
   *
   * None of these takes a window id. See {@link WindowRequest}.
   */
  readonly window: {
    minimize(request: WindowRequest): Promise<IpcResult<WindowStateResponse>>;
    /** Maximize, or restore. One call, because the button is one button. */
    toggleMaximize(request: WindowRequest): Promise<IpcResult<WindowStateResponse>>;
    /**
     * Close this window. The reply races the window's own destruction — treat
     * it as fire-and-forget rather than sequencing anything behind it.
     */
    close(request: WindowRequest): Promise<IpcResult<WindowStateResponse>>;
    /** The state right now, for the first paint before any change has been pushed. */
    state(request: WindowRequest): Promise<IpcResult<WindowStateResponse>>;
    /**
     * Subscribe to chrome-state changes. Call this before {@link state}, for
     * the reason {@link runs.onEvent} says: a change can land while the read is
     * still in flight.
     */
    onStateChange(listener: (state: WindowState) => void): Unsubscribe;
  };

  /**
   * App updates, reduced to what a banner needs.
   *
   * The renderer can find out where the updater is, say yes, and say "not this
   * version". It cannot point the updater anywhere, see where downloads land,
   * or influence how the app is replaced — the whole mechanism lives in the
   * main process, and this surface is deliberately too small to steer it.
   */
  readonly updates: {
    /** The updater's state right now, for the first paint before any push. */
    state(request: UpdatesStateRequest): Promise<IpcResult<UpdatesStateResponse>>;
    /**
     * Download, verify and install the offered version. Resolves as soon as
     * the attempt is underway — progress arrives on {@link onChange}, not in
     * this reply. Installing never restarts anything: the flow parks at
     * `ready` and waits for {@link restart}.
     */
    install(request: UpdatesInstallRequest): Promise<IpcResult<UpdatesStateResponse>>;
    /**
     * Relaunch into the installed version. Only meaningful at `ready`; at any
     * other phase it answers with the current state and does nothing. This is
     * the single place a restart can come from — the updater itself never
     * initiates one.
     */
    restart(request: UpdatesRestartRequest): Promise<IpcResult<UpdatesStateResponse>>;
    /** Silence the banner for one version. The next version offers again. */
    dismiss(request: UpdatesDismissRequest): Promise<IpcResult<UpdatesStateResponse>>;
    /**
     * Subscribe to updater-state changes. Call this before {@link state}, for
     * the reason {@link runs.onEvent} says: a change can land while the read
     * is still in flight.
     */
    onChange(listener: (state: UpdateState) => void): Unsubscribe;
  };

  /**
   * The macOS application menu, in the one direction it can travel.
   *
   * Listen-only, and deliberately so. The renderer cannot build, reorder or
   * enable anything in the menu bar — that menu is assembled in main, where the
   * app's identity lives, and a renderer able to rewrite it would put window
   * state in charge of app-level chrome. All that crosses is the news that a
   * user picked something.
   */
  readonly menu: {
    /**
     * Subscribe to the menu bar's Settings… item. The listener runs on every
     * click; opening Settings when they are already open is a no-op in the
     * store, which is why this needs no matching "close" push.
     */
    onOpenSettings(listener: (payload: MenuOpenSettings) => void): Unsubscribe;
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
