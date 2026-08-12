/**
 * The window header — which *is* the title bar.
 * ============================================================================
 *
 *     ┌──────────────────────────────────────────────────────────────────┐
 *     │ ●●● [◧] artemis › Wire the seam  [⊞][⊟] [+] [⚙]   [–][□][✕] │
 *     └──────────────────────────────────────────────────────────────────┘
 *       ↑    ↑   ↑                        ↑  ↑   ↑   ↑        ↑
 *       │    │   │                        │  │   │   │        └ Windows and
 *       │    │   │                        │  │   │   │          Linux only
 *       │    │   │                        │  │   │   └ settings
 *       │    │   │                        │  │   └ new session
 *       │    │   │                        │  └ split downwards
 *       │    │   │                        └ split to the right
 *       │    │   └ what the focused pane shows
 *       │    └ show/hide the sidebar — always present
 *       └ macOS traffic lights: the system's own, drawn over this bar
 *
 * ## This bar replaced the title bar rather than sitting under it
 *
 * `main/window.ts` hides the platform's title bar, so what is drawn here is the
 * only chrome the window has. That file explains why; the consequence for this
 * one is that the header now owes the user everything the native bar used to
 * provide, and the two ends of that debt are handled differently:
 *
 *  - **macOS** keeps its traffic lights. They are still AppKit's — the system
 *    draws them, handles the clicks, and does full screen — so there is nothing
 *    to implement, only room to leave. See {@link useTrafficLightGutter}.
 *  - **Windows and Linux** get nothing back from the system, so
 *    {@link WindowControls} draws minimize, maximize and close and routes them
 *    through `artemis.window.*`.
 *
 * Dragging and double-click-to-zoom come free with the drag region below; they
 * are Chromium's, not ours.
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

import { type ReactElement } from 'react';
import {
  ChevronRightIcon,
  Columns2Icon,
  CopyIcon,
  MinusIcon,
  PanelLeftCloseIcon,
  Rows2Icon,
  PanelLeftIcon,
  PlusIcon,
  Settings2Icon,
  SquareIcon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react';

import { keyLabel } from '../hooks/useHotkeys';
import { useWindowState } from '../hooks/useWindowState';
import { resolveBridge } from '../lib/bridge';
import { lastSegment } from '../lib/paths';
import { cn } from '../lib/utils';
import {
  SPLIT_LIMIT_REASON,
  canSplit,
  newSession,
  openSettings,
  splitPane,
  toggleTerminal,
  toggleSidebar,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { IconButton } from './disabled-reason';

/**
 * Room reserved for the macOS traffic lights, in pixels.
 *
 * The group is 52px wide and `main/window.ts` puts its left edge at 16, so the
 * buttons end at 68. The remainder is the gap before the sidebar toggle, whose
 * own optical padding does the rest.
 *
 * The 16 is that file's to choose and this is the only number here that depends
 * on it: if the traffic lights move, this moves with them.
 */
const TRAFFIC_LIGHT_GUTTER = 76;

/**
 * How much space to leave at the leading edge for buttons Artemis does not draw.
 *
 * Three conditions, and full screen is the one worth explaining. macOS takes
 * its traffic lights away when a window goes full screen — they move into the
 * overlay that slides down with the menu bar — so a gutter that stayed put
 * would leave a 76px hole at the start of the bar for as long as the user was
 * in full screen. It closes, and reopens on the way out.
 *
 * The other two are static: no other platform has traffic lights, and a browser
 * tab in dev (`bridgeMode !== 'preload'`) has no window chrome at all.
 */
function useTrafficLightGutter(fullScreen: boolean): number {
  const platform = useApp((s) => s.platform);
  const bridgeMode = useApp((s) => s.bridgeMode);

  if (platform !== 'darwin' || bridgeMode !== 'preload' || fullScreen) return 0;
  return TRAFFIC_LIGHT_GUTTER;
}

/* -------------------------------------------------------------------------- */
/* Window controls                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimize, maximize and close, for the platforms that hand back nothing.
 *
 * Renders `null` on macOS, where the traffic lights are the system's own and a
 * second set of buttons doing the same three jobs would be a bug rather than a
 * feature — and in dev's browser tab, where there is no window to act on.
 *
 * Drawn in Artemis's own idiom rather than to Windows' 46×32px metrics. Those
 * metrics only read as native inside a native title bar, and this bar is
 * plainly the app's — so matching the icon buttons two positions to the left is
 * the more coherent choice. Close keeps a red hover, because that convention is
 * about consequence rather than about geometry.
 *
 * Every button is `.no-drag`, or it would drag the window instead of firing.
 */
function WindowControls({ maximized, focused }: {
  readonly maximized: boolean;
  readonly focused: boolean;
}): ReactElement | null {
  const platform = useApp((s) => s.platform);
  const bridgeMode = useApp((s) => s.bridgeMode);

  if (platform === 'darwin' || bridgeMode !== 'preload') return null;

  // Fire and forget. Each channel does answer with the resulting state, but the
  // state this renders from is already on its way over the push channel — and
  // `close` in particular resolves about a window that no longer exists.
  const send = (action: 'minimize' | 'toggleMaximize' | 'close') => () => {
    void resolveBridge().bridge?.window[action]({});
  };

  return (
    <div
      // Dimmed while the window is in the background, which is what every
      // platform does to its own controls. The header's *content* is left
      // alone: a title that faded whenever the user clicked another app would
      // be movement without meaning.
      className={cn('ml-1 flex shrink-0 items-center gap-0.5', !focused && 'opacity-60')}
    >
      <IconButton
        label="Minimize"
        onClick={send('minimize')}
        className="no-drag shrink-0 text-ink-faint"
      >
        <MinusIcon />
      </IconButton>
      <IconButton
        label={maximized ? 'Restore' : 'Maximize'}
        onClick={send('toggleMaximize')}
        className="no-drag shrink-0 text-ink-faint"
      >
        {/* Two overlapping squares for restore, one for maximize — the glyphs
            Windows itself uses, so the button says which way it will go. */}
        {maximized ? <CopyIcon /> : <SquareIcon />}
      </IconButton>
      <IconButton
        label="Close"
        onClick={send('close')}
        className="no-drag shrink-0 text-ink-faint hover:bg-destructive/20 hover:text-destructive"
      >
        <XIcon />
      </IconButton>
    </div>
  );
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
  // Subscribed once, here, and passed down. Two components calling the hook
  // would open two IPC subscriptions to describe one window.
  const windowState = useWindowState();
  const gutter = useTrafficLightGutter(windowState.fullScreen);
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
      {/*
        Beside the splits rather than next to New Session, because it is the same
        kind of act: it changes what this window is showing, not what the agent
        is doing. `toggleTerminal` opens the focused conversation's shell or
        brings it forward — see the store for why repeating it does not stack up
        terminals nobody asked for.
      */}
      <IconButton
        label={`Terminal (${keyLabel('mod+j')})`}
        onClick={() => toggleTerminal(pane)}
        className="no-drag shrink-0 text-ink-faint"
      >
        <SquareTerminalIcon />
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

      <WindowControls maximized={windowState.maximized} focused={windowState.focused} />
    </header>
  );
}
