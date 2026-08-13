/**
 * The macOS application menu.
 *
 *      Artemis
 *      ├ About Artemis
 *      ├ ─────────────────────
 *      ├ Settings…
 *      ├ Check for Updates…      ← the reason this file exists
 *      ├ ─────────────────────
 *      ├ Services              ▸
 *      └ …Hide / Quit
 *
 * ## Why the whole menu, to add one item
 *
 * Artemis had no application menu at all: Electron installs a default one when
 * nothing else is set, and that default is where ⌘C, ⌘V, ⌘Z, ⌘W, ⌘M and ⌘Q
 * have been coming from all along. On macOS those keys are menu items — the
 * roles below are what binds them, not the OS and not Chromium. So the moment
 * anything calls `setApplicationMenu`, every one of them has to be named again
 * or it stops working, and the symptom is not a missing menu, it is copy and
 * paste dying in the composer.
 *
 * That is the whole reason this file is longer than the one item it adds. The
 * roles are Electron's defaults, reproduced deliberately rather than inherited,
 * and the only additions are the update item and its separator.
 *
 * ## What is deliberately *not* here
 *
 * No File → New, and **no accelerators on anything the renderer already binds**.
 * `mod+n` and `mod+,` are the renderer's (`useHotkeys`), and a menu accelerator
 * wins against a `keydown` listener — so naming either here would take the
 * shortcut away from the code that implements it and hand it to a menu item
 * that does nothing. The renderer's other bindings (`mod+b`, `mod+i`, `mod+\`)
 * collide with nothing below.
 *
 * Settings… is the one item that tests that rule rather than avoiding it. It is
 * in the menu, because a menu bar with no way to reach settings is a menu bar
 * people stop opening — but it carries *no* `⌘,`, so the renderer keeps the key
 * and keeps the toggle it implements. The item opens; it does not close.
 *
 * ## macOS only
 *
 * Other platforms keep Electron's default menu, and the window they open hides
 * the menu bar anyway (`autoHideMenuBar`). The item would also be a lie there:
 * the updater's swap is written in macOS terms and `start()` refuses to run on
 * anything else — see `updater.ts`.
 */

import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';

import { createLogger } from './log.js';
import type { CheckOutcome, Updater } from './updater.js';

const log = createLogger('menu');

export interface ApplicationMenuOptions {
  readonly updater: Updater;
  /**
   * Runs when Settings… is picked. Main cannot open the dialog itself — it is
   * renderer state — so `index.ts` passes a function that pushes the ask over
   * {@link IPC_PUSH.menuOpenSettings}.
   */
  readonly onOpenSettings: () => void;
}

/**
 * What to tell the user about a finished check, or null when the outcome has
 * already spoken for itself.
 *
 * `offered` is the null: the state went to `available`, which puts the update
 * card at the foot of the sidebar (or the strip under the header, if the
 * sidebar is collapsed). A dialog on top of that would be the same news twice,
 * and the card is the surface that can actually act on it.
 *
 * Every other outcome leaves the screen exactly as it was, which is
 * indistinguishable from the menu item having done nothing at all. Those get a
 * dialog, because a question asked out loud is owed an answer even when the
 * answer is "nothing changed".
 */
export function checkOutcomeNotice(
  outcome: CheckOutcome,
  runningVersion: string,
): { readonly message: string; readonly detail: string } | null {
  switch (outcome.kind) {
    case 'offered':
      return null;
    case 'current':
      return {
        message: 'Artemis is up to date.',
        detail: `You are running version ${runningVersion}.`,
      };
    case 'unreachable':
      return {
        message: 'Artemis could not check for updates.',
        detail:
          'Releases are public and need no account, so this is almost always the network: ' +
          'check your connection, or whether a proxy sits between you and github.com, then try ' +
          'again. The releases page always works as the manual path.',
      };
    case 'busy':
      return {
        message: 'An update is already under way.',
        detail: 'The update card at the foot of the sidebar has the details.',
      };
    case 'unsupported':
      // The menu is macOS-only, so the platform half of `supported()` cannot be
      // what failed here — this is always the development build.
      return {
        message: 'This build cannot update itself.',
        detail:
          'Updates replace an installed copy of Artemis. This one is running from a development ' +
          'build, where the "installed app" is the repository checkout.',
      };
  }
}

/**
 * The menu, as data.
 *
 * Pure and separate from installing it so the shape can be asserted in a test —
 * specifically that the Edit roles survive, which is the thing that silently
 * breaks if someone trims this template down to the item they cared about.
 */
export function applicationMenuTemplate(options: {
  readonly appName: string;
  /** Disables the update item and says why, while a check is in flight. */
  readonly checking: boolean;
  readonly onCheckForUpdates: () => void;
  readonly onOpenSettings: () => void;
}): MenuItemConstructorOptions[] {
  const { appName, checking, onCheckForUpdates, onOpenSettings } = options;

  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          // Above Check for Updates…, not in macOS's usual Settings slot below
          // it, because that is where this app wants it.
          //
          // **No accelerator, deliberately.** `⌘,` belongs to the renderer's
          // `useHotkeys`, where it *toggles* — it closes Settings when Settings
          // are already open. A menu accelerator wins against a `keydown`
          // listener, so naming `⌘,` here would silently replace that toggle
          // with an open-only item. The click opens; the key keeps doing the
          // better thing.
          id: 'open-settings',
          label: 'Settings…',
          click: onOpenSettings,
        },
        {
          // Under About, above Services: where macOS has put this item since
          // long before Sparkle made it a convention, and the first place
          // anyone looks for it.
          id: 'check-for-updates',
          label: checking ? 'Checking for Updates…' : 'Check for Updates…',
          enabled: !checking,
          click: onCheckForUpdates,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'File', submenu: [{ role: 'close' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Speech',
          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' },
      ],
    },
  ];
}

/**
 * Build the menu and install it. macOS only; a no-op everywhere else.
 *
 * Safe to call again — it is, every time a check starts and ends, because the
 * item's own label is where "this is running" is reported. A menu that answered
 * a click with nothing at all for the several seconds `gh` takes would read as
 * a dead control, and the alternative (a spinner somewhere in the window) puts
 * the feedback in a different place from the thing that was clicked.
 */
export function installApplicationMenu(options: ApplicationMenuOptions): void {
  if (process.platform !== 'darwin') return;

  let checking = false;

  const render = (): void => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        applicationMenuTemplate({
          appName: app.name,
          checking,
          onCheckForUpdates: () => void runCheck(),
          onOpenSettings: options.onOpenSettings,
        }),
      ),
    );
  };

  const runCheck = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    render();
    try {
      const outcome = await options.updater.checkNow();
      const notice = checkOutcomeNotice(outcome, app.getVersion());
      if (notice === null) return;
      const parent = BrowserWindow.getFocusedWindow();
      const box = { type: 'info' as const, buttons: ['OK'], ...notice };
      // Sheet on the window when there is one, free-floating when there is not
      // (every window closed, app still running — the macOS default).
      await (parent === null ? dialog.showMessageBox(box) : dialog.showMessageBox(parent, box));
    } catch (error) {
      // checkNow swallows its own failures into an outcome, so reaching here
      // means something unforeseen. Losing a menu click is not worth a dialog.
      log.error('The manual update check threw.', error);
    } finally {
      checking = false;
      render();
    }
  };

  render();
}
