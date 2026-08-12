/**
 * Every session, grouped by the project it ran in.
 * ============================================================================
 *
 *                               [ filter… ]
 *     ▾ artemis ·22 ────────────────────────
 *         Wire the adapter seam
 *         ⌥ main · ▪ Work
 *     ▸ api ·9 ─────────────────────────────
 *     ▾ cli ·3 ─────────────────────────────
 *         Profile store encryption
 *         ▪ Home
 *
 * Every project, most recently worked in first.
 *
 * The list was once scoped to the working directory, with everything else behind
 * an "All projects" switcher, because an undifferentiated stream of every
 * repository buried the answer to "what was I doing in *this* repo". That fixed
 * the wrong half: scoping made the other question — "where was that session I
 * had open yesterday?" — unanswerable without first guessing the folder it was
 * in and switching to it, which meant changing directory, which ends the current
 * session. History you have to destroy your place to look at is not history you
 * can browse.
 *
 * Recency answers the first question well enough on its own, because the project
 * you are working in is almost always the one you touched last. It is also the
 * order that makes the list *stable*: the top of it is where you just were,
 * wherever that was, rather than moving under you when the directory changes.
 *
 * Clicking any row does the whole switch — provider, profile, directory and
 * transcript — because `resumeSession` already had to: a session id only
 * resolves against the directory it ran in. Crossing a project boundary from
 * here was always going to work; it was only ever the list that hid the rows.
 *
 * ## 0. Each project is its own fold, and there is no title over them
 *
 * There was a `SESSIONS` caption here once, and later the current repository's
 * name; both sat over a single fold for the entire list. The caption named the
 * shape of what was below rather than its subject, the repository name became a
 * lie the moment the list held every project, and the fold answered a question
 * nobody has — "hide all my history at once" — while the one people do have,
 * "put *that* project away", had no control at all.
 *
 * So the title is gone and each group heading folds its own project. The filter
 * has the row to itself.
 *
 * Repository name where it is known, directory name otherwise. Working in
 * `~/code/artemis/apps/desktop` you are working on *artemis*; a heading reading
 * "desktop" is technically true and useless. The renderer has no `fs`, so the
 * main process is asked once per directory change — which means only the
 * *current* project can be named that way, and the others fall back to their
 * folder name rather than paying a round trip per heading.
 *
 * The folds are persisted, per directory. A section the user closed and found
 * reopened on the next launch is the same discourtesy as a sidebar width that
 * resets. See `collapsedProjects` in the store for why the stored list is of
 * the *shut* projects rather than the open ones.
 *
 * ## 1. It is virtualised, over two row heights
 *
 * History runs to hundreds of rows, and mounting all of them costs a visible
 * hitch every time the list refreshes — which happens at the end of every run.
 * So rows are absolutely positioned inside a spacer of the full height and only
 * the slice inside the viewport (plus overscan) is mounted.
 *
 * Headings are shorter than session rows, so an offset is no longer
 * `index * ROW_HEIGHT`. Row starts are accumulated once per change of the row
 * array and the visible window is a binary search over them — see `indexAt`.
 * What is deliberately *not* back is the second copy of each heading pinned to
 * the top of the viewport to fake `position: sticky` inside an absolutely
 * positioned list. A heading you have scrolled past belongs to the rows you are
 * already reading; it did not earn its bookkeeping.
 *
 * ## 2. `ROW_HEIGHT` is a constant, and it is not arbitrary
 *
 * A row is two lines: a 12px title on an 18px leading and an 11px meta line on
 * a 16px leading, 2px apart — 36px of text. Add the button's 12px of vertical
 * padding and the 4px gap between rows and you get 52; 54 leaves two pixels of
 * slack. The meta line lost its timestamp and its terminal glyph and gained a
 * colour swatch, none of which changes its height — the line box is set by the
 * 11px type, and the swatch is 8px. Getting this wrong is not cosmetic: a row
 * that is *slightly* too short
 * squeezes the flex children, and because the title also carries `truncate`
 * (`overflow: hidden`) the glyphs are then clipped horizontally through the
 * middle. That was a real, shipped bug — the title line was being compressed
 * from 18px to 12px and every session title was sliced. Both lines now carry
 * `shrink-0`, so even if this arithmetic goes stale the text will overflow
 * visibly rather than be quietly cut in half.
 *
 * ## 3. Rows take primitives, so `memo` actually works
 *
 * A row's position is passed as a number, not as a `style` object. An object
 * literal is a new identity every render, which would defeat `memo` on every
 * row on every scroll frame — the exact opposite of the point.
 *
 * ## 4. It never subscribes to the transcript
 *
 * Streaming text lives in an external store React does not see (see
 * `state/transcript.ts`), and nothing here reads it. Scroll state is local. The
 * sidebar is therefore invisible to a `text.delta`, which is the property the
 * whole layout depends on: adding a persistent pane must not put a re-render on
 * the hot path.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  InboxIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import type { ProfileId, SessionSummary } from '@rx-artemis/protocol';

import { useCapability } from '../hooks/useCapability';
import type { WorkspaceNames } from '../lib/extensions';
import { condenseTitle, formatRelative } from '../lib/format';
import { lastSegment } from '../lib/paths';
import {
  flattenGroups,
  groupSessionsByProject,
  orderArchived,
  partitionArchived,
  sessionKey,
  type ListRow,
} from '../lib/sessionGroups';
import { writeSessionDrag } from '../lib/sessionDrag';
import {
  refreshSessions,
  renameSession,
  resumeSession,
  sessionOrderKey,
  toggleArchivedExpanded,
  toggleProjectCollapsed,
  toggleSessionArchived,
  useApp,
} from '../state/store';
import { usePane } from '../state/paneContext';
import { CapabilityButton } from './capability-button';
import { ProfileSwatch, StatusDot } from './primitives';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** See note 2 in the file header before changing this. */
const ROW_HEIGHT = 54;
/**
 * A group heading's row height.
 *
 * One 11px line on a 16px leading, with 4px of air above and below. Deliberately
 * much shorter than a session row: a heading is a divider with a word on it, and
 * at row height it would read as an unclickable entry in the list.
 */
