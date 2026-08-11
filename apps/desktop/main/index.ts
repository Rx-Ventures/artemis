/**
 * Artemis — Electron main process.
 *
 * This process owns everything the renderer is not allowed to touch: decrypted
 * API keys, the filesystem, and the engine that drives agent runs. It is the
 * only place in Artemis where a credential exists in plaintext, and then only for
 * as long as it takes to hand it to a provider's environment bundle.
 *
 * Startup order matters and is deliberate:
 *
 *  1. Sandbox and single-instance locks, before the app is ready — both are
 *     no-ops if set later.
 *  2. Probe the OS credential store, so a machine that cannot encrypt is
 *     discovered before the user types a key into a form that will then fail.
 *  3. Apply session-wide security policy *before* any window exists, so no
 *     window is ever briefly unprotected.
 *  4. Start the engine, register IPC, and only then open a window.
 *
 * A failure at step 2 or 4 does not stop the app. Artemis opens anyway and tells
 * the user what is wrong — an app that refuses to launch cannot explain itself.
 */

import { existsSync, renameSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, nativeTheme, session } from 'electron';

import { IPC_PUSH } from '@rx-artemis/protocol';

import { profilesRoot } from '@rx-artemis/core';

import { APP_NAME, previousUserDataDir } from './appNames.js';
import { EngineHost } from './engine.js';
import { broadcast, forwardAgentEvents, registerIpcHandlers, type IpcLayer } from './ipc.js';
import { createLogger } from './log.js';
import { startPlanUsagePolling } from './planUsagePoll.js';
import { createUpdater } from './updater.js';
import {
  applySessionPolicy,
  hardenWebContents,
  installNetworkAuthGuard,
  windowSecurityPreferences,
  type SecurityPolicy,
} from './security.js';
import { forwardWindowState, windowChromeOptions } from './window.js';

const log = createLogger('main');

/**
 * Windows application identity.
 *
 * **Kept in sync by hand with `appId` in `apps/desktop/electron-builder.yml`.**
 * There is no runtime accessor for the builder's `appId` — it is baked into the
 * installer, not into anything the app can read back — so the string exists
 * twice and this comment is the link between them. Change one, change the
 * other, or Windows treats the running app and its installed shortcut as two
 * unrelated applications.
 */
const APP_USER_MODEL_ID = 'dev.artemis.app';

/**
 * Set before anything reads a path. See `appNames.ts` for why the name matters
 * and for the rule that governs changing it.
 */
app.setName(APP_NAME);

/**
 * Adopt the user data left behind by a previous name.
 *
 * Moves the newest surviving directory across, once, on the first launch that
 * finds one. Which one that is, and why the list of candidates only ever grows,
 * is in `appNames.ts`.
 *
 * ## `secrets.v1.json` is deleted rather than carried
 *
 * Artemis no longer has a secret store — the provider's own CLI holds the
 * credential, inside the profile's config directory, which *does* come across
 * with the rename. So the old encrypted file has nothing to be read by. It is
 * removed rather than left in place, because a file of undecryptable
 * ciphertext sitting in the user-data directory invites exactly one question
 * later ("what is this, and does it still matter?") whose answer is "no". Only
 * a Libra-era directory can still contain one; the call is unconditional
 * because `force` makes a miss free and a special case would need a comment
 * longer than the line it saved.
 *
 * Runs before `app.whenReady()` and synchronously, because everything that
 * follows reads `userData`. A failure is logged and swallowed — a migration
 * that cannot complete must not stop the app from starting, it must only mean
 * the user starts fresh.
 */
function adoptPreviousUserData(): void {
  const current = app.getPath('userData');

  try {
    const previous = previousUserDataDir(dirname(current), current, existsSync, join);
    if (previous === null) return;

    renameSync(previous, current);
    // Nothing reads this any more, and nothing can. See above.
    rmSync(join(current, 'secrets.v1.json'), { force: true });
    log.info(`Adopted user data from the previous app name: ${previous} → ${current}`);
  } catch (error) {
    log.error('Could not adopt user data from the previous app name', error);
  }
}

adoptPreviousUserData();

/**
 * Force the sandbox on for every renderer, including any created later by code
 * that forgets to ask for it. Must run before `app.whenReady()`.
 */
app.enableSandbox();

/** Directory containing the built main bundle (`out/main`). */
const distributionDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite's dev server, when running under `electron-vite dev`.
 *
 * Its presence is what distinguishes development from a packaged app
 * everywhere in this process — including which Content-Security-Policy is
 * applied, so it is read once and threaded through rather than re-derived.
 */
const devServerUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;

let ipcLayer: IpcLayer | null = null;
let stopEventForwarding: (() => void) | null = null;
let stopPlanUsagePolling: (() => void) | null = null;
let stopUpdater: (() => void) | null = null;
const engineHost = new EngineHost();

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

function buildSecurityPolicy(): SecurityPolicy {
  const rendererEntry = join(distributionDir, '..', 'renderer', 'index.html');
  return {
    devServerOrigin: devServerUrl ? new URL(devServerUrl).origin : null,
    rendererFileUrl: pathToFileURL(rendererEntry).toString(),
  };
}

