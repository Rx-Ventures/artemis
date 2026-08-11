/**
 * The IPC layer.
 *
 * `@rx-artemis/protocol` defines the channels, the request and response types, and
 * the rule that handlers resolve an {@link IpcResult} instead of rejecting.
 * This file is the main-process half of that contract, and it adds three things
 * the type system cannot express:
 *
 *  1. **Sender verification.** Every message must come from Artemis's own
 *     top-level frame at an allowed URL. A nested frame cannot reach these
 *     handlers.
 *  2. **Validation.** Payloads arrive as `unknown` and are checked and rebuilt
 *     by `./validate.ts` before any of them reaches the engine.
 *  3. **A leak tripwire.** Every response is scanned by `./redact.ts` on its way
 *     out. A handler that returns a `Profile` where the contract says
 *     `ProfileMetadata` throws here rather than shipping a credential to the
 *     renderer.
 *
 * (3) is the reason this file exists as a chokepoint rather than as one
 * `ipcMain.handle` call per channel scattered through the bootstrap. There is
 * exactly one path from a handler's return value to the renderer, and the
 * assertion sits on it.
 *
 * ### One event channel, not one per run
 *
 * Agent events are pushed on the single {@link IPC_PUSH.agentEvent} channel
 * defined by the protocol, and the renderer demultiplexes on `event.runId`.
 * A channel per run would force the preload to build channel names out of
 * renderer-supplied strings, which is precisely the dynamic-channel pattern the
 * preload is forbidden to have. The protocol's `ArtemisBridge.runs.onEvent` is
 * likewise a single global subscription, so one channel is also what the
 * contract asks for.
 */

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';

import {
  IPC,
  IPC_CHANNELS,
  IPC_PUSH,
  ipcFail,
  ipcOk,
  type AgentEvent,
  type IpcChannel,
  type IpcHandlerResult,
  type IpcPushChannel,
  type IpcRequest,
  type IpcResponse,
  type Unsubscribe,
  type WorkspacePickDirectoryRequest,
} from '@rx-artemis/protocol';

import { checkWorkingDirectory, describeWorkspace } from '@rx-artemis/core';

import type { EngineHost } from './engine.js';
import {
  toIpcError,
  UntrustedSenderError,
  WorkspaceError,
} from './errors.js';
import { createLogger } from './log.js';
import { grantPreview } from './preview.js';
import { assertNoSecrets, EVENT_SCAN_POLICY, RESPONSE_SCAN_POLICY } from './redact.js';
import { isTrustedFrame, type SecurityPolicy } from './security.js';
import type { Updater } from './updater.js';
import {
  validateProfilesCreate,
  validateProfilesDelete,
  validateProfilesList,
  validateProfilesUpdate,
  validateProvidersList,
  validateProvidersModels,
  validateRunsDispose,
  validateRunsInterrupt,
  validateRunsEvents,
  validateRunsList,
  validateRunsRespondPermission,
  validateRunsSend,
  validateRunsStart,
  validateSessionsList,
  validateSessionsDelete,
  validateSessionsListAll,
  validateSessionsMessages,
  validateSessionsRename,
  validateProfilesSuggestDir,
  validatePreviewOpen,
  validateAuthSignOut,
  validateAuthStatus,
  validateUsagePlan,
  validateUpdatesDismiss,
  validateUpdatesInstall,
  validateUpdatesRestart,
  validateUpdatesState,
  validateWindowRequest,
  validateWorkspaceDescribe,
  validateWorkspacePickDirectory,
} from './validate.js';
import { readWindowState } from './window.js';
import { DIRECTORY_PICKER_PROPERTIES, readPickedDirectory } from './workspace.js';

const log = createLogger('ipc');

/**
 * One channel's implementation: how to check the request, and what to do with
 * it once checked.
 *
 * Written as a mapped type over {@link IpcChannel} so that the object literal
 * below is exhaustive by construction — adding a channel to the protocol breaks
 * this file's build until it is handled, which is the point.
 */
