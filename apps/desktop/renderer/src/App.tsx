/**
 * The application shell.
 * ============================================================================
 *
 * A header over a floating sidebar and the working area:
 *
 *     +------------------------------------------------------------------+
 *     | [◧]  artemis › Wire the adapter seam      [⊞][⊟] [+]  [⚙]  HEADER  |
 *     +------------------------------------------------------------------+
 *     |  ╭──────────────────╮ |  artemis › Wire…  ┊  api › Rate limiter  |
 *     |  │ [+ New session][◧]│ |  TRANSCRIPT       ┊  TRANSCRIPT          |
 *     |  │ ── artemis · 22 ─│ |  COMPOSER·STATUS  ┊  COMPOSER·STATUS     |
 *     |  │  this project    │ |┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈|
 *     |  │  only            │ |  cli › Flag parsing                      |
 *     |  │ ⌂ All projects ▴ │ |  TRANSCRIPT                              |
 *     |  ╰──────────────────╯ |  COMPOSER·STATUS                         |
 *     +------------------------------------------------------------------+
 *
 * ## The working area holds a grid of conversations
 *
 * A pane is a whole conversation — its own directory, account, model, run,
 * permission queue and transcript — and the window can show up to four across
 * and four down. The grid is *rows of columns* rather than a matrix, which is
 * why a third conversation added under a left/right pair spans the full width
 * instead of quartering the window. All of that lives in `WorkingArea`;
 * everything about what a pane *owns* lives in `state/pane.ts`.
 *
 * What matters here is the division of responsibility this file used to blur:
 * the header, the sidebar, the banners, the palette and the settings dialog are
 * the *window's*, and there is one of each no matter how many panes are open.
 * Each of those surfaces acts on the focused pane.
 *
 * ## The header exists so that hiding the sidebar is reversible
 *
 * `Sidebar` renders `null` when collapsed — not a rail, not a sliver — so its
 * own close button cannot bring it back. That control has to live somewhere
 * always-mounted, and "somewhere always-mounted" used to mean the status line,
 * which is the bar describing *what the next prompt will do*. Whether a pane is
 * showing is not that; it is a property of the window. So the window has a bar
 * of its own now, carrying the pane toggle, the name of what this window is
 * pointed at, and the way into settings. It is also the Electron drag region.
 *
 * ## The sidebar floats
 *
 * It is a card with a margin, a border and a shadow, sitting on the window
 * background rather than being a column welded to the frame. Everything in it
 * is scoped to one project — that is the point of the redesign — and other
 * projects are reached through an explicit switcher rather than by scrolling
 * past them.
 *
 * ## The status line belongs to the composer, not to the window
 *
 * Profile, model, thinking effort, permission mode, working directory: every
 * segment describes what the *next run* will do, so the bar lines up with the
 * input's edges inside the working column instead of spanning the app. See
 * `StatusLine`'s own header.
 *
 * The working directory is the strictest case of that rule and the reason it is
 * worth stating twice. It is a property of the session in this column — it
 * follows the session you select, and changing it ends the session rather than
 * moving one somewhere its transcript was never written. The sidebar used to
 * offer it too, one row under New session, which framed it as a standing window
 * setting the next session would inherit. It does not live there any more.
 *
 * ## What stayed where it was
 *
 *  - tool input, output and diffs        → expand in place, in the transcript
 *  - permission prompts                  → inline, where they happened, so a
 *                                          failed decision is reported
 *                                          somewhere the user is looking
 *  - run facts and the capability matrix → the run inspector dialog
 *  - every command, and session search   → still ⌘K. Sessions live in the
 *                                          sidebar as well; the palette remains
 *                                          the keyboard route to them.
 *
 * ## Performance
 *
 * The sidebar is a sibling of the transcript, not an ancestor, and nothing in
 * it reads the transcript store. Streaming deltas are delivered to leaf rows by
 * an external store React never sees (`state/transcript.ts`), so adding a
 * persistent pane put no work on the per-token path. Do not lift transcript
 * state up into this component to share it with the sidebar. The header follows
 * the same rule: it names the session, never its contents.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { useHotkeys } from './hooks/useHotkeys';
import { AppHeader } from './components/AppHeader';
import { CommandPalette } from './components/CommandPalette';
import { ErrorSurface } from './components/ErrorSurface';
import { RunInfoDialog } from './components/RunInfoDialog';
import { SettingsDialog } from './components/settings';
import { Sidebar } from './components/Sidebar';
import { WorkingArea } from './components/WorkingArea';
import { LogoMark } from './components/logo';
import { paneState } from './state/pane';
import {
  bootstrap,
  closeSettings,
  denyPendingPermission,
  focusedPane,
  installEventBridge,
  installPlanUsageFeed,
  startSessionFeed,
  interruptRun,
  isLive,
  newSession,
  openSettings,
  setInfo,
  setPalette,
  splitPane,
  toggleSidebar,
  togglePalette,
  useApp,
} from './state/store';

export function App(): ReactElement {
  const bridgeMode = useApp((s) => s.bridgeMode);
  const booted = useApp((s) => s.booted);
  const started = useRef(false);

  /**
   * Subscribe *before* bootstrapping. Events for a run can arrive before the
   * call that started it resolves, and a listener installed afterwards would
   * miss the beginning of the stream.
   */
  useEffect(() => {
    const unsubscribe = installEventBridge();
    // The sidebar's history is not only written by this window — another Artemis
    // window, or the user's own CLI in a terminal, writes into the same store.
    // The feed is what keeps the list current without a reload; see
    // `startSessionFeed`.
    const stopFeed = startSessionFeed();
    // Plan usage arrives unasked, from main's poller, for every account rather
    // than the active one — which is what lets the profile menu recommend.
    const stopUsageFeed = installPlanUsageFeed();
    if (!started.current) {
      started.current = true;
      void bootstrap();
    }
    return () => {
      unsubscribe();
      stopFeed();
      stopUsageFeed();
    };
  }, []);

  useHotkeys({
    /*
     * `!` — fires even from inside a text field. The palette has to be
     * reachable from the composer, which is where the caret spends its life.
     */
    /*
     * Every session-scoped shortcut below acts on the *focused* pane, and says
     * so by resolving `focusedPane()` itself rather than leaning on the store's
     * default argument. The difference is only legibility — the default is the
     * same pane — but a reader of this file should not have to open the store to
     * find out which of several conversations ⌘N clears.
     */
    '!mod+k': () => {
      // Never over a permission prompt: the run is parked and the answer is
      // owed. Opening a palette on top of it would put a scrim over the one
      // thing that unblocks the agent.
      if (paneState(focusedPane()).permissionQueue.length > 0) return;
      togglePalette();
    },
    escape: () => {
      const state = useApp.getState();
      if (state.paletteOpen) {
        setPalette(false);
        return;
      }
      if (state.infoOpen) {
        setInfo(false);
        return;
      }
      const pane = focusedPane(state);
      const session = paneState(pane);
      // A parked prompt owns Escape. Denying is the safe answer and it unblocks
      // the provider; interrupting a run that owes a decision would strand it.
      //
      // Only *this* pane's queue. A prompt parked in another pane is still
      // answerable on its own card, and having Escape reach across a divider
      // would deny a tool call the user is not looking at.
      if (session.permissionQueue.length > 0) {
        void denyPendingPermission(pane);
        return;
      }
      if (state.screen === 'profiles') {
        closeSettings();
        return;
      }
      if (isLive(session)) void interruptRun(pane);
    },
    'mod+n': () => newSession(focusedPane()),
    'mod+b': toggleSidebar,
    /*
     * `⌘\` splits to the right, `⌘⇧\` splits downwards.
     *
     * Two keys rather than one toggle, because the two produce different
     * layouts and neither is undone by repeating it — a third press of a
     * "toggle" would have to guess which of three panes to destroy. Closing has
     * no shortcut on purpose: with up to sixteen panes open, a keystroke that
     * ends a conversation should be aimed at a specific one, and the button on
     * each pane's caption is that aim.
     *
     * Both act on the focused pane, whose brighter caption marks it. A split
     * the grid has no room for is a no-op here; the header's buttons say why.
     */
    'mod+\\': () => splitPane('right'),
    /*
     * Two spellings for one chord, and the second is not a typo.
     *
     * `useHotkeys` builds its combo from `event.key`, which is the character
     * the keyboard *produced* — and Shift turns `\` into `|`. So a binding
     * written the way it is spoken (`mod+shift+\`) never matches anything, and
     * does so silently: no error, no warning, a shortcut that simply does
     * nothing. Registering both is the honest fix at this level; teaching
     * `describe()` to reason about physical keys would change the meaning of
     * every existing binding to solve one.
     */
    'mod+shift+\\': () => splitPane('down'),
    'mod+shift+|': () => splitPane('down'),
    /*
     * `screen === 'profiles'` still means "the settings surface is open" — the
     * value kept its historical name so that every existing call site stayed
     * correct. Which pane it shows is the separate `settingsSection`, and
     * `openSettings()` with no argument deliberately leaves that alone so the
     * shortcut reopens wherever the user last was.
     */
    'mod+,': () => {
      if (useApp.getState().screen === 'profiles') closeSettings();
      else openSettings();
    },
    'mod+i': () => setInfo(!useApp.getState().infoOpen),
  });

  if (booted && bridgeMode === 'unavailable') return <DeadEnd />;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-abyss">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/*
          The banner surface spans the working area rather than sitting inside a
          column, because a banner is the *window* reporting: "could not list
          providers", "no bridge to the main process". The failures that belong
          to one conversation are already reported inside it — a run that fails
          writes its reason into that column's transcript, and a permission
          decision that will not send says so on its own card.

          The controls under each transcript belong to the input, not to the
          window; see `WorkingArea`, which owns that arrangement now.
        */}
        <main className="flex min-w-0 min-h-0 flex-1 flex-col">
          <ErrorSurface />
          <WorkingArea />
        </main>
      </div>

      <CommandPalette />
      <RunInfoDialog />
      {/*
        Mounted unconditionally, unlike the full-screen profiles surface it
        replaces. It is a Radix dialog and reads its own open state off the
        store (`screen === 'profiles'` — see the `mod+,` note above), so
        gating it here would unmount it mid-transition and cost the close
        animation.
      */}
      <SettingsDialog />
    </div>
  );
}

/**
 * What the window shows when there is no preload script.
 *
 * The renderer has no fallback path to the outside world by design, so this is
 * genuinely terminal — better to say so plainly than to render an app whose
 * every button silently fails.
 */
function DeadEnd(): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-abyss px-8 text-center">
      <LogoMark size={30} className="text-signal" />
      <h1 className="text-lg font-semibold tracking-tight text-ink">Artemis could not start</h1>
      <p className="max-w-md text-xs leading-relaxed text-ink-muted">
        The preload bridge is missing, so this window has no way to reach the main process. Nothing
        in the interface would work. Restart Artemis; if it keeps happening, the app’s preload script
        failed to load.
      </p>
    </div>
  );
}
