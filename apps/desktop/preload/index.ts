/**
 * The contextBridge preload.
 *
 * This file is the entire attack surface between Libra's UI and its privileged
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
 *     from `@libra/protocol`. Nothing the renderer passes is ever concatenated
 *     into a channel name, so the set of reachable channels is fixed at build
 *     time and readable in one screen.
 *
 *  3. **Exactly the contract, nothing more.** The exposed object is typed as
 *     {@link LibraBridge}; if it grows a method the protocol does not define,
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
  type AgentEvent,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type LibraBridge,
  type ProfilesCreateRequest,
  type ProfilesDeleteRequest,
  type ProfilesListRequest,
  type ProfilesUpdateRequest,
  type ProvidersListRequest,
  type RunsDisposeRequest,
  type RunsInterruptRequest,
  type RunsListRequest,
  type RunsRespondPermissionRequest,
  type RunsSendRequest,
  type RunsStartRequest,
  type SessionsListAllRequest,
  type SessionsListRequest,
  type Unsubscribe,
  type SessionsMessagesRequest,
  type UsagePlanRequest,
  type WorkspacePickDirectoryRequest,
} from '@libra/protocol';

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

/**
 * Every renderer subscriber, behind a single `ipcRenderer` listener.
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
 */
const subscribers = new Set<(event: AgentEvent) => void>();
let listening = false;

function handlePushedEvent(_event: unknown, payload: unknown): void {
  if (!isAgentEvent(payload)) return;
  // Iterate a copy: a subscriber that unsubscribes (or subscribes) while being
  // notified must not disturb this pass.
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(payload);
    } catch {
      // One broken consumer must not stop the rest of the UI from updating,
      // and the error has already surfaced in the renderer's own console.
    }
  }
}

function subscribeToAgentEvents(listener: (event: AgentEvent) => void): Unsubscribe {
  if (typeof listener !== 'function') {
    throw new TypeError('libra.runs.onEvent expects a function');
  }

  subscribers.add(listener);
  if (!listening) {
    ipcRenderer.on(IPC_PUSH.agentEvent, handlePushedEvent);
    listening = true;
  }

  let active = true;
  return () => {
    // Idempotent: calling the returned function twice (a React effect cleanup
    // running after a hot reload, say) must not remove someone else's listener.
    if (!active) return;
    active = false;
    subscribers.delete(listener);
    if (subscribers.size === 0 && listening) {
      ipcRenderer.removeListener(IPC_PUSH.agentEvent, handlePushedEvent);
      listening = false;
    }
  };
}

// A renderer reload destroys the JavaScript context without unwinding this
// script's state. Drop the subscribers so a reloaded page starts from zero
// rather than fanning events out to callbacks in a dead world.
window.addEventListener('beforeunload', () => {
  subscribers.clear();
  if (listening) {
    ipcRenderer.removeListener(IPC_PUSH.agentEvent, handlePushedEvent);
    listening = false;
  }
});

/* -------------------------------------------------------------------------- */
/* Host facts                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a value the main process passed through `webPreferences.additionalArguments`.
 *
 * `LibraBridge.version` and `.platform` are synchronous properties, so they
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

function resolvePlatform(): LibraBridge['platform'] {
  const reported = readArgument('libra-platform', String(process.platform));
  if (reported === 'darwin' || reported === 'win32' || reported === 'linux') return reported;
  // Libra ships for these three. Anything else (freebsd, say) gets the
  // keyboard-hint behaviour closest to it rather than an undefined branch.
  return 'linux';
}

/* -------------------------------------------------------------------------- */
/* The bridge                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Exactly {@link LibraBridge} — the annotation is load-bearing. An extra method
 * here is a compile error, which is what keeps "expose only what the contract
 * defines" from being a comment nobody checks.
 */
const bridge: LibraBridge = Object.freeze({
  version: readArgument('libra-version', '0.0.0'),
  platform: resolvePlatform(),

  profiles: Object.freeze({
    list: (request: ProfilesListRequest) => invoke(IPC.profilesList, request),
    create: (request: ProfilesCreateRequest) => invoke(IPC.profilesCreate, request),
    update: (request: ProfilesUpdateRequest) => invoke(IPC.profilesUpdate, request),
    remove: (request: ProfilesDeleteRequest) => invoke(IPC.profilesDelete, request),
  }),

  providers: Object.freeze({
    list: (request: ProvidersListRequest) => invoke(IPC.providersList, request),
  }),

  runs: Object.freeze({
    start: (request: RunsStartRequest) => invoke(IPC.runsStart, request),
    send: (request: RunsSendRequest) => invoke(IPC.runsSend, request),
    interrupt: (request: RunsInterruptRequest) => invoke(IPC.runsInterrupt, request),
    respondToPermission: (request: RunsRespondPermissionRequest) =>
      invoke(IPC.runsRespondPermission, request),
    dispose: (request: RunsDisposeRequest) => invoke(IPC.runsDispose, request),
    list: (request: RunsListRequest) => invoke(IPC.runsList, request),
    onEvent: subscribeToAgentEvents,
  }),

  sessions: Object.freeze({
    list: (request: SessionsListRequest) => invoke(IPC.sessionsList, request),
    listAll: (request: SessionsListAllRequest) => invoke(IPC.sessionsListAll, request),
    messages: (request: SessionsMessagesRequest) => invoke(IPC.sessionsMessages, request),
  }),

  workspace: Object.freeze({
    pickDirectory: (request: WorkspacePickDirectoryRequest) =>
      invoke(IPC.workspacePickDirectory, request),
  }),

  /**
   * Two channels rather than one, so the renderer can paint before the
   * provider answers: `cached` returns immediately from memory, `refresh`
   * spawns a subprocess.
   */
  usagePlan: Object.freeze({
    cached: (request: UsagePlanRequest) => invoke(IPC.usagePlanCached, request),
    refresh: (request: UsagePlanRequest) => invoke(IPC.usagePlanRefresh, request),
  }),
});

contextBridge.exposeInMainWorld('libra', bridge);
