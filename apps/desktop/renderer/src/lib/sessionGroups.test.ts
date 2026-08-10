/**
 * Grouping past sessions for the sidebar.
 *
 * The requirements these lock down came from the user directly: all past
 * sessions, grouped by project, in recent order, each row showing the profile
 * it belongs to. Each rule below is one of those, plus the collision case the
 * module's own header warns about.
 */

import { describe, expect, it } from 'vitest';
import type { ProfileId, SessionSummary } from '@rx-apollo/protocol';
import {
  flattenGroups,
  groupSessionsByProject,
  matchesQuery,
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
});