type ChannelHandlers = {
  readonly [C in IpcChannel]: {
    readonly validate: (raw: unknown) => IpcRequest<C>;
    readonly handle: (request: IpcRequest<C>, context: HandlerContext) => Promise<IpcResponse<C>>;
  };
};

/**
 * What a handler knows about *where* a request came from, beyond its payload.
 *
 * Deliberately not the `IpcMainInvokeEvent` itself. A handler with the raw
 * event can reach `event.sender` and from there most of Electron, which is a
 * much wider surface than any of these handlers needs — and the one thing they
 * do need is modest: a native dialog has to be parented to the window that
 * asked for it, or it opens detached from the app (and, on macOS, is not
 * sheeted to the window that will be blocked while it is open).
 */
export interface HandlerContext {
  /**
   * The window the request came from, or `null` when it has already been
   * destroyed — which is routine for an in-flight call during a reload or a
   * quit, and never worth failing over.
   */
  readonly window: BrowserWindow | null;
}

export interface IpcLayerOptions {
  readonly engine: EngineHost;
  readonly policy: SecurityPolicy;
  readonly updater: Updater;
}

/** Handle for tearing the IPC layer down again. */
export interface IpcLayer {
  dispose(): void;
}

/**
 * Register every channel in the protocol.
 *
 * Returns a disposer; `ipcMain.handle` throws if a channel is registered twice,
 * so a hot-reloaded main process has to be able to unregister.
 */
