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

import type { ProfileId, SessionSummary } from '@rx-apollo/protocol';

export interface SessionGroup {
  /** The project directory. The group's identity and its `key`. */
  readonly cwd: string;
  /** Newest first. */
  readonly sessions: readonly SessionSummary[];
  /** `updatedAt` of the newest session in the group — the group's sort key. */
  readonly updatedAt: number;
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

export interface GroupOptions {
  readonly query?: string;
  readonly profileLabel?: ProfileLabelLookup;
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

  const groups: SessionGroup[] = [];
  for (const [cwd, bucket] of byCwd) {
    bucket.sort(byRecency);
    groups.push({ cwd, sessions: bucket, updatedAt: bucket[0]?.updatedAt ?? 0 });
  }

  groups.sort((a, b) => b.updatedAt - a.updatedAt || a.cwd.localeCompare(b.cwd));
  return groups;
}

function byRecency(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || sessionKey(a).localeCompare(sessionKey(b));
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
  readonly count: number;
  /** Index into the group array — what the sticky header resolves against. */
  readonly group: number;
}

export interface SessionRow {
  readonly kind: 'session';
  readonly key: string;
  readonly session: SessionSummary;
  readonly group: number;
}

export type ListRow = HeaderRow | SessionRow;

/**
 * Groups → one flat array of rows.
 *
 * A virtualiser needs a single indexable sequence with a known height per
 * entry; nested arrays cannot be windowed without walking them. The `group`
 * index on every row is what lets the sticky header answer "which project am I
 * inside right now?" from a scroll offset alone.
 */
export function flattenGroups(groups: readonly SessionGroup[]): readonly ListRow[] {
  const rows: ListRow[] = [];
  groups.forEach((group, index) => {
    rows.push({ kind: 'header', key: `h:${group.cwd}`, cwd: group.cwd, count: group.sessions.length, group: index });
    for (const session of group.sessions) {
      // `sessionKey`, not `session.id`: ids are unique per profile, not per
      // machine (see the note at the top of this file), and two profiles
      // surfacing the same id would collide into one React key and silently
      // drop a row.
      rows.push({ kind: 'session', key: sessionKey(session), session, group: index });
    }
  });
  return rows;
}
