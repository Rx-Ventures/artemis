/**
 * Which pane a component belongs to.
 * ============================================================================
 *
 * Every component under a working column reads its session state through
 * {@link usePane} instead of `useApp`, and the column it belongs to is carried
 * by context rather than threaded through props. That is what makes the split
 * possible without a prop drilled through the status line's dozen segments and
 * every row of the transcript.
 *
 * ## The fallback is the point, not a convenience
 *
 * Half the surfaces that read session state are *not* inside a column: the
 * command palette, the run inspector and the settings dialog are window-level
 * overlays, and there is exactly one of each. They ask the same questions — what
 * model, what profile, what permission mode — and the only sensible answer is
 * "the focused column's". So {@link usePane} falls back to the focused pane when
 * there is no provider above it, and those overlays need no special handling.
 *
 * The fallback subscribes to the focus, so an overlay left open while the user
 * clicks into the other column re-points at it. That is deliberate: a settings
 * dialog editing the column you are not looking at is a worse outcome than one
 * that follows you.
 */

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { useStore } from 'zustand';

import { focusedPane, useApp } from './store';
import type { Pane, SessionState } from './pane';

const PaneContext = createContext<Pane | null>(null);

/** Scope a subtree to one column. */
export function PaneProvider({
  pane,
  children,
}: {
  readonly pane: Pane;
  readonly children: ReactNode;
}): ReactElement {
  return <PaneContext.Provider value={pane}>{children}</PaneContext.Provider>;
}

/**
 * The pane this component acts on — its own column, or the focused one.
 *
 * Both hooks below it are called unconditionally, which is why the fallback is
 * written this way rather than as an early return: `useApp` must run on every
 * render whether or not the context is present.
 */
export function usePaneRef(): Pane {
  const scoped = useContext(PaneContext);
  const focused = useApp(focusedPane);
  return scoped ?? focused;
}

/**
 * Read this pane's session state.
 *
 * The drop-in for `useApp` on anything session-scoped. Every selector exported
 * by the store that used to take `AppState` takes a `SessionState` now and can
 * be passed straight in: `usePane(activeModel)`, `usePane(isLive)`.
 */
export function usePane<T>(selector: (state: SessionState) => T): T {
  return useStore(usePaneRef().store, selector);
}
