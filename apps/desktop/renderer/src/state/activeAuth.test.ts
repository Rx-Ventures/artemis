/**
 * @vitest-environment jsdom
 *
 * Reading the sign-in state of the account you are about to run on.
 *
 * `authByProfile` was written by exactly one thing — a card mounting on the
 * profiles screen — so until that screen had been opened it was empty, and empty
 * again after every reload, because nothing persists it. The status line's amber
 * "signed out" therefore could not appear for an account nobody had gone looking
 * at, which is the wrong way round: the warning exists for the person who has
 * *not* been looking.
 *
 * The obvious repair — read every profile at startup — is the one deliberately
 * not taken. Each read spawns the provider's CLI, so on the machine this came
 * from that is eight subprocesses during boot to colour seven rows nobody is
 * about to run on. So this reads *one* account, at the moments its answer can
 * have changed, and the economy is as much the subject of these tests as the
 * behaviour is.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  focusedPane,
  resetAuthFreshness,
  resumeSession,
  setProfile,
  useApp,
} from './store';
import { setPaneState } from './pane';
import { seedApp } from './testkit';

/** Every profile whose sign-in state was actually asked about, in order. */
let probed: string[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  auth: {
    status: async ({ profileId }: { profileId: string }) => {
      probed.push(profileId);
      return {
        ok: true,
        value: { status: { loggedIn: true, subscriptionType: 'max' }, signInCommand: 'x' },
      };
    },
  },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  workspace: { describe: async () => ({ ok: false, error: { code: 'internal', message: 'x' } }) },
};

const pane = () => focusedPane();

/** Let the probe's promise settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  probed = [];
  resetAuthFreshness();
  seedApp({
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.p2' },
    ],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
  });
  useApp.setState({ authByProfile: {} });
  pane().transcript.reset();
});

describe('switching account', () => {
  it('reads the account being switched to', async () => {
    setProfile('p2', pane());
    await flush();

    expect(probed).toEqual(['p2']);
  });

  it('stores what came back, so the bar can colour itself', async () => {
    setProfile('p2', pane());
    await flush();

    expect(useApp.getState().authByProfile['p2']?.loggedIn).toBe(true);
  });

  it('reads exactly one account, not the whole list', async () => {
    // The decision this file exists to protect. Eight profiles is eight
    // subprocesses, and seven of them describe accounts nothing is about to run
    // on.
    setProfile('p2', pane());
    await flush();

    expect(probed).toHaveLength(1);
    expect(probed).not.toContain('p1');
  });

  it('does not re-read the same account on a rapid second switch', async () => {
    // `applyProfile` also fires from `newSession`'s automatic adoption, which is
    // not a deliberate act — somebody starting several sessions in a row would
    // otherwise spawn a probe per session.
    setProfile('p2', pane());
    await flush();
    setProfile('p1', pane());
    await flush();
    setProfile('p2', pane());
    await flush();

    // p2 twice would be the regression. p1 is a different account and is read.
    expect(probed).toEqual(['p2', 'p1']);
  });
});

describe('resuming a session', () => {
  it('reads the account the session lands on', async () => {
    // `resumeSession` writes `activeProfileId` directly rather than going
    // through `applyProfile`, so it needs its own call — and a resume that moves
    // account is exactly when the bar's sign-in state is about to be wrong.
    resumeSession({
      id: 'sess-1',
      providerId: 'claude',
      profileId: 'p2',
      cwd: '/a',
      title: 'One conversation',
      updatedAt: 10,
    } as never);
    await flush();

    expect(probed).toContain('p2');
  });
});

describe('with no account selected', () => {
  it('asks nothing', async () => {
    setPaneState(pane(), { activeProfileId: null });
    resetAuthFreshness();
    // Nothing to ask about, and `auth.status` needs a profile id.
    setProfile('p1', pane());
    await flush();

    expect(probed).toEqual(['p1']);
  });
});