const HEADER_HEIGHT = 24;
/** Rows kept mounted beyond each edge, so a fast flick does not show gaps. */
const OVERSCAN = 6;
/**
 * Viewport height assumed before the first measurement.
 *
 * `clientHeight` is zero on the very first paint and under jsdom, and a
 * zero-height viewport would render zero rows. Guessing tall is the safe
 * direction: the worst case is a few extra rows for one frame.
 */
const ASSUMED_VIEWPORT = 720;
/** Below this many sessions, scanning beats typing and the field is clutter. */
const FILTER_THRESHOLD = 8;

export function SessionList(): ReactElement {
  const sessions = useApp((s) => s.sessions);
  const loading = useApp((s) => s.sessionsLoading);
  const error = useApp((s) => s.sessionsError);
  const profiles = useApp((s) => s.profiles);
  const collapsedProjects = useApp((s) => s.collapsedProjects);
  const archivedSessions = useApp((s) => s.archivedSessions);
  const archivedExpanded = useApp((s) => s.archivedExpanded);
  const listing = useCapability('listSessions');
  const resuming = useCapability('resumeSession');

  const [query, setQuery] = useState('');

  const profileLabel = useCallback(
    (id: ProfileId): string | undefined => profiles.find((p) => p.id === id)?.label,
    [profiles],
  );

  /*
   * Every project, grouped, newest first.
   *
   * `groupSessionsByProject` owns the query matching, the recency order and the
   * id tie-break, and it is the part of this feature that has tests — filtering
   * here instead would quietly fork all three.
   */
  const collapsed = useMemo(() => new Set(collapsedProjects), [collapsedProjects]);
  const archivedKeys = useMemo(() => new Set(archivedSessions), [archivedSessions]);

  /*
   * Rows hold their place while their agent is working.
   *
   * `updatedAt` is the transcript file's mtime, and the feed re-reads it every
   * four seconds while anything is live, so ordering several working sessions by
   * it made the list trade places under the pointer. `sessionOrderHold` pins each
   * one where it was when its run started; see the field for the whole story.
   */
  const hold = useApp((s) => s.sessionOrderHold);
  const orderKey = useCallback(
    (session: SessionSummary) => sessionOrderKey(session, hold),
    [hold],
  );

  /*
   * Archived sessions are lifted out *before* grouping, so they leave their
   * project rather than hiding inside it — a project whose every session is
   * archived disappears from the list entirely, which is the point of putting
   * them away. The archive is then filtered by the same query, so searching
   * still finds what you put in it.
   */
  const rows = useMemo(() => {
    const split = partitionArchived(sessions, archivedKeys);
    return flattenGroups(
      groupSessionsByProject(split.active, { query, profileLabel, orderKey }),
      collapsed,
      {
        sessions: orderArchived(split.archived, { query, profileLabel, orderKey }),
        collapsed: !archivedExpanded,
      },
    );
  }, [sessions, query, profileLabel, orderKey, collapsed, archivedKeys, archivedExpanded]);

  /** Unfiltered, so the count does not jump around while typing. */
  const total = sessions.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      {/*
       * The filter is the only thing left on this row. A "Sessions" title sat
       * here, folding the whole list from one control — a caption for a list
       * whose contents are obvious, over a fold that answered the wrong
       * question. Folding is per project now, on the group headings, which is
       * the level anyone actually wants to put away.
       */}
      {total > FILTER_THRESHOLD ? (
        <div className="px-1.5 pt-2 pb-1.5">
          <div className="relative min-w-0">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter…"
              aria-label="Filter sessions"
              spellCheck={false}
              className="h-6 rounded-md pl-6.5 text-2xs md:text-2xs"
            />
          </div>
        </div>
      ) : (
        <div className="pt-1.5" />
      )}

      <>
        {/*
         * Both capability notes sit *above* the rows rather than replacing
         * them, and neither ever empties the list.
         *
         * `listSessions` used to blank it: selecting an account whose CLI
         * cannot enumerate history removed every other provider's sessions
         * from the screen too. That was the wrong scope. This list spans
         * providers, so the capability of the one currently selected decides
         * what is *missing* from it, not whether there is anything to show —
         * and the sentence says exactly that much.
         *
         * `resumeSession` never emptied it; the rows are still worth reading
         * when they cannot be clicked.
         */}
        {!listing.supported ? (
          <p className="border-y border-line bg-raised px-2.5 py-1.5 text-2xs leading-snug text-ink-muted">
            {listing.reason} Its own sessions are not in this list; everything below belongs to the
            other accounts.
          </p>
        ) : null}

        {!resuming.supported ? (
          <p className="border-y border-line bg-raised px-2.5 py-1.5 text-2xs leading-snug text-ink-muted">
            {resuming.reason} These are listed for reference; picking one would not carry the
            conversation forward.
          </p>
        ) : null}

        {error ? (
          <Note tone="signal">
            {/* The backend's own sentence — a paraphrase would lose the cause. */}
            {error}
            <button
              type="button"
              onClick={() => void refreshSessions()}
              className="mt-1 block text-2xs text-lunar underline-offset-2 hover:underline"
            >
              Try again
            </button>
          </Note>
        ) : loading && sessions.length === 0 ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <NothingHere filtered={total > 0} query={query} />
        ) : (
          <VirtualRows rows={rows} />
        )}
      </>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Group headings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One project's heading, and the control that folds it.
 *
 * ## The fold lives here, not over the whole list
 *
 * There was a `Sessions` title above the list with a single fold on it. It was a
 * caption for a list whose contents are obviously sessions, and its fold
 * answered a question nobody has — "hide all my history at once" — while the one
 * people do have, "put *that* project away", had no control at all. So the title
 * is gone and every project folds independently.
 *
 * The whole row is the control rather than a chevron beside a label, because a
 * 10px target next to a word that looks clickable and is not is the kind of
 * thing people click three times before reading. The chevron is the
 * *affordance*; `aria-expanded` says the same thing to a screen reader.
 *
 * ## The count is the project's, not the visible rows'
 *
 * It stays put when the group is folded — that is the number worth reading while
 * it is shut, and it is why folding a project does not make it look empty. It is
 * also unfiltered, so it does not count down while someone types in the filter.
 *
 * Rendered as an ordinary row rather than a `position: sticky` element: the rows
 * are absolutely positioned inside a spacer, where sticky does not apply, and
 * faking it needs a second pinned copy of the heading plus the bookkeeping to
 * know which one it is. That was in this file once and is not worth its weight.
 */
