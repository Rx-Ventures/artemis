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
  entriesFiling,
  flattenGroups,
  groupSessionsByProject,
  matchesQuery,
  orderSessions,
  partitionSessions,
  sessionKey,
} from './sessionGroups';

/** `partitionSessions` with the set the case under test is not about. */
const NOTHING: ReadonlySet<string> = new Set();

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

    expect(groups.map((g) => g.project)).toEqual(['/code/api', '/code/web']);
    expect(groups[0]!.sessions).toHaveLength(2);
    expect(groups[1]!.sessions).toHaveLength(1);
  });

  it('orders groups by name, whatever their sessions have been doing', () => {
    // /code/web holds the newest session by a distance. Under the old rule that
    // put it first and moved /code/api down the sidebar; the folders are
    // furniture now, so the only thing that decides is the name.
    const groups = groupSessionsByProject([
      session({ id: 'a', cwd: '/code/api', updatedAt: 15 }),
      session({ id: 'b', cwd: '/code/api', updatedAt: 1 }),
      session({ id: 'c', cwd: '/code/web', updatedAt: 20 }),
    ]);

    expect(groups.map((g) => g.project)).toEqual(['/code/api', '/code/web']);
    // The mtime is still reported honestly; it just no longer decides position.
    expect(groups[1]!.updatedAt).toBe(20);
  });

  it('does not move a project when a session in it is worked on', () => {
    // The report, in one assertion: send a prompt in the project at the bottom
    // and the heading someone was reaching for must not slide out from under
    // the pointer.
    const before = groupSessionsByProject([
      session({ id: 'a', cwd: '/code/api', updatedAt: 10 }),
      session({ id: 'b', cwd: '/code/web', updatedAt: 20 }),
      session({ id: 'c', cwd: '/code/zeta', updatedAt: 30 }),
    ]);
    const after = groupSessionsByProject([
      session({ id: 'a', cwd: '/code/api', updatedAt: 10 }),
      session({ id: 'b', cwd: '/code/web', updatedAt: 20 }),
      // Just used, by a long way the newest thing in the list.
      session({ id: 'c', cwd: '/code/zeta', updatedAt: 9_000 }),
    ]);

    expect(after.map((g) => g.project)).toEqual(before.map((g) => g.project));
  });

  it('sorts by the name the heading shows, not by the path it sits under', () => {
    // The heading renders the last segment, so an order computed from the full
    // path would look unsorted on screen: `zebra` before `api` because `/aaa`
    // comes before `/zzz`.
    const groups = groupSessionsByProject([
      session({ id: 'a', cwd: '/aaa/zebra', updatedAt: 1 }),
      session({ id: 'b', cwd: '/zzz/api', updatedAt: 2 }),
    ]);

    expect(groups.map((g) => g.project)).toEqual(['/zzz/api', '/aaa/zebra']);
  });

  it('keeps two projects of the same name together and in a fixed order', () => {
    const groups = groupSessionsByProject([
      session({ id: 'a', cwd: '/work/api', updatedAt: 1 }),
      session({ id: 'b', cwd: '/code/api', updatedAt: 2 }),
      session({ id: 'c', cwd: '/code/web', updatedAt: 3 }),
    ]);

    // Both `api` folders first, path breaking the tie, and the tie-break is
    // total — an order that is not would reshuffle between renders.
    expect(groups.map((g) => g.project)).toEqual(['/code/api', '/work/api', '/code/web']);
  });

  it('ignores case, so one project does not sit in an uppercase block', () => {
    const groups = groupSessionsByProject([
      session({ id: 'a', cwd: '/code/zulu', updatedAt: 1 }),
      session({ id: 'b', cwd: '/code/Api', updatedAt: 2 }),
    ]);

    expect(groups.map((g) => g.project)).toEqual(['/code/Api', '/code/zulu']);
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

/*
 * A worktree is a place; the repository it came from is the project.
 *
 * Reported directly: splitting work into `.claude/worktrees/<branch>` moved
 * those sessions out of the project they belonged to and into a heading named
 * after the branch — a repository the user had never worked in, sitting next to
 * the one they had. The directory is still where the session runs and still what
 * a resume needs; it is only the *grouping* that was answering the wrong
 * question.
 */
describe('groupSessionsByProject across worktrees', () => {
  const WORKTREE = '/code/api/.claude/worktrees/adapter-seam';
  /** What the store's `projectRoots` holds: only the directories that move. */
  const projectOf = (cwd: string): string | undefined =>
    cwd === WORKTREE ? '/code/api' : undefined;

  it('files a worktree’s sessions under the repository they were split off from', () => {
    const groups = groupSessionsByProject(
      [
        session({ id: 'main', cwd: '/code/api', updatedAt: 10 }),
        session({ id: 'split', cwd: WORKTREE, updatedAt: 20 }),
      ],
      { projectOf },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.project).toBe('/code/api');
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(['split', 'main']);
  });

  it('keeps each session’s own directory, which is what a resume needs', () => {
    const groups = groupSessionsByProject([session({ id: 'split', cwd: WORKTREE, updatedAt: 1 })], {
      projectOf,
    });

    expect(groups[0]!.project).toBe('/code/api');
    expect(groups[0]!.sessions[0]!.cwd).toBe(WORKTREE);
  });

  it('groups by directory until the project is known', () => {
    // The answer needs the filesystem, so it lands a moment after the rows do.
    // Before it, this is the list the sidebar has always shown.
    const groups = groupSessionsByProject([
      session({ id: 'main', cwd: '/code/api', updatedAt: 10 }),
      session({ id: 'split', cwd: WORKTREE, updatedAt: 20 }),
    ]);

    expect(groups.map((g) => g.project)).toEqual([WORKTREE, '/code/api']);
  });

  it('carries a group’s recency across the directories inside it', () => {
    // The worktree holds the newest work, so the project it belongs to leads —
    // which it could not do while the two were separate groups.
    const groups = groupSessionsByProject(
      [
        session({ id: 'other', cwd: '/code/web', updatedAt: 50 }),
        session({ id: 'main', cwd: '/code/api', updatedAt: 10 }),
        session({ id: 'split', cwd: WORKTREE, updatedAt: 90 }),
      ],
      { projectOf },
    );

    expect(groups.map((g) => g.project)).toEqual(['/code/api', '/code/web']);
    expect(groups[0]!.updatedAt).toBe(90);
  });
});

/*
 * The sort key the sidebar substitutes while an agent is working.
 *
 * `updatedAt` is the transcript file's mtime, so several running sessions
 * reorder themselves every time the feed re-reads — see `sessionOrderHold` in
 * the store, which is where the held values come from. This module only has to
 * sort by whatever key it is handed, in rows and in groups alike.
 */
describe('groupSessionsByProject with a held order', () => {
  /** `a` pinned high, everything else on its own mtime. */
  const held = (pinned: Readonly<Record<string, number>>) => (s: SessionSummary) =>
    pinned[s.id] ?? s.updatedAt;

  it('orders rows by the key rather than by updatedAt', () => {
    const groups = groupSessionsByProject(
      [
        session({ id: 'running', cwd: '/code/api', updatedAt: 1 }),
        session({ id: 'idle', cwd: '/code/api', updatedAt: 50 }),
      ],
      { orderKey: held({ running: 99 }) },
    );

    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(['running', 'idle']);
  });

  it('does not reach the groups at all, which no longer sort by any key', () => {
    const groups = groupSessionsByProject(
      [
        session({ id: 'running', cwd: '/code/web', updatedAt: 1 }),
        // Written more recently than the pinned row, but not pinned itself. Once
        // it made no difference because the key was held; now it makes none
        // because the groups are sorted by name either way.
        session({ id: 'busy', cwd: '/code/api', updatedAt: 90 }),
      ],
      { orderKey: held({ running: 99 }) },
    );

    expect(groups.map((g) => g.project)).toEqual(['/code/api', '/code/web']);
  });

  it('still reports the real newest updatedAt on the group', () => {
    // Rendered as "4m ago", which is a claim about when the work happened — not
    // about where the row sits, and never was.
    const groups = groupSessionsByProject(
      [
        session({ id: 'running', cwd: '/code/api', updatedAt: 10 }),
        session({ id: 'idle', cwd: '/code/api', updatedAt: 70 }),
      ],
      { orderKey: held({ running: 99 }) },
    );

    expect(groups[0]!.sessions[0]!.id).toBe('running');
    expect(groups[0]!.updatedAt).toBe(70);
  });

  it('leaves the archive on the same rule', () => {
    const ordered = orderSessions(
      [
        session({ id: 'running', cwd: '/code/api', updatedAt: 1 }),
        session({ id: 'idle', cwd: '/code/api', updatedAt: 50 }),
      ],
      { orderKey: held({ running: 99 }) },
    );

    expect(ordered.map((s) => s.id)).toEqual(['running', 'idle']);
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

    expect(groups.map((g) => g.project)).toEqual(['/code/api']);
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
    expect(rows[0]).toMatchObject({ kind: 'header', project: '/code/api', count: 1, group: 0 });
    expect(rows[2]).toMatchObject({ kind: 'header', project: '/code/web', count: 1, group: 1 });
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
    expect(rows[0]).toMatchObject({ project: '/code/api', collapsed: true });
    expect(rows[1]).toMatchObject({ project: '/code/web', collapsed: false });
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
/* Pinning and archiving                                                      */
/* -------------------------------------------------------------------------- */

describe('partitionSessions', () => {
  it('lifts archived sessions out of the listing', () => {
    const kept = session({ id: 'a', cwd: '/code/api', updatedAt: 2 });
    const put = session({ id: 'b', cwd: '/code/api', updatedAt: 1 });

    const split = partitionSessions([kept, put], {
      pinned: NOTHING,
      archived: new Set([sessionKey(put)]),
    });

    expect(split.active.map((s) => s.id)).toEqual(['a']);
    expect(split.archived.map((s) => s.id)).toEqual(['b']);
  });

  it('lifts pinned sessions out of the listing too', () => {
    const kept = session({ id: 'a', cwd: '/code/api', updatedAt: 2 });
    const up = session({ id: 'b', cwd: '/code/api', updatedAt: 1 });

    const split = partitionSessions([kept, up], {
      pinned: new Set([sessionKey(up)]),
      archived: NOTHING,
    });

    expect(split.active.map((s) => s.id)).toEqual(['a']);
    expect(split.pinned.map((s) => s.id)).toEqual(['b']);
  });

  it('shows rather than hides a session that is somehow in both sets', () => {
    // The store makes this unreachable — pinning unarchives and archiving
    // unpins — so this is about what a hand-edited preferences file does. Of
    // the two answers, the one the user can act on wins: the row is somewhere
    // they can see it and un-pin it, rather than filed in a drawer they would
    // have to think to open.
    const both = session({ id: 'a', cwd: '/code/api', updatedAt: 1 });
    const key = new Set([sessionKey(both)]);

    const split = partitionSessions([both], { pinned: key, archived: key });

    expect(split.pinned.map((s) => s.id)).toEqual(['a']);
    expect(split.archived).toEqual([]);
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

    const split = partitionSessions([mine, theirs], {
      pinned: NOTHING,
      archived: new Set([sessionKey(mine)]),
    });

    expect(split.archived.map((s) => s.profileId)).toEqual(['prof_work']);
    expect(split.active.map((s) => s.profileId)).toEqual(['prof_personal']);
  });

  it('returns the input untouched when neither set holds anything', () => {
    const sessions = [session({ id: 'a', cwd: '/code/api', updatedAt: 1 })];
    const split = partitionSessions(sessions, { pinned: NOTHING, archived: NOTHING });

    expect(split.active).toBe(sessions);
    expect(split.archived).toEqual([]);
    expect(split.pinned).toEqual([]);
  });

  it('removes a project from the list entirely once its last session is archived', () => {
    // The point of archiving: the row leaves its project rather than hiding
    // inside it, so a project with nothing left does not linger as an empty
    // header.
    const only = session({ id: 'a', cwd: '/code/old', updatedAt: 1 });
    const other = session({ id: 'b', cwd: '/code/api', updatedAt: 2 });

    const split = partitionSessions([only, other], {
      pinned: NOTHING,
      archived: new Set([sessionKey(only)]),
    });
    const groups = groupSessionsByProject(split.active);

    expect(groups.map((g) => g.project)).toEqual(['/code/api']);
  });

  it('empties a project by pinning its last session, same as archiving does', () => {
    const only = session({ id: 'a', cwd: '/code/old', updatedAt: 1 });
    const other = session({ id: 'b', cwd: '/code/api', updatedAt: 2 });

    const split = partitionSessions([only, other], {
      pinned: new Set([sessionKey(only)]),
      archived: NOTHING,
    });

    expect(groupSessionsByProject(split.active).map((g) => g.project)).toEqual(['/code/api']);
  });

  it('keeps a shared session archived when its entry names a profile that left', () => {
    // The mass-unarchive this guards against: five hundred sessions were
    // archived while `prof_old` owned the shared store's rows, then the
    // arrangement changed — a profile deleted, the share script re-run — and
    // `prof_old` is no longer among the sharers. The id never changed and the
    // transcript never moved, so the filing must hold.
    const row = session({
      id: 'sess-1',
      cwd: '/code/api',
      updatedAt: 1,
      profileId: 'prof_a' as ProfileId,
      alsoInProfiles: ['prof_b' as ProfileId],
      profileIsUnknown: true,
    });

    const split = partitionSessions([row], {
      pinned: NOTHING,
      archived: new Set(['prof_old:sess-1']),
    });

    expect(split.archived.map((s) => s.id)).toEqual(['sess-1']);
    expect(split.active).toEqual([]);
  });

  it('keeps a shared session pinned across the same profile change', () => {
    const row = session({
      id: 'sess-1',
      cwd: '/code/api',
      updatedAt: 1,
      profileId: 'prof_a' as ProfileId,
      profileIsUnknown: true,
    });

    const split = partitionSessions([row], {
      pinned: new Set(['prof_old:sess-1']),
      archived: NOTHING,
    });

    expect(split.pinned.map((s) => s.id)).toEqual(['sess-1']);
  });

  it('does not extend the id match to an unshared row', () => {
    // The old guarantee, restated against the new matching: for a row only one
    // profile reaches, an entry under some other profile is about some other
    // profile's session, and must not put this one away.
    const mine = session({
      id: 'dup',
      cwd: '/code/api',
      updatedAt: 1,
      profileId: 'prof_work' as ProfileId,
    });

    const split = partitionSessions([mine], {
      pinned: NOTHING,
      archived: new Set(['prof_personal:dup']),
    });

    expect(split.active.map((s) => s.id)).toEqual(['dup']);
    expect(split.archived).toEqual([]);
  });

  it('files a scheduler firing under Archived with no entry at all', () => {
    // The rule, not a key: firings arrive on a schedule under fresh ids, so a
    // list of the ones already put away is wrong again by the next firing.
    const fired = session({ id: 'a', cwd: '/code/api', updatedAt: 2, spawnedBy: 'scheduled-task' });
    const talked = session({ id: 'b', cwd: '/code/api', updatedAt: 1 });

    const split = partitionSessions([fired, talked], { pinned: NOTHING, archived: NOTHING });

    expect(split.archived.map((s) => s.id)).toEqual(['a']);
    expect(split.active.map((s) => s.id)).toEqual(['b']);
  });

  it('lets a pin lift a firing back into view', () => {
    // The one explicit "keep this in view" a user can put on a firing they
    // want to watch; it outranks the rule exactly as it outranks an entry.
    const fired = session({ id: 'a', cwd: '/code/api', updatedAt: 1, spawnedBy: 'scheduled-task' });

    const split = partitionSessions([fired], {
      pinned: new Set([sessionKey(fired)]),
      archived: NOTHING,
    });

    expect(split.pinned.map((s) => s.id)).toEqual(['a']);
    expect(split.archived).toEqual([]);
  });

  it('archiving a firing by hand changes nothing it would not already do', () => {
    // The entry a user added before the rule existed — five hundred of them,
    // in the store this was built against — is redundant, not conflicting.
    const fired = session({ id: 'a', cwd: '/code/api', updatedAt: 1, spawnedBy: 'scheduled-task' });

    const split = partitionSessions([fired], {
      pinned: NOTHING,
      archived: new Set([sessionKey(fired)]),
    });

    expect(split.archived.map((s) => s.id)).toEqual(['a']);
  });
});

describe('entriesFiling', () => {
  it('finds the entry under any current sharer', () => {
    const row = session({
      id: 'sess-1',
      cwd: '/code/api',
      updatedAt: 1,
      profileId: 'prof_a' as ProfileId,
      alsoInProfiles: ['prof_b' as ProfileId],
    });

    expect(entriesFiling(row, ['prof_b:sess-1', 'prof_b:other'])).toEqual(['prof_b:sess-1']);
  });

  it('finds the stale entry a profile change left behind, for a shared row', () => {
    // What the toggles must remove on unarchive: an entry the current keys no
    // longer predict. Leaving it behind would look done and be undone at the
    // next listing.
    const row = session({
      id: 'sess-1',
      cwd: '/code/api',
      updatedAt: 1,
      profileId: 'prof_a' as ProfileId,
      profileIsUnknown: true,
    });

    expect(entriesFiling(row, ['prof_old:sess-1', 'prof_a:sess-1'])).toEqual([
      'prof_old:sess-1',
      'prof_a:sess-1',
    ]);
  });

  it('matches only exact keys for an unshared row', () => {
    const row = session({
      id: 'dup',
      cwd: '/code/api',
      updatedAt: 1,
      profileId: 'prof_work' as ProfileId,
    });

    expect(entriesFiling(row, ['prof_personal:dup', 'prof_work:dup'])).toEqual(['prof_work:dup']);
  });
});

describe('orderSessions', () => {
  it('orders newest first, across projects', () => {
    // Not regrouped by directory — the section is one flat list, because
    // rebuilding the project structure inside it defeats putting things away.
    const ordered = orderSessions([
      session({ id: 'old', cwd: '/code/api', updatedAt: 1 }),
      session({ id: 'new', cwd: '/code/web', updatedAt: 99 }),
      session({ id: 'mid', cwd: '/code/api', updatedAt: 50 }),
    ]);

    expect(ordered.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('applies the query, so searching still finds what you archived', () => {
    const ordered = orderSessions(
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
    const rows = flattenGroups(groups(), new Set(), {
      archived: { sessions: archived, collapsed: false },
    });

    expect(rows.map((r) => r.kind)).toEqual([
      'header',
      'session',
      'archive-header',
      'session',
    ]);
  });

  it('emits no archive header at all when nothing is archived', () => {
    // A permanent "Archived · 0" is a control for a state the user is not in.
    const rows = flattenGroups(groups(), new Set(), {
      archived: { sessions: [], collapsed: false },
    });

    expect(rows.some((r) => r.kind === 'archive-header')).toBe(false);
  });

  it('drops the archived rows when the section is shut but keeps the count', () => {
    const rows = flattenGroups(groups(), new Set(), {
      archived: { sessions: archived, collapsed: true },
    });

    expect(rows.map((r) => r.kind)).toEqual(['header', 'session', 'archive-header']);
    expect(rows.at(-1)).toMatchObject({ kind: 'archive-header', count: 1, collapsed: true });
  });

  it('tags archived rows, so the menu can offer Unarchive rather than Archive', () => {
    const rows = flattenGroups(groups(), new Set(), {
      archived: { sessions: archived, collapsed: false },
    });

    const sessions = rows.filter((r) => r.kind === 'session');
    expect(sessions.map((r) => r.archived ?? false)).toEqual([false, true]);
  });

  it('leaves the row list unchanged when no section is passed at all', () => {
    // The two-argument call is what every existing caller used; it must keep
    // meaning "no flat sections".
    expect(flattenGroups(groups(), new Set())).toEqual(flattenGroups(groups()));
  });
});

describe('flattenGroups with pinned sessions', () => {
  const groups = () =>
    groupSessionsByProject([session({ id: 'live', cwd: '/code/api', updatedAt: 20 })]);
  const pinned = [session({ id: 'kept', cwd: '/code/web', updatedAt: 10 })];
  const archived = [session({ id: 'put', cwd: '/code/web', updatedAt: 5 })];

  it('puts the pinned section above every project', () => {
    const rows = flattenGroups(groups(), new Set(), {
      pinned: { sessions: pinned, collapsed: false },
    });

    expect(rows.map((r) => r.kind)).toEqual(['pinned-header', 'session', 'header', 'session']);
  });

  it('emits no pinned header at all when nothing is pinned', () => {
    // The requirement, in one assertion: the folder appears only once there is
    // something in it. A permanent empty section is furniture that teaches
    // nothing and costs a row on every sidebar in the product.
    const rows = flattenGroups(groups(), new Set(), {
      pinned: { sessions: [], collapsed: false },
    });

    expect(rows.some((r) => r.kind === 'pinned-header')).toBe(false);
  });

  it('brackets the projects when both sections are present', () => {
    const rows = flattenGroups(groups(), new Set(), {
      pinned: { sessions: pinned, collapsed: false },
      archived: { sessions: archived, collapsed: false },
    });

    expect(rows.map((r) => r.kind)).toEqual([
      'pinned-header',
      'session',
      'header',
      'session',
      'archive-header',
      'session',
    ]);
  });

  it('drops the pinned rows when the section is shut but keeps the count', () => {
    const rows = flattenGroups(groups(), new Set(), {
      pinned: { sessions: pinned, collapsed: true },
    });

    expect(rows.map((r) => r.kind)).toEqual(['pinned-header', 'header', 'session']);
    expect(rows[0]).toMatchObject({ kind: 'pinned-header', count: 1, collapsed: true });
  });

  it('tags pinned rows, so the menu can offer Unpin rather than Pin', () => {
    const rows = flattenGroups(groups(), new Set(), {
      pinned: { sessions: pinned, collapsed: false },
    });

    const sessions = rows.filter((r) => r.kind === 'session');
    expect(sessions.map((r) => r.pinned ?? false)).toEqual([true, false]);
  });

  it('keeps every project’s group index equal to its position, sections aside', () => {
    // The flat sections are numbered past the end of the group array even
    // though pinned rows come first: the index identifies a section rather
    // than describing where it sits, and shifting the projects to make room
    // would break the one thing the field is read for.
    const rows = flattenGroups(groups(), new Set(), {
      pinned: { sessions: pinned, collapsed: false },
      archived: { sessions: archived, collapsed: false },
    });

    expect(rows[0]).toMatchObject({ kind: 'pinned-header' });
    expect(rows[1]).toMatchObject({ group: 1, pinned: true });
    expect(rows[3]).toMatchObject({ group: 0 });
    expect(rows[5]).toMatchObject({ group: 2, archived: true });
  });
});
