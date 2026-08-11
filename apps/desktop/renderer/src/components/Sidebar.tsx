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
 *      ├────────────────────────────────┤
 *      │ ⌂ Start somewhere else      ▴  │  ← a project with no history yet
 *      ╰────────────────────────────────╯
 *
 * ## It is a card sitting on the window, not a column bolted to its edge
 *
 * The pane used to be a full-height bordered column flush against the left and
 * bottom of the window, which made it read as part of the frame — furniture.
 * As a detached card with its own border and shadow it reads as a thing about
 * your work rather than a wall of the room it happens in.
 *
 * The `<aside>` still owns the full width, including the margin. The card is a
 * child inset by the aside's padding. Keeping the outer element the full width
 * means resizing, which measures the aside, is unchanged by the visual change —
 * and it puts the drag handle in the gutter between the card and the transcript
 * instead of on top of the card's rounded edge.
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
 * ## Collapsed still renders nothing
 *
 * Not a rail, not a sliver — `null`. The control that brings it back lives in
 * `AppHeader`, which is always mounted; that is the whole reason the app grew a
 * header.
 */

import {
  useCallback,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { FolderIcon, FolderTreeIcon, PanelLeftCloseIcon, PlusIcon } from 'lucide-react';

import { keyLabel } from '../hooks/useHotkeys';
import { useCapability } from '../hooks/useCapability';
import { formatRelative } from '../lib/format';
import { inferHomeDirectory, lastSegment, shortenPath } from '../lib/paths';
import { groupSessionsByProject } from '../lib/sessionGroups';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  newSession,
  setCwd,
  setSidebarCollapsed,
  setSidebarWidth,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { SessionList } from './SessionList';
import { IconButton, ReasonButton } from './disabled-reason';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';

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
      className="relative flex shrink-0 flex-col p-2 pt-0"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-md ring-1 ring-foreground/5">
        <div className="flex flex-col gap-1.5 p-2.5">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={() => newSession(pane)}
              className="min-w-0 flex-1 justify-start gap-1.5"
            >
              <PlusIcon />
              <span className="truncate">New session</span>
              <span aria-hidden="true" className="ml-auto font-mono text-2xs opacity-60">
                {keyLabel('mod+n')}
              </span>
            </Button>
            <IconButton
              label={`Hide the sidebar (${keyLabel('mod+b')})`}
              onClick={() => setSidebarCollapsed(true)}
              size="icon-xs"
              className="shrink-0 text-ink-faint"
            >
              <PanelLeftCloseIcon />
            </IconButton>
          </div>
        </div>

        <SessionList />
        <ProjectSwitcher />
      </div>

      <ResizeHandle target={asideRef} />
    </aside>
  );
}

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
 */

/* -------------------------------------------------------------------------- */
/* All-projects switcher                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Move to a project without resuming anything in it.
 *
 * This is no longer the route to the rest of the history — the list above holds
 * every project now, and clicking a row does the whole switch. What it still
 * does that the list cannot is land you in a project *fresh*: a blank session in
 * a directory, rather than the continuation of an old one. That is the only
 * reachable way to start work in a project whose history you do not want, and
 * the only way at all into one that has no history to click.
 *
 * Its degraded states are still worth spelling out rather than hiding. Each
 * renders the button disabled with its reason attached, per the app-wide rule:
 *
 *   - the provider cannot list sessions at all;
 *   - it can, but only for the current directory (`sessionsScope === 'cwd'`),
 *     so no other project is even enumerated;
 *   - it listed everything and there genuinely is only one project.
 *
 * ## Choosing a project starts a fresh session in it
 *
 * A session id only resolves against the directory it ran in — see `setCwd` and
 * `resumeSession` in the store. Carrying a resume target across a directory
 * change would aim the next prompt at a session the provider cannot find, so
 * `setCwd` clears it. That is the difference from clicking a row above, which
 * carries the session *and* its directory across together.
 */
function ProjectSwitcher(): ReactElement {
  const sessions = useApp((s) => s.sessions);
  const pane = usePaneRef();
  const cwd = usePane((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const scope = useApp((s) => s.sessionsScope);
  const listing = useCapability('listSessions');

  const groups = useMemo(() => groupSessionsByProject(sessions), [sessions]);
  const home = useMemo(
    () => inferHomeDirectory([...sessions.map((s) => s.cwd), cwd], platform),
    [sessions, cwd, platform],
  );

  const others = groups.filter((group) => group.cwd !== cwd);

  const reason = !listing.supported
    ? `${listing.reason} Without a listing there is no way to enumerate other projects.`
    : scope === 'cwd'
      ? 'This build lists sessions for the current directory only, so other projects are never enumerated. Change the working directory above the composer to move to one.'
      : others.length === 0
        ? 'No other project has a recorded session yet. Change the working directory above the composer to start one somewhere else.'
        : undefined;

  /*
   * Not "All projects" any more. That label was accurate when the list above
   * held one project and this was the door to the rest; with every project
   * listed it would name what is already on screen, and the one thing this does
   * that the list cannot is land you somewhere *without* resuming anything. The
   * count went with it — it counted the other projects, which are now visible.
   */
  const label = (
    <>
      <FolderTreeIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">Start somewhere else</span>
    </>
  );

  const className =
    'h-7 w-full justify-start gap-1.5 rounded-none border-t border-line px-2.5 text-2xs font-normal text-ink-muted';

  if (reason !== undefined) {
    return (
      <ReasonButton
        variant="ghost"
        size="sm"
        disabled
        disabledReason={reason}
        tooltipSide="top"
        className={className}
      >
        {label}
      </ReasonButton>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={className}>
          {label}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-80 max-w-[min(20rem,90vw)]">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Switch project — newest activity first
        </DropdownMenuLabel>
        {others.map((group) => (
          <DropdownMenuItem
            key={group.cwd}
            // Just the directory. `setCwd` clears the resume target itself now,
            // in the right order, for every caller — this used to be the one
            // place that remembered to.
            onSelect={() => setCwd(group.cwd, pane)}
          >
            <Item size="xs" className="w-full">
              <ItemMedia variant="icon">
                <FolderIcon className="size-3.5 text-ink-faint" aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="text-xs text-ink">{lastSegment(group.cwd)}</ItemTitle>
                {/* Full path on hover; the label elides its middle. */}
                <ItemDescription
                  title={group.cwd}
                  className="font-mono text-2xs text-ink-faint"
                >
                  {shortenPath(group.cwd, { home, platform, max: 34 })}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="gap-1.5 font-mono text-2xs text-ink-faint">
                <span>{formatRelative(group.updatedAt)}</span>
                <span className="tabular-nums">{group.sessions.length}</span>
              </ItemActions>
            </Item>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
      className="absolute inset-y-2 right-0 z-20 w-2 cursor-col-resize touch-none rounded-full bg-transparent transition-colors hover:bg-lunar/30 focus-visible:bg-lunar/40"
    />
  );
}
