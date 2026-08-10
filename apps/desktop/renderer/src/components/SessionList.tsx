/**
 * This project's session history.
 * ============================================================================
 *
 *     SESSIONS · 22            [ filter… ]
 *       Wire the adapter seam
 *       4m ago  ⌥ main            ·Work
 *       Profile store encryption
 *       52m ago                   ·Home
 *
 * One project, flat. The sidebar is scoped to the working directory now, and
 * other projects are reached through the switcher at the foot of the card
 * rather than by scrolling past them here. That is the change that matters:
 * this list used to interleave every repository under sticky per-project
 * headers, which meant the answer to "what was I doing in *this* repo" was
 * somewhere in the middle of a thousand rows.
 *
 * ## 1. It is still virtualised, and now trivially so
 *
 * Even one project's history can run to hundreds of rows, and mounting all of
 * them costs a visible hitch every time the list refreshes — which happens at
 * the end of every run. So rows are absolutely positioned inside a spacer of
 * the full height and only the slice inside the viewport (plus overscan) is
 * mounted.
 *
 * With the group headers gone every row is the same height, so an offset is
 * `index * ROW_HEIGHT` and the visible window is two divisions. The previous
 * version needed prefix sums, a binary search, and a second copy of each header
 * pinned to the top of the viewport to fake `position: sticky` inside an
 * absolutely-positioned list. None of that has to exist any more.
 *
 * ## 2. `ROW_HEIGHT` is a constant, and it is not arbitrary
 *
 * A row is two lines: a 12px title on an 18px leading and an 11px meta line on
 * a 16px leading, 2px apart — 36px of text. Add the button's 12px of vertical
 * padding and the 4px gap between rows and you get 52; 54 leaves two pixels of
 * slack. Getting this wrong is not cosmetic: a row that is *slightly* too short
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
import { GitBranchIcon, InboxIcon, SearchIcon, SquareTerminalIcon } from 'lucide-react';
import type { ProfileId, SessionSummary } from '@apollo/protocol';

import { useCapability } from '../hooks/useCapability';
import { formatRelative, oneLine } from '../lib/format';
import { groupSessionsByProject, sessionKey } from '../lib/sessionGroups';
import { refreshSessions, resumeSession, useApp } from '../state/store';
import { CapabilityButton } from './capability-button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** See note 2 in the file header before changing this. */
const ROW_HEIGHT = 54;
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
  const listing = useCapability('listSessions');
  const resuming = useCapability('resumeSession');

  const [query, setQuery] = useState('');

  const profileLabel = useCallback(
    (id: ProfileId): string | undefined => profiles.find((p) => p.id === id)?.label,
    [profiles],
  );

  /*
   * Grouping is reused rather than re-implemented, even though only one group
   * is wanted. `groupSessionsByProject` owns the query matching, the recency
   * order and the id tie-break, and it is the part of this feature that has
   * tests. Filtering by `cwd` here instead would have quietly forked all three.
   */
  const rows = useMemo(() => {
    const groups = groupSessionsByProject(sessions, { query, profileLabel });
    return groups.find((group) => group.cwd === cwd)?.sessions ?? [];
  }, [sessions, query, profileLabel, cwd]);

  /** Unfiltered, so the section count does not jump around while typing. */
  const total = useMemo(
    () => sessions.reduce((count, session) => (session.cwd === cwd ? count + 1 : count), 0),
    [sessions, cwd],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1.5">
        <span className="shrink-0 text-2xs tracking-wider text-ink-faint uppercase">Sessions</span>
        {total > 0 ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint">·{total}</span>
        ) : null}
        {total > FILTER_THRESHOLD ? (
          <div className="relative ml-auto min-w-0 flex-1">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter…"
              aria-label="Filter this project’s sessions"
              spellCheck={false}
              className="h-6 rounded-md pl-6.5 text-2xs md:text-2xs"
            />
          </div>
        ) : null}
      </div>

      {/*
       * Listing and resuming are independent capabilities and are gated
       * independently: without `listSessions` there is nothing to show, and
       * without `resumeSession` the rows are still worth showing but cannot be
       * clicked. Neither ever silently disappears.
       */}
      {listing.supported && !resuming.supported ? (
        <p className="border-y border-line bg-amber/5 px-2.5 py-1.5 text-2xs leading-snug text-amber">
          {resuming.reason} These are listed for reference; picking one would not carry the
          conversation forward.
        </p>
      ) : null}

      {!listing.supported ? (
        <Note tone="amber">{listing.reason} There is no history to list for it.</Note>
      ) : error ? (
        <Note tone="signal">
          {/* The backend's own sentence — a paraphrase would lose the cause. */}
          {error}
          <button
            type="button"
            onClick={() => void refreshSessions()}
            className="mt-1 block text-2xs text-ember underline-offset-2 hover:underline"
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
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Virtualiser                                                                */
/* -------------------------------------------------------------------------- */

function VirtualRows({ rows }: { readonly rows: readonly SessionSummary[] }): ReactElement {
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

  const height = viewport > 0 ? viewport : ASSUMED_VIEWPORT;
  const total = rows.length * ROW_HEIGHT;

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length - 1, Math.floor((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  const visible: ReactElement[] = [];
  for (let i = first; i <= last; i += 1) {
    const session = rows[i];
    if (!session) continue;
    // `sessionKey`, not `session.id`: an id is unique inside the profile that
    // owns it, not globally, and two profiles surfacing the same id would
    // collide into one React key and silently drop a row.
    visible.push(<Row key={sessionKey(session)} top={i * ROW_HEIGHT} session={session} />);
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
        tooltip={`Resume — ${session.cwd}${profile ? ` — ${profile.label}` : ''}`}
        tooltipSide="right"
        onClick={() => resumeSession(session)}
        className={cn(
          'h-full w-full flex-col items-start justify-center gap-0.5 rounded-lg border-l-2 border-transparent px-2 py-1.5 text-left font-normal',
          active && 'border-ember/70 bg-raised/60',
        )}
      >
        {/* `shrink-0` on both lines: see note 2 in the file header. Without it
            a row one pixel too short compresses the line box and `truncate`
            clips the glyphs through the middle. */}
        <span
          className={cn(
            'w-full shrink-0 truncate text-xs',
            active ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {session.title}
        </span>
        <span className="flex w-full shrink-0 items-center gap-1.5 font-mono text-2xs text-ink-faint">
          <SquareTerminalIcon className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{formatRelative(session.updatedAt)}</span>
          {session.gitBranch ? (
            <span className="flex min-w-0 items-center gap-0.5">
              <GitBranchIcon className="size-2.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{session.gitBranch}</span>
            </span>
          ) : null}
          {/*
           * The profile marker, per row rather than per project: two profiles
           * can hold sessions in the same directory, and which account a resume
           * will bill is not something to leave to inference.
           */}
          <span
            title={
              profile ? `Profile: ${profile.label}` : `Profile ${session.profileId} no longer exists`
            }
            className={cn('ml-auto max-w-[7rem] shrink-0 truncate', orphaned && 'text-amber')}
          >
            ·{profile ? oneLine(profile.label, 12) : 'missing'}
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
            ? `Nothing in this project matches “${query.trim()}”.`
            : 'Anything you start in this project shows up here. Other projects are under “All projects” below.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Note({
  tone,
  children,
}: {
  readonly tone: 'faint' | 'amber' | 'signal';
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p
      className={cn(
        'px-2.5 py-3 text-2xs leading-snug',
        tone === 'faint' && 'text-ink-faint',
        tone === 'amber' && 'text-amber',
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
