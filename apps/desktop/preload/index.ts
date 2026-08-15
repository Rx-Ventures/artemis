/**
 * The contextBridge preload.
 *
 * This file is the entire attack surface between Artemis's UI and its privileged
 * main process. Everything the renderer can do, it does through the object
 * exposed here — there is no `require`, no `process`, no `ipcRenderer` on the
 * other side, and `contextIsolation` keeps this script's scope in a separate
 * JavaScript world from the page's.
 *
 * Three rules shape it:
 *
 *  1. **No passthrough.** `ipcRenderer` is never exposed, wrapped or partially
 *     forwarded. An `invoke(channel, payload)` helper handed to the renderer
 *     would re-open every channel in the app — including any added later — to
 *     arbitrary page script.
 *
 *  2. **No dynamic channel names.** Every function below closes over a constant
 *     from `@rx-artemis/protocol`. Nothing the renderer passes is ever concatenated
 *     into a channel name, so the set of reachable channels is fixed at build
 *     time and readable in one screen.
 *
 *  3. **Exactly the contract, nothing more.** The exposed object is typed as
 *     {@link ArtemisBridge}; if it grows a method the protocol does not define,
 *     the build fails.
 *
 * The bridge also never rejects. `ipcRenderer.invoke` rejects when a main
 * handler throws, and a rejection carries a stringified main-process stack into
 * the renderer — lossy and a small information leak. Anything that goes wrong
 * here comes back as an {@link IpcFail}, the same shape the main process
 * returns deliberately.
 */

import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  IPC_PUSH,
  ipcFail,
  AGENT_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  type AgentEvent,
  type IpcChannel,
  type IpcPushChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type ArtemisBridge,
  type ProfilesCreateRequest,
  type ProfilesDeleteRequest,
  type ProfilesSuggestDirRequest,
  type ProfilesListRequest,
  type ProfilesUpdateRequest,
  type ProvidersListRequest,
  type ProvidersModelsRequest,
  type RunsDisposeRequest,
  type RunsInterruptRequest,
  type RunsStopTaskRequest,
  type RunsEventsRequest,
  type RunsListRequest,
  type RunsRespondPermissionRequest,
  type RunsSendRequest,
  type RunsStartRequest,
  type SessionsListAllRequest,
  type SessionsListRequest,
  type AgentPromptsListRequest,
  type AgentPromptsSaveRequest,
  type CerebroDraftRequest,
  type CerebroListRequest,
  type CerebroPreflightRequest,
  type CerebroRetireRequest,
  type CerebroSetupRequest,
  type CerebroStatusRequest,
  type CerebroSyncRequest,
  type SharedConfigStatusRequest,
  type Unsubscribe,
  type SessionsDeleteRequest,
  type SessionsMessagesRequest,
  type SessionsSubagentMessagesRequest,
  type SessionsRenameRequest,
  type AuthSignOutRequest,
  type AuthStatusRequest,
  type PlanUsagePush,
  type MenuOpenSettings,
  type UpdateState,
  type UpdatesDismissRequest,
  type UpdatesInstallRequest,
  type UpdatesRestartRequest,
  type UpdatesStateRequest,
  type UsagePlanRequest,
  type PreviewOpenRequest,
  type FilesReadRequest,
  type TerminalCloseRequest,
  type TerminalEvent,
  type TerminalListRequest,
  type TerminalReplayRequest,
  type TerminalResizeRequest,
  type TerminalStartRequest,
  type TerminalWriteRequest,
  type WindowRequest,
  type WindowState,
  type WorkspaceDescribeRequest,
  type WorkspacePickDirectoryRequest,
} from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Request/response                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Invoke one channel and normalise whatever comes back.
 *
 * The `channel` parameter is only ever supplied by the call sites in this file,
 * each of which passes a literal from {@link IPC}. It is not, and must never
 * become, something the renderer can influence.
 */
async function invoke<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResult<IpcResponse<C>>> {
  try {
    const result: unknown = await ipcRenderer.invoke(channel, request);
    if (isIpcResult(result)) return result as IpcResult<IpcResponse<C>>;
    // A handler that resolved something off-contract is a main-process bug, but
    // the renderer still has to be handed something it can narrow on.
    return ipcFail({
      code: 'unknown',
      message: 'The main process returned an unrecognised response.',
      channel,
    });
  } catch (error) {
    // Reached when the channel has no handler at all, or when the main process
    // is shutting down mid-call.
    return ipcFail({
      code: 'transport',
      message: error instanceof Error ? error.message : 'The main process could not be reached.',
      channel,
      retryable: true,
    });
  }
}

