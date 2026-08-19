/**
 * The window header — which *is* the title bar.
 * ============================================================================
 *
 *     ┌──────────────────────────────────────────────────────────────────┐
 *     │ ●●● [◧] artemis › Wire the seam           [>_] [⚙]   [–][□][✕] │
 *     └──────────────────────────────────────────────────────────────────┘
 *       ↑    ↑   ↑                                 ↑   ↑        ↑
 *       │    │   │                                 │   │        └ Windows and
 *       │    │   │                                 │   │          Linux only
 *       │    │   │                                 │   └ settings
 *       │    │   │                                 └ terminal
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
 * ## Splitting is not here
 *
 * The bar used to carry a split-right and a split-down button. They are gone:
 * this is window chrome, and a header that grows a control per pane operation
 * competes with the panes' own captions for the same job. Splitting is reached
 * by `⌘\` and `⌘⇧\` (`App.tsx`) and by "Open beside" in the command palette;
 * closing stays on each pane's caption, where the thing being closed is
 * unambiguous. Only the two controls that act on *the window rather than the
 * grid* are left — the focused conversation's terminal, and settings.
 *
 * ## Why the app grew a header
 *
 * Originally because a control that vanishes along with the thing it controls
 * makes hiding a one-way door: the sidebar collapsed to nothing, so its toggle
 * had to live somewhere that did not. The status line held it first, which was
 * wrong on its own terms — that bar says *what the next prompt will do*, and
 * "is the sidebar showing" is not that. So the window got a bar of its own.
 *
 * That original reason is gone: the sidebar collapses to a rail and reopens
 * itself. The toggle stays here anyway, because the top-left corner is where a
 * person looks for window chrome — which is a reason to keep it rather than an
 * obligation to. The status line no longer carries a copy; an earlier change
 * removed it and left both file headers claiming otherwise.
 *
 * ## New session is not here either
 *
 * It was, on the argument that hiding the sidebar must not hide the app's
 * primary action. The button is gone and that argument still stands, so the
 * routes that answer it are `⌘N`, the command palette, and the sidebar's own
 * button — none of which depend on this bar. If hiding the sidebar ever does
 * start to feel like losing the way to start work, this is the paragraph that
 * was wrong, and the button comes back.
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
  CopyIcon,
  MinusIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  Settings2Icon,
  SquareIcon,
  GlobeIcon,
  SquareTerminalIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';

import { keyLabel } from '../hooks/useHotkeys';
import { useWindowState } from '../hooks/useWindowState';
import { installUpdate, restartForUpdate, useUpdateState } from '../hooks/useUpdateState';
import { resolveBridge } from '../lib/bridge';
import { lastSegment } from '../lib/paths';
import { cn } from '../lib/utils';
import { ArrowDownIcon } from 'lucide-react';
import {
  focusWaitingPane,
  openSettings,
  toggleBrowser,
  toggleTasks,
  toggleTerminal,
  toggleSidebar,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { IconButton } from './disabled-reason';
import { StatusDot } from './primitives';
import { ThemeToggle } from './ThemeToggle';

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
  // A count, not the rows: this only decides whether the button has anything to
  // open, and a selector returning the array would re-render the header on every
  // progress message the delegated work emits.
  const delegated = usePane((s) => s.tasks.length);
  // Subscribed once, here, and passed down. Two components calling the hook
  // would open two IPC subscriptions to describe one window.
  const windowState = useWindowState();
  const gutter = useTrafficLightGutter(windowState.fullScreen);
  const pane = usePaneRef();

  const project = cwd.trim().length > 0 ? lastSegment(cwd) : null;

  return (
    <header
      // `pl` is overridden inline only when there are traffic lights to clear;
      // see `useTrafficLightGutter`.
      style={gutter > 0 ? { paddingLeft: gutter } : undefined}
      // The rule at the bottom is doing real work: the header and the app body
      // below it are both `bg-abyss`, so without it the window chrome and the
      // conversation are one continuous field and the title reads as though it
      // belongs to the transcript. `border-line` rather than anything heavier,
      // to match the seam the dock's tab strip already draws.
      className="drag-region flex h-11 shrink-0 items-center gap-1 border-b border-line bg-abyss px-2"
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
        `toggleTerminal` opens the focused conversation's shell or brings it
        forward — see the store for why repeating it does not stack up terminals
        nobody asked for.
      */}
      <UpdateChip />
      <WaitingBadge />

      <IconButton
        label={`Terminal (${keyLabel('mod+j')})`}
        onClick={() => toggleTerminal(pane)}
        className="no-drag shrink-0 text-ink-faint"
      >
        <SquareTerminalIcon />
      </IconButton>
      {/*
        Beside the terminal, because it is the same kind of control: a live
        thing this conversation can put in the rail, opened or brought forward
        by pressing the same button twice. `toggleBrowser` is `toggleTerminal`'s
        twin down in the store, including the part that keeps a second press
        from stacking up pages nobody asked for.
      */}
      <IconButton
        label={`Browser (${keyLabel('mod+shift+b')})`}
        onClick={() => toggleBrowser(pane)}
        className="no-drag shrink-0 text-ink-faint"
      >
        <GlobeIcon />
      </IconButton>
      {/*
        After the terminal rather than before it, because that is the order the
        two appear in down in the strip — terminals, then delegated work pinned
        to the end. Two controls for one rail should not disagree about which way
        round it is.

        Disabled rather than hidden when there is nothing delegated, which is the
        rule `disabled-reason.tsx` sets out: a control that vanishes teaches
        nothing, and this is the one surface that says what the button is for.
      */}
      <IconButton
        label="Delegated work"
        disabled={delegated === 0}
        disabledReason="Nothing delegated in this conversation yet."
        onClick={() => toggleTasks(pane)}
        className="no-drag shrink-0 text-ink-faint"
      >
        <UsersIcon />
      </IconButton>
      <IconButton
        label={`Settings (${keyLabel('mod+,')})`}
        onClick={() => openSettings()}
        className="no-drag shrink-0 text-ink-faint"
      >
        <Settings2Icon />
      </IconButton>
      {/*
        Last in the row, and the only control here that is not a button.

        It sits beside Settings rather than inside it because it is the one
        preference whose whole effect is the window you are looking at — the
        transcript, the sidebar, this header. Everything behind a modal would be
        covered by the modal you opened to change it.

        A separator ahead of it: the three to the left act on the *conversation*
        (its shell, its delegated work, its settings) and this one acts on the
        application. Without the rule they read as a row of four peers.
      */}
      <div className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden="true" />
      <ThemeToggle />

      <WindowControls maximized={windowState.maximized} focused={windowState.focused} />
    </header>
  );
}