function createWindow(policy: SecurityPolicy): BrowserWindow {
  const preloadPath = join(distributionDir, '..', 'preload', 'index.cjs');

  const window = new BrowserWindow({
    width: 1_280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'Artemis',
    // Painting the window before the renderer has anything to show produces a
    // white flash on a dark desktop. Start hidden, reveal on `ready-to-show`.
    show: false,
    // Hex, and the one colour in this app that lives outside index.css: it is
    // read by Chromium before any stylesheet exists, so it cannot be a token.
    // Keep it equal to `--abyss` — it is what fills the window for the frame or
    // two before the renderer paints, and a mismatch shows up as a flash of the
    // wrong dark.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0a09' : '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    // No native title bar: the app's own header is the title bar. What that
    // costs, and what has to be drawn in its place, is in `window.ts`.
    ...windowChromeOptions(),
    webPreferences: windowSecurityPreferences(preloadPath, [
      `--artemis-version=${app.getVersion()}`,
      `--artemis-platform=${process.platform}`,
    ]),
  });

  window.once('ready-to-show', () => window.show());

  // Maximized, full screen and focused are invisible from inside the page, and
  // the header draws with all three. The listeners die with the window, so the
  // disposer is deliberately dropped rather than tracked.
  forwardWindowState(window);

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(join(distributionDir, '..', 'renderer', 'index.html'));
  }

  // `app.on('web-contents-created')` already hardened this one. Calling again
  // is a deliberate belt-and-braces: `hardenWebContents` is idempotent, and a
  // future refactor that drops the app-level hook should not silently produce
  // an unguarded window.
  hardenWebContents(window.webContents, policy);

  return window;
}

function focusExistingWindow(): void {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
}

/* -------------------------------------------------------------------------- */
/* Startup diagnostics                                                        */
/* -------------------------------------------------------------------------- */

function reportEngineProblem(): void {
  if (engineHost.ready) return;
  const detail = engineHost.failureMessage ?? 'The engine did not start.';
  log.error(`Engine unavailable: ${detail}`);
  dialog.showErrorBox(
    'Artemis could not start its engine',
    `${detail}\n\nRuns and profiles are unavailable. If you are running from source, build the workspace ` +
      'packages first (`pnpm build:libs`) and restart Artemis.',
  );
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A second `artemis` process should raise the first one's window, not open a
 * second copy with a second engine writing the same profile file.
 */
if (!app.requestSingleInstanceLock()) {
  log.info('Another Artemis instance is already running; exiting.');
  app.quit();
} else {
  app.on('second-instance', focusExistingWindow);
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Windows uses this to group taskbar entries and route notifications.
  //
  // This must be byte-identical to `appId` in electron-builder.yml. The NSIS
  // installer stamps that value onto the Start Menu shortcut, and Windows
  // matches a running process to its shortcut by AUMID alone: a mismatch means
  // the live window does not coalesce with the installed entry, pinning it
  // creates a second pin, and notifications are dropped because the Action
  // Center cannot resolve the id to a shortcut.
  app.setAppUserModelId(APP_USER_MODEL_ID);

  const policy = buildSecurityPolicy();

  // Order matters: the session policy and the `web-contents-created` hook are
  // installed before any window exists, so there is no window that was ever
  // unprotected — not even for one paint.
  applySessionPolicy(session.defaultSession, policy);
  installNetworkAuthGuard(app);
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, policy));

  const userDataDir = app.getPath('userData');
  // Where Artemis's *suggested* config directories live. A profile may point
  // anywhere, but the suggestions land here and hold real logins and
  // transcripts, so the root is created owner-only rather than inheriting the
  // process umask. Core creates each directory inside it on demand.
  await mkdir(profilesRoot(userDataDir), { recursive: true, mode: 0o700 }).catch((error: unknown) => {
    log.error('Could not create the profiles directory', error);
  });

  await engineHost.start({ userDataDir, appVersion: app.getVersion() });

  // The updater exists before the IPC layer because the layer's handlers
  // close over it; it *starts* after the window exists so its first push has
  // somewhere to land. In dev builds start() is a no-op — see updater.ts.
  const updater = createUpdater({
    userDataDir,
    broadcast: (state) => broadcast(IPC_PUSH.updateState, state),
  });
  stopUpdater = () => updater.stop();

  ipcLayer = registerIpcHandlers({ engine: engineHost, policy, updater });
  stopEventForwarding = forwardAgentEvents(engineHost);
  // Reads every profile's plan limits on a timer, so the profile menu can say
  // which account has room. Started after IPC so its first push has somewhere
  // to land, and before the window so the schedule does not depend on how long
  // the renderer takes to boot.
  stopPlanUsagePolling = startPlanUsagePolling(engineHost);

  createWindow(policy);
  updater.start();

  reportEngineProblem();

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows open should reopen one.
    if (BrowserWindow.getAllWindows().length === 0) createWindow(policy);
  });
}

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;

  // Runs own child processes and open file handles. Give the engine a chance to
  // stop them cleanly rather than orphaning them, but do not let a hung
  // adapter make the app unquittable.
  event.preventDefault();
  stopEventForwarding?.();
  stopPlanUsagePolling?.();
  stopUpdater?.();
  ipcLayer?.dispose();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  void Promise.race([engineHost.stop(), timeout]).finally(() => {
    app.exit(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Last-resort error handling                                                 */
/* -------------------------------------------------------------------------- */

// These log through `./log.ts`, which scrubs credential-shaped strings out of
// messages and stacks. An unhandled provider error can easily carry an
// `Authorization` header in its stack; it must not reach a terminal or a crash
// report verbatim.
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception in the main process', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection in the main process', reason);
});