function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown; value?: unknown; error?: unknown };
  if (candidate.ok === true) return true;
  return candidate.ok === false && typeof candidate.error === 'object' && candidate.error !== null;
}

/* -------------------------------------------------------------------------- */
/* Event fan-out                                                              */
/* -------------------------------------------------------------------------- */

const AGENT_EVENT_TYPE_SET = new Set<string>(AGENT_EVENT_TYPES);

/**
 * Minimal shape check on a pushed event.
 *
 * Not validation in the security sense — the sender is the main process, which
 * is more trusted than this script — but a guard against a malformed payload
 * reaching a `switch (event.type)` in the renderer and falling through to an
 * `assertNever` that throws inside a React render.
 */
function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; runId?: unknown; seq?: unknown };
  return (
    typeof candidate.type === 'string' &&
    AGENT_EVENT_TYPE_SET.has(candidate.type) &&
    typeof candidate.runId === 'string' &&
    typeof candidate.seq === 'number'
  );
}

const TERMINAL_EVENT_TYPE_SET = new Set<string>(TERMINAL_EVENT_TYPES);

/**
 * Minimal shape check on a pushed terminal event. Same standard as
 * {@link isAgentEvent}.
 *
 * `data` is checked for being a string and nothing else — not for length, not
 * for content. It is a byte stream on its way to a terminal emulator, and the
 * one thing that could go wrong at this layer is a `switch (event.type)` in the
 * renderer meeting a type it has no branch for.
 */
function isTerminalEvent(value: unknown): value is TerminalEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; id?: unknown; data?: unknown };
  if (typeof candidate.type !== 'string' || !TERMINAL_EVENT_TYPE_SET.has(candidate.type)) {
    return false;
  }
  if (typeof candidate.id !== 'string' || candidate.id === '') return false;
  return candidate.type !== 'data' || typeof candidate.data === 'string';
}

/**
 * Minimal shape check on a pushed window state. Same standard as
 * {@link isAgentEvent}: a guard against a malformed payload reaching a render,
 * not validation of an untrusted sender.
 */
function isWindowState(value: unknown): value is WindowState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { maximized?: unknown; fullScreen?: unknown; focused?: unknown };
  return (
    typeof candidate.maximized === 'boolean' &&
    typeof candidate.fullScreen === 'boolean' &&
    typeof candidate.focused === 'boolean'
  );
}

/**
 * Minimal shape check on a pushed plan-usage reading. Same standard as
 * {@link isAgentEvent}.
 *
 * `windows` is checked for being an array but not walked: a malformed *window*
 * renders as a row of dashes, which the meter already handles, whereas a
 * missing `available` reaches a branch that decides whether the account is
 * recommendable at all.
 */
function isPlanUsagePush(value: unknown): value is PlanUsagePush {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { profileId?: unknown; usage?: unknown };
  if (typeof candidate.profileId !== 'string' || candidate.profileId === '') return false;
  if (typeof candidate.usage !== 'object' || candidate.usage === null) return false;
  const usage = candidate.usage as { available?: unknown; windows?: unknown; fetchedAt?: unknown };
  return (
    typeof usage.available === 'boolean' &&
    Array.isArray(usage.windows) &&
    typeof usage.fetchedAt === 'number'
  );
}

/**
 * Minimal shape check on a menu-bar Settings push. Same standard as
 * {@link isAgentEvent}.
 *
 * The payload carries nothing but its discriminator, so checking that
 * discriminator is the entire check.
 */
function isMenuOpenSettings(value: unknown): value is MenuOpenSettings {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { kind?: unknown }).kind === 'open-settings';
}

/**
 * Minimal shape check on a pushed updater state. Same standard as
 * {@link isAgentEvent}: a guard against a malformed payload reaching a
 * render, not validation of an untrusted sender.
 */
function isUpdateState(value: unknown): value is UpdateState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    phase?: unknown;
    version?: unknown;
    message?: unknown;
    releaseUrl?: unknown;
  };
  const phases = ['idle', 'available', 'working', 'ready', 'restarting', 'error'];
  const nullableString = (field: unknown): boolean => field === null || typeof field === 'string';
  return (
    typeof candidate.phase === 'string' &&
    phases.includes(candidate.phase) &&
    nullableString(candidate.version) &&
    nullableString(candidate.message) &&
    nullableString(candidate.releaseUrl)
  );
}

