/**
 * The sidebar's session history.
 * ============================================================================
 *
 *     ~/code/libra                   3  ← sticky group header, one per project
 *       fix auth failure     2m   ·Work
 *       refactor adapters    1h   ·Work
 *     ~/code/api                     1
 *       triage flaky test    3d   ·Home
 *
 * Grouping, ordering and filtering are pure functions in `lib/sessionGroups.ts`;
 * this file renders them. Four things here are load-bearing.
 *
 * ## 1. It is virtualised, and that is why the headers are drawn twice
 *
 * A history spanning twenty repositories is thousands of rows, and mounting all
 * of them costs a visible hitch every time the list refreshes — which happens at
 * the end of every run. So the flat row list is windowed: rows are absolutely
 * positioned inside a spacer of the full height, and only the slice inside the
 * viewport (plus overscan) is mounted.
 *
 * Absolute positioning rules out `position: sticky`, which needs normal flow.
 * The sticky header is therefore a *second*, opaque copy of the current group's
 * header pinned to the top of the viewport and translated upward as the next
 * group's real header arrives, so the two swap places the way a native sectioned
 * list does. That is why `ListRow` carries a `group` index: the pinned header is
 * resolved from the scroll offset alone.
 *
 * ## 2. Row heights are constants, not measurements
 *
 * Every row is a fixed two-line shape and every header a fixed one-line shape,
 * so offsets are arithmetic rather than a measure-then-place pass. If a row ever
 * grows a third line, change the constant — do not start measuring, or the list
 * acquires a layout cycle per scroll frame.
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
import { FolderIcon, GitBranchIcon, SearchIcon, SquareTerminalIcon } from 'lucide-react';
import type { ProfileId, SessionSummary } from '@libra/protocol';

import { useCapability } from '../hooks/useCapability';
import { formatRelative, oneLine } from '../lib/format';
import { inferHomeDirectory, shortenPath, type Platform } from '../lib/paths';
import {
  flattenGroups,
  groupSessionsByProject,
  type ListRow,
  type SessionGroup,
} from '../lib/sessionGroups';
import { refreshSessions, resumeSession, useApp } from '../state/store';
import { CapabilityButton } from './capability-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const HEADER_HEIGHT = 24;
const ROW_HEIGHT = 44;
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
  const scope = useApp((s) => s.sessionsScope);
  const profiles = useApp((s) => s.profiles);
  const platform = useApp((s) => s.platform);
  const cwd = useApp((s) => s.cwd);
  const listing = useCapability('listSessions');
  const resuming = useCapability('resumeSession');

  const [query, setQuery] = useState('');

  const profileLabel = useCallback(
    (id: ProfileId): string | undefined => profiles.find((p) => p.id === id)?.label,
    [profiles],
  );

  const groups = useMemo(
    () => groupSessionsByProject(sessions, { query, profileLabel }),
    [sessions, query, profileLabel],
  );
  const rows = useMemo(() => flattenGroups(groups), [groups]);

  // The home directory is guessed from the paths themselves — the renderer has
  // no `$HOME`. Every shortened path also carries the full one on hover, so a
  // wrong guess costs a hover and never hides anything. See `lib/paths.ts`.
  const home = useMemo(
    () => inferHomeDirectory([...sessions.map((s) => s.cwd), cwd], platform),
    [sessions, cwd, platform],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sessions.length > FILTER_THRESHOLD ? (
        <div className="relative px-2 pb-1.5">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3.5 size-3 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${sessions.length} sessions…`}
            aria-label="Filter sessions"
            spellCheck={false}
            className="h-6 rounded-md pl-7 text-2xs md:text-2xs"
          />
        </div>
      ) : null}

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
            className="mt-1 block text-2xs text-brass underline-offset-2 hover:underline"
          >
            Try again
          </button>
        </Note>
      ) : loading && sessions.length === 0 ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <Note tone="faint">
          {sessions.length === 0
            ? 'No past sessions yet. Anything you start shows up here, grouped by project.'
            : `Nothing matches “${query.trim()}”.`}
        </Note>
      ) : (
        <VirtualRows rows={rows} groups={groups} home={home} platform={platform} />
      )}

      {scope === 'cwd' && listing.supported ? (
        <p className="border-t border-line px-2.5 py-1.5 text-2xs leading-snug text-ink-faint">
          Showing the current directory only — this build has no cross-project session listing, so
          other projects’ history is not enumerated here.
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Virtualiser                                                                */
/* -------------------------------------------------------------------------- */