const GroupHeading = memo(function GroupHeading({
  cwd,
  count,
  collapsed,
  top,
}: {
  readonly cwd: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly top: number;
}): ReactElement {
  // The focused column's directory. `usePane` outside a column resolves to it,
  // so the heading marks the project the header is naming — the two agree by
  // construction rather than by both reading the same field.
  const current = usePane((s) => s.cwd === cwd);
  const workspace = usePane((s) => (s.cwd === cwd ? s.workspace : null));

  // `workspace` only describes the *current* directory, so every other group
  // falls back to the folder name. A repository name for a project you are not
  // in would need a `describe` call per project, which is a round trip per row
  // for a word.
  const name = projectLabel(cwd, workspace);

  return (
    <div style={{ top, height: HEADER_HEIGHT }} className="absolute inset-x-0 px-1.5">
      <button
        type="button"
        onClick={() => toggleProjectCollapsed(cwd)}
        aria-expanded={!collapsed}
        title={cwd}
        className="flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-left transition-colors hover:bg-raised/70"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-2.5 shrink-0 text-ink-faint transition-transform',
            collapsed && '-rotate-90',
          )}
        />
        {/*
          One folder, drawn the same way in every heading.
          ------------------------------------------------------------------
          Both the glyph and its colour used to turn on whether this was the
          directory you were standing in, and the glyph did so invisibly: the
          repository variant was chosen from `workspace`, which is only ever
          resolved for the *current* project, so "is a git repo" and "is the
          active project" were the same condition wearing different clothes.
          A project's icon would silently change shape as you moved away from
          it, which says something about the project that is not true.

          So it is one folder at one weight throughout. The active project is
          still marked — by the label beside this, which is a claim about
          which project you are in rather than about what kind of thing it is.
        */}
        <FolderIcon aria-hidden="true" className="size-2.5 shrink-0 text-lunar" />
        <span
          className={cn(
            'min-w-0 truncate text-2xs font-medium tracking-tight',
            current ? 'text-ink-muted' : 'text-ink-faint',
          )}
        >
          {name ?? 'No project'}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">·{count}</span>
        <span aria-hidden="true" className="ml-1 h-px min-w-0 flex-1 bg-line" />
      </button>
    </div>
  );
});

