/**
 * The sidebar — a floating card carrying every session.
 * ============================================================================
 *
 *      ╭────────────────────────────────╮
 *      │ [ + New session       ⌘N ] [◧] │  ← the thing you came here to do
 *      ├────────────────────────────────┤
 *      │ ▾ Sessions · 47                │
 *      │   artemis ·22 ─────────────────│  ← the project you are in, pinned
 *      │    Wire the adapter seam       │
 *      │    ⌥ main · ▪ Work             │
 *      │   api ·9 ──────────────────────│  ← and every other project
 *      │    …                           │
 *      ╰────────────────────────────────╯
 *      ╭────────────────────────────────╮
 *      │ ↓ Artemis 0.4.0 is available ✕ │  ← only when there is an update
 *      │ [ Update now ]                 │
 *      ╰────────────────────────────────╯
 *
 * ## It is a card sitting on the window, not a column bolted to its edge
 *
 * Literally, since the 7D shell landed: rounded, bordered, floating on the
 * window ground inside `App.tsx`'s 7px inset. The column era read as part of
 * the frame — furniture.
 * As a detached card with its own border and shadow it reads as a thing about
 * your work rather than a wall of the room it happens in.
 *
 * The `<aside>` still owns the full width, including the margin. The card is a
 * child inset by the aside's padding — the same inset on all four sides, so the
 * gap above it reads as the same gutter as the one below the bug report row
 * rather than as the card hanging off the header's rule. Keeping the outer
 * element the full width means resizing, which measures the aside, is unchanged
 * by the visual change — and it puts the drag handle in the gutter between the
 * card and the transcript instead of on top of the card's rounded edge.
 *
 * ## New Session is the first control, and now literally first
 *
 * It used to sit under a title row. That row named the working directory's
 * folder, and the session section below it now names the *repository* and folds
 * the list — the same word, one line apart, with the lower one carrying more
 * information and a control besides. So the title went and its hide button
 * moved up here, which puts the two sidebar-level controls on one row and makes
 * the thing a person opens this app to do the first thing in the card and in
 * the tab order.
 *
 * ## The working directory is not a sidebar control
 *
 * There used to be a path under that button, which put "where the next prompt
 * runs" inside the window's furniture — next to the pane toggle, above a list
 * of history, in the one region of the app that is *about* the window. That
 * framing was the bug. The directory belongs to the session in the working
 * column: it moves when you select a session, and changing it ends the session
 * rather than dragging it somewhere its transcript does not exist (`setCwd` in
 * the store carries the argument).
 *
 * So it is stated and set by the chip directly above the composer, beside the
 * profile and model and permission mode — the bar whose whole subject is what
 * the next prompt will do. Sitting it here as well meant two controls for one
 * value in two different scopes, and the sidebar's was the one implying it
 * outranked the conversation.
 *
 * The card names the *projects*, in the group headings inside the list. That is
 * a fact about the rows underneath each one, which is what a sidebar is for.
 *
 * ## The foot of the card is outside the card
 *
 * It used to be a permanent `Start somewhere else` row *inside* it. What sits
 * below the card now are siblings of it: a floating notice when the updater has
 * something to say (`UpdateCard`), and one permanent row for reporting a bug
 * (`BugReportCard`). Each owns its own reasoning and both borrow this card's
 * chrome, so they read as a stack rather than as panels bolted into it.
 *
 * The row that was removed and the row that was added are not the same argument
 * twice. That one duplicated a control the sidebar already offered — see the
 * note on `ProjectSwitcher` below — and this one is the only place the app offers
 * its action at all; `BugReportCard` carries the rest of it.
 *
 * ## Resizing writes to the DOM, then to the store
 *
 * A drag that called `setState` per `pointermove` would re-render the session
 * list sixty times a second. The handle writes `style.width` straight onto the
 * `<aside>` while dragging and commits the final value to the store on release
 * — the store is the persistence layer here, not the animation loop. Both the
 * live write and the committed measurement are the aside's *border-box* width,
 * margin included, so the two agree and a resize never drifts.
 *
 * ## Nothing here subscribes to the transcript
 *
 * See `SessionList`. Streaming text never reaches this subtree, so a persistent
 * pane costs nothing per token.
 *
 * ## Collapsed renders nothing — again, and this time it is true
 *
 * Not a rail, not a sliver — `null`. The navigator rail that stood here for a
 * while is gone (2026-08-30, with the 7D pass): its icons were doubles of
 * controls the header and the kebab menu already carry, and 46px of chrome
 * whose best argument was "the way back" is a lot to pay for one button. The
 * way back is the panel toggle in `AppHeader`, which renders exactly when the
 * list is closed — one control, two homes, never both at once. The caption's
 * chevron below is the same control's other home, on the thing it closes.
 */