interface PushChannel<T> {
  /** Register a listener. Returns an idempotent disposer. */
  readonly subscribe: (listener: (payload: T) => void) => Unsubscribe;
  /** Drop every listener and detach from `ipcRenderer`. */
  readonly reset: () => void;
}

/**
 * Every renderer subscriber to one push channel, behind a single `ipcRenderer`
 * listener.
 *
 * The obvious implementation registers one `ipcRenderer.on` per subscriber and
 * removes it on unsubscribe. That leaks in two ways over a long session: an
 * unsubscribe that runs twice, or that runs after the function identity has
 * been re-wrapped by contextBridge, silently removes nothing; and Node's
 * ten-listener warning starts firing once a few components subscribe.
 *
 * One listener plus a `Set` fixes both. The `ipcRenderer` listener is attached
 * when the set becomes non-empty and detached when it empties, so a renderer
 * that has torn everything down leaves nothing attached.
 *
 * Written once and instantiated per channel rather than copied: the invariants
 * above are subtle enough that a second hand-rolled copy would be where they
 * quietly stop holding.
 */
function createPushChannel<T>(options: {
  readonly channel: IpcPushChannel;
  /** The bridge method this backs, named in the error a bad argument raises. */
  readonly label: string;
  readonly isValid: (value: unknown) => value is T;
}): PushChannel<T> {
  const { channel, label, isValid } = options;
  const subscribers = new Set<(payload: T) => void>();
  let listening = false;

  const deliver = (_event: unknown, payload: unknown): void => {
    if (!isValid(payload)) return;
    // Iterate a copy: a subscriber that unsubscribes (or subscribes) while
    // being notified must not disturb this pass.
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(payload);
      } catch {
        // One broken consumer must not stop the rest of the UI from updating,
        // and the error has already surfaced in the renderer's own console.
      }
    }
  };

  const detach = (): void => {
    if (!listening) return;
    ipcRenderer.removeListener(channel, deliver);
    listening = false;
  };

  return {
    subscribe(listener: (payload: T) => void): Unsubscribe {
      if (typeof listener !== 'function') {
        throw new TypeError(`${label} expects a function`);
      }

      subscribers.add(listener);
      if (!listening) {
        ipcRenderer.on(channel, deliver);
        listening = true;
      }

      let active = true;
      return () => {
        // Idempotent: calling the returned function twice (a React effect
        // cleanup running after a hot reload, say) must not remove someone
        // else's listener.
        if (!active) return;
        active = false;
        subscribers.delete(listener);
        if (subscribers.size === 0) detach();
      };
    },
    reset(): void {
      subscribers.clear();
      detach();
    },
  };
}

const agentEvents = createPushChannel<AgentEvent>({
  channel: IPC_PUSH.agentEvent,
  label: 'artemis.runs.onEvent',
  isValid: isAgentEvent,
});

const terminalEvents = createPushChannel<TerminalEvent>({
  channel: IPC_PUSH.terminalEvent,
  label: 'artemis.terminal.onEvent',
  isValid: isTerminalEvent,
});

const windowStates = createPushChannel<WindowState>({
  channel: IPC_PUSH.windowState,
  label: 'artemis.window.onStateChange',
  isValid: isWindowState,
});

const planUsages = createPushChannel<PlanUsagePush>({
  channel: IPC_PUSH.planUsage,
  label: 'artemis.usagePlan.onChange',
  isValid: isPlanUsagePush,
});

const updateStates = createPushChannel<UpdateState>({
  channel: IPC_PUSH.updateState,
  label: 'artemis.updates.onChange',
  isValid: isUpdateState,
});

const menuOpenSettings = createPushChannel<MenuOpenSettings>({
  channel: IPC_PUSH.menuOpenSettings,
  label: 'artemis.menu.onOpenSettings',
  isValid: isMenuOpenSettings,
});

// A renderer reload destroys the JavaScript context without unwinding this
// script's state. Drop the subscribers so a reloaded page starts from zero
// rather than fanning events out to callbacks in a dead world.
window.addEventListener('beforeunload', () => {
  agentEvents.reset();
  terminalEvents.reset();
  windowStates.reset();
  planUsages.reset();
  updateStates.reset();
  menuOpenSettings.reset();
});

/* -------------------------------------------------------------------------- */
/* Host facts                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a value the main process passed through `webPreferences.additionalArguments`.
 *
 * `ArtemisBridge.version` and `.platform` are synchronous properties, so they
 * cannot be fetched over `invoke`. `sendSync` would block the renderer's first
 * paint on an IPC round-trip. Passing them as process arguments costs nothing
 * and is available before the page loads.
 */
