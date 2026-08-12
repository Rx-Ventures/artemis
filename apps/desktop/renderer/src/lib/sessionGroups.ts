/**
 * Session history, arranged for the sidebar.
 * ============================================================================
 *
 * The sidebar shows every past session grouped by the project directory it ran
 * in. That ordering is the whole feature, so it lives here as pure functions
 * over `SessionSummary[]` rather than inside a component: it is the part most
 * worth testing, and the part a virtualised list must be able to recompute
 * without touching the DOM.
 *
 * The rules, in the order the UI depends on them:
 *
 *  1. One group per `cwd`.
 *  2. Groups are ordered by their most recent session, newest first — so the
 *     project you were last in is at the top, which is where a person looks.
 *  3. Sessions inside a group are ordered newest first.
 *     "Newest" is {@link GroupOptions.orderKey}, which defaults to `updatedAt`
 *     and is overridden by the sidebar to hold a running session still. See
 *     `AppState.sessionOrderHold`: `updatedAt` is the transcript file's mtime,
 *     so ordering several working agents by it reshuffles the list every few
 *     seconds. Nothing here knows about runs — it takes a key and sorts by it.
 *  4. A session belongs to a **profile as well as a directory**, and two
 *     profiles can have sessions in the same directory. Grouping is therefore
 *     by directory only, and the profile is carried per row. Grouping by
 *     (cwd, profile) instead would split one project into two headers with the
 *     same path, which reads as a bug.
 *
 * Ties are broken by session id everywhere, so the order is total and a render
 * never reshuffles rows that compare equal.
 *
 * ## Row keys are `profileId + id`, not `id`
 *
 * `SessionsListAllResponse` says so explicitly: a session id is unique inside
 * the profile that owns it, not globally, because each profile has its own
 * provider config directory. Two profiles could in principle surface the same
 * id, and duplicate React keys inside one list silently drop a row.
 */

import type { ProfileId, SessionSummary } from '@rx-artemis/protocol';

export interface SessionGroup {
  /** The project directory. The group's identity and its `key`. */
  readonly cwd: string;
  /** Newest first. */
  readonly sessions: readonly SessionSummary[];
  /**
   * The most recent `updatedAt` in the group — what the project switcher shows.
   *
   * Deliberately the real mtime rather than the group's sort key: a held key
   * says where a row sits, and a person reading "4m ago" is asking when the
   * work happened.
   */
  readonly updatedAt: number;
  /** The group's sort key: the highest {@link GroupOptions.orderKey} in it. */
  readonly order: number;
}

/* -------------------------------------------------------------------------- */
/* Archiving                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split a listing into the sessions that belong in their projects and the ones
 * the user has put away.
 *
 * A separate step *before* grouping rather than a flag inside it, because an
 * archived session leaves its project entirely — it is not a hidden row in
 * `/code/api`, it is a row in Archived. Filtering inside `groupSessionsByProject`
 * would have to special-case the group whose every member was archived, and
 * would leave the caller no way to render the archived ones at all.
 *
 * Keys are `sessionKey` values, not ids: see the note at the top of this file.
 */
export function partitionArchived(
  sessions: readonly SessionSummary[],
  archived: ReadonlySet<string>,
): {
  readonly active: readonly SessionSummary[];
  readonly archived: readonly SessionSummary[];
} {
  // The overwhelmingly common case is an empty archive, and walking the list
  // twice to discover that is waste on the sidebar's hot path.
  if (archived.size === 0) return { active: sessions, archived: [] };

  const active: SessionSummary[] = [];
  const put: SessionSummary[] = [];
  for (const session of sessions) {
    if (archived.has(sessionKey(session))) put.push(session);
    else active.push(session);
  }
  return { active, archived: put };
}

/**
 * The archived sessions, ready to render as one section.
 *
 * Ordered newest-first by the same comparator projects use, and *not* grouped
 * by directory: the point of the section is that these are out of the way, and
 * re-imposing the project structure inside it would rebuild the thing the user
 * archived them to escape.
 */
