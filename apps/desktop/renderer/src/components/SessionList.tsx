/**
 * Every session, grouped by the project it ran in.
 * ============================================================================
 *
 *     ▾ Sessions · 47           [ filter… ]
 *       artemis ·22 ──────────────────────
 *         Wire the adapter seam
 *         ⌥ main · ▪ Work
 *       api ·9 ───────────────────────────
 *         Profile store encryption
 *         ▪ Home
 *
 * All projects, with the working directory pinned to the top.
 *
 * This has been both ways round. The list was once scoped to the working
 * directory, with everything else behind an "All projects" switcher, because an
 * undifferentiated stream of every repository buried the answer to "what was I
 * doing in *this* repo". That fixed the wrong half: scoping made the other
 * question — "where was that session I had open yesterday?" — unanswerable
 * without first guessing the folder it was in and switching to it, which meant
 * changing directory, which ends the current session. History you have to
 * destroy your place to look at is not history you can browse.
 *
 * Pinning is what lets both hold at once. The current project sits at the top
 * under its own heading, and every other project follows in recency order, so
 * the scoped view is still the first thing on screen and the rest is a scroll
 * rather than a mode change.
 *
 * Clicking any row does the whole switch — provider, profile, directory and
 * transcript — because `resumeSession` already had to: a session id only
 * resolves against the directory it ran in. Crossing a project boundary from
 * here was always going to work; it was only ever the list that hid the rows.
 *
 * ## 0. The card header names the list; the group headings name the projects
 *
 * It read `SESSIONS` once, which captions a list whose contents are obviously
 * sessions — the *shape* of what is below, not the subject. It then named the
 * current repository, which was right while the list held one project and
 * became a lie the moment it held all of them. The projects are named inside
 * the list now, each heading directly above its own rows.
 *
 * Repository name where it is known, directory name otherwise. Working in
 * `~/code/artemis/apps/desktop` you are working on *artemis*; a heading reading
 * "desktop" is technically true and useless. The renderer has no `fs`, so the
 * main process is asked once per directory change — which means only the
 * *current* project can be named that way, and the others fall back to their
 * folder name rather than paying a round trip per heading.
 *
 * The fold is persisted. A section the user closed and found reopened on the
 * next launch is the same discourtesy as a sidebar width that resets.
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
  ChevronDownIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  SearchIcon,
} from 'lucide-react';
import type { ProfileId, SessionSummary } from '@rx-artemis/protocol';

import { useCapability } from '../hooks/useCapability';
import type { WorkspaceNames } from '../lib/extensions';
import { condenseTitle, formatRelative } from '../lib/format';
import { lastSegment } from '../lib/paths';
import { flattenGroups, groupSessionsByProject, type ListRow } from '../lib/sessionGroups';
import { refreshSessions, resumeSession, toggleSessionsCollapsed, useApp } from '../state/store';
import { CapabilityButton } from './capability-button';
import { ProfileSwatch } from './primitives';
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
  const cwd = useApp((s) => s.cwd);
  const collapsed = useApp((s) => s.sessionsCollapsed);
  const listing = useCapability('listSessions');
  const resuming = useCapability('resumeSession');

  const [query, setQuery] = useState('');

  const profileLabel = useCallback(
    (id: ProfileId): string | undefined => profiles.find((p) => p.id === id)?.label,
    [profiles],
  );

  /*
   * Every project, grouped, with the working directory pinned to the top.
   *
   * `groupSessionsByProject` owns the query matching, the recency order, the
   * pin and the id tie-break, and it is the part of this feature that has
   * tests — filtering here instead would quietly fork all four.
   */
  const rows = useMemo(
    () => flattenGroups(groupSessionsByProject(sessions, { query, profileLabel, pinned: cwd })),
    [sessions, query, profileLabel, cwd],
  );

  /** Unfiltered, so the count does not jump around while typing. */
  const total = sessions.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex items-center gap-1.5 px-1.5 pt-2 pb-1.5">
        <SessionsHeader count={total} />
        {/*
         * The filter goes with the rows, so it goes away with them. Leaving a
         * field over a folded list would offer to search nothing.
         */}
        {!collapsed && total > FILTER_THRESHOLD ? (
          <div className="relative ml-auto min-w-0 flex-1">
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
        ) : null}
      </div>

      {collapsed ? null : (
        <>
          {/*
           * Listing and resuming are independent capabilities and are gated
           * independently: without `listSessions` there is nothing to show, and
           * without `resumeSession` the rows are still worth showing but cannot
           * be clicked. Neither ever silently disappears.
           */}
          {listing.supported && !resuming.supported ? (
            <p className="border-y border-line bg-raised px-2.5 py-1.5 text-2xs leading-snug text-ink-muted">
              {resuming.reason} These are listed for reference; picking one would not carry the
              conversation forward.
            </p>
          ) : null}

          {!listing.supported ? (
            <Note tone="muted">{listing.reason} There is no history to list for it.</Note>
          ) : error ? (
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
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The card's title and its fold control, in one button.
 *
 * The whole row is the control rather than a chevron beside a label, because a
 * 12px target next to a word that looks clickable and is not is the kind of
 * thing people click three times before reading. The chevron stays as the
 * *affordance*; `aria-expanded` is what says the same thing to a screen reader.
 *
 * ## It names the list, not a project
 *
 * It used to name the working directory's repository, which was right while the
 * list held one project and became a lie the moment it held all of them — a
 * heading reading `artemis` over rows from four other repositories. The projects
 * are named by the group headings inside the list now, each directly above its
 * own rows, which is where that fact belongs.
 *
 * The count is unfiltered on purpose: it says how much history exists, which is
 * a stable fact, and a number that counted down while someone typed in the
 * filter would be answering a question nobody asked of a header.
 */
function SessionsHeader({ count }: { readonly count: number }): ReactElement {
  const collapsed = useApp((s) => s.sessionsCollapsed);

  return (
    <button
      type="button"
      onClick={toggleSessionsCollapsed}
      aria-expanded={!collapsed}
      title="Every session, newest project first"
      className="flex min-w-0 shrink items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-raised/70"
    >
      <ChevronDownIcon
        aria-hidden="true"
        className={cn(
          'size-3 shrink-0 text-ink-faint transition-transform',
          collapsed && '-rotate-90',
        )}
      />
      <HistoryIcon aria-hidden="true" className="size-3 shrink-0 text-lunar" />
      <span className="min-w-0 truncate text-xs font-medium tracking-tight text-ink">Sessions</span>
      {count > 0 ? (
        <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">·{count}</span>
      ) : null}
    </button>
  );
}

/**
 * One project's heading, inside the list.
 *
 * Rendered as an ordinary row rather than a `position: sticky` element: the
 * rows are absolutely positioned inside a spacer, where sticky does not apply,
 * and faking it needs a second pinned copy of the heading plus the bookkeeping
 * to know which one it is. That was in this file once and is not worth its
 * weight — a heading you have scrolled past is a heading whose project you are
 * already reading.
 *
 * The current project is marked rather than merely being first, because "first"
 * stops being legible the moment the list is scrolled.
 */
const GroupHeading = memo(function GroupHeading({
  cwd,
  count,
  top,
}: {
  readonly cwd: string;
  readonly count: number;
  readonly top: number;
}): ReactElement {
  const current = useApp((s) => s.cwd === cwd);
  const workspace = useApp((s) => (s.cwd === cwd ? s.workspace : null));

  // `workspace` only describes the *current* directory, so every other group
  // falls back to the folder name. A repository name for a project you are not
  // in would need a `describe` call per project, which is a round trip per row
  // for a word.
  const { name, isRepo } = projectLabel(cwd, workspace);
  const Icon = isRepo ? FolderGit2Icon : FolderIcon;

  return (
    <div
      style={{ top, height: HEADER_HEIGHT }}
      className="absolute inset-x-0 flex items-center gap-1 px-3"
      title={cwd}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-2.5 shrink-0', current ? 'text-lunar' : 'text-ink-faint')}
      />
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
    </div>
  );
});

/**
 * What to call this project, and whether it is a repository.
 *
 * Repository name first, then the directory's, then the last segment of `cwd`
 * — the last of which is the answer for a build with no `workspace.describe`
 * and for the moment before the first reply lands. `null` means there is no
 * working directory at all, which is a different thing from an unnamed one and
 * is rendered as its own faint placeholder state.
 */
function projectLabel(
  cwd: string,
  workspace: WorkspaceNames | null,
): { readonly name: string | null; readonly isRepo: boolean } {
  if (cwd.trim().length === 0) return { name: null, isRepo: false };
  const repo = workspace?.repoName;
  if (repo !== undefined && repo.length > 0) return { name: repo, isRepo: true };
  return { name: workspace?.name ?? lastSegment(cwd), isRepo: false };
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
      y += rows[i]?.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT;
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
      visible.push(<GroupHeading key={row.key} cwd={row.cwd} count={row.count} top={top} />);
      continue;
    }
    // `row.key` is `sessionKey` — an id is unique inside the profile that owns
    // it, not globally, and two profiles surfacing the same id would collide
    // into one React key and silently drop a row.
    visible.push(<Row key={row.key} top={top} session={row.session} />);
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
}: {
  readonly session: SessionSummary;
  readonly top: number;
}): ReactElement {
  const active = useApp((s) => s.resumeSessionId === session.id);
  const profile = useApp((s) => s.profiles.find((p) => p.id === session.profileId));

  // A session whose profile is gone cannot be resumed at all — its transcript
  // lives in that profile's config directory. Say so on the row rather than
  // letting the click fail somewhere the user is not looking.
  const orphaned = profile === undefined;

  return (
    <div style={{ top, height: ROW_HEIGHT }} className="absolute inset-x-0 px-2 py-0.5">
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
        tooltip={`Resume — ${session.cwd}${profile ? ` — ${profile.label}` : ''} — ${formatRelative(session.updatedAt)}`}
        tooltipSide="right"
        onClick={() => resumeSession(session)}
        className={cn(
          'h-full w-full flex-col items-start justify-center gap-0.5 rounded-lg border-l-2 border-transparent px-2 py-1.5 text-left font-normal',
          active && 'border-lunar/70 bg-raised/60',
        )}
      >
        {/* `shrink-0` on both lines: see note 2 in the file header. Without it
            a row one pixel too short compresses the line box and `truncate`
            clips the glyphs through the middle. */}
        <span
          title={session.title}
          className={cn(
            'w-full shrink-0 truncate text-xs',
            active ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {condenseTitle(session.title)}
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
  );
});

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