/**
 * How many conversations have stopped and are waiting on you.
 *
 * The one thing in this header that is about the *window* rather than the
 * conversation in front of you, and it is here because that is the problem it
 * solves: a pane parked on a permission in the other column, or behind the one
 * you are reading, is invisible until you happen to look. The agent is not
 * working, it is waiting, and nothing was saying so from anywhere you were
 * likely to be looking.
 *
 * Renders nothing at zero. A badge that is always present and usually says "0"
 * teaches the eye to skip it, which is the opposite of what an alert is for —
 * and the header is narrow enough that a permanent slot would cost the title
 * real width on every window that never needs it.
 *
 * Amber, matching the sidebar dot and the activity indicator: three surfaces,
 * one colour, one meaning. Clicking focuses the first waiting pane; see
 * `focusWaitingPane` for why "first" is layout order.
 */
function WaitingBadge(): ReactElement | null {
  const waiting = useApp((s) => s.waitingSessions.length);
  if (waiting === 0) return null;

  const label =
    waiting === 1 ? '1 conversation is waiting for you' : `${waiting} conversations are waiting for you`;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        focusWaitingPane();
      }}
      className="no-drag flex h-[22px] shrink-0 items-center gap-1.5 rounded-sm bg-amber px-2 text-2xs font-medium text-abyss transition-opacity hover:opacity-90"
    >
      <StatusDot tone="neutral" className="bg-abyss/70" />
      {waiting} waiting
    </button>
  );
}

/**
 * The one update surface.
 *
 * `_layout.md` item 3: in the command bar, always, whatever else is open. It
 * used to be three places telling one story — a card in the sidebar, a dot on
 * the rail when the sidebar was shut, and, before that, a strip under the
 * header for when both were gone. Each existed because the one before it could
 * disappear. The command bar cannot, so one is enough and the other two are
 * gone.
 *
 * A chip rather than a sentence, because the header is not where an update is
 * *read* — it is where it is noticed. Clicking installs when there is something
 * to install and restarts when the new version is already staged, which are the
 * only two things anyone wants from it; everything else the card used to say is
 * a consequence of one of those two.
 *
 * Renders nothing while the updater is idle, which is almost always.
 */
function UpdateChip(): ReactElement | null {
  const state = useUpdateState();
  if (state.phase === 'idle') return null;

  const version = state.version ?? '';
  const ready = state.phase === 'ready';
  const failed = state.phase === 'error';
  const busy = state.phase === 'working' || state.phase === 'restarting';

  const label = failed
    ? 'The update could not be installed'
    : ready
      ? `Artemis ${version} is ready — restart to use it`.trim()
      : busy
        ? `Working on Artemis ${version}`.trim()
        : `Artemis ${version} is available`.trim();

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={() => {
        if (ready) restartForUpdate();
        else if (!busy) installUpdate();
      }}
      className={cn(
        'no-drag flex h-[22px] shrink-0 items-center gap-1.5 rounded-sm border px-2 font-mono text-2xs transition-colors',
        failed
          ? 'border-signal/50 text-signal hover:bg-signal/10'
          : 'border-beam/50 text-beam hover:bg-beam/10',
        busy && 'opacity-60',
      )}
    >
      <ArrowDownIcon className="size-3" aria-hidden="true" />
      {failed ? 'update failed' : ready ? `restart for ${version}` : version}
    </button>
  );
}
