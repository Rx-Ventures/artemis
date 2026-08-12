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

import { focusedPane, newSession, setCwd, useApp } from './store';
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