/**
 * The Archived section's heading.
 *
 * Built to the same shape as {@link GroupHeading} so the two read as one list
 * rather than as a list plus an appendix, but deliberately not the same
 * component: it names no directory, marks no current project, and folds on its
 * own preference rather than on `collapsedProjects` — see `archivedExpanded`
 * for why the polarity differs.
 */
const ArchiveHeading = memo(function ArchiveHeading({
  count,
  collapsed,
  top,
}: {
  readonly count: number;
  readonly collapsed: boolean;
  readonly top: number;
}): ReactElement {
  return (
    <div style={{ top, height: HEADER_HEIGHT }} className="absolute inset-x-0 px-1.5">
      <button
        type="button"
        onClick={() => toggleArchivedExpanded()}
        aria-expanded={!collapsed}
        title="Sessions you have put away. Still on disk, still resumable."
        className="flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-left transition-colors hover:bg-raised/70"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-2.5 shrink-0 text-ink-faint transition-transform',
            collapsed && '-rotate-90',
          )}
        />
        <ArchiveIcon aria-hidden="true" className="size-2.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate text-2xs font-medium tracking-tight text-ink-faint">
          Archived
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">·{count}</span>
        <span aria-hidden="true" className="ml-1 h-px min-w-0 flex-1 bg-line" />
      </button>
    </div>
  );
});

