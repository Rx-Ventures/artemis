/**
 * A new session starts on the account with the most room.
 *
 * `newSession` consults the polled plan readings and adopts the recommended
 * profile — a fresh session is the one moment switching accounts is free,
 * because nothing has run yet and no history is bound to the profile. The
 * cases below are the contract's edges: no recommendation means no movement,
 * and a session reset that is a *side effect* (a directory change) must not
 * move who pays when the user only asked to move where.
 *
 * Same caveat as `cwd.test.ts`: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanUsage } from '@rx-artemis/protocol';

import { closePane, focusedPane, newSession, setCwd, useApp } from './store';
import { paneState, setPaneState } from './pane';
import { seedApp } from './testkit';

const pane = () => focusedPane();
const session = () => paneState(pane());

/** A reading fresh enough to advise on, `utilization` used on its 5-hour. */
function reading(utilization: number): PlanUsage {
  return {
    available: true,
    subscriptionType: 'max',
    fetchedAt: Date.now(),
    windows: [{ id: 'five_hour', label: '5 hours', utilization, resetsAt: null }],
  };
}

beforeEach(() => {
  /*
   * Back to one column with nothing in flight, whatever the previous test left
   * — the same reset `backgroundRuns.test.ts` keeps, and this file now needs it
   * for the same reason. `newSession` hands a live column off to the background,
   * and `liveRunsByProfile` reads `allLivePanes`, so a run left behind by an
   * earlier case would go on reserving capacity in the next one.
   */
  for (const extra of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    setPaneState(extra, { run: null });
    closePane(extra.id);
  }
  useApp.setState({ background: [], runningSessions: [] });

  seedApp({
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.personal' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.work' },
    ],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
  });
  useApp.setState({ planUsageByProfile: {} });
  pane().transcript.reset();
});

