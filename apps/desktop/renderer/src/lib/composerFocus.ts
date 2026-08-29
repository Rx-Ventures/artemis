/**
 * Where the caret goes when a store action hands it back to a conversation.
 * ============================================================================
 *
 * The composer's textarea belongs to React — it lives inside `Composer`, one
 * per column — but the things that want to focus it do not: `toggleTerminal`
 * is a store action, and the store cannot reach into a component's ref. So
 * each composer offers its focus here on mount, keyed by pane, and the store
 * asks by id. The same seam `lib/terminalSessions.ts` provides for xterm, at a
 * fraction of the size and for the same reason: focus is imperative, and
 * pretending otherwise means threading a ref through state that re-renders on
 * every keystroke.
 *
 * Nothing here decides *whether* to move focus. Taking the caret is rude in
 * almost every situation — see `requestTerminalFocus` for the catalogue — so
 * the callers are expected to be actions that unambiguously mean it, and there
 * is exactly one today: ⌘J on a terminal that already holds the caret.
 */

import type { PaneId } from '../state/pane';

const composers = new Map<PaneId, () => void>();

/**
 * Offer this column's composer for focusing. Returns the withdrawal, which the
 * registering effect must call on unmount — a retired pane's entry would
 * otherwise hold a ref into a component React has already dropped.
 */
export function registerComposer(paneId: PaneId, focus: () => void): () => void {
  composers.set(paneId, focus);
  return () => {
    // Only its own entry. A column that re-registered — a remount, a strict
    // mode double-run — must not have the new registration torn down by the
    // old one's cleanup arriving late.
    if (composers.get(paneId) === focus) composers.delete(paneId);
  };
}

/** Put the caret in a column's composer, if that column has one mounted. */
export function focusComposer(paneId: PaneId): void {
  composers.get(paneId)?.();
}
