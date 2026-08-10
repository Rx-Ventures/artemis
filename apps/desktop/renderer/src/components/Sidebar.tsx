/**
 * The left sidebar.
 * ============================================================================
 *
 *     ┌──────────────────────────────┐
 *     │ [ + New session         ⌘N ] │  ← first, and the most prominent thing
 *     │ ~/code/libra              ⌄  │  ← where the next run will happen
 *     ├──────────────────────────────┤
 *     │ [ filter 41 sessions…      ] │
 *     │ ~/code/libra              3  │  ← sticky, one per project
 *     │   fix auth        2m   ·Work │
 *     │   …                          │
 *     └──────────────────────────────┘
 *
 * Persistent, collapsible, and resizable. Three decisions worth keeping:
 *
 * ## New Session is the first element
 *
 * Not a logo, not a header, not a search field. It is the thing a person opens
 * this app to do, so it is the first thing under the cursor and the first thing
 * in the tab order. The collapse control shares its row rather than sitting
 * above it, because a chrome row above the primary action would demote it.
 *
 * ## Resizing writes to the DOM, then to the store
 *
 * A drag that called `setState` per `pointermove` would re-render the whole
 * session list sixty times a second. The handle writes `style.width` straight
 * onto the element while dragging and commits the final value to the store on
 * release — the store is the persistence layer here, not the animation loop.
 *
 * ## Nothing here subscribes to the transcript
 *
 * See `SessionList`. Streaming text never reaches this subtree, so a persistent
 * pane costs nothing per token.
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
import { SessionList } from './SessionList';
import { WorkingDirectoryButton } from './WorkingDirectory';
import { IconButton } from './disabled-reason';
import { Button } from '@/components/ui/button';

export function Sidebar(): ReactElement | null {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const width = useApp((s) => s.sidebarWidth);
  const asideRef = useRef<HTMLElement>(null);

  if (collapsed) return null;

  return (
    <aside
      ref={asideRef}
      style={{ width }}
      aria-label="Sessions"
      className="relative flex shrink-0 flex-col border-r border-line bg-panel"
    >
      <div className="flex items-center gap-1 px-2 pt-2">
        <Button size="sm" onClick={newSession} className="min-w-0 flex-1 justify-start gap-1.5">
          <PlusIcon />
          <span className="truncate">New session</span>
          <span aria-hidden="true" className="ml-auto font-mono text-2xs opacity-60">
            {keyLabel('mod+n')}
          </span>
        </Button>
        <IconButton
          label={`Collapse the sidebar (${keyLabel('mod+b')})`}
          onClick={() => setSidebarCollapsed(true)}
          className="shrink-0 text-ink-faint"
        >
          <PanelLeftCloseIcon />
        </IconButton>
      </div>

      <div className="px-2 pt-1.5 pb-2">
        <WorkingDirectoryButton />
      </div>

      <SessionList />

      <ResizeHandle target={asideRef} />
    </aside>
  );
}

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
      className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-brass/30 focus-visible:bg-brass/40"
    />
  );
}
