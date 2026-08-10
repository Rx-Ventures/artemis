/**
 * Libra — Electron main process.
 *
 * This process owns everything the renderer is not allowed to touch: decrypted
 * API keys, the filesystem, and the engine that drives agent runs. It is the
 * only place in Libra where a credential exists in plaintext, and then only for
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
 * A failure at step 2 or 4 does not stop the app. Libra opens anyway and tells
 * the user what is wrong — an app that refuses to launch cannot explain itself.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, nativeTheme, session } from 'electron';

import { profilesRoot } from '@libra/core';

import { EngineHost } from './engine.js';
import { forwardAgentEvents, registerIpcHandlers, type IpcLayer } from './ipc.js';
import { createLogger } from './log.js';
import { createSecretStore, probeEncryption, type EncryptionProbe, type SecretStore } from './secrets.js';
import {
  applySessionPolicy,
  hardenWebContents,
  installNetworkAuthGuard,
  windowSecurityPreferences,
  type SecurityPolicy,
} from './security.js';

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
const APP_USER_MODEL_ID = 'dev.libra.app';

/**
 * Set before anything reads a path.
 *
 * `app.getPath('userData')` is derived from the app name, and the package is
 * called `@libra/desktop` — which would put user data in a nested
 * `@libra/desktop` directory and name the OS keychain entry after it. Naming
 * the app here keeps the credential store's identity stable and legible.
 */
app.setName('Libra');

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
    title: 'Libra',
    // Painting the window before the renderer has anything to show produces a
    // white flash on a dark desktop. Start hidden, reveal on `ready-to-show`.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: windowSecurityPreferences(preloadPath, [
      `--libra-version=${app.getVersion()}`,
      `--libra-platform=${process.platform}`,
    ]),
  });

  window.once('ready-to-show', () => window.show());

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

/**
 * Tell the user, in a dialog, when credentials cannot be stored.
 *
 * This is the surfaced half of the "never silently fall back to plaintext"
 * rule. Libra could make key storage *appear* to work by calling
 * `safeStorage.setUsePlainTextEncryption(true)`; it does not, so the user has to
 * be told why the profile editor is going to refuse their key.
 */
function reportEncryptionProblem(probe: EncryptionProbe): void {
  if (probe.available) return;
  log.error(`Encrypted credential storage is unavailable: ${probe.detail ?? 'unknown reason'}`);
  dialog.showErrorBox(
    'Libra cannot store API keys securely',
    `${probe.detail ?? 'This machine has no usable credential store.'}\n\n` +
      'Libra will not save an API key in plaintext, so profiles cannot be created until this is fixed. ' +
      'Everything else in the app will continue to work.',
  );
}

function reportEngineProblem(): void {
  if (engineHost.ready) return;
  const detail = engineHost.failureMessage ?? 'The engine did not start.';
  log.error(`Engine unavailable: ${detail}`);
  dialog.showErrorBox(
    'Libra could not start its engine',
    `${detail}\n\nRuns and profiles are unavailable. If you are running from source, build the workspace ` +
      'packages first (`pnpm build:libs`) and restart Libra.',
  );
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A second `libra` process should raise the first one's window, not open a
 * second copy with a second engine writing the same profile file.
 */
if (!app.requestSingleInstanceLock()) {
  log.info('Another Libra instance is already running; exiting.');
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

  const probe = probeEncryption();
  const secrets: SecretStore = createSecretStore({ probe });
  if (probe.backend) log.info(`Credential storage backend: ${probe.backend}`);

  const userDataDir = app.getPath('userData');
  // Per-profile `CLAUDE_CONFIG_DIR`s live under `<userData>/profiles/<name>` and
  // hold session transcripts. Core creates each one on demand; the root is
  // created here so it is owner-only rather than inheriting the process umask.
  await mkdir(profilesRoot(userDataDir), { recursive: true, mode: 0o700 }).catch((error: unknown) => {
    log.error('Could not create the profiles directory', error);
  });

  await engineHost.start({ secrets, userDataDir, appVersion: app.getVersion() });

  ipcLayer = registerIpcHandlers({ engine: engineHost, secrets, policy });
  stopEventForwarding = forwardAgentEvents(engineHost);

  createWindow(policy);

  reportEncryptionProblem(probe);
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
