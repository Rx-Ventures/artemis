/**
 * The application shell.
 * ============================================================================
 *
 * A sidebar and a working column, over one status line:
 *
 *     +------------------+----------------------------------+
 *     | [ + New session ]|  TRANSCRIPT   (scrolls, streams)  |
 *     |  ~/code/libra    |                                   |
 *     |  ── sessions ──  |                                   |
 *     |  grouped by      +----------------------------------+
 *     |  project         |  COMPOSER                         |
 *     +------------------+----------------------------------+
 *     |  STATUS LINE  (profile · model · thinking · mode · ~)|
 *     +------------------------------------------------------+
 *
 * ## The status line spans the full width, deliberately
 *
 * Every segment on it — profile, model, thinking effort, permission mode,
 * working directory — describes what the *next run* will do. None of it is a
 * property of the transcript pane, and all of it applies just as much when a
 * session is picked in the sidebar as when a prompt is typed in the composer.
 * Scoping it to the right-hand column would have implied otherwise, and would
 * have left a dead corner under the sidebar. Running it edge to edge also gives
 * the sidebar toggle a permanent home, so a collapsed sidebar is always one
 * click from coming back.
 *
 * ## What stayed where it was
 *
 *  - tool input, output and diffs        → expand in place, in the transcript
 *  - permission prompts                  → inline, where they happened, so a
 *                                          failed decision is reported
 *                                          somewhere the user is looking
 *  - run facts and the capability matrix → the run inspector dialog
 *  - every command, and session search   → still ⌘K. Sessions now live in the
 *                                          sidebar as well; the palette remains
 *                                          the keyboard route to them.
 *
 * ## Performance
 *
 * The sidebar is a sibling of the transcript, not an ancestor, and nothing in
 * it reads the transcript store. Streaming deltas are delivered to leaf rows by
 * an external store React never sees (`state/transcript.ts`), so adding a
 * persistent pane put no work on the per-token path. Do not lift transcript
 * state up into this component to share it with the sidebar.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { useHotkeys } from './hooks/useHotkeys';
import { CommandPalette } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { ErrorSurface } from './components/ErrorSurface';
import { ProfilesScreen } from './components/ProfilesScreen';
import { RunInfoDialog } from './components/RunInfoDialog';
import { Sidebar } from './components/Sidebar';
import { StatusLine } from './components/StatusLine';
import { Transcript } from './components/Transcript';
import { LogoMark } from './components/logo';
import {
  bootstrap,
  denyPendingPermission,
  installEventBridge,
  interruptRun,
  isLive,
  newSession,
  setInfo,
  setPalette,
  setScreen,
  toggleSidebar,
  togglePalette,
  useApp,
} from './state/store';

export function App(): ReactElement {
  const bridgeMode = useApp((s) => s.bridgeMode);
  const booted = useApp((s) => s.booted);
  const screen = useApp((s) => s.screen);
  const started = useRef(false);

  /**
   * Subscribe *before* bootstrapping. Events for a run can arrive before the
   * call that started it resolves, and a listener installed afterwards would
   * miss the beginning of the stream.
   */
  useEffect(() => {
    const unsubscribe = installEventBridge();
    if (!started.current) {
      started.current = true;
      void bootstrap();
    }
    return unsubscribe;
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
        setScreen('chat');
        return;
      }
      if (isLive(state)) void interruptRun();
    },
    'mod+n': newSession,
    'mod+b': toggleSidebar,
    'mod+,': () => setScreen(useApp.getState().screen === 'profiles' ? 'chat' : 'profiles'),
    'mod+i': () => setInfo(!useApp.getState().infoOpen),
  });

  if (booted && bridgeMode === 'unavailable') return <DeadEnd />;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-abyss">
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
      {screen === 'profiles' ? <ProfilesScreen /> : null}
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
      <h1 className="text-lg font-semibold tracking-tight text-ink">Libra could not start</h1>
      <p className="max-w-md text-xs leading-relaxed text-ink-muted">
        The preload bridge is missing, so this window has no way to reach the main process. Nothing
        in the interface would work. Restart Libra; if it keeps happening, the app’s preload script
        failed to load.
      </p>
    </div>
  );
}
