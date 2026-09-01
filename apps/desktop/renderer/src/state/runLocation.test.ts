/**
 * @vitest-environment jsdom
 *
 * The run location: where new conversations go, and what it outranks.
 *
 * A server is a place that runs accounts, not an account — so the choice of
 * place is sticky (it outlives the session that made it), it seeds every new
 * session until changed, and it outranks the local plan recommendation: a
 * person who chose their server has said where work happens, and dragging
 * them home because a local account has more headroom would un-make a
 * decision they made on purpose. A stored location whose server has since
 * been deleted or disabled falls back to the local path rather than pinning
 * new sessions to a ghost.
 *
 * Same caveat as the neighbours: `renderer/tsconfig.json` excludes test
 * files, so the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ProfileMetadata } from '@rx-artemis/protocol';

import {
  focusedPane,
  newSession,
  serverLocationProfiles,
  setRunLocation,
  useApp,
} from './store';
import { paneState } from './pane';
import { seedApp } from './testkit';

const LOCAL = {
  id: 'prof-local',
  label: 'Claude Personal',
  providerId: 'claude',
  configDir: '/tmp/a',
  publicEnv: {},
} as unknown as ProfileMetadata;

const OTHER_LOCAL = {
  id: 'prof-other',
  label: 'Codex',
  providerId: 'codex',
  configDir: '/tmp/b',
  publicEnv: {},
} as unknown as ProfileMetadata;

const SERVER = {
  id: 'prof-server',
  label: 'System Server',
  providerId: 'artemis',
  configDir: '/tmp/s',
  publicEnv: {},
} as unknown as ProfileMetadata;

beforeEach(() => {
  seedApp({
    profiles: [LOCAL, OTHER_LOCAL, SERVER] as never,
    runLocation: 'local' as never,
    lastLocalProfileId: null as never,
    run: null,
    activeProfileId: LOCAL.id as never,
    activeProviderId: 'claude' as never,
  });
});

describe('serverLocationProfiles', () => {
  it('offers exactly the enabled artemis profiles', () => {
    expect(serverLocationProfiles([LOCAL, OTHER_LOCAL, SERVER]).map((p) => p.id)).toEqual([
      'prof-server',
    ]);
    expect(serverLocationProfiles([LOCAL, OTHER_LOCAL])).toEqual([]);
  });
});

describe('setRunLocation', () => {
  it('moves to the server and remembers the local account being left', () => {
    setRunLocation(SERVER.id as never);
    expect(useApp.getState().runLocation).toBe(SERVER.id);
    expect(useApp.getState().lastLocalProfileId).toBe(LOCAL.id);
    expect(paneState(focusedPane()).activeProfileId).toBe(SERVER.id);
  });

  it('returns to the remembered local account, not just any local one', () => {
    setRunLocation(SERVER.id as never);
    setRunLocation('local');
    expect(useApp.getState().runLocation).toBe('local');
    expect(paneState(focusedPane()).activeProfileId).toBe(LOCAL.id);
  });

  it('refuses a location that names no artemis profile', () => {
    setRunLocation(OTHER_LOCAL.id as never);
    expect(useApp.getState().runLocation).toBe('local');
  });
});

describe('newSession under a location', () => {
  it('seeds a new conversation at the chosen server, outranking the recommender', () => {
    setRunLocation(SERVER.id as never);
    const pane = newSession();
    expect(paneState(pane).activeProfileId).toBe(SERVER.id);
  });

  it('does not chase a stored server that is gone', () => {
    // The location still says "server", but the profile was deleted. A new
    // session from a local pane must stay local rather than adopting a ghost.
    setRunLocation(SERVER.id as never);
    seedApp({
      profiles: [LOCAL, OTHER_LOCAL] as never,
      activeProfileId: LOCAL.id as never,
      run: null,
    });
    const pane = newSession(focusedPane(), { adoptRecommendedProfile: false });
    expect(paneState(pane).activeProfileId).toBe(LOCAL.id);
  });
});