import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { PanelLeftCloseIcon, PlusIcon } from 'lucide-react';

import { keyLabel } from '../hooks/useHotkeys';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  newSession,
  setSidebarCollapsed,
  setSidebarWidth,
  useApp,
} from '../state/store';
import { usePaneRef } from '../state/paneContext';
import { SessionList } from './SessionList';
import { ScheduledStrip } from './ScheduledStrip';
import { BugReportCard } from './BugReportCard';
import { IconButton } from './disabled-reason';
import { Button } from '@/components/ui/button';

export function Sidebar(): ReactElement | null {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const width = useApp((s) => s.sidebarWidth);
  // The sidebar sits outside every column, so this is the focused one — which
  // is what New session should clear and what the project switcher should move.
  const pane = usePaneRef();
  const asideRef = useRef<HTMLElement>(null);

  if (collapsed) return null;

  return (
    <aside
          ref={asideRef}
          style={{ width }}
          aria-label="Sessions"
          className="relative flex shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel"
        >
          {/*
            A caption over the list, and the chevron that shuts it.

            The card this replaced had a `+ New session` button in a header of
            its own, which put the one thing you came to do above the thing you
            came to look at. The mockup's order is the honest one: say what the
            column is, give it a way to close, and let the action sit with the
            list it acts on.
          */}
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3">
            <span className="chrome-label text-ink-faint">Sessions</span>
            <IconButton
              label={`Hide the sidebar (${keyLabel('mod+b')})`}
              onClick={() => setSidebarCollapsed(true)}
              size="icon-xs"
              className="ml-auto shrink-0 text-ink-faint"
            >
              <PanelLeftCloseIcon />
            </IconButton>
          </div>

          <div className="p-2">
            {/*
              Filled with the accent, not outlined.

              It is the only thing in this column that *starts* something, and
              Sheet spends colour on exactly that. Everything else here — the
              rows, the headings, the counts — is a record of work that already
              exists.
            */}
            {/*
              `rounded-lg` — the full `--radius`, not the `sm` size's clamped
              6px. This is the Console language's `.newb`, which takes the
              control radius one step up from the rows beneath it: the button
              that starts something should not be the same shape as a record of
              something already started.
            */}
            <Button
              size="sm"
              onClick={() => newSession(pane)}
              className="w-full min-w-0 justify-center gap-1.5 rounded-lg bg-beam text-beam-ink hover:bg-beam-dim"
            >
              <PlusIcon />
              <span className="truncate">New session</span>
              <span aria-hidden="true" className="font-mono text-2xs opacity-70">
                {keyLabel('mod+n')}
              </span>
            </Button>
          </div>

          {/*
            Appointments above the record of what they produced. The strip
            renders nothing at all until a routine exists — see its header.
          */}
          <ScheduledStrip />

          <SessionList />

          {/*
            The bug report stays; the update card is gone from here. There is
            one update surface now and it is in the command bar — see
            `_layout.md` item 3 and `AppHeader`. A card here *and* a dot on the
            rail *and* a strip under the header was three places telling one
            story, which is how the old header ended up carrying a control it
            did not own.
          */}
          <BugReportCard />

          <ResizeHandle target={asideRef} />
    </aside>
  );
}

