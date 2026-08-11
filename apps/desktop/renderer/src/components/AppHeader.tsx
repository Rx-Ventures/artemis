/**
 * The window header.
 * ============================================================================
 *
 *     ┌──────────────────────────────────────────────────────────────────┐
 *     │ ●●●  [◧]  artemis › Wire the adapter seam   [⊞][⊟] [+]  [⚙]      │
 *     └──────────────────────────────────────────────────────────────────┘
 *       ↑     ↑    ↑                                 ↑  ↑   ↑    ↑
 *       │     │    │                                 │  │   │    └ settings
 *       │     │    │                                 │  │   └ new session
 *       │     │    │                                 │  └ split downwards
 *       │     │    │                                 └ split to the right
 *       │     │    └ what the focused pane shows
 *       │     └ show/hide the sidebar — always present
 *       └ macOS traffic lights, when the window is frameless
 *
 * ## With a grid open, this names the focused pane
 *
 * The header is the window's, and the window can be showing several
 * conversations. Rather than trying to name them all in one line, it names
 * whichever pane has focus, and each pane carries its own caption — see
 * `WorkingArea`. That is why the title is read through `usePane` (which falls
 * back to the focused pane outside a pane) rather than off the app store.
 *
 * ## Two split controls, not one toggle
 *
 * Splitting right and splitting down are different actions with different
 * results — right grows a row, down adds a full-width one — so they are two
 * buttons rather than one that guesses. Each is disabled *with its reason
 * attached* when the grid has no room in that direction, per the app-wide rule
 * that a gate is explained rather than hidden. Closing is on each pane's own
 * caption, where the thing being closed is unambiguous.
 *
 * ## Why the app grew a header
 *
 * The sidebar is now a floating card that can be hidden, and a control that
 * vanishes along with the thing it controls makes hiding a one-way door. The
 * toggle used to live in the status line for exactly that reason — but the
 * status line is, by its own file header, the bar that says *what the next
 * prompt will do*, and "is the sidebar showing" is not that. It is a property
 * of the window. So the window got a bar of its own, and the toggle moved to
 * the one place a person looks for window chrome: the top-left corner.
 *
 * The status line keeps its own copy of the toggle. That is deliberate
 * duplication, not an oversight: it is a live control, it costs 20px, and
 * removing it would have meant editing a file this change does not own.
 *
 * ## New session is here as well as in the sidebar
 *
 * Hiding the sidebar must not hide the app's primary action. The alternative —
 * showing this button only while the sidebar is collapsed — was rejected
 * because a control that appears and disappears as a side effect of an
 * unrelated toggle is harder to learn than a redundant one. It never moves.
 *
 * ## The whole bar is an Electron drag region
 *
 * `.drag-region` / `.no-drag` are Artemis utilities (`index.css`) over
 * `-webkit-app-region`, which has no Tailwind equivalent. The rule that bites:
 * a drag region swallows clicks, so **every interactive child needs
 * `.no-drag`** or it becomes decoration that drags the window instead of
 * firing its handler. If a button in here ever stops responding, this is why.
 */

import { useEffect, useState, type ReactElement } from 'react';
import {
  ChevronRightIcon,
  Columns2Icon,
  PanelLeftCloseIcon,
  Rows2Icon,
  PanelLeftIcon,
  PlusIcon,
  Settings2Icon,
} from 'lucide-react';

