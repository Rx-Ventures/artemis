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

import { profilesRoot } from '@rx-artemis/core';

import { EngineHost } from './engine.js';
import { forwardAgentEvents, registerIpcHandlers, type IpcLayer } from './ipc.js';
import { createLogger } from './log.js';
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
const APP_USER_MODEL_ID = 'dev.artemis.app';

/**
 * Set before anything reads a path.
 *
 * `app.getPath('userData')` is derived from the app name, and the package is
 * called `@rx-artemis/desktop` — which would put user data in a nested
 * `@rx-artemis/desktop` directory and name the OS keychain entry after it. Naming
 * the app here keeps the credential store's identity stable and legible.
 */
app.setName('Artemis');

/**
 * Every name this app has shipped under, newest first.
 *
 * `app.getPath('userData')` is derived from the app name, so each rename
 * silently pointed the app at an empty directory and lost every profile and
 * every session history the user had. This list is how the current build finds
 * the one it left behind.
 *
 * **Append to the front, never edit or remove an entry.** A user who skipped a
 * version upgrades straight from whichever name they last ran, and dropping an
 * entry is indistinguishable from deleting their data. Libra is two names back
 * and still has to be here for exactly that reason.
 */
const PREVIOUS_APP_NAMES = ['Apollo', 'Libra'] as const;

/**
 * Adopt the user data left behind by a previous name.
 *
 * Moves the newest surviving directory across, once, on the first launch that
 * finds one — newest first, because someone who ran Apollo *and* Libra has
 * stale Libra data sitting beside the directory they actually care about, and
 * taking the older one would silently roll them back.
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
    // Never overwrite data this name already has: whatever is here now is
    // newer than anything an older name left behind.
    if (existsSync(current)) return;

    const parent = dirname(current);
    for (const name of PREVIOUS_APP_NAMES) {
      const previous = join(parent, name);
      if (previous === current || !existsSync(previous)) continue;

      renameSync(previous, current);
      // Nothing reads this any more, and nothing can. See above.
      rmSync(join(current, 'secrets.v1.json'), { force: true });
      log.info(`Adopted user data from the previous app name: ${previous} → ${current}`);
      return;
    }
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
    webPreferences: windowSecurityPreferences(preloadPath, [
      `--artemis-version=${app.getVersion()}`,
      `--artemis-platform=${process.platform}`,
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

  ipcLayer = registerIpcHandlers({ engine: engineHost, policy });
  stopEventForwarding = forwardAgentEvents(engineHost);

  createWindow(policy);

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