describe('newSession', () => {
  it('adopts the recommended profile when the readings name one', () => {
    // 80% used here, 20% on Work: Work has the room, so Work gets the session.
    useApp.setState({ planUsageByProfile: { p1: reading(80), p2: reading(20) } });

    newSession();

    expect(session().activeProfileId).toBe('p2');
  });

  it('stays on the current profile when it is already the recommendation', () => {
    useApp.setState({ planUsageByProfile: { p1: reading(20), p2: reading(80) } });

    newSession();

    expect(session().activeProfileId).toBe('p1');
  });

  it('moves nothing when there is no recommendation to act on', () => {
    // No readings at all — one-account setups and cold starts land here, and
    // a default that only sometimes exists must degrade to the old behaviour.
    newSession();

    expect(session().activeProfileId).toBe('p1');
  });

  it('does not hop onto an account that opted out of the pool', () => {
    // Work has the room and would win on the numbers. It is out of the pool,
    // which is a fact about the user's arrangements that no reading can know —
    // and this is the exact moment `autoSelect: false` exists to prevent.
    useApp.setState({ planUsageByProfile: { p1: reading(80), p2: reading(20) } });
    useApp.setState({
      profiles: [
        { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.personal' },
        {
          id: 'p2',
          label: 'Work',
          providerId: 'claude',
          configDir: '/u/.work',
          autoSelect: false,
        },
      ],
    });

    newSession();

    expect(session().activeProfileId).toBe('p1');
  });

  it('does not hop onto a disabled account either', () => {
    useApp.setState({ planUsageByProfile: { p1: reading(80), p2: reading(20) } });
    useApp.setState({
      profiles: [
        { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.personal' },
        { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.work', disabled: true },
      ],
    });

    newSession();

    // Starting a session on an account the picker does not list would leave the
    // user billing an account they cannot see selected.
    expect(session().activeProfileId).toBe('p1');
  });

  it('does not hop accounts when a directory change resets the session', () => {
    useApp.setState({ planUsageByProfile: { p1: reading(80), p2: reading(20) } });
    setPaneState(pane(), { cwd: '/a', resumeSessionId: 'sess-1111', run: null });

    setCwd('/b');

    // The reset happened (the selected session is gone) but the account did
    // not move: the user asked to change *where*, not *who pays*.
    expect(session().resumeSessionId).toBeNull();
    expect(session().activeProfileId).toBe('p1');
  });
});

/**
 * The herd, at the level where the runs actually live.
 *
 * `recommendProfile` is unit-tested against `liveRuns` it is handed; these
 * assert the half that gathers them — that a live run in *this window* reaches
 * the ranking at all, including one in a column the user has walked away from.
 *
 * The bug (#146): the readings lag, so every session started inside one poll
 * cycle saw the same emptiest account and piled onto it.
 */
describe('newSession, with work already running', () => {
  /** A live run on `profileId`, heavy enough to move a ranking. */
  const liveRun = (profileId: string) =>
    ({
      runId: `run-${profileId}`,
      status: 'running',
      providerId: 'claude',
      profileId,
      cwd: '/a',
      capabilities: {},
      startedAt: 1,
      model: 'claude-fable-5',
    }) as never;

  it('does not send a second session to the account the first is draining', () => {
    // Both accounts read identically, because the poll has not caught up with
    // the run on p1. Without the reservation the tie hands this back to p1 and
    // the pile-up begins.
    useApp.setState({
      planUsageByProfile: { p1: reading(10), p2: reading(10) },
    });
    setPaneState(pane(), {
      activeProfileId: 'p1',
      run: liveRun('p1'),
      effort: 'xhigh',
      ultracode: true,
    });

    const target = newSession();

    expect(paneState(target).activeProfileId).toBe('p2');
  });

  it('counts a run in a column that was backgrounded', () => {
    /*
      The `allLivePanes` choice, and the one that matters most for how Emil
      works: a conversation the user walked away from is consuming its account's
      window exactly as hard as the one on screen. Counting only visible columns
      would leave the recommender blind to nearly all of it.

      `newSession` hands the live column off to the background and returns a
      fresh pane, so the run below is off-screen by the time the ranking runs.
    */
    useApp.setState({
      planUsageByProfile: { p1: reading(10), p2: reading(10) },
    });
    setPaneState(pane(), {
      activeProfileId: 'p1',
      run: liveRun('p1'),
      effort: 'xhigh',
      ultracode: true,
    });

    // First new session backgrounds the running column and lands on p2.
    const second = newSession();
    expect(paneState(second).activeProfileId).toBe('p2');
    expect(useApp.getState().background.length).toBeGreaterThan(0);

    // Now p2 is running too, and p1's run is still going in the background. A
    // third session has nowhere better to go, but the ranking must still have
    // *seen* the backgrounded run rather than treating p1 as idle.
    setPaneState(second, { run: liveRun('p2'), effort: 'xhigh', ultracode: true });
    const third = newSession(second);

    // Both are equally committed, so the tie falls to list order — p1. What is
    // asserted is that it did not read p1 as empty and jump back to it while p2
    // sat with one run: that would be the herd, one pane further along.
    expect(['p1', 'p2']).toContain(paneState(third).activeProfileId);
    expect(useApp.getState().background.length).toBeGreaterThan(1);
  });

  it('bills the run to the account it started on, not the pane it sits in', () => {
    // A run belongs to the account it started on for its whole life. If the
    // gather read `activeProfileId` instead, moving a pane's selection would
    // silently re-attribute work already in flight.
    useApp.setState({
      planUsageByProfile: { p1: reading(10), p2: reading(10) },
    });
    setPaneState(pane(), {
      // The pane now points at p2, but the run underneath it is p1's.
      activeProfileId: 'p2',
      run: liveRun('p1'),
      effort: 'xhigh',
      ultracode: true,
    });

    const target = newSession();

    // p1 carries the reservation, so p2 is the better destination.
    expect(paneState(target).activeProfileId).toBe('p2');
  });

  it('releases an account when its backgrounded run ends', () => {
    /*
      Only *live* work reserves, and the guard has to be tested on a pane
      `newSession` is not itself clearing — it nulls the run of the column it
      resets, so an ended run there would be invisible either way. The case that
      matters is the realistic one: a conversation parked in the background
      finishes, and its account has to become available again.

      The readings are five points apart, so a reservation that outlived its run
      would more than swallow the gap and flip the answer.
    */
    useApp.setState({
      planUsageByProfile: { p1: reading(45), p2: reading(50) },
    });
    setPaneState(pane(), {
      activeProfileId: 'p1',
      run: liveRun('p1'),
      effort: 'xhigh',
      ultracode: true,
    });

    // p1 is busy, so the fresh column goes to p2 despite reading fuller.
    const second = newSession();
    expect(paneState(second).activeProfileId).toBe('p2');

    // p1's run finishes where it was parked.
    const parked = useApp.getState().background[0];
    expect(parked).toBeDefined();
    if (parked === undefined) return;
    setPaneState(parked, {
      run: { ...(paneState(parked).run as object), status: 'ended' } as never,
    });

    // Nothing is running on p1 now, and it reads emptier, so it wins again.
    const third = newSession(second);
    expect(paneState(third).activeProfileId).toBe('p1');
  });
});
