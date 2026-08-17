/**
 * The working area: a grid of conversations.
 * ============================================================================
 *
 *     ╭───────────────────────╮╭───────────────────────╮
 *     │ artemis › Wire the seam││ api › Rate limiter  ✕ │
 *     ├───────────────────────┤├───────────────────────┤
 *     │  TRANSCRIPT           ┊│  TRANSCRIPT           │
 *     │  COMPOSER · STATUS    ┊│  COMPOSER · STATUS    │
 *     ╰───────────────────────╯╰───────────────────────╯
 *     ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈  ← a row divider
 *     ╭─────────────────────────────────────────────────╮
 *     │ cli › Flag parsing                            ✕ │
 *     ├─────────────────────────────────────────────────┤
 *     │  TRANSCRIPT                                     │
 *     │  COMPOSER · STATUS                              │
 *     ╰─────────────────────────────────────────────────╯
 *
 * ## Rows of columns, not a matrix
 *
 * The grid is a list of rows, each holding its own panes — see `PaneRow` in
 * `state/pane.ts`. That is what puts a third conversation *across the bottom*
 * of a left/right pair instead of quartering the window: splitting downwards
 * adds a full-width row, and splitting that row's pane rightwards is what makes
 * the two-by-two. Within the ceiling (`MAX_PANES`) every arrangement is
 * reachable — a row of them, a stack of them, a square, or a pair over a
 * full-width third — and none needs an empty cell to stay rectangular.
 *
 * Reachable is not the same as usable: `SPLIT_MIN_WIDTH` is a pixel floor, so a
 * window's worth of panes all in one row runs out of width long before it runs
 * out of the pane budget, and the stacked shapes are what a full window
 * actually looks like. The grid does not enforce that — "will this fit on this
 * display" is a question about the window, not about the layout model.
 *
 * Structurally that is a vertical `ResizablePanelGroup` of rows, each row a
 * horizontal group of panes. A row holding one pane renders no inner group at
 * all — a group with a single panel is a divider with nothing to divide — which
 * also keeps the ordinary single-conversation window free of the library's DOM
 * entirely.
 *
 * ## The dividers are `react-resizable-panels`, through shadcn's `resizable`
 *
 * Rather than the hand-rolled pointer maths the sidebar's handle uses. The
 * sidebar resizes one element against the window edge; these resize panels
 * against each other, with a keyboard path, a double-click reset, touch targets
 * sized for coarse pointers and `aria-valuenow` on every separator — all of
 * which the library already does correctly and none of which is worth writing
 * twice, let alone twice per axis.
 *
 * Sizes are committed on `onLayoutChanged`, **not** on `onLayoutChange`. The
 * latter fires per pointer sample; persisting from it would write to
 * `localStorage` sixty times a second and re-render every pane while the user
 * is still dragging. Same rule the sidebar's handle states: the store is the
 * persistence layer, not the animation loop.
 *
 * The floors are *sizes* rather than fractions — see `SPLIT_MIN_WIDTH` and
 * `SPLIT_MIN_HEIGHT` — so a pane stays usable on a laptop window as well as on
 * a display.
 *
 * ## Dropping a session
 *
 * While a session is being dragged out of the sidebar, every pane grows a set
 * of targets: a centre that opens it in that pane, and edges that open it in a
 * new pane on that side. Where you drop is where it lands. Edges the grid has
 * no room for are not offered at all, rather than accepting a drop and doing
 * nothing with it.
 *
 * The overlay mounts only while a session drag is actually in progress
 * (`isSessionDrag`, which is answerable during `dragover` — see
 * `lib/sessionDrag.ts`), so nothing intercepts pointer events the rest of the
 * time.
 *
 * ## Nothing here reads the transcript
 *
 * Same rule as the sidebar. This component re-renders when a pane is opened or
 * closed and when a drag starts — never on a token. Each pane owns a
 * `TranscriptModel` subscribed to by its own leaf rows, so a fast run in one
 * pane cannot re-render another.
 */

