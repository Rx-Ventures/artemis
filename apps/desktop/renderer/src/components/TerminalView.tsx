/**
 * One terminal, on screen.
 * ============================================================================
 *
 * A deliberately thin component, and the thinness is the design. Everything
 * that persists — the xterm instance, its element, its scrollback, its
 * subscription — lives in `lib/terminalSessions.ts`; this owns a slot to put it
 * in and an observer to keep it the right size.
 *
 * The consequence worth stating: **React never renders the terminal's
 * contents.** The div below is always empty as far as the reconciler is
 * concerned, and the live element is moved into it imperatively. That is what
 * lets a terminal survive its tab being hidden and shown, and it is why a
 * re-render here costs nothing no matter how fast the shell is printing.
 *
 * The one piece of React state here — whether a selection exists — is a
 * boolean about the *user's hand*, not about the stream, so it changes at
 * human speed and costs nothing. It gates the "Add to chat" affordance: the
 * terminal→chat bridge, which turns a selected stack trace into a fenced
 * block in the conversation's composer.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { MessageSquarePlusIcon } from 'lucide-react';
import type { TerminalId } from '@rx-artemis/protocol';

import {
  attachTerminal,
  detachTerminal,
  fitTerminal,
  focusTerminal,
  getTerminalSelection,
  onTerminalSelectionChange,
} from '../lib/terminalSessions';
import { quoteTerminalSelection } from '../state/store';

export function TerminalView({ id }: { readonly id: TerminalId }): ReactElement {
  const slot = useRef<HTMLDivElement>(null);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    const element = slot.current;
    if (element === null) return;

    const session = attachTerminal(id, element);
    if (session === null) return;

    /*
     * Fit *after* a frame, not immediately.
     *
     * On the render that mounts this, the slot has been inserted but not laid
     * out — `offsetWidth` is 0 — and a fit against zero produces a 1×1 terminal
     * and a `SIGWINCH` telling the shell so. One frame later the box is real.
     * The observer below would eventually correct it, but not before the shell
     * had drawn its prompt at the wrong width, and a prompt is drawn once.
     *
     * No focus here, deliberately. This effect runs whenever the conversation
     * comes back on screen, and taking the caret then would move it out of the
     * composer every time the user glanced at another session and back. Focus is
     * requested by the actions that mean it — see `requestTerminalFocus`.
     */
    const first = requestAnimationFrame(() => fitTerminal(id));

    /*
     * Refit on any change to the slot's box: the divider being dragged, the
     * window resized, the sidebar collapsed, another tab opening. `fitTerminal`
     * is a no-op when the cell count has not actually changed, which is most of
     * what this observer reports.
     */
    const observer = new ResizeObserver(() => fitTerminal(id));
    observer.observe(element);

    // Selection is xterm's fact; this only mirrors "is there one" so the
    // bridge button can come and go with the user's hand. Subscribed here
    // rather than in a second effect because it shares the attach's lifetime:
    // a parked terminal has no button to show.
    const selection = onTerminalSelectionChange(id, () =>
      setHasSelection(getTerminalSelection(id).length > 0),
    );

    return () => {
      cancelAnimationFrame(first);
      observer.disconnect();
      selection();
      // Back to the parking lot, still running. Only `closeTerminal` disposes.
      detachTerminal(id);
    };
  }, [id]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={slot}
        // Clicking anywhere in the pane should put the caret in the shell,
        // including on the padding beside the last short line.
        onMouseDown={() => focusTerminal(id)}
        className="min-h-0 min-w-0 flex-1 overflow-hidden px-2 py-1.5"
      />
      {/*
        The terminal→chat bridge. Floated over the terminal's corner rather
        than parked in a header the terminal otherwise does not have, and only
        while a selection exists — a standing button would be chrome in the
        one surface whose whole value is being nothing but the shell.

        `onMouseDown.preventDefault()` so the click cannot move focus and
        collapse the very selection it is about to quote.
      */}
      {hasSelection ? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => quoteTerminalSelection(id)}
          // No shadow, deliberately: elevation is reserved for overlays
          // (`designLanguage.test.ts`), and the border on a `--panel` fill is
          // already the language's way of saying "detached".
          className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded-sm border border-line bg-panel px-1.5 py-0.5 text-2xs text-ink-muted hover:text-ink"
        >
          <MessageSquarePlusIcon className="size-3" aria-hidden="true" />
          Add to chat
        </button>
      ) : null}
    </div>
  );
}