import { keyLabel } from '../hooks/useHotkeys';
import { lastSegment } from '../lib/paths';
import {
  SPLIT_LIMIT_REASON,
  canSplit,
  newSession,
  openSettings,
  splitPane,
  toggleSidebar,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { IconButton } from './disabled-reason';

/**
 * Room reserved for the macOS traffic lights, in pixels.
 *
 * The buttons themselves end around 78px from the left edge on a standard
 * `hiddenInset` title bar. Rounded down slightly because the first control
 * after them is an icon button with its own optical padding.
 */
const TRAFFIC_LIGHT_GUTTER = 76;

/**
 * How much space to leave at the leading edge for the window's own buttons.
 *
 * Zero unless three things are true at once: macOS, a real Electron window
 * (a browser tab has no traffic lights to dodge), and a window whose frame has
 * been hidden so the buttons are drawn *over* the page.
 *
 * That last condition is measured rather than assumed, because the main
 * process does not set `titleBarStyle: 'hiddenInset'` today — it ships a native
 * title bar, and reserving 76px for buttons that are not there would leave a
 * permanent hole in the header. A framed window's chrome shows up as the
 * difference between `outerHeight` and `innerHeight`; a frameless one has
 * none. So this reads correctly now *and* the moment the window goes
 * frameless, with no coordination between the two files.
 */
function useTrafficLightGutter(): number {
  const platform = useApp((s) => s.platform);
  const bridgeMode = useApp((s) => s.bridgeMode);
  const [frameless, setFrameless] = useState(false);

  useEffect(() => {
    const measure = (): void => {
      // A couple of pixels of slack: fractional device-pixel ratios can leave
      // a sub-pixel difference on a window that has no chrome at all.
      setFrameless(window.outerHeight - window.innerHeight <= 2);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return platform === 'darwin' && bridgeMode === 'preload' && frameless
    ? TRAFFIC_LIGHT_GUTTER
    : 0;
}

/**
 * What this window is pointed at, in words.
 *
 * A resumed session is named by its title; anything else is a session that has
 * not been given a name yet, which is the honest thing to say about it. The
 * selector returns a string, so it is compared by value and a transcript delta
 * cannot re-render the header.
 */
function useSessionTitle(): string {
  const id = usePane((s) => s.resumeSessionId);
  return useApp((s) => {
    if (id === null) return 'New session';
    return s.sessions.find((session) => session.id === id)?.title ?? 'Resumed session';
  });
}

export function AppHeader(): ReactElement {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const cwd = usePane((s) => s.cwd);
  const title = useSessionTitle();
  const gutter = useTrafficLightGutter();
  const pane = usePaneRef();
  const room = useApp(canSplit);

  const project = cwd.trim().length > 0 ? lastSegment(cwd) : null;

  return (
    <header
      // `pl` is overridden inline only when there are traffic lights to clear;
      // see `useTrafficLightGutter`.
      style={gutter > 0 ? { paddingLeft: gutter } : undefined}
      className="drag-region flex h-11 shrink-0 items-center gap-1 bg-abyss px-2"
    >
      <IconButton
        label={`${collapsed ? 'Show' : 'Hide'} the sidebar (${keyLabel('mod+b')})`}
        onClick={toggleSidebar}
        className="no-drag shrink-0 text-ink-muted"
      >
        {collapsed ? <PanelLeftIcon /> : <PanelLeftCloseIcon />}
      </IconButton>

      <div className="mx-1 flex min-w-0 flex-1 items-center gap-1.5">
        {project === null ? (
          /* Faint, not amber. This is a placeholder for a value nobody has set
             yet, sitting in the window's own chrome — it is not a warning, and
             it was colouring the first thing in the header on every fresh
             launch. The empty state says "not ready to run" in as many words,
             which is where that belongs. */
          <span className="shrink-0 text-xs text-ink-faint">No project</span>
        ) : (
          /* Full path on hover — the basename alone is ambiguous across
             checkouts, and two worktrees of the same repo share it. */
          <span title={cwd} className="max-w-[14rem] shrink-0 truncate text-xs font-medium text-ink">
            {project}
          </span>
        )}
        <ChevronRightIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
        <h1 className="min-w-0 flex-1 truncate text-xs font-normal text-ink-muted">{title}</h1>
      </div>

      {/*
        The keyboard routes are `⌘\\` and `⌘⇧\\`; these are the discoverable
        ones, and the only route for someone who never drags a session out of
        the sidebar. Both act on the focused pane, which is what its brighter
        caption marks.
      */}
      <IconButton
        label={`Split to the right (${keyLabel('mod+\\')})`}
        disabled={!room}
        disabledReason={room ? undefined : SPLIT_LIMIT_REASON}
        onClick={() => splitPane('right', pane)}
        className="no-drag shrink-0 text-ink-faint"
      >
        <Columns2Icon />
      </IconButton>
      <IconButton
        label={`Split downwards, full width (${keyLabel('mod+shift+\\')})`}
        disabled={!room}
        disabledReason={room ? undefined : SPLIT_LIMIT_REASON}
        onClick={() => splitPane('down', pane)}
        className="no-drag shrink-0 text-ink-faint"
      >
        <Rows2Icon />
      </IconButton>
      <IconButton
        label={`New session (${keyLabel('mod+n')})`}
        onClick={() => newSession(pane)}
        className="no-drag shrink-0 text-ink-faint"
      >
        <PlusIcon />
      </IconButton>
      <IconButton
        label={`Settings (${keyLabel('mod+,')})`}
        onClick={() => openSettings()}
        className="no-drag shrink-0 text-ink-faint"
      >
        <Settings2Icon />
      </IconButton>
    </header>
  );
}
