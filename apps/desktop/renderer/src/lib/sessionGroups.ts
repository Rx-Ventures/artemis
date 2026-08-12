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
 *  1. One group per **project**, which is the session's `cwd` resolved through
 *     {@link GroupOptions.projectOf} — see below.
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
 * ## Two sections stand outside the projects
 *
 * A **pinned** session and an **archived** one both leave their project — one to
 * a section above every heading, the other to a section below every heading —
 * because a row that stayed in place and merely changed appearance is a row the
 * user still has to find. Both are flat lists spanning every project, both are
 * lifted out by {@link partitionSessions} before grouping happens, and both
 * vanish when they hold nothing. See {@link SessionSection}.
 *
 * ## A project is not a directory
 *
 * Grouping by `cwd` alone files a session under the folder it ran in, which is
 * the same thing as the project only when the two happen to coincide. They stop
 * coinciding the moment work is split into a **linked worktree**: `.claude/
 * worktrees/some-branch` is a different directory, so an afternoon's work on
 * Artemis appeared in the sidebar as a repository called `some-branch` and left
 * the Artemis group it belonged to. Sessions in a subdirectory of a repository
 * split the same way, for the same reason.
 *
 * So the key is whatever {@link GroupOptions.projectOf} says a directory belongs
 * to — the main checkout for a worktree, the repository root for a directory
 * inside one — and the `cwd` only when it says nothing. Resolving that needs the
 * filesystem, which the renderer does not have, so the answer arrives from the
 * main process a moment after the rows do (see `projectRoots` in the store).
 * Until it does, every session groups by its own directory, which is where this
 * module started and remains a correct-looking list rather than an empty one.
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
  /**
   * The project's root directory. The group's identity and its `key`.
   *
   * Not necessarily any session's `cwd`: a group holding one session from a
   * worktree and one from the checkout is keyed on the checkout, which is the
   * project both of them were working on.
   */
  readonly project: string;
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
/* Pinning and archiving                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Split a listing three ways: kept up front, filed under its project, put away.
 *
 * A separate step *before* grouping rather than a flag inside it, because a
 * pinned or archived session leaves its project entirely — an archived session
 * is not a hidden row in `/code/api`, it is a row in Archived, and a pinned one
 * is a row in Pinned. Filtering inside `groupSessionsByProject` would have to
 * special-case the group whose every member had left, and would leave the caller
 * no way to render the lifted rows at all.
 *
 * Pinned is tested first, so a session that somehow ended up in both sets is
 * kept rather than hidden. The store makes the two mutually exclusive — pinning
 * unarchives and archiving unpins, because "keep this in front of me" and "put
 * this away" cannot both be true — so this only decides what a hand-edited
 * preferences file does, and of the two answers, showing the row is the one the
 * user can act on.
 *
 * Keys are `sessionKey` values, not ids: see the note at the top of this file.
 */
export function partitionSessions(
  sessions: readonly SessionSummary[],
  sets: { readonly pinned: ReadonlySet<string>; readonly archived: ReadonlySet<string> },
): {
  readonly pinned: readonly SessionSummary[];
  readonly active: readonly SessionSummary[];
  readonly archived: readonly SessionSummary[];
} {
  // The overwhelmingly common case is that neither set has anything in it, and
  // walking the list to discover that is waste on the sidebar's hot path.
  if (sets.pinned.size === 0 && sets.archived.size === 0) {
    return { pinned: [], active: sessions, archived: [] };
  }

  const pinned: SessionSummary[] = [];
  const active: SessionSummary[] = [];
  const put: SessionSummary[] = [];
  for (const session of sessions) {
    const key = sessionKey(session);
    if (sets.pinned.has(key)) pinned.push(session);
    else if (sets.archived.has(key)) put.push(session);
    else active.push(session);
  }
  return { pinned, active, archived: put };
}

/**
 * One flat, project-less run of rows — the Pinned section or the Archived one.
 *
 * Ordered newest-first by the same comparator projects use, and *not* grouped by
 * directory. For the archive, the point of the section is that these are out of
 * the way, and re-imposing the project structure inside it would rebuild the
 * thing the user archived them to escape. For pinned, it is that a handful of
 * hand-picked sessions is a short list the user assembled themselves, and
 * splitting six rows across four project headings would bury them under more
 * furniture than rows.
 */
export interface SessionSection {
  /** Newest first, spanning every project. */
  readonly sessions: readonly SessionSummary[];
  /** Whether the section is folded shut. */
  readonly collapsed: boolean;
}

/**
 * Sort a flat section for display. Same rule as inside a project group.
 *
 * Shared by Pinned and Archived deliberately: they differ in where they sit and
 * in what they mean, not in how their rows are ordered, and two copies of "newest
 * first, ties by identity" would be two chances to drift.
 */