import {
  Fragment,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { XIcon } from 'lucide-react';

import { lastSegment } from '../lib/paths';
import { isSessionDrag, readSessionDrag, resolveSessionDrag } from '../lib/sessionDrag';
import {
  SPLIT_MIN_HEIGHT,
  SPLIT_MIN_WIDTH,
  canSplit,
  closePane,
  focusPane,
  openSessionBeside,
  paneCount,
  resumeSession,
  setPaneLayout,
  useApp,
} from '../state/store';
import { PaneProvider, usePane } from '../state/paneContext';
import type { Pane, PaneRow } from '../state/pane';
import { Composer } from './Composer';
import { DockPane } from './DockPane';
import { StatusLine } from './StatusLine';
import { Transcript } from './Transcript';
import { IconButton } from './disabled-reason';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Stored geometry                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The stored key for a divider position.
 *
 * Positional, not by id: pane and row ids are minted per session and mean
 * nothing after a restart, whereas "the second column of the top row" is the
 * same place tomorrow. See `AppState.paneLayout`.
 */
const rowKey = (row: number): string => `row:${row}`;
const cellKey = (row: number, column: number): string => `r${row}c${column}`;

/**
 * The two panels of the dock split.
 *
 * Fixed strings rather than positional keys, because there is only ever one dock
 * and it is always to the right of everything else. They double as the panel ids
 * and as the stored keys — `cellKey` can never produce either, so the two naming
 * schemes cannot collide in `paneLayout`.
 *
 * `DOCK_PANEL` was `'preview'` before the rail grew tabs. The old key is simply
 * never read again: a window that had dragged the preview divider gets an even
 * split once, and stores the new key from the next drag. Migrating it would mean
 * carrying a rename through `localStorage` forever to save one adjustment.
 */
const CONVERSATIONS_PANEL = 'conversations';
const DOCK_PANEL = 'dock';

/**
 * The layout a group should mount with, computed **once per group**.
 *
 * ## Why this is a hook and not a function call in the JSX
 *
 * `defaultLayout` is not an ordinary render prop. The library holds it in the
 * dependency list of the effect that registers the group and applies its
 * layout, so a *new object identity* is indistinguishable from "the author
 * changed the default sizes": the effect re-runs and re-applies the layout.
 * Building it inline meant a fresh object on every render, so every render of
 * the grid re-registered both groups and re-applied their sizes — during the
 * exact renders where the panel set was changing, which is the moment a group
 * is least able to cope with being told to re-lay-out from scratch.
 *
 * Computing it in a state initialiser pins it to the panel set the group
 * actually mounted with, and never recomputes. If panels are added or removed
 * later the library redistributes on its own, which is what it is for — and a
 * `defaultLayout` describing a different number of panels is discarded by the
 * library rather than applied, so the stale value is inert.
 *
 * ## All or nothing
 *
 * A group whose positions are only partly remembered gets `undefined` and
 * splits evenly. `defaultLayout` is a complete description of a group, and half
 * of one — three panes remembered, a fourth just opened and unknown — would
 * settle the grid somewhere nobody chose.
 */
function useStoredLayout(
  stored: Readonly<Record<string, number>>,
  entries: readonly { readonly id: string; readonly key: string }[],
): Record<string, number> | undefined {
  const [layout] = useState(() => {
    const out: Record<string, number> = {};
    for (const entry of entries) {
      const share = stored[entry.key];
      if (share === undefined) return undefined;
      out[entry.id] = share;
    }
    return out;
  });
  return layout;
}

/**
 * The divider's own styling, shared by both axes.
 *
 * Transparent at rest, so the grid reads as panes with gaps between them rather
 * than as a table with rules drawn on it — each pane already carries its own
 * caption border. It lights up on hover and while dragging, which is the only
 * time a divider is worth seeing.
 */
const HANDLE = 'bg-transparent transition-colors hover:bg-lunar/30 data-[state=drag]:bg-lunar/50';

/* -------------------------------------------------------------------------- */
/* The grid                                                                   */
/* -------------------------------------------------------------------------- */

export function WorkingArea(): ReactElement {
  const grid = useApp((s) => s.grid);
  const stored = useApp((s) => s.paneLayout);
  // A boolean, not the tab list itself: this component must re-render when the
  // dock opens or closes and never when a tab is switched, renamed, or when a
  // shell prints a line.
  const showDock = useApp((s) => s.visibleDockTabs.length > 0);

  /*
   * Whether a session is being dragged over this area.
   *
   * A counter, not a boolean. `dragenter` and `dragleave` both fire as the
   * pointer crosses *child* elements, so a boolean flickers off every time the
   * cursor passes over a composer or a transcript row and the overlay
   * disappears from under the user's hand. Counting enters against leaves is
   * the standard fix and the only one that survives a deep subtree.
   */
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isSessionDrag(event.dataTransfer)) return;
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isSessionDrag(event.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const endDrag = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  const alone = grid.length === 1 && (grid[0] as PaneRow).panes.length === 1;

  const conversations =
    grid.length === 1 ? (
      <PaneRowView
        row={grid[0] as PaneRow}
        index={0}
        stored={stored}
        alone={alone}
        dragging={dragging}
        onSettled={endDrag}
      />
    ) : (
      <RowStack grid={grid} stored={stored} dragging={dragging} onSettled={endDrag} />
    );

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={endDrag}
      // A drag that ends outside any target fires no `drop`, and without this
      // the overlay would be left on screen with nothing to dismiss it.
      onDragEnd={endDrag}
    >
      {showDock ? <DockSplit>{conversations}</DockSplit> : conversations}
    </div>
  );
}

