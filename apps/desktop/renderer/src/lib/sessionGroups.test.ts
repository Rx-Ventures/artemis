/**
 * Grouping past sessions for the sidebar.
 *
 * The requirements these lock down came from the user directly: all past
 * sessions, grouped by project, in recent order, each row showing the profile
 * it belongs to. Each rule below is one of those, plus the collision case the
 * module's own header warns about.
 */

import { describe, expect, it } from 'vitest';
import type { ProfileId, SessionSummary } from '@rx-artemis/protocol';
import {
  flattenGroups,
  groupSessionsByProject,
  matchesQuery,
  orderArchived,
  partitionArchived,
  sessionKey,
} from './sessionGroups';

/** A SessionSummary with only the fields these rules actually read. */
function session(over: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'cwd' | 'updatedAt'>): SessionSummary {
  return {
    providerId: 'claude',
    profileId: 'prof_personal' as ProfileId,
    title: 'untitled',
    ...over,
  } as SessionSummary;
}

describe('groupSessionsByProject', () => {
  it('groups sessions by their project directory', () => {
    const groups = groupSessionsByProject([
      session({ id: 'a', cwd: '/code/api', updatedAt: 10 }),
      session({ id: 'b', cwd: '/code/web', updatedAt: 20 }),
      session({ id: 'c', cwd: '/code/api', updatedAt: 30 }),
    ]);

    expect(groups.map((g) => g.cwd)).toEqual(['/code/api', '/code/web']);
    expect(groups[0]!.sessions).toHaveLength(2);
    expect(groups[1]!.sessions).toHaveLength(1);
  });

  it('orders groups by their most recent session, newest first', () => {
    // /code/web's newest (20) beats /code/api's newest (15), even though
    // /code/api holds more sessions and one very old one.
    const groups = groupSessionsByProject([
      session({ id: 'a', cwd: '/code/api', updatedAt: 15 }),
      session({ id: 'b', cwd: '/code/api', updatedAt: 1 }),
      session({ id: 'c', cwd: '/code/web', updatedAt: 20 }),
    ]);

    expect(groups.map((g) => g.cwd)).toEqual(['/code/web', '/code/api']);
    expect(groups[0]!.updatedAt).toBe(20);
  });

  it('orders sessions within a group newest first', () => {
    const groups = groupSessionsByProject([
      session({ id: 'old', cwd: '/code/api', updatedAt: 1 }),
      session({ id: 'new', cwd: '/code/api', updatedAt: 99 }),
      session({ id: 'mid', cwd: '/code/api', updatedAt: 50 }),
    ]);

    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('keeps ordering stable when two sessions share a timestamp', () => {
    // Equal `updatedAt` must not produce a list whose order changes between
    // renders — a shifting sidebar is worse than an arbitrary but fixed order.
    const input = [
      session({ id: 'b', cwd: '/code/api', updatedAt: 5 }),
      session({ id: 'a', cwd: '/code/api', updatedAt: 5 }),
    ];

    const first = groupSessionsByProject(input)[0]!.sessions.map((s) => s.id);
    const again = groupSessionsByProject([...input].reverse())[0]!.sessions.map((s) => s.id);

    expect(first).toEqual(again);
  });

  it('separates identical directories belonging to different profiles into one group but distinct rows', () => {
    // Same project, two accounts. One group (it is one directory), two rows.
    const groups = groupSessionsByProject([
      session({ id: 'x', cwd: '/code/api', updatedAt: 2, profileId: 'prof_work' as ProfileId }),
      session({ id: 'y', cwd: '/code/api', updatedAt: 1, profileId: 'prof_personal' as ProfileId }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessions.map((s) => s.profileId)).toEqual(['prof_work', 'prof_personal']);
  });
});

describe('matchesQuery', () => {
  const s = session({
    id: 'sesn_1',
    cwd: '/code/api',
    updatedAt: 1,
    title: 'fix auth redirect',
  });

  it('matches on the title', () => {
    expect(matchesQuery(s, 'auth')).toBe(true);
  });

  it('matches on the project directory, so "the auth work in api" is answerable', () => {
    expect(matchesQuery(s, 'api')).toBe(true);
  });

  it('matches on the profile label, so "everything on my work account" is answerable', () => {
    expect(matchesQuery(s, 'work', 'Work')).toBe(true);
    expect(matchesQuery(s, 'work', 'Personal')).toBe(false);
  });

  it('ANDs its terms rather than ORing them', () => {
    // "api auth" means the auth session in api — not every session in either.
    expect(matchesQuery(s, 'api auth')).toBe(true);
    expect(matchesQuery(s, 'api nonsense')).toBe(false);
  });

  it('treats an empty or whitespace query as matching everything', () => {
    expect(matchesQuery(s, '')).toBe(true);
    expect(matchesQuery(s, '   ')).toBe(true);
  });

  it('filters before grouping, so a project with no surviving sessions disappears', () => {
    const groups = groupSessionsByProject(
      [
        session({ id: 'a', cwd: '/code/api', updatedAt: 2, title: 'fix auth' }),
        session({ id: 'b', cwd: '/code/web', updatedAt: 1, title: 'restyle nav' }),
      ],
      { query: 'auth' },
    );

    expect(groups.map((g) => g.cwd)).toEqual(['/code/api']);
  });
});

describe('sessionKey', () => {
  it('disambiguates the same session id across two profiles', () => {
    // Session ids are unique per profile, not per machine.
    const a = session({ id: 'dup', cwd: '/code/api', updatedAt: 1, profileId: 'prof_work' as ProfileId });
    const b = session({ id: 'dup', cwd: '/code/api', updatedAt: 1, profileId: 'prof_personal' as ProfileId });

    expect(sessionKey(a)).not.toBe(sessionKey(b));
  });
});

describe('flattenGroups', () => {
  it('emits a header before each group and tags every row with its group index', () => {
    const rows = flattenGroups(
      groupSessionsByProject([
        session({ id: 'a', cwd: '/code/api', updatedAt: 20 }),
        session({ id: 'b', cwd: '/code/web', updatedAt: 10 }),
      ]),
    );

    expect(rows.map((r) => r.kind)).toEqual(['header', 'session', 'header', 'session']);
    expect(rows[0]).toMatchObject({ kind: 'header', cwd: '/code/api', count: 1, group: 0 });
    expect(rows[2]).toMatchObject({ kind: 'header', cwd: '/code/web', count: 1, group: 1 });
    expect(rows[3]).toMatchObject({ group: 1 });
  });

  it('REGRESSION: keys rows by profile+id, so a colliding id across profiles does not drop a row', () => {
    // This previously used `session.id` alone. React silently drops the second
    // of two identically-keyed siblings, so one account's session would vanish
    // from a project both accounts had worked in.
    const rows = flattenGroups(
      groupSessionsByProject([
        session({ id: 'dup', cwd: '/code/api', updatedAt: 2, profileId: 'prof_work' as ProfileId }),
        session({ id: 'dup', cwd: '/code/api', updatedAt: 1, profileId: 'prof_personal' as ProfileId }),
      ]),
    );

    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('drops a collapsed group’s sessions but keeps its header', () => {
    const rows = flattenGroups(
      groupSessionsByProject([
        session({ id: 'a', cwd: '/code/api', updatedAt: 20 }),
        session({ id: 'b', cwd: '/code/web', updatedAt: 10 }),
      ]),
      new Set(['/code/api']),
    );

    // Dropped here rather than hidden in CSS: the virtualiser computes its
    // geometry from this array, so a row that is present but invisible would
    // still take up its height and leave a hole in the list.
    expect(rows.map((r) => r.kind)).toEqual(['header', 'header', 'session']);
    expect(rows[0]).toMatchObject({ cwd: '/code/api', collapsed: true });
    expect(rows[1]).toMatchObject({ cwd: '/code/web', collapsed: false });
  });

  it('keeps a collapsed group’s full count on its header', () => {
    const rows = flattenGroups(
      groupSessionsByProject([
        session({ id: 'a', cwd: '/code/api', updatedAt: 3 }),
        session({ id: 'b', cwd: '/code/api', updatedAt: 2 }),
        session({ id: 'c', cwd: '/code/api', updatedAt: 1 }),
      ]),
      new Set(['/code/api']),
    );

    // The number is a fact about the project, not about how much of it is on
    // screen — it is the one thing worth reading while the group is shut, and
    // counting the visible rows would render it as `·0`.
    expect(rows[0]).toMatchObject({ count: 3, collapsed: true });
  });

  it('expands everything when nothing is collapsed', () => {
    const groups = groupSessionsByProject([session({ id: 'a', cwd: '/code/api', updatedAt: 1 })]);

    expect(flattenGroups(groups).map((r) => r.kind)).toEqual(['header', 'session']);
    expect(flattenGroups(groups)[0]).toMatchObject({ collapsed: false });
  });
});

/* -------------------------------------------------------------------------- */
/* Archiving                                                                  */
/* -------------------------------------------------------------------------- */

describe('partitionArchived', () => {
  it('lifts archived sessions out of the listing', () => {
    const kept = session({ id: 'a', cwd: '/code/api', updatedAt: 2 });
    const put = session({ id: 'b', cwd: '/code/api', updatedAt: 1 });

    const split = partitionArchived([kept, put], new Set([sessionKey(put)]));

    expect(split.active.map((s) => s.id)).toEqual(['a']);
    expect(split.archived.map((s) => s.id)).toEqual(['b']);
  });

  it('keys on profile+id, so archiving does not hide another profile’s session', () => {
    // The same failure the row keys guard against: an id is unique inside its
    // profile, not across them. Archiving by bare id would put both away.
    const mine = session({
      id: 'dup',
      cwd: '/code/api',
      updatedAt: 2,
      profileId: 'prof_work' as ProfileId,
    });
    const theirs = session({
      id: 'dup',
      cwd: '/code/api',
      updatedAt: 1,
      profileId: 'prof_personal' as ProfileId,
    });

    const split = partitionArchived([mine, theirs], new Set([sessionKey(mine)]));

    expect(split.archived.map((s) => s.profileId)).toEqual(['prof_work']);
    expect(split.active.map((s) => s.profileId)).toEqual(['prof_personal']);
  });

  it('returns the input untouched when nothing is archived', () => {
    const sessions = [session({ id: 'a', cwd: '/code/api', updatedAt: 1 })];
    const split = partitionArchived(sessions, new Set());

    expect(split.active).toBe(sessions);
    expect(split.archived).toEqual([]);
  });

  it('removes a project from the list entirely once its last session is archived', () => {
    // The point of archiving: the row leaves its project rather than hiding
    // inside it, so a project with nothing left does not linger as an empty
    // header.
    const only = session({ id: 'a', cwd: '/code/old', updatedAt: 1 });
    const other = session({ id: 'b', cwd: '/code/api', updatedAt: 2 });

    const split = partitionArchived([only, other], new Set([sessionKey(only)]));
    const groups = groupSessionsByProject(split.active);

    expect(groups.map((g) => g.cwd)).toEqual(['/code/api']);
  });
});

describe('orderArchived', () => {
  it('orders newest first, across projects', () => {
    // Not regrouped by directory — the section is one flat list, because
    // rebuilding the project structure inside it defeats putting things away.
    const ordered = orderArchived([
      session({ id: 'old', cwd: '/code/api', updatedAt: 1 }),
      session({ id: 'new', cwd: '/code/web', updatedAt: 99 }),
      session({ id: 'mid', cwd: '/code/api', updatedAt: 50 }),
    ]);

    expect(ordered.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('applies the query, so searching still finds what you archived', () => {
    const ordered = orderArchived(
      [
        session({ id: 'a', cwd: '/code/api', updatedAt: 2, title: 'fix auth' }),
        session({ id: 'b', cwd: '/code/api', updatedAt: 1, title: 'restyle nav' }),
      ],
      { query: 'auth' },
    );

    expect(ordered.map((s) => s.id)).toEqual(['a']);
  });
});

describe('flattenGroups with an archive', () => {
  const groups = () =>
    groupSessionsByProject([session({ id: 'live', cwd: '/code/api', updatedAt: 20 })]);
  const archived = [session({ id: 'put', cwd: '/code/web', updatedAt: 10 })];

  it('pins the archive last, after every project', () => {
    const rows = flattenGroups(groups(), new Set(), { sessions: archived, collapsed: false });

    expect(rows.map((r) => r.kind)).toEqual([
      'header',
      'session',
      'archive-header',
      'session',
    ]);
  });

  it('emits no archive header at all when nothing is archived', () => {
    // A permanent "Archived · 0" is a control for a state the user is not in.
    const rows = flattenGroups(groups(), new Set(), { sessions: [], collapsed: false });

    expect(rows.some((r) => r.kind === 'archive-header')).toBe(false);
  });

  it('drops the archived rows when the section is shut but keeps the count', () => {
    const rows = flattenGroups(groups(), new Set(), { sessions: archived, collapsed: true });

    expect(rows.map((r) => r.kind)).toEqual(['header', 'session', 'archive-header']);
    expect(rows.at(-1)).toMatchObject({ kind: 'archive-header', count: 1, collapsed: true });
  });

  it('tags archived rows, so the menu can offer Unarchive rather than Archive', () => {
    const rows = flattenGroups(groups(), new Set(), { sessions: archived, collapsed: false });

    const sessions = rows.filter((r) => r.kind === 'session');
    expect(sessions.map((r) => r.archived ?? false)).toEqual([false, true]);
  });

  it('leaves the row list unchanged when no archive is passed at all', () => {
    // The two-argument call is what every existing caller used; it must keep
    // meaning "no archive section".
    expect(flattenGroups(groups(), new Set())).toEqual(flattenGroups(groups()));
  });
});