export function orderSessions(
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

/**
 * Which project a directory belongs to.
 *
 * `undefined` for a directory nothing is known about yet, which groups it by
 * itself — see the note on projects in the file header.
 */
export type ProjectLookup = (cwd: string) => string | undefined;

export interface GroupOptions {
  readonly query?: string;
  readonly profileLabel?: ProfileLabelLookup;
  readonly orderKey?: SessionOrderKey;
  readonly projectOf?: ProjectLookup;
}

/** Apply rules 1–4 above. */
export function groupSessionsByProject(
  sessions: readonly SessionSummary[],
  options: GroupOptions = {},
): readonly SessionGroup[] {
  const query = options.query ?? '';
  const lookup = options.profileLabel;
  const projectOf = options.projectOf;

  const byProject = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (query && !matchesQuery(session, query, lookup?.(session.profileId))) continue;
    const project = projectOf?.(session.cwd) ?? session.cwd;
    const bucket = byProject.get(project);
    if (bucket) bucket.push(session);
    else byProject.set(project, [session]);
  }

  const orderKey = options.orderKey ?? byUpdatedAt;
  const groups: SessionGroup[] = [];
  for (const [project, bucket] of byProject) {
    bucket.sort(byRecency(orderKey));
    groups.push({
      project,
      sessions: bucket,
      // Not `bucket[0]`: the first row is the one that sorts highest, which
      // under a held key is not necessarily the one written most recently.
      updatedAt: bucket.reduce((newest, s) => Math.max(newest, s.updatedAt), 0),
      order: bucket.reduce((highest, s) => Math.max(highest, orderKey(s)), 0),
    });
  }

  groups.sort((a, b) => b.order - a.order || a.project.localeCompare(b.project));
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
  /** The project's root directory — {@link SessionGroup.project}. */
  readonly project: string;
  /** Sessions in the group — the full count, even when it is folded shut. */
  readonly count: number;
  /** Index into the group array — what the sticky header resolves against. */
  readonly group: number;
  /** True when this group's sessions are folded away behind the header. */
  readonly collapsed: boolean;
}

/**
 * The Pinned section's heading, and the Archived section's.
 *
 * Their own row kinds rather than a {@link HeaderRow} with a flag, because
 * almost nothing a project heading renders applies to either: there is no
 * directory to name, no repository to look up, and no "you are here" marker —
 * both span every project by construction. Giving them distinct kinds means the
 * renderer cannot accidentally ask one for a `cwd` it does not have.
 *
 * Two kinds rather than one `section-header` with a label, because the renderer
 * draws them differently and folds them against different preferences, and a
 * shared kind would put a `section === 'pinned'` branch inside every one of
 * those places instead of at the one point that picks the component.
 */
export interface PinnedHeaderRow {
  readonly kind: 'pinned-header';
  readonly key: string;
  /** Sessions pinned — the full count, even when the section is folded shut. */
  readonly count: number;
  readonly collapsed: boolean;
}

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
   * True for rows inside the Pinned section.
   *
   * Carried on the row for the same reason as {@link archived}: the renderer
   * knows which menu item to offer — Pin or Unpin — without consulting the set
   * again, once per row per frame.
   */
  readonly pinned?: boolean;
  /**
   * True for rows inside the Archived section.
   *
   * Carried on the row so the renderer does not have to consult the archive set
   * again to know which menu item to offer — and so an archived row can be
   * styled as put-away without a second lookup per frame.
   */
  readonly archived?: boolean;
}

export type ListRow = HeaderRow | PinnedHeaderRow | ArchiveHeaderRow | SessionRow;

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
 *
 * ## The two flat sections bracket the projects
 *
 * Pinned goes above every project and Archived below every project, and neither
 * competes for position by recency: one is the shelf at eye level and the other
 * is the drawer under the desk, and furniture that wandered up and down the list
 * as its newest member aged would be neither. Both are absent entirely when
 * empty — a permanent "Pinned · 0" is a control for a state the user is not in.
 *
 * `sections` is one object rather than two trailing parameters because the order
 * these are *passed* has nothing to do with the order they are drawn in, and a
 * third positional argument that renders first would read as the opposite of
 * what it does.
 */
export function flattenGroups(
  groups: readonly SessionGroup[],
  collapsed: ReadonlySet<string> = new Set(),
  sections?: {
    readonly pinned?: SessionSection;
    readonly archived?: SessionSection;
  },
): readonly ListRow[] {
  const rows: ListRow[] = [];

  /*
   * Pinned first, before any project heading.
   *
   * Its group index sits *past* the end of the group array even though its rows
   * come first, and so does the archive's. The number identifies a section
   * rather than describing where it sits — both flat sections are nailed to an
   * end of the list, so there is no position for an index to describe — and
   * numbering them after the projects keeps every project's index equal to its
   * own position in `groups`, which is the one thing that field is read for.
   */
  const pinned = sections?.pinned;
  if (pinned !== undefined && pinned.sessions.length > 0) {
    rows.push({
      kind: 'pinned-header',
      key: 'h:pinned',
      count: pinned.sessions.length,
      collapsed: pinned.collapsed,
    });
    if (!pinned.collapsed) {
      for (const session of pinned.sessions) {
        rows.push({
          kind: 'session',
          key: sessionKey(session),
          session,
          group: groups.length,
          pinned: true,
        });
      }
    }
  }

  groups.forEach((group, index) => {
    const folded = collapsed.has(group.project);
    rows.push({
      kind: 'header',
      key: `h:${group.project}`,
      project: group.project,
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
   * Archived last, always, and absent when empty — see the note above.
   *
   * Its group index sits one past Pinned's, and archived rows are tagged so the
   * renderer can offer "Unarchive" rather than "Archive".
   */
  const archive = sections?.archived;
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
          group: groups.length + 1,
          archived: true,
        });
      }
    }
  }

  return rows;
}