export function registerIpcHandlers(options: IpcLayerOptions): IpcLayer {
  const { engine, policy, updater } = options;

  const handlers: ChannelHandlers = {
    /* ---------------------------------------------------------------- */
    /* Profiles                                                         */
    /* ---------------------------------------------------------------- */

    [IPC.profilesList]: {
      validate: validateProfilesList,
      handle: async (request) => ({
        profiles: await engine.require().listProfiles({ providerId: request.providerId }),
      }),
    },

    [IPC.profilesCreate]: {
      validate: validateProfilesCreate,
      handle: async (request) => ({
        profile: await engine.require().createProfile(request.draft),
      }),
    },

    [IPC.profilesUpdate]: {
      validate: validateProfilesUpdate,
      handle: async (request) => ({
        profile: await engine.require().updateProfile(request.id, request.patch),
      }),
    },

    [IPC.profilesDelete]: {
      validate: validateProfilesDelete,
      handle: async (request) =>
        engine.require().deleteProfile(request.id, { deleteConfigDir: request.deleteConfigDir }),
    },

    [IPC.profilesSuggestDir]: {
      validate: validateProfilesSuggestDir,
      handle: async (request) => ({
        configDir: await engine.require().suggestConfigDir(request.label),
      }),
    },

    /* ---------------------------------------------------------------- */
    /* Providers                                                        */
    /* ---------------------------------------------------------------- */

    [IPC.providersList]: {
      validate: validateProvidersList,
      handle: async (request) => ({
        providers: await engine.require().listProviders({ refresh: request.refresh }),
      }),
    },

    /**
     * The one handler in this file that deliberately swallows its failure.
     *
     * Everywhere else, a fault becomes an `IpcFail` and the UI says so. Here
     * the UI cannot usefully say anything: the caller is a model picker, and
     * "Artemis could not read your model list" leaves the user staring at an
     * empty menu with no way to change a setting. The engine already resolves
     * the adapter's built-in list for every ordinary failure — no CLI, no
     * credential, no network — so the only thing left to catch is the engine
     * itself being down, and an empty list is the truthful answer to that.
     *
     * `live: false` is what keeps this from being a lie. It is the difference
     * between the renderer showing a catalogue and the renderer showing a
     * catalogue it knows the account never confirmed, which the settings
     * screen labels.
     */
    [IPC.providersModels]: {
      validate: validateProvidersModels,
      handle: async (request) => {
        try {
          return await engine.require().listProviderModels({
            providerId: request.providerId,
            profileId: request.profileId,
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          });
        } catch (error) {
          log.error(`Could not read the model list for provider "${request.providerId}"`, error);
          return { models: [], live: false };
        }
      },
    },

    /* ---------------------------------------------------------------- */
    /* Runs                                                             */
    /* ---------------------------------------------------------------- */

    [IPC.runsStart]: {
      validate: validateRunsStart,
      handle: async (request) => ({ run: await engine.require().startRun(request.input) }),
    },

    [IPC.runsSend]: {
      validate: validateRunsSend,
      handle: async (request) => {
        const result = await engine
          .require()
          .sendToRun(request.runId, request.text, request.attachments);
        return { runId: request.runId, deliveredImmediately: result.deliveredImmediately };
      },
    },

    [IPC.runsInterrupt]: {
      validate: validateRunsInterrupt,
      handle: async (request) => {
        const result = await engine.require().interruptRun(request.runId);
        return result.stillQueued
          ? { runId: request.runId, stillQueued: result.stillQueued }
          : { runId: request.runId };
      },
    },

    [IPC.runsRespondPermission]: {
      validate: validateRunsRespondPermission,
      handle: async (request) => {
        await engine.require().respondToPermission(request.runId, request.requestId, request.decision);
        return { requestId: request.requestId };
      },
    },

    [IPC.runsDispose]: {
      validate: validateRunsDispose,
      handle: async (request) => {
        await engine.require().disposeRun(request.runId);
        return { runId: request.runId };
      },
    },

    [IPC.runsList]: {
      validate: validateRunsList,
      handle: async (request) => ({ runs: await engine.require().listRuns({ cwd: request.cwd }) }),
    },

    [IPC.runsEvents]: {
      validate: validateRunsEvents,
      handle: (request) => {
        const replay = engine.require().runEvents({
          runId: request.runId,
          ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
        });
        return Promise.resolve({ runId: request.runId, ...replay });
      },
    },

    /* ---------------------------------------------------------------- */
    /* Sessions                                                         */
    /* ---------------------------------------------------------------- */

    [IPC.sessionsList]: {
      validate: validateSessionsList,
      handle: async (request) =>
        engine.require().listSessions({
          providerId: request.providerId,
          profileId: request.profileId,
          cwd: request.cwd,
          limit: request.limit,
          offset: request.offset,
        }),
    },

    [IPC.sessionsListAll]: {
      validate: validateSessionsListAll,
      handle: async (request) =>
        engine.require().listAllSessions({
          providerId: request.providerId,
          limit: request.limit,
          offset: request.offset,
        }),
    },

    /* ---------------------------------------------------------------- */
    /* Workspace                                                        */
    /* ---------------------------------------------------------------- */

    [IPC.workspacePickDirectory]: {
      validate: validateWorkspacePickDirectory,
      handle: async (request, context) => ({
        path: await pickDirectory(request, context.window),
      }),
    },

    /**
     * Name a directory for the sidebar's header.
     *
     * Does not go through the engine: it reads the filesystem and needs no
     * provider, no profile and no adapter, so routing it through the engine
     * would make a label depend on a booted engine for no reason.
     */
    [IPC.workspaceDescribe]: {
      validate: validateWorkspaceDescribe,
      handle: async (request) => describeWorkspace(request.path),
    },

    /* ---------------------------------------------------------------- */
    /* Preview                                                          */
    /* ---------------------------------------------------------------- */

    /**
     * Make one file renderable.
     *
     * The path arriving here came from a tool call in a transcript, which is to
     * say from model output — so this is the one handler whose whole job is to
     * take an untrusted path and hand back something safe to frame. Everything
     * that makes it safe is in `preview.ts`; what matters at this layer is that
     * the renderer receives a `artemis-preview://` URL and never a `file:` one,
     * and so is never in a position to frame a path of its own choosing.
     */
    [IPC.previewOpen]: {
      validate: validatePreviewOpen,
      handle: async (request) => grantPreview(request.path),
    },

    [IPC.sessionsMessages]: {
      validate: validateSessionsMessages,
      handle: async (request) => engine.require().getSessionMessages(request),
    },

    [IPC.sessionsRename]: {
      validate: validateSessionsRename,
      handle: async (request) =>
        engine.require().renameSession({
          profileId: request.profileId,
          sessionId: request.sessionId,
          title: request.title,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        }),
    },

    /**
     * Destroys a transcript on disk. The confirmation that guards it lives in
     * the renderer, which is the only layer that can ask a person anything —
     * so by the time a request reaches here the decision has been made and
     * this does not second-guess it.
     */
    [IPC.sessionsDelete]: {
      validate: validateSessionsDelete,
      handle: async (request) =>
        engine.require().deleteSession({
          profileId: request.profileId,
          sessionId: request.sessionId,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        }),
    },

    /* ---------------------------------------------------------------- */
    /* Plan usage                                                       */
    /* ---------------------------------------------------------------- */

    /**
     * The cheap half of the pair: synchronous, no provider contact, may be
     * null. The renderer opens its popover on this and never waits.
     */
    [IPC.usagePlanCached]: {
      validate: validateUsagePlan,
      handle: async (request) => ({ usage: engine.require().cachedPlanUsage(request.profileId) }),
    },

    /**
     * The expensive half: spawns a provider subprocess. Costs no model tokens
     * — see the adapter's `fetchPlanUsage` — but takes a second or two, which
     * is exactly why it is a separate channel from the cached read.
     */
    [IPC.usagePlanRefresh]: {
      validate: validateUsagePlan,
      handle: async (request) => ({
        usage: await engine.require().refreshPlanUsage({ profileId: request.profileId }),
      }),
    },

    /* ---------------------------------------------------------------- */

    /**
     * Auth. Note what is *absent*: no channel accepts a key, token or password,
     * and none performs a login. The user runs the provider's own command
     * against the profile's config directory; these two report what landed
     * there. A credential never crosses this boundary in either direction.
     *
     * `authStatus` is polled while the user signs in, so it has to stay cheap —
     * it spawns one short-lived status probe and nothing else.
     */
    [IPC.authStatus]: {
      validate: validateAuthStatus,
      handle: async (request) => engine.require().authStatus(request.profileId),
    },

    [IPC.authSignOut]: {
      validate: validateAuthSignOut,
      handle: async (request) => engine.require().signOut(request.profileId),
    },

    /* ---------------------------------------------------------------- */
    /* Window chrome                                                    */
    /* ---------------------------------------------------------------- */

    /**
     * The four channels that exist because Artemis hides the native title bar.
     *
     * The only handlers in this file that touch neither the engine nor the
     * filesystem — they act on `context.window`, and on nothing else. That is
     * the whole security story here: the request carries no window id (see
     * `WindowRequest`), so a renderer can only ever minimize, zoom or close
     * *itself*, and a second Artemis window is unreachable from the first.
     *
     * Each answers with the resulting state so the header never has to assume
     * its command landed. A window that died mid-call answers with the
     * all-false state rather than failing; see `readWindowState`.
     */
    [IPC.windowMinimize]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => {
        // `minimize()` on a full-screen window is ignored by macOS and leaves
        // the user in full screen with a button that did nothing. Leave first.
        if (context.window?.isFullScreen() === true) context.window.setFullScreen(false);
        context.window?.minimize();
        return { state: readWindowState(context.window) };
      },
    },

    /**
     * One button, so one channel.
     *
     * On macOS the *native* green button toggles full screen rather than
     * maximizing, and this deliberately does not: it is the Windows and Linux
     * maximize control, and macOS reaches full screen through its own traffic
     * lights, which are still AppKit's.
     */
    [IPC.windowToggleMaximize]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => {
        const window = context.window;
        if (window !== null && !window.isDestroyed()) {
          if (window.isMaximized()) window.unmaximize();
          else window.maximize();
        }
        return { state: readWindowState(window) };
      },
    },

    /**
     * The reply is read off the window *before* it is asked to close, because
     * a moment later there may be no window to read. Nothing consumes it — see
     * `ArtemisBridge.window.close` — but returning the state of a destroyed
     * window as though it were the outcome would be a small lie in a response
     * whose whole contract is "here is what actually happened".
     */
    [IPC.windowClose]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => {
        const state = readWindowState(context.window);
        context.window?.close();
        return { state };
      },
    },

    [IPC.windowState]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => ({ state: readWindowState(context.window) }),
    },

    /* ---------------------------------------------------------------- */
    /* Updates                                                          */
    /* ---------------------------------------------------------------- */

    /**
     * Three channels, one shape of answer: the updater's state now, so the
     * banner never assumes a command landed — the same contract as the window
     * channels. Note what the requests *cannot* say: no URL, no path, no
     * version to install. The renderer can consent to what main found, and
     * silence one version, and that is all.
     */
    [IPC.updatesState]: {
      validate: validateUpdatesState,
      handle: async () => ({ state: updater.state() }),
    },

    [IPC.updatesInstall]: {
      validate: validateUpdatesInstall,
      handle: async () => ({ state: updater.install() }),
    },

    /**
     * The only way a restart happens. `install` parks at `ready` and stays
     * there — across hours, or forever — until this channel is invoked by the
     * user's own click. At any phase but `ready` it is a read.
     */
    [IPC.updatesRestart]: {
      validate: validateUpdatesRestart,
      handle: async () => ({ state: updater.restart() }),
    },

    [IPC.updatesDismiss]: {
      validate: validateUpdatesDismiss,
      handle: async (request) => ({ state: await updater.dismiss(request.version) }),
    },
  };

  /**
   * Validate, run, scan, wrap.
   *
   * Generic in the channel so that `validate`'s output and `handle`'s input are
   * the same type — the map above is what proves they line up.
   */
  const dispatch = async <C extends IpcChannel>(
    channel: C,
    event: IpcMainInvokeEvent,
    raw: unknown,
  ): Promise<IpcHandlerResult<C>> => {
    try {
      assertTrustedSender(event, policy);

      const implementation = handlers[channel];
      const request = implementation.validate(raw);
      const value = await implementation.handle(request, {
        window: BrowserWindow.fromWebContents(event.sender),
      });

      // The tripwire. Everything above this line is "we believe the response is
      // renderer-safe"; this line is what makes it true.
      assertNoSecrets(value, channel, RESPONSE_SCAN_POLICY);

      return ipcOk(toCloneable(value, channel));
    } catch (error) {
      // The full error — stack and all — stays here. What crosses is a code and
      // a scrubbed message.
      log.error(`Handler for ${channel} failed`, error);
      return ipcFail(toIpcError(error, channel));
    }
  };

  const register = <C extends IpcChannel>(channel: C): void => {
    ipcMain.handle(channel, (event, raw: unknown) => dispatch(channel, event, raw));
  };

  for (const channel of IPC_CHANNELS) register(channel);

  log.info(`Registered ${IPC_CHANNELS.length} IPC channels.`);

  return {
    dispose(): void {
      for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Directory picker                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ask the OS for a directory.
 *
 * Parented to the requesting window when there is one, so the dialog is modal
 * to Artemis rather than floating free (and, on macOS, sheets onto the window it
 * is blocking). A destroyed window falls back to an app-modal dialog instead of
 * failing: the user asked for a folder, and losing the parent is not a reason
 * to refuse.
 *
 * The result is validated twice, for two different failure modes:
 *
 *  1. {@link readPickedDirectory} — is this a path at all, or a cancel?
 *  2. `checkWorkingDirectory` — is it a directory that exists and can be
 *     entered *right now*? A picker makes that near-certain, but "near" is not
 *     "certain": the user can create a folder in the dialog on a volume that
 *     unmounts, or pick one over a network mount that has just dropped. The
 *     alternative is finding out at `spawn` time, where a bad cwd raises the
 *     same `ENOENT` as a missing binary and gets blamed on the binary.
 *
 * Cancelling resolves `null`, which is an ordinary success. Only a genuinely
 * unusable path is an error.
 */
async function pickDirectory(
  request: WorkspacePickDirectoryRequest,
  window: BrowserWindow | null,
): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose a working directory',
    buttonLabel: 'Use this folder',
    // Spread from the shared constant so the two properties that make this a
    // *directory* picker cannot drift.
    properties: [...DIRECTORY_PICKER_PROPERTIES],
    ...(request.defaultPath === undefined ? {} : { defaultPath: request.defaultPath }),
  };

  const outcome =
    window === null || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);

  const picked = readPickedDirectory(outcome);
  if (picked === null) return null;

  const check = await checkWorkingDirectory(picked);
  if (!check.ok) throw new WorkspaceError(check.message);
  return check.path;
}