/**
 * What to call this project.
 *
 * Repository name first, then the directory's, then the last segment of `cwd`
 * — the last of which is the answer for a build with no `workspace.describe`
 * and for the moment before the first reply lands. `null` means there is no
 * working directory at all, which is a different thing from an unnamed one and
 * is rendered as its own faint placeholder state.
 *
 * It no longer reports whether the directory *is* a repository. That fact was
 * only ever knowable for the current project, so the icon it selected changed
 * shape as you moved between projects — see the note on the folder glyph above.
 */
function projectLabel(cwd: string, workspace: WorkspaceNames | null): string | null {
  if (cwd.trim().length === 0) return null;
  const repo = workspace?.repoName;
  if (repo !== undefined && repo.length > 0) return repo;
  return workspace?.name ?? lastSegment(cwd);
}

/* -------------------------------------------------------------------------- */
/* Virtualiser                                                                */
/* -------------------------------------------------------------------------- */

function VirtualRows({ rows }: { readonly rows: readonly ListRow[] }): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A filter keystroke — or a project switch — can leave the scroller parked
  // past the end of a much shorter list, which would show an empty window until
  // the user scrolled.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || element.scrollTop === 0) return;
    if (element.scrollTop > element.scrollHeight - element.clientHeight) {
      element.scrollTop = 0;
      setScrollTop(0);
    }
  }, [rows]);

  /*
   * Where every row starts, and where the list ends.
   *
   * Two row heights means an offset is no longer `index * ROW_HEIGHT`, so the
   * starts are accumulated once per change of `rows` and the window is found by
   * binary search over them. `offsets` has one extra entry — the end of the last
   * row — so `offsets[i + 1]` is always the bottom of row `i` and the total
   * height is the final element, with no special case for an empty list.
   */
  const offsets = useMemo(() => {
    const starts = new Array<number>(rows.length + 1);
    let y = 0;
    for (let i = 0; i < rows.length; i += 1) {
      starts[i] = y;
      const kind = rows[i]?.kind;
      y += kind === 'header' || kind === 'archive-header' ? HEADER_HEIGHT : ROW_HEIGHT;
    }
    starts[rows.length] = y;
    return starts;
  }, [rows]);

  const height = viewport > 0 ? viewport : ASSUMED_VIEWPORT;
  const total = offsets[rows.length] ?? 0;

  const first = Math.max(0, indexAt(offsets, scrollTop) - OVERSCAN);
  const last = Math.min(rows.length - 1, indexAt(offsets, scrollTop + height) + OVERSCAN);

  const visible: ReactElement[] = [];
  for (let i = first; i <= last; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const top = offsets[i] ?? 0;
    if (row.kind === 'header') {
      visible.push(
        <GroupHeading
          key={row.key}
          cwd={row.cwd}
          count={row.count}
          collapsed={row.collapsed}
          top={top}
        />,
      );
      continue;
    }
    if (row.kind === 'archive-header') {
      visible.push(
        <ArchiveHeading key={row.key} count={row.count} collapsed={row.collapsed} top={top} />,
      );
      continue;
    }
    // `row.key` is `sessionKey` — an id is unique inside the profile that owns
    // it, not globally, and two profiles surfacing the same id would collide
    // into one React key and silently drop a row.
    visible.push(
      <Row key={row.key} top={top} session={row.session} archived={row.archived ?? false} />,
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
    >
      <div className="relative" style={{ height: total }}>
        {visible}
      </div>
    </div>
  );
}

/**
 * Index of the row containing `y`.
 *
 * Binary search for the last start at or before `y`. Clamped to a real index at
 * both ends: `y` below the first row and `y` past the last are both routine —
 * overscan asks for offsets outside the list on purpose — and the caller clamps
 * again against `rows.length`.
 */
function indexAt(offsets: readonly number[], y: number): number {
  let low = 0;
  // `offsets` carries a trailing end-of-list entry, which is not a row.
  let high = offsets.length - 2;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= y) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, low);
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