function readArgument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const argv: readonly string[] = Array.isArray(process.argv) ? process.argv : [];
  for (const argument of argv) {
    if (typeof argument === 'string' && argument.startsWith(prefix)) {
      return argument.slice(prefix.length);
    }
  }
  return fallback;
}

function resolvePlatform(): ArtemisBridge['platform'] {
  const reported = readArgument('artemis-platform', String(process.platform));
  if (reported === 'darwin' || reported === 'win32' || reported === 'linux') return reported;
  // Artemis ships for these three. Anything else (freebsd, say) gets the
  // keyboard-hint behaviour closest to it rather than an undefined branch.
  return 'linux';
}

/* -------------------------------------------------------------------------- */
/* The bridge                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Exactly {@link ArtemisBridge} — the annotation is load-bearing. An extra method
 * here is a compile error, which is what keeps "expose only what the contract
 * defines" from being a comment nobody checks.
 */
const bridge: ArtemisBridge = Object.freeze({
  version: readArgument('artemis-version', '0.0.0'),
  platform: resolvePlatform(),

  profiles: Object.freeze({
    list: (request: ProfilesListRequest) => invoke(IPC.profilesList, request),
    create: (request: ProfilesCreateRequest) => invoke(IPC.profilesCreate, request),
    update: (request: ProfilesUpdateRequest) => invoke(IPC.profilesUpdate, request),
    remove: (request: ProfilesDeleteRequest) => invoke(IPC.profilesDelete, request),
    suggestDir: (request: ProfilesSuggestDirRequest) => invoke(IPC.profilesSuggestDir, request),
  }),

  /**
   * Two channels, for the same reason `usagePlan` has two: `list` is answered
   * out of the registry and is instant, `models` spawns a provider subprocess.
   * A picker that opened on the slow one would stall on every render.
   */
  providers: Object.freeze({
    list: (request: ProvidersListRequest) => invoke(IPC.providersList, request),
    models: (request: ProvidersModelsRequest) => invoke(IPC.providersModels, request),
  }),

  runs: Object.freeze({
    start: (request: RunsStartRequest) => invoke(IPC.runsStart, request),
    send: (request: RunsSendRequest) => invoke(IPC.runsSend, request),
    interrupt: (request: RunsInterruptRequest) => invoke(IPC.runsInterrupt, request),
    stopTask: (request: RunsStopTaskRequest) => invoke(IPC.runsStopTask, request),
    respondToPermission: (request: RunsRespondPermissionRequest) =>
      invoke(IPC.runsRespondPermission, request),
    dispose: (request: RunsDisposeRequest) => invoke(IPC.runsDispose, request),
    list: (request: RunsListRequest) => invoke(IPC.runsList, request),
    events: (request: RunsEventsRequest) => invoke(IPC.runsEvents, request),
    onEvent: agentEvents.subscribe,
  }),

  sessions: Object.freeze({
    list: (request: SessionsListRequest) => invoke(IPC.sessionsList, request),
    listAll: (request: SessionsListAllRequest) => invoke(IPC.sessionsListAll, request),
    messages: (request: SessionsMessagesRequest) => invoke(IPC.sessionsMessages, request),
    subagentMessages: (request: SessionsSubagentMessagesRequest) =>
      invoke(IPC.sessionsSubagentMessages, request),
    rename: (request: SessionsRenameRequest) => invoke(IPC.sessionsRename, request),
    delete: (request: SessionsDeleteRequest) => invoke(IPC.sessionsDelete, request),
  }),

  workspace: Object.freeze({
    pickDirectory: (request: WorkspacePickDirectoryRequest) =>
      invoke(IPC.workspacePickDirectory, request),
    describe: (request: WorkspaceDescribeRequest) => invoke(IPC.workspaceDescribe, request),
  }),

  /**
   * One read, and nothing that writes.
   *
   * The shared-`~/.claude` arrangement is made by a script the user runs, so the
   * only thing to expose is the reading of what that script did. Note that the
   * request names nothing — no path, no profile — which is the rule this file
   * keeps everywhere, read from the other direction: main derives what to look at,
   * so the renderer cannot aim this at the filesystem.
   */
  sharedConfig: Object.freeze({
    status: (request: SharedConfigStatusRequest) => invoke(IPC.sharedConfigStatus, request),
  }),

  /**
   * The team memory bank. Same rule as everywhere else in this file: nothing
   * here names a path, a binary or a remote — main resolves the bank's repo
   * and its CLI, so the renderer can ask for the bank and only the bank.
   */
  cerebro: Object.freeze({
    status: (request: CerebroStatusRequest) => invoke(IPC.cerebroStatus, request),
    list: (request: CerebroListRequest) => invoke(IPC.cerebroList, request),
    preflight: (request: CerebroPreflightRequest) => invoke(IPC.cerebroPreflight, request),
    setup: (request: CerebroSetupRequest) => invoke(IPC.cerebroSetup, request),
    sync: (request: CerebroSyncRequest) => invoke(IPC.cerebroSync, request),
    draft: (request: CerebroDraftRequest) => invoke(IPC.cerebroDraft, request),
    retire: (request: CerebroRetireRequest) => invoke(IPC.cerebroRetire, request),
  }),

  /** The standing-instruction library. Read and replaced whole; see {@link IPC}. */
  agentPrompts: Object.freeze({
    list: (request: AgentPromptsListRequest) => invoke(IPC.agentPromptsList, request),
    save: (request: AgentPromptsSaveRequest) => invoke(IPC.agentPromptsSave, request),
  }),

  preview: Object.freeze({
    open: (request: PreviewOpenRequest) => invoke(IPC.previewOpen, request),
  }),

  files: Object.freeze({
    read: (request: FilesReadRequest) => invoke(IPC.filesRead, request),
  }),

  /**
   * The user's own shell.
   *
   * Six literal channels and one subscription, and — like every other namespace
   * here — nothing that lets the caller name a program. `start` says where and
   * how big; main decides what to run. The five methods after it echo an id main
   * issued, which main resolves against its own registry before acting.
   */
  terminal: Object.freeze({
    start: (request: TerminalStartRequest) => invoke(IPC.terminalStart, request),
    write: (request: TerminalWriteRequest) => invoke(IPC.terminalWrite, request),
    resize: (request: TerminalResizeRequest) => invoke(IPC.terminalResize, request),
    close: (request: TerminalCloseRequest) => invoke(IPC.terminalClose, request),
    list: (request: TerminalListRequest) => invoke(IPC.terminalList, request),
    replay: (request: TerminalReplayRequest) => invoke(IPC.terminalReplay, request),
    onEvent: terminalEvents.subscribe,
  }),

  /**
   * Two reads and no write: nothing here accepts a credential, and nothing here
   * performs a login. The user runs the provider's own command; `status` is
   * what Artemis polls to find out whether they finished.
   */
  auth: Object.freeze({
    status: (request: AuthStatusRequest) => invoke(IPC.authStatus, request),
    signOut: (request: AuthSignOutRequest) => invoke(IPC.authSignOut, request),
  }),

  usagePlan: Object.freeze({
    cached: (request: UsagePlanRequest) => invoke(IPC.usagePlanCached, request),
    refresh: (request: UsagePlanRequest) => invoke(IPC.usagePlanRefresh, request),
    onChange: planUsages.subscribe,
  }),

  /**
   * The window's own chrome, hidden by the main process and drawn by the app.
   *
   * Nothing here names a window, which is the same rule as everywhere else in
   * this file read from the other direction: no channel name is built from
   * renderer input, and no *target* is either. Main resolves the window from
   * the sender, so these four reach exactly one window — the one that called.
   */
  window: Object.freeze({
    minimize: (request: WindowRequest) => invoke(IPC.windowMinimize, request),
    toggleMaximize: (request: WindowRequest) => invoke(IPC.windowToggleMaximize, request),
    close: (request: WindowRequest) => invoke(IPC.windowClose, request),
    state: (request: WindowRequest) => invoke(IPC.windowState, request),
    onStateChange: windowStates.subscribe,
  }),

  updates: Object.freeze({
    state: (request: UpdatesStateRequest) => invoke(IPC.updatesState, request),
    install: (request: UpdatesInstallRequest) => invoke(IPC.updatesInstall, request),
    restart: (request: UpdatesRestartRequest) => invoke(IPC.updatesRestart, request),
    dismiss: (request: UpdatesDismissRequest) => invoke(IPC.updatesDismiss, request),
    onChange: updateStates.subscribe,
  }),

  menu: Object.freeze({
    onOpenSettings: menuOpenSettings.subscribe,
  }),
});

contextBridge.exposeInMainWorld('artemis', bridge);