export interface ArchiveSection {
  /** Newest first, spanning every project. */
  readonly sessions: readonly SessionSummary[];
  /** Whether the section is folded shut. Defaults to shut — see `flattenGroups`. */
  readonly collapsed: boolean;
}

/** Sort archived sessions for display. Same rule as inside a project group. */
export function orderArchived(
  sessions: readonly SessionSummary[],
  options: GroupOptions = {},
): readonly SessionSummary[] {
  const query = options.query ?? '';
  const lookup = options.profileLabel;
  const kept = query
    ? sessions.filter((s) => matchesQuery(s, query, lookup?.(s.profileId)))
    : [...sessions];
  return kept.sort(byRecency(options.orderKey ?? byUpdatedAt));
}

/** Resolves a profile id to its display label, for search and for the row badge. */
export type ProfileLabelLookup = (id: ProfileId) => string | undefined;

/**
 * Everything a user might plausibly type when hunting for a session.
 *
 * The directory and the profile label are in here deliberately: with every
 * project in one list, "the auth work in the api repo" and "everything on my
 * work account" are both reasonable queries, and neither is answerable from the
 * title alone.
 */
function haystack(session: SessionSummary, profileLabel: string | undefined): string {
  return [
    session.title,
    session.firstPrompt ?? '',
    session.gitBranch ?? '',
    session.cwd,
    session.model ?? '',
    session.tag ?? '',
    profileLabel ?? '',
    session.id,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Does this session match the query?
 *
 * Whitespace-separated terms, all of which must match somewhere (AND, not OR).
 * `api auth` should mean "the auth session in the api project", which an OR
 * would answer with every session in either.
 */
export function matchesQuery(
  session: SessionSummary,
  query: string,
  profileLabel?: string | undefined,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(session, profileLabel);
  return terms.every((term) => text.includes(term));
}

/** Where a session sorts. Higher is newer. See rule 3 in the file header. */
export type SessionOrderKey = (session: SessionSummary) => number;

/** The plain answer, and the one every caller that has no runs to hold wants. */
const byUpdatedAt: SessionOrderKey = (session) => session.updatedAt;

export interface GroupOptions {
  readonly query?: string;
  readonly profileLabel?: ProfileLabelLookup;
  readonly orderKey?: SessionOrderKey;
}

/** Apply rules 1–4 above. */
export function groupSessionsByProject(
  sessions: readonly SessionSummary[],
  options: GroupOptions = {},
): readonly SessionGroup[] {
  const query = options.query ?? '';
  const lookup = options.profileLabel;

  const byCwd = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (query && !matchesQuery(session, query, lookup?.(session.profileId))) continue;
    const bucket = byCwd.get(session.cwd);
    if (bucket) bucket.push(session);
    else byCwd.set(session.cwd, [session]);
  }

  const orderKey = options.orderKey ?? byUpdatedAt;
  const groups: SessionGroup[] = [];
  for (const [cwd, bucket] of byCwd) {
    bucket.sort(byRecency(orderKey));
    groups.push({
      cwd,
      sessions: bucket,
      // Not `bucket[0]`: the first row is the one that sorts highest, which
      // under a held key is not necessarily the one written most recently.
      updatedAt: bucket.reduce((newest, s) => Math.max(newest, s.updatedAt), 0),
      order: bucket.reduce((highest, s) => Math.max(highest, orderKey(s)), 0),
    });
  }

  groups.sort((a, b) => b.order - a.order || a.cwd.localeCompare(b.cwd));
  return groups;
}

/** Newest first, by whichever key the caller sorts on, ties broken by identity. */
function byRecency(orderKey: SessionOrderKey) {
  return (a: SessionSummary, b: SessionSummary): number =>
    orderKey(b) - orderKey(a) || sessionKey(a).localeCompare(sessionKey(b));
}

/**
 * The globally unique identity of a session row.
 *
 * A session id is unique per profile, not per machine — see the note at the top
 * of this file. Everything that keys, compares or highlights a row goes through
 * this so there is one definition of "the same session".
 */
export function sessionKey(session: SessionSummary): string {
  return `${session.profileId}:${session.id}`;
}

/* -------------------------------------------------------------------------- */
/* Flattening, for the virtualised list                                       */
/* -------------------------------------------------------------------------- */

export interface HeaderRow {
  readonly kind: 'header';
  readonly key: string;
  readonly cwd: string;
  /** Sessions in the group — the full count, even when it is folded shut. */
  readonly count: number;
  /** Index into the group array — what the sticky header resolves against. */
  readonly group: number;
  /** True when this group's sessions are folded away behind the header. */
  readonly collapsed: boolean;
}

/**
 * The Archived section's heading.
 *
 * Its own row kind rather than a {@link HeaderRow} with a flag, because almost
 * nothing a project heading renders applies to it: there is no directory to
 * name, no repository to look up, and no "you are here" marker — it spans every
 * project by construction. Giving it a distinct kind means the renderer cannot
 * accidentally ask it for a `cwd` it does not have.
 */
export interface ArchiveHeaderRow {
  readonly kind: 'archive-header';
  readonly key: string;
  /** Sessions in the archive — the full count, even when it is folded shut. */
  readonly count: number;
  readonly collapsed: boolean;
}

export interface SessionRow {
  readonly kind: 'session';
  readonly key: string;
  readonly session: SessionSummary;
  readonly group: number;
  /**
   * True for rows inside the Archived section.
   *
   * Carried on the row so the renderer does not have to consult the archive set
   * again to know which menu item to offer — and so an archived row can be
   * styled as put-away without a second lookup per frame.
   */
  readonly archived?: boolean;
}

export type ListRow = HeaderRow | ArchiveHeaderRow | SessionRow;

/**
 * Groups → one flat array of rows.
 *
 * A virtualiser needs a single indexable sequence with a known height per
 * entry; nested arrays cannot be windowed without walking them. The `group`
 * index on every row is what lets a header answer "which project am I inside
 * right now?" from a scroll offset alone.
 *
 * A collapsed group contributes its header and none of its sessions. Dropping
 * the rows here rather than hiding them in CSS is what keeps the virtualiser
 * honest: its geometry is computed from this array, so a row that is present
 * but invisible would still take up its height and leave a hole in the list.
 * The header keeps the *full* count either way — the number is a fact about the
 * project, not about how much of it is currently on screen.
 */
export function flattenGroups(
  groups: readonly SessionGroup[],
  collapsed: ReadonlySet<string> = new Set(),
  archive?: ArchiveSection,
): readonly ListRow[] {
  const rows: ListRow[] = [];
  groups.forEach((group, index) => {
    const folded = collapsed.has(group.cwd);
    rows.push({
      kind: 'header',
      key: `h:${group.cwd}`,
      cwd: group.cwd,
      count: group.sessions.length,
      group: index,
      collapsed: folded,
    });
    if (folded) return;
    for (const session of group.sessions) {
      // `sessionKey`, not `session.id`: ids are unique per profile, not per
      // machine (see the note at the top of this file), and two profiles
      // surfacing the same id would collide into one React key and silently
      // drop a row.
      rows.push({ kind: 'session', key: sessionKey(session), session, group: index });
    }
  });

  /*
   * Archived last, always, and absent when empty.
   *
   * Pinned to the bottom rather than sorted in by recency because it is not a
   * project competing for position — it is the drawer everything else can be
   * put into, and a drawer that wandered up the list as its newest member aged
   * would be furniture that moves. An empty archive contributes no header at
   * all: a permanently visible "Archived · 0" is a control for a state the user
   * is not in.
   *
   * The group index continues past the projects so the sticky-header lookup
   * still resolves every row to something, and archived rows are tagged so the
   * renderer can offer "Unarchive" rather than "Archive".
   */
  if (archive !== undefined && archive.sessions.length > 0) {
    rows.push({
      kind: 'archive-header',
      key: 'h:archive',
      count: archive.sessions.length,
      collapsed: archive.collapsed,
    });
    if (!archive.collapsed) {
      for (const session of archive.sessions) {
        rows.push({
          kind: 'session',
          key: sessionKey(session),
          session,
          group: groups.length,
          archived: true,
        });
      }
    }
  }

  return rows;
}