/**
 * The grid, against the dock.
 *
 * A group of its own rather than another column inside the grid's, because
 * nothing in the dock is a conversation — see `state/dock.ts`. Keeping it
 * outside means the grid's own geometry (which row, which column, what is
 * stored under `r0c1`) is unchanged whether or not the dock is open, so opening
 * a terminal cannot disturb dividers the user has already placed.
 *
 * Its own component so {@link useStoredLayout} is scoped to the group's
 * lifetime, exactly as in `RowStack`: this mounts when the first dock tab
 * appears and unmounts when the last one goes, which is the span
 * `defaultLayout` must be constant over.
 *
 * The stored key is not positional like the grid's, because there is only ever
 * one of these and it is always in the same place.
 */
function DockSplit({ children }: { readonly children: ReactNode }): ReactElement {
  const stored = useApp((s) => s.paneLayout);
  const defaultLayout = useStoredLayout(stored, [
    { id: CONVERSATIONS_PANEL, key: CONVERSATIONS_PANEL },
    { id: DOCK_PANEL, key: DOCK_PANEL },
  ]);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        const shares: Record<string, number> = {};
        for (const id of [CONVERSATIONS_PANEL, DOCK_PANEL]) {
          const share = layout[id];
          if (typeof share === 'number') shares[id] = share;
        }
        setPaneLayout(shares);
      }}
      className="min-h-0 min-w-0 flex-1"
    >
      <ResizablePanel id={CONVERSATIONS_PANEL} minSize={SPLIT_MIN_WIDTH} className="flex min-w-0">
        {children}
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="Resize the dock" className={HANDLE} />
      <ResizablePanel id={DOCK_PANEL} minSize={SPLIT_MIN_WIDTH} className="flex min-w-0">
        <DockPane />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * The rows, stacked, with dividers between them.
 *
 * Its own component so that {@link useStoredLayout} is scoped to the group's
 * lifetime: this mounts when the window gains a second row and unmounts when it
 * loses it, which is exactly the span over which `defaultLayout` must not
 * change identity.
 */
