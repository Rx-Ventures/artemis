/**
 * The application shell.
 * ============================================================================
 *
 * A header over a floating sidebar and a working column, over one status line:
 *
 *     +------------------------------------------------------------------+
 *     | [◧]  artemis › Wire the adapter seam              [+]  [⚙]  HEADER  |
 *     +------------------------------------------------------------------+
 *     |  ╭──────────────────╮ |                                          |
 *     |  │ [+ New session][◧]│ |  TRANSCRIPT   (scrolls, streams)         |
 *     |  │ ── artemis · 22 ─│ |                                          |
 *     |  │  this project    │ +------------------------------------------+
 *     |  │  only            │ |  COMPOSER                                |
 *     |  │ ⌂ All projects ▴ │ |------------------------------------------|
 *     |  ╰──────────────────╯ |  STATUS (profile·model·effort·directory)  |
 *     +------------------------------------------------------------------+
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
import { Composer } from './components/Composer';
import { ErrorSurface } from './components/ErrorSurface';
import { RunInfoDialog } from './components/RunInfoDialog';
import { SettingsDialog } from './components/settings';
import { Sidebar } from './components/Sidebar';
import { StatusLine } from './components/StatusLine';
import { Transcript } from './components/Transcript';
import { LogoMark } from './components/logo';
import {
  bootstrap,
  closeSettings,
  denyPendingPermission,
  installEventBridge,
  startSessionFeed,
  interruptRun,
  isLive,
  newSession,
  openSettings,
  setInfo,
  setPalette,
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
    if (!started.current) {
      started.current = true;
      void bootstrap();
    }
    return () => {
      unsubscribe();
      stopFeed();
    };
  }, []);

  useHotkeys({
    /*
     * `!` — fires even from inside a text field. The palette has to be
     * reachable from the composer, which is where the caret spends its life.
     */
    '!mod+k': () => {
      // Never over a permission prompt: the run is parked and the answer is
      // owed. Opening a palette on top of it would put a scrim over the one
      // thing that unblocks the agent.
      if (useApp.getState().permissionQueue.length > 0) return;
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
      // A parked prompt owns Escape. Denying is the safe answer and it unblocks
      // the provider; interrupting a run that owes a decision would strand it.
      if (state.permissionQueue.length > 0) {
        void denyPendingPermission();
        return;
      }
      if (state.screen === 'profiles') {
        closeSettings();
        return;
      }
      if (isLive(state)) void interruptRun();
    },
    'mod+n': newSession,
    'mod+b': toggleSidebar,
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
        <main className="flex min-w-0 min-h-0 flex-1 flex-col">
          <ErrorSurface />
          <Transcript />
          {/*
            The controls belong to the input, not to the window. Sitting them
            directly under the composer — rather than in a bar spanning the
            whole app, sidebar included — keeps "what will this prompt do"
            (profile, model, thinking, directory) adjacent to the box you type
            it into, instead of in furniture at the edge of the screen.
          */}
          <Composer />
          <StatusLine />
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