const Row = memo(function Row({
  session,
  top,
  archived,
}: {
  readonly session: SessionSummary;
  readonly top: number;
  readonly archived: boolean;
}): ReactElement {
  /*
   * "Open in *a* column", not "open in the focused one".
   *
   * With the window split, the same session can be showing on either side, and
   * a row that only lit up for the focused column would go dark the moment the
   * user clicked into the other one — the row would stop marking a session that
   * is plainly on screen. So this asks the question the user is actually
   * asking: is this open anywhere?
   *
   * Read off `openSessions` rather than computed from the panes, for the same
   * reason `running` below reads `runningSessions`: which session a column is
   * showing is a fact about a *pane's* store, and this component subscribes to
   * the window's. This line used to reach across the two — `allPanes(s).some(p
   * => paneState(p).resumeSessionId === session.id)` — which React had no way
   * to invalidate, so the mark appeared only when an unrelated window write
   * forced a repaint, and the id it compared was the wrong one for a session
   * that had not finished its first turn. See `syncOpenSessions`.
   */
  const active = useApp((s) => s.openSessions.includes(session.id));
  /*
   * Working, whether or not it is on screen.
   *
   * A conversation the user walked away from keeps running — see
   * `AppState.background` — and this row is then the only place it exists in the
   * UI. Without the marker, an agent halfway through a refactor looks exactly
   * like a transcript that finished last Tuesday, and the user has no way to
   * know there is anything to come back to.
   *
   * Read off `runningSessions` rather than computed from the panes, because run
   * state lives in a store this component does not subscribe to. See
   * `syncRunningSessions`.
   */
  const running = useApp((s) => s.runningSessions.includes(session.id));
  const profile = useApp((s) => s.profiles.find((p) => p.id === session.profileId));
  const renaming = useCapability('renameSession');
  const deleting = useCapability('deleteSession');

  // A session whose profile is gone cannot be resumed at all — its transcript
  // lives in that profile's config directory. Say so on the row rather than
  // letting the click fail somewhere the user is not looking.
  const orphaned = profile === undefined;

  /*
   * Two pieces of row-local UI state, and both are deliberately here rather
   * than in the store.
   *
   * `editing` is a text field that exists for a few seconds; `confirming` is a
   * dialog answering one question about one row. Neither is a fact about the
   * application — putting either in the store would make every row re-render
   * when any row started an edit, on a list that is virtualised precisely to
   * avoid that.
   */
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /*
   * The rename field replaces the whole row, not just its first line.
   *
   * Overlaying an input on top of the button would leave a resume click live
   * underneath it — the row's own click handler is what the user is trying to
   * type inside. Swapping the row out means there is nothing behind the field
   * to hit by accident, and the row comes back the moment the edit ends.
   */
  if (editing) {
    return (
      <div style={{ top, height: ROW_HEIGHT }} className="absolute inset-x-0 px-2 py-0.5">
        <RenameField session={session} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div
      style={{ top, height: ROW_HEIGHT }}
      className="absolute inset-x-0 px-2 py-0.5"
      /*
       * The drag source for the split, and it is the outermost wrapper rather
       * than the button or the context-menu trigger inside it.
       *
       * A `<button draggable>` is a fight: the element already owns pointer
       * gestures for its own activation, and browsers differ on whether a drag
       * that starts on one suppresses the click. The trigger is no better — it
       * owns the right-button gesture. Hanging the drag on the positioning
       * wrapper the row already has costs nothing, drags the whole row, and
       * leaves both the click and the context menu exactly as they were.
       *
       * An orphaned session is not draggable, for the same reason its button is
       * disabled and its menu items are: there is nowhere it could be opened.
       */
      draggable={!orphaned}
      onDragStart={(event) => {
        if (orphaned) {
          event.preventDefault();
          return;
        }
        writeSessionDrag(event.dataTransfer, session);
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="h-full w-full">
      <CapabilityButton
        capability="resumeSession"
        variant="ghost"
        disabled={orphaned}
        disabledReason={
          orphaned
            ? 'The profile that created this session no longer exists, so its transcript cannot be reached.'
            : undefined
        }
        /*
         * The timestamp lives here now rather than on the row. It was the
         * first thing on the meta line and the least useful thing on it — the
         * list is already in recency order, so "4m ago" mostly restated the
         * row's position — and evicting it is what gave the profile the room
         * it was being truncated for.
         */
        tooltip={`${running ? 'Running now' : 'Resume'} — ${session.cwd}${profile ? ` — ${profile.label}` : ''} — ${formatRelative(session.updatedAt)}`}
        tooltipSide="right"
        onClick={() => resumeSession(session)}
        className={cn(
          'h-full w-full flex-col items-start justify-center gap-0.5 rounded-lg border-l-2 border-transparent px-2 py-1.5 text-left font-normal',
          active && 'border-lunar/70 bg-raised/60',
          // Put away, and it should look it — but still legible, because these
          // rows are only on screen when the user went looking for them.
          archived && 'opacity-60',
        )}
      >
        {/* `shrink-0` on both lines: see note 2 in the file header. Without it
            a row one pixel too short compresses the line box and `truncate`
            clips the glyphs through the middle. */}
        <span
          title={session.title}
          className={cn(
            'flex w-full shrink-0 items-center gap-1.5 truncate text-xs',
            active ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {/* Ahead of the title, not after it: the title is what truncates, and
              a marker on the far side of a clip is a marker nobody sees. */}
          {running ? <StatusDot tone="cyan" pulse /> : null}
          <span className="truncate">{condenseTitle(session.title)}</span>
        </span>
        <span className="flex w-full shrink-0 items-center gap-1 font-mono text-2xs text-ink-faint">
          {/*
           * The branch yields first. It is the field with a long tail — release
           * branches carry ticket numbers and slashes — and it is the one whose
           * head still identifies it after a clip, which is not true of a
           * profile called "Personal (billing)".
           */}
          {/*
            `min-w-0` without `flex-1`: it must be *able* to shrink, but must
            not grow. Growing would push the separator and the profile out to
            the right edge on every row wide enough to fit them, which is the
            pinned-right layout this replaced, arrived at by accident.
          */}
          {session.gitBranch ? (
            <span className="flex min-w-0 items-center gap-0.5">
              <GitBranchIcon className="size-2.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{session.gitBranch}</span>
            </span>
          ) : null}
          {session.gitBranch ? (
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
          ) : null}
          {/*
           * The profile marker, per row rather than per project: two profiles
           * can hold sessions in the same directory, and which account a resume
           * will bill is not something to leave to inference.
           *
           * It used to be pinned right with `ml-auto` and clipped at twelve
           * characters, which is how "Personal" and "Personal (billing)" became
           * the same word on screen — the exact pair the marker exists to tell
           * apart. It now sits directly after the branch and is given the room:
           * the branch takes the slack and truncates, this does not.
           */}
          <span
            title={
              profile ? `Profile: ${profile.label}` : `Profile ${session.profileId} no longer exists`
            }
            className={cn(
              'flex min-w-0 max-w-[11rem] shrink-0 items-center gap-1',
              orphaned && 'text-amber',
            )}
          >
            <ProfileSwatch color={profile?.color} />
            <span className="truncate">{profile ? profile.label : 'profile missing'}</span>
          </span>
        </span>
      </CapabilityButton>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-44">
          {/*
           * Rename and Delete are capability-gated; Archive is not, and that
           * asymmetry is the design. The first two write to the provider's own
           * store, so a provider that cannot do them must not offer them.
           * Archiving is Artemis's own bookkeeping and works against every
           * provider, including one whose CLI cannot even list its history.
           */}
          <ContextMenuItem
            disabled={!renaming.supported}
            title={renaming.supported ? undefined : renaming.reason}
            onSelect={() => setEditing(true)}
          >
            <PencilIcon aria-hidden="true" />
            Rename
          </ContextMenuItem>

          <ContextMenuItem onSelect={() => toggleSessionArchived(session)}>
            {archived ? (
              <>
                <ArchiveRestoreIcon aria-hidden="true" />
                Unarchive
              </>
            ) : (
              <>
                <ArchiveIcon aria-hidden="true" />
                Archive
              </>
            )}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem
            variant="destructive"
            disabled={!deleting.supported}
            title={deleting.supported ? undefined : deleting.reason}
            /*
             * Opening the dialog is deferred out of the `onSelect` tick.
             *
             * Radix restores focus to the trigger as the menu unmounts, and a
             * dialog mounted synchronously inside that same tick fights it for
             * focus — the dialog opens without it, so Escape and the default
             * button do nothing until the user clicks. Letting the menu finish
             * closing first is the documented way out.
             */
            onSelect={() => setTimeout(() => setConfirming(true), 0)}
          >
            <Trash2Icon aria-hidden="true" />
            Delete…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/*
       * Mounted only while it is open, so a virtualised list is not carrying a
       * dialog per row. `DeleteSessionDialog` asks the main process whether the
       * session is still running as it opens, which is a question worth asking
       * once per confirmation rather than once per render.
       */}
      {confirming ? (
        <DeleteSessionDialog session={session} onClose={() => setConfirming(false)} />
      ) : null}
    </div>
  );
});

/**
 * The rename field, in place of the row.
 *
 * Commits on Enter and on blur; abandons on Escape. Blur-commits rather than
 * blur-cancels because the field is opened from a menu and dismissed by
 * clicking away, and the reading of "click away" that loses typing is the one
 * people complain about — every other list in this app that renames in place
 * behaves the same way.
 */
function RenameField({
  session,
  onDone,
}: {
  readonly session: SessionSummary;
  readonly onDone: () => void;
}): ReactElement {
  const [value, setValue] = useState(session.title);
  /*
   * Guards the double-commit. Enter commits and then blurs, and the blur
   * handler would commit the same edit a second time — harmless for the store,
   * but it is a second IPC write and a second chance to fail.
   */
  const done = useRef(false);

  const finish = useCallback(
    (commit: boolean): void => {
      if (done.current) return;
      done.current = true;
      if (commit) void renameSession(session, value);
      onDone();
    },
    [session, value, onDone],
  );

  return (
    <Input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
        // Arrow keys and Home/End belong to the field while it is open. Without
        // this the sidebar's own key handling would move the selection out from
        // under a cursor the user is using to edit.
        event.stopPropagation();
      }}
      onFocus={(event) => event.target.select()}
      aria-label={`Rename session: ${session.title}`}
      spellCheck={false}
      className="h-full w-full rounded-lg px-2 text-xs md:text-xs"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Nothing to show.
 *
 * Two different sentences, because the two cases call for different next
 * actions: an empty project is waiting for a first session, whereas an empty
 * *filter* means the sessions are there and the query is wrong.
 */
function NothingHere({
  filtered,
  query,
}: {
  readonly filtered: boolean;
  readonly query: string;
}): ReactElement {
  return (
    <Empty className="gap-2 px-3 py-6">
      <EmptyHeader className="gap-1.5">
        <EmptyMedia variant="icon" className="mb-0 size-7 bg-raised/70">
          <InboxIcon className="size-3.5 text-ink-faint" aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-xs text-ink-muted">
          {filtered ? 'No match' : 'No sessions yet'}
        </EmptyTitle>
        <EmptyDescription className="text-2xs leading-snug text-ink-faint">
          {filtered
            ? `No session in any project matches “${query.trim()}”.`
            : 'Every session you start shows up here, grouped by the project it ran in.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * A line of prose where the session list would be.
 *
 * `signal` is for a failure the user can retry. `muted` and `faint` are both
 * neutral, and neither is a warning colour — a capability this provider does not
 * have is a fact about the product, not something going wrong, and amber made
 * "Codex cannot list past sessions" read as an error the user had caused. Same
 * move as the alert cards, where the icon carries the warning and the card does
 * not.
 */
function Note({
  tone,
  children,
}: {
  readonly tone: 'faint' | 'muted' | 'signal';
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p
      className={cn(
        'px-2.5 py-3 text-2xs leading-snug',
        tone === 'faint' && 'text-ink-faint',
        tone === 'muted' && 'text-ink-muted',
        tone === 'signal' && 'text-signal',
      )}
    >
      {children}
    </p>
  );
}

function LoadingRows(): ReactElement {
  return (
    <div className="flex flex-col gap-3 px-2.5 py-2" aria-busy="true" aria-label="Loading sessions">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex flex-col gap-1">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}