/*
 * REMOVED: `Rail`, the 46px navigator column, and `RailTasks` with it.
 *
 * It held five icons: the sessions view, New session, search, the working
 * folder, delegated work, and settings at the foot. Every one of them was a
 * double — the header carries search and settings, the kebab menu carries the
 * folder and delegated work, `⌘N` and the list's own button carry New session
 * — so the rail's one non-duplicate job was reopening the list it stood
 * beside. That job moved to `AppHeader`, which shows the panel toggle exactly
 * while the list is closed. See the file header (2026-08-30, the 7D pass).
 */

/*
 * REMOVED: `ProjectTitle`.
 *
 * It was the card's first row — a folder icon, the basename of the working
 * directory, and the hide button. The name is now the session section's header
 * one row lower (see `SessionList`), where it also folds the list and reports
 * the *repository* rather than the directory, so keeping this row meant the
 * same word twice inside forty pixels with only one of the two being the more
 * accurate of the pair.
 *
 * The hide button moved up beside New session, which is where it should have
 * been anyway: the two controls that act on the sidebar itself, rather than on
 * the project it is showing, now sit together on one row.
 *
 * REMOVED: the `WorkingDirectoryButton` row that sat under New session.
 *
 * Same idea, one scope up. It offered the directory as a property of the window
 * — a standing setting the next session would inherit — when it is a property
 * of the session, and the chip above the composer already states and sets it
 * as one. See
 * the header. The component went with it; `WorkingDirectoryDialog` and
 * `DirectoryChooser` are still exported and still used by that chip, the
 * palette and the empty state.
 *
 * REMOVED: `ProjectSwitcher`, the `Start somewhere else` row at the foot of the
 * card.
 *
 * It moved to a project without resuming anything in it — a blank session in
 * another directory — which was the one thing the session list could not do, back
 * when the list held one project and this was the door to the rest.
 *
 * Two changes ate it. The list holds *every* project now and a row click does the
 * whole switch, so reaching history is not this control's job; and the chip above
 * the composer grew recent folders beside its `Browse…`, so starting fresh
 * somewhere — including somewhere with no history at all, which was the last
 * thing only this row could reach — is a click on the control whose subject is
 * the working directory. What was left here was a third route to a value this
 * card deliberately does not own (see above), holding the most permanent slot in
 * it, hiding its own reason for existing in a tooltip whenever the provider could
 * not enumerate projects.
 *
 * `groupSessionsByProject` still has callers in `SessionList`; nothing else went
 * with the row.
 */

/* -------------------------------------------------------------------------- */
/* Resize                                                                     */
/* -------------------------------------------------------------------------- */

/** How far an arrow key nudges the sidebar. */
const KEYBOARD_STEP = 16;

/**
 * The drag handle on the sidebar's trailing edge.
 *
 * A real `separator` with keyboard support, not a bare div: a pane the user can
 * only resize with a mouse is a pane a keyboard user cannot resize at all, and
 * the arrow-key path is four lines.
 *
 * It sits *inside* the aside's right padding rather than straddling its edge,
 * so the grab target is the gutter between the floating card and the transcript
 * and never lands on the card's rounded corner.
 */
function ResizeHandle({
  target,
}: {
  readonly target: RefObject<HTMLElement | null>;
}): ReactElement {
  const width = useApp((s) => s.sidebarWidth);
  const dragging = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const element = target.current;
      if (!element) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging.current = event.clientX - element.getBoundingClientRect().width;
    },
    [target],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const origin = dragging.current;
      const element = target.current;
      if (origin === null || !element) return;
      // Straight to the DOM. Committing to the store here would re-render the
      // session list on every pointer sample.
      element.style.width = `${clampSidebarWidth(event.clientX - origin)}px`;
    },
    [target],
  );

  const finish = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragging.current === null) return;
      dragging.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      const element = target.current;
      if (element) setSidebarWidth(element.getBoundingClientRect().width);
    },
    [target],
  );

  return (
    <div
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setSidebarWidth(width - KEYBOARD_STEP);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          setSidebarWidth(width + KEYBOARD_STEP);
        }
      }}
      className="absolute inset-y-2 right-0 z-20 w-2 cursor-col-resize touch-none rounded-full bg-transparent transition-colors hover:bg-beam/30 focus-visible:bg-beam/40"
    />
  );
}