function VirtualRows({
  rows,
  groups,
  home,
  platform,
}: {
  readonly rows: readonly ListRow[];
  readonly groups: readonly SessionGroup[];
  readonly home: string | undefined;
  readonly platform: Platform;
}): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  /** Prefix sums: `offsets[i]` is the top of row `i`; the last entry is the total. */
  const offsets = useMemo(() => {
    const out = new Array<number>(rows.length + 1);
    let y = 0;
    for (let i = 0; i < rows.length; i += 1) {
      out[i] = y;
      y += rows[i]?.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT;
    }
    out[rows.length] = y;
    return out;
  }, [rows]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A filter keystroke can leave the scroller parked past the end of a much
  // shorter list, which would show an empty window until the user scrolled.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || element.scrollTop === 0) return;
    if (element.scrollTop > element.scrollHeight - element.clientHeight) {
      element.scrollTop = 0;
      setScrollTop(0);
    }
  }, [rows]);

  const height = viewport > 0 ? viewport : ASSUMED_VIEWPORT;
  const total = offsets[rows.length] ?? 0;

  const first = Math.max(0, indexAt(offsets, scrollTop) - OVERSCAN);
  const last = Math.min(rows.length - 1, indexAt(offsets, scrollTop + height) + OVERSCAN);

  // Which project the top edge is inside, and how far the next group's real
  // header has already pushed the pinned copy off the top.
  const anchor = indexAt(offsets, scrollTop);
  const pinnedGroup = groups[rows[anchor]?.group ?? 0];
  const nextHeader = nextHeaderIndex(rows, anchor);
  const push =
    nextHeader === -1 ? 0 : Math.min(0, (offsets[nextHeader] ?? 0) - scrollTop - HEADER_HEIGHT);

  const visible: ReactElement[] = [];
  for (let i = first; i <= last; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const top = offsets[i] ?? 0;
    visible.push(
      row.kind === 'header' ? (
        <GroupHeader
          key={row.key}
          top={top}
          cwd={row.cwd}
          count={row.count}
          home={home}
          platform={platform}
        />
      ) : (
        <Row key={row.key} top={top} session={row.session} />
      ),
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="relative" style={{ height: total }}>
          {visible}
        </div>
      </div>

      {/*
       * The pinned copy. Opaque and positioned over the real header it stands in
       * for, so the two are indistinguishable when a group's own header happens
       * to be at the top of the viewport. Hidden from assistive technology —
       * the real header is already in the list.
       */}
      {pinnedGroup ? (
        <GroupHeader
          pinnedCopy
          top={push}
          cwd={pinnedGroup.cwd}
          count={pinnedGroup.sessions.length}
          home={home}
          platform={platform}
        />
      ) : null}
    </div>
  );
}

/** Index of the last row starting at or before `y`. Binary search over prefix sums. */
function indexAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  if (high < 0) return 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

function nextHeaderIndex(rows: readonly ListRow[], from: number): number {
  for (let i = from + 1; i < rows.length; i += 1) {
    if (rows[i]?.kind === 'header') return i;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

const GroupHeader = memo(function GroupHeader({
  cwd,
  count,
  home,
  platform,
  top,
  pinnedCopy = false,
}: {
  readonly cwd: string;
  readonly count: number;
  readonly home: string | undefined;
  readonly platform: Platform;
  readonly top: number;
  readonly pinnedCopy?: boolean;
}): ReactElement {
  return (
    <div
      style={{ top, height: HEADER_HEIGHT }}
      aria-hidden={pinnedCopy || undefined}
      className={cn(
        'absolute inset-x-0 flex items-center gap-1.5 bg-panel px-2.5 text-2xs',
        pinnedCopy && 'z-10 border-b border-line/60',
      )}
    >
      <FolderIcon className="size-2.5 shrink-0 text-ink-faint" aria-hidden="true" />
      {/* Full path on hover. The label elides its middle, and its tail is the
          project name, so it is the head a reader may need back. */}
      <span title={cwd} className="min-w-0 flex-1 truncate font-mono tracking-wide text-ink-muted">
        {shortenPath(cwd, { home, platform, max: 30 })}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-ink-faint">{count}</span>
    </div>
  );
});

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
    <div
      style={{ top, height: ROW_HEIGHT }}
      className="absolute inset-x-0 flex items-center px-1.5"
    >
      <CapabilityButton
        capability="resumeSession"
        variant="ghost"
        disabled={orphaned}
        disabledReason={
          orphaned
            ? 'The profile that created this session no longer exists, so its transcript cannot be reached.'
            : undefined
        }
        tooltip={`Resume in ${session.cwd}${profile ? ` — ${profile.label}` : ''}`}
        tooltipSide="right"
        onClick={() => resumeSession(session)}
        className={cn(
          'h-10 w-full flex-col items-start justify-center gap-0.5 rounded-md border-l-2 border-transparent px-2 py-1 text-left font-normal',
          active && 'border-brass/70 bg-raised/60',
        )}
      >
        <span className={cn('w-full truncate text-xs', active ? 'text-ink' : 'text-ink-muted')}>
          {session.title}
        </span>
        <span className="flex w-full items-center gap-1.5 font-mono text-2xs text-ink-faint">
          <SquareTerminalIcon className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{formatRelative(session.updatedAt)}</span>
          {session.gitBranch ? (
            <span className="flex min-w-0 items-center gap-0.5">
              <GitBranchIcon className="size-2.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{session.gitBranch}</span>
            </span>
          ) : null}
          {/*
           * The profile marker, per row rather than per group: two profiles can
           * hold sessions in the same project, and which account a resume will
           * bill is not something to leave to inference.
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