function RowStack({
  grid,
  stored,
  dragging,
  onSettled,
}: {
  readonly grid: readonly PaneRow[];
  readonly stored: Readonly<Record<string, number>>;
  readonly dragging: boolean;
  readonly onSettled: () => void;
}): ReactElement {
  const defaultLayout = useStoredLayout(
    stored,
    grid.map((row, index) => ({ id: row.id, key: rowKey(index) })),
  );

  return (
    <ResizablePanelGroup
      orientation="vertical"
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => {
        // Ignore everything that is not a person dragging a divider — mounting,
        // a window resize and the imperative API all report a layout too, and
        // persisting those would overwrite a deliberate choice with an
        // incidental one.
        if (!meta.isUserInteraction) return;
        const shares: Record<string, number> = {};
        grid.forEach((row, index) => {
          const share = layout[row.id];
          if (typeof share === 'number') shares[rowKey(index)] = share;
        });
        setPaneLayout(shares);
      }}
      className="min-h-0 min-w-0 flex-1"
    >
      {grid.map((row, index) => (
        <Fragment key={row.id}>
          {index > 0 ? (
            <ResizableHandle withHandle aria-label="Resize the rows" className={HANDLE} />
          ) : null}
          <ResizablePanel id={row.id} minSize={SPLIT_MIN_HEIGHT} className="flex min-h-0">
            <PaneRowView
              row={row}
              index={index}
              stored={stored}
              alone={false}
              dragging={dragging}
              onSettled={onSettled}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

/** One row: its panes side by side, with dividers between them. */
function PaneRowView({
  row,
  index,
  stored,
  alone,
  dragging,
  onSettled,
}: {
  readonly row: PaneRow;
  readonly index: number;
  readonly stored: Readonly<Record<string, number>>;
  readonly alone: boolean;
  readonly dragging: boolean;
  readonly onSettled: () => void;
}): ReactElement {
  // A group with one panel is a divider with nothing to divide, and rendering
  // the pane directly keeps the ordinary single-conversation window free of the
  // library's DOM entirely. The early return is safe because this component
  // holds no hooks of its own — the group's are in `ColumnStack`.
  if (row.panes.length === 1) {
    return (
      <PaneCell
        pane={row.panes[0] as Pane}
        alone={alone}
        dragging={dragging}
        onSettled={onSettled}
      />
    );
  }

  return (
    <ColumnStack
      row={row}
      index={index}
      stored={stored}
      dragging={dragging}
      onSettled={onSettled}
    />
  );
}

/** One row's panes, side by side. See {@link RowStack} for why it is a component. */
function ColumnStack({
  row,
  index,
  stored,
  dragging,
  onSettled,
}: {
  readonly row: PaneRow;
  readonly index: number;
  readonly stored: Readonly<Record<string, number>>;
  readonly dragging: boolean;
  readonly onSettled: () => void;
}): ReactElement {
  const defaultLayout = useStoredLayout(
    stored,
    row.panes.map((pane, column) => ({ id: pane.id, key: cellKey(index, column) })),
  );

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        const shares: Record<string, number> = {};
        row.panes.forEach((pane, column) => {
          const share = layout[pane.id];
          if (typeof share === 'number') shares[cellKey(index, column)] = share;
        });
        setPaneLayout(shares);
      }}
      className="min-h-0 min-w-0 flex-1"
    >
      {row.panes.map((pane, column) => (
        <Fragment key={pane.id}>
          {column > 0 ? (
            <ResizableHandle withHandle aria-label="Resize the columns" className={HANDLE} />
          ) : null}
          <ResizablePanel id={pane.id} minSize={SPLIT_MIN_WIDTH} className="flex min-w-0">
            <PaneCell pane={pane} alone={false} dragging={dragging} onSettled={onSettled} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* One pane                                                                   */
/* -------------------------------------------------------------------------- */

/** A pane plus the drop overlay that covers it while a session is in flight. */
function PaneCell({
  pane,
  alone,
  dragging,
  onSettled,
}: {
  readonly pane: Pane;
  readonly alone: boolean;
  readonly dragging: boolean;
  readonly onSettled: () => void;
}): ReactElement {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <PaneColumn pane={pane} alone={alone} />
      {dragging ? <DropZones pane={pane} onSettled={onSettled} /> : null}
    </div>
  );
}

/**
 * A pane: caption, transcript, composer, status line.
 *
 * (The hunt bar lived between the transcript and the composer for one
 * release. It rides inside the transcript's own content column now — the ask
 * was the bottom of the *text*, not of the pane — so this column is back to
 * its original four rows. See `HuntBar.tsx` for the placement's history.)
 *
 * `PaneProvider` is the whole reason this component exists as a wrapper. Every
 * descendant — down to a permission card six levels into the transcript — reads
 * its session state through `usePane`, which resolves against this provider. A
 * component that does not care which pane it is in needs no changes at all, and
 * one that does gets the answer without a prop threaded through the status
 * line's dozen segments.
 *
 * Focus is captured rather than bubbled (`onFocusCapture`,
 * `onPointerDownCapture`) so that clicking anywhere — including on a control
 * that stops propagation, or on dead space that focuses nothing — points the
 * window's overlays at this pane.
 */
function PaneColumn({
  pane,
  alone,
}: {
  readonly pane: Pane;
  readonly alone: boolean;
}): ReactElement {
  const focused = useApp((s) => s.focusedPaneId === pane.id);
  const take = useCallback(() => focusPane(pane.id), [pane.id]);

  return (
    <PaneProvider pane={pane}>
      <section
        onFocusCapture={take}
        onPointerDownCapture={take}
        aria-label={alone ? undefined : 'Conversation'}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {alone ? null : <PaneCaption pane={pane} focused={focused} />}
        <Transcript />
        <Composer />
        <StatusLine />
      </section>
    </PaneProvider>
  );
}

/**
 * A pane's name, and the way to close it. Only while the grid holds more than
 * one.
 *
 * With a single pane the window header already answers "what am I looking at",
 * and a caption under it would say the same thing twice. With several, the
 * header can only name one of them — it names the focused pane — so each gets
 * its own line. The focused one is the brighter, which is what ties the
 * header's title to the pane it is describing.
 */
function PaneCaption({
  pane,
  focused,
}: {
  readonly pane: Pane;
  readonly focused: boolean;
}): ReactElement {
  const cwd = usePane((s) => s.cwd);
  const resumeId = usePane((s) => s.resumeSessionId);
  const title = useApp((s) =>
    resumeId === null
      ? 'New session'
      : (s.sessions.find((session) => session.id === resumeId)?.title ?? 'Resumed session'),
  );
  const project = cwd.trim().length > 0 ? lastSegment(cwd) : 'No project';

  return (
    <div
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 border-b px-2.5',
        focused ? 'border-lunar/40 bg-raised/60' : 'border-line',
      )}
    >
      <span
        title={cwd}
        className={cn('shrink-0 text-2xs font-medium', focused ? 'text-ink' : 'text-ink-faint')}
      >
        {project}
      </span>
      <span aria-hidden="true" className="shrink-0 text-2xs text-ink-faint">
        ›
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-2xs',
          focused ? 'text-ink-muted' : 'text-ink-faint',
        )}
      >
        {title}
      </span>
      <IconButton
        label="Close this pane"
        size="icon-xs"
        onClick={() => closePane(pane.id)}
        className="shrink-0 text-ink-faint"
      >
        <XIcon />
      </IconButton>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Drop zones                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a dragged session can land on this pane.
 *
 * Three targets: two edges and a centre. `left` and `up` are deliberately not
 * offered — the grid inserts *after* a pane, so an "open on the left" would
 * mean either a second, invisible rule about ordering or a target that
 * silently does the same thing as `right`. Two directions, unambiguous, and
 * every position in the grid is still reachable because you choose *which pane*
 * to drop on.
 *
 * With the window already at {@link MAX_PANES} the edges are simply absent and
 * the centre fills the pane: at that point every drop is a replacement, which
 * is the only thing left that can happen.
 */
type Zone = 'centre' | 'right' | 'down';

/** How much of the pane each edge target claims. */
const EDGE = '28%';

function DropZones({
  pane,
  onSettled,
}: {
  readonly pane: Pane;
  readonly onSettled: () => void;
}): ReactElement {
  const room = useApp(canSplit);
  const shared = useApp((s) => paneCount(s) > 1);

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {/*
        The centre fills the pane and the edges sit over it, so a drop near a
        border reads as "that side" and everything else reads as "here". The
        edges are declared after the centre for exactly that reason — later
        siblings win the hit test at the same stacking level.
      */}
      <DropZone
        zone="centre"
        pane={pane}
        onSettled={onSettled}
        label={shared ? 'Open in this pane' : 'Open here'}
        className="absolute inset-0"
      />
      {room ? (
        <DropZone
          zone="right"
          pane={pane}
          onSettled={onSettled}
          label="Open to the right"
          className="absolute inset-y-0 right-0"
          style={{ width: EDGE }}
        />
      ) : null}
      {room ? (
        <DropZone
          zone="down"
          pane={pane}
          onSettled={onSettled}
          label="Open below, full width"
          className="absolute inset-x-0 bottom-0"
          style={{ height: EDGE }}
        />
      ) : null}
    </div>
  );
}

function DropZone({
  zone,
  pane,
  label,
  className,
  style,
  onSettled,
}: {
  readonly zone: Zone;
  readonly pane: Pane;
  readonly label: string;
  readonly className: string;
  readonly style?: CSSProperties;
  readonly onSettled: () => void;
}): ReactElement {
  const [over, setOver] = useState(false);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      // Stopped so the centre target underneath does not also handle it, which
      // would open the session twice — once beside and once in place.
      event.stopPropagation();
      setOver(false);
      onSettled();

      const payload = readSessionDrag(event.dataTransfer);
      if (!payload) return;
      const session = resolveSessionDrag(payload, useApp.getState().sessions);
      // The row can disappear mid-drag — a refresh lands, or the session is
      // gone. Declining is the honest outcome; see `lib/sessionDrag.ts`.
      if (!session) return;

      if (zone === 'centre') resumeSession(session, pane);
      else openSessionBeside(session, zone, pane);
    },
    [zone, pane, onSettled],
  );

  return (
    <div
      style={style}
      onDragOver={(event) => {
        // `preventDefault` is what marks this element as a valid drop target.
        // Without it the browser refuses the drop and shows the "no entry"
        // cursor — the single most common way an HTML5 drop silently does
        // nothing.
        if (!isSessionDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'pointer-events-auto flex items-center justify-center transition-colors',
        over ? 'bg-lunar/15 ring-1 ring-lunar/50 ring-inset' : 'bg-transparent',
        className,
      )}
    >
      {/*
        Only the target under the cursor names itself. Three labels on every
        pane at once — a dozen across a full grid — is a wall of text over the
        thing the user is trying to aim at.
      */}
      {over ? (
        <span className="rounded-lg border border-dashed border-lunar/70 bg-panel px-3 py-1.5 text-2xs text-ink shadow-lg shadow-black/40">
          {label}
        </span>
      ) : null}
    </div>
  );
}