/**
 * Reduce a response to plain, structured-cloneable data.
 *
 * Electron clones every IPC payload anyway, so this changes nothing the
 * renderer sees. What it changes is *where a mistake surfaces*: if a handler
 * returns a class instance, a `Map`, or an object carrying a method, Electron's
 * own clone fails inside `invoke` and the renderer receives an opaque
 * `An object could not be cloned` rejection with no indication of which channel
 * or field caused it. Doing it here names the channel and keeps the diagnosis
 * in the main process.
 *
 * It is also a second, structural scrub: a getter that would have recomputed a
 * secret cannot survive a clone.
 */
function toCloneable<T>(value: T, channel: IpcChannel): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error(
      `The handler for ${channel} returned a value that cannot cross IPC. ` +
        'Responses must be plain JSON-like data — no class instances, Maps, Sets or functions. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Reject anything that is not Artemis's own top-level frame.
 *
 * `senderFrame` can be null when the frame died between sending and being
 * handled, and reading `.url` on a destroyed frame throws — both are treated as
 * untrusted, because there is nothing useful to do with a message whose origin
 * cannot be established.
 */
function assertTrustedSender(event: IpcMainInvokeEvent, policy: SecurityPolicy): void {
  const frame = event.senderFrame;
  if (!frame) throw new UntrustedSenderError('the sending frame no longer exists');

  let isMainFrame = false;
  let url: string | undefined;
  try {
    isMainFrame = frame === event.sender.mainFrame;
    url = frame.url;
  } catch {
    throw new UntrustedSenderError('the sending frame could not be inspected');
  }

  if (!isTrustedFrame(url, isMainFrame, policy)) {
    throw new UntrustedSenderError(isMainFrame ? 'the frame is at an unexpected URL' : 'the sender is a subframe');
  }
}

/* -------------------------------------------------------------------------- */
/* Event forwarding                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deliver one payload to every open window.
 *
 * Deliberately dumb: it does not scan, because the two callers scan under
 * *different* policies and which one applies is a property of the payload
 * rather than of the delivery. Callers scan first, then hand the result here.
 *
 * A window closing mid-send is routine — a user quitting while a run streams —
 * so a failed delivery is logged at debug and the remaining windows still get
 * theirs.
 */
export function broadcast(channel: IpcPushChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const contents: WebContents = window.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send(channel, payload);
    } catch (error) {
      log.debug(`Failed to deliver a ${channel} payload to a window`, error);
    }
  }
}

/**
 * Push the engine's event stream at every open window.
 *
 * Events are scanned before they are sent, with the looser
 * {@link EVENT_SCAN_POLICY}: model output and tool results are content and are
 * exempt from the credential patterns, but no profile field may appear on an
 * event at any depth.
 *
 * A failing event is dropped rather than thrown, and the failure is logged.
 * Dropping one event degrades a transcript; letting a credential-bearing event
 * through does not degrade anything, it just leaks.
 */
export function forwardAgentEvents(engine: EngineHost): Unsubscribe {
  if (!engine.ready) return () => undefined;

  const send = (event: AgentEvent): void => {
    try {
      assertNoSecrets(event, IPC_PUSH.agentEvent, EVENT_SCAN_POLICY);
    } catch (error) {
      log.error(`Dropped a ${event.type} event that failed its credential-safety check`, error);
      return;
    }

    broadcast(IPC_PUSH.agentEvent, event);
  };

  return engine.require().subscribe(send);
}
