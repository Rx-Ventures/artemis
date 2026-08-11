/**
 * The window's own chrome state.
 *
 * Artemis hides the native title bar and draws its own (see `main/window.ts`),
 * which leaves the header needing three facts about the window that no DOM API
 * reports: is it maximized, is it in full screen, is it focused. The main
 * process pushes all three; this hook is the renderer's end of that feed.
 *
 * Not in the app store, deliberately. Nothing here is application state — it
 * survives no reload, belongs to one window rather than to the session, and has
 * exactly one consumer. Putting it in the store would mean every subscriber
 * re-evaluating its selector each time the user dragged the window edge.
 */

import { useEffect, useState } from 'react';

import type { WindowState } from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

/**
 * What to assume until the main process answers: an ordinary, focused window.
 *
 * The optimistic choice on all three. A first paint that guessed `maximized`
 * would show a restore icon that flips to maximize a frame later, and one that
 * guessed unfocused would render the whole bar dimmed on launch — the two
 * states you are least likely to be in on the frame a window opens.
 */
const INITIAL: WindowState = { maximized: false, fullScreen: false, focused: true };

export function useWindowState(): WindowState {
  const [state, setState] = useState<WindowState>(INITIAL);

  useEffect(() => {
    const { bridge } = resolveBridge();
    if (!bridge) return;

    let live = true;
    let pushed = false;

    // Subscribe before reading, for the reason `runs.onEvent` gives: a change
    // can land while the read below is still in flight, and a listener
    // installed afterwards would miss it — leaving the header a state behind
    // until something else happened to move the window.
    const unsubscribe = bridge.window.onStateChange((next) => {
      if (!live) return;
      pushed = true;
      setState(next);
    });

    void call(() => bridge.window.state({})).then((result) => {
      // A push that arrived first is newer than this answer, so it wins.
      if (!live || pushed || !result.ok) return;
      setState(result.value.state);
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return state;
}
