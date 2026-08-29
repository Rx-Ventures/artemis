/**
 * @vitest-environment jsdom
 *
 * The rate-limit wall grows a door (§5 phase 1, ADR 0003).
 *
 * A run dying `rate_limit` used to end in a shrug: "code rate_limit · HTTP 429
 * · retryable", with `retryable` decorating nothing. The banner now names the
 * binding window and its reset, and — when a reachable, signed-in,
 * fresh-reading target exists — offers "Continue on <profile>", which performs
 * the hand off manually. Three properties carry the design:
 *
 *  - **The door opens after the promotion, never before.** `run.end` promotes
 *    `endedSessionId` into `resumeSessionId` only while the pane still matches
 *    the run; the door hangs off that promoted id, so a conversation the
 *    promotion refused (directory moved, profile moved) gets a banner with no
 *    door rather than a door onto a dropped conversation.
 *  - **The offer is gated, and the click re-validates.** A banner can sit for
 *    minutes; the world it was pushed into is not the world it is clicked in.
 *  - **No candidate, no door — and still a better banner.** Naming the window
 *    and reset is most of the feature; the door is the bonus.
 *
 * Same caveat as its neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { focusedPane, handleAgentEvent, resetRunStreamState, useApp } from './store';
import { paneState, setPaneState } from './pane';
import { capabilities } from './testkit';

/* -------------------------------------------------------------------------- */
/* Bridge                                                                     */
/* -------------------------------------------------------------------------- */

/** Auth answers per profile, so tests can decide what a probe learns. */
let authAnswers: Record<string, { loggedIn: boolean }> = {};

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    list: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    listAll: async () => ({ ok: true, value: { sessions: [], unreadableProfiles: [] } }),
  },
  providers: {
    list: async () => ({ ok: true, value: { providers: [] } }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
  },
  auth: {
    status: async ({ profileId }: { profileId: string }) => {
      const status = authAnswers[profileId];
      if (status === undefined) return { ok: false as const, error: { code: 'unknown', message: 'stub' } };
      return { ok: true as const, value: { status, signInCommand: 'claude auth login' } };
    },
  },
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: null } }),
    refresh: async () => ({ ok: true, value: { usage: null } }),
    onChange: () => () => undefined,
  },
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CAPS = capabilities();

const PROFILES = [
  { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' },
  { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.p2' },
];

/** The dying run: on `p1`, in `/repo`, holding session `sess-1`. */
const RUN = {
  runId: 'r1',
  status: 'running',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/repo',
  capabilities: CAPS,
  startedAt: 1,
  sessionId: 'sess-1',
};

/** The sidebar's row: `p1` ran it, `p2` shares the store. */
const SHARED_ROW = {
  id: 'sess-1',
  providerId: 'claude',
  profileId: 'p1',
  alsoInProfiles: ['p2'],
  cwd: '/repo',
  title: 'One conversation',
  updatedAt: 10,
};

const reading = (utilization: number, over: Record<string, unknown> = {}) => ({
  available: true,
  windows: [
    { id: 'five_hour', label: '5-hour', utilization, resetsAt: Date.now() + 3 * 3600_000, ...over },
  ],
  fetchedAt: Date.now(),
});

const died = (over: Record<string, unknown> = {}) =>
  ({
    type: 'run.end',
    runId: 'r1',
    seq: 1,
    ts: 0,
    reason: 'error',
    sessionId: 'sess-1',
    error: { code: 'rate_limit', message: 'Rate limited', httpStatus: 429, retryable: true },
    ...over,
  }) as never;

const banner = () => useApp.getState().banners.at(-1);
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 16));

beforeEach(() => {
  resetRunStreamState();
  authAnswers = {};
  useApp.setState({
    banners: [],
    background: [],
    profiles: PROFILES,
    sessions: [SHARED_ROW],
    // The world in which the door opens: the source is spent, the target has
    // room, both readings fresh, target signed in. Tests below subtract one
    // condition each.
    planUsageByProfile: { p1: reading(99, { status: 'rejected' }), p2: reading(20) },
    authByProfile: { p2: { loggedIn: true } },
  } as never);
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    run: RUN,
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/repo',
    resumeSessionId: null,
    permissionQueue: [],
    handoff: 'none',
  } as never);
});

/* -------------------------------------------------------------------------- */
/* What the banner says                                                       */
/* -------------------------------------------------------------------------- */

describe('what the banner says', () => {
  it('names the binding window and its reset, not an error-code shrug', () => {
    handleAgentEvent(died());

    expect(banner()?.level).toBe('error');
    expect(banner()?.detail).toContain('5-hour limit is reached');
    expect(banner()?.detail).toContain('resets');
    expect(banner()?.detail).not.toContain('HTTP 429');
  });

  it('falls back to the error description when no reading exists to speak from', () => {
    useApp.setState({ planUsageByProfile: {} } as never);

    handleAgentEvent(died());

    // Inventing a window would be worse than the shrug; the old sentence is at
    // least true.
    expect(banner()?.detail).toContain('rate_limit');
    expect(banner()?.action).toBeUndefined();
  });

  it('leaves every other death exactly as it was', () => {
    handleAgentEvent(
      died({ error: { code: 'transport', message: 'the process died' } }),
    );

    expect(banner()?.detail).toContain('code transport');
    expect(banner()?.action).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The door                                                                   */
/* -------------------------------------------------------------------------- */

describe('the door', () => {
  it('offers the recommended target when it is reachable, signed in and fresh-reading', () => {
    handleAgentEvent(died());

    expect(banner()?.action?.label).toBe('Continue on Work');
  });

  it('performs the move on click: account moves, session stays', async () => {
    const pane = focusedPane();
    handleAgentEvent(died());

    // The promotion happened first — the same event, one write earlier — which
    // is the ordering §5 obstacle 1 is about: move the profile before the
    // promotion and the conversation is silently dropped.
    expect(paneState(pane).resumeSessionId).toBe('sess-1');

    banner()?.action?.run();
    await settled();

    expect(paneState(pane).activeProfileId).toBe('p2');
    expect(paneState(pane).resumeSessionId).toBe('sess-1');
  });

  it('offers no door when the promotion was refused', () => {
    // The pane moved to another directory while the run was dying, so run.end
    // refuses to promote the session id — there is no conversation here for
    // the door to continue, and offering one would resume the wrong history.
    setPaneState(focusedPane(), { cwd: '/elsewhere' } as never);

    handleAgentEvent(died());

    expect(banner()?.detail).toContain('5-hour limit');
    expect(banner()?.action).toBeUndefined();
  });

  it('offers no door to a target that cannot reach the store', () => {
    useApp.setState({ sessions: [{ ...SHARED_ROW, alsoInProfiles: [] }] } as never);

    handleAgentEvent(died());

    expect(banner()?.action).toBeUndefined();
  });

  it('offers no door to a target known to be signed out', () => {
    useApp.setState({ authByProfile: { p2: { loggedIn: false } } } as never);

    handleAgentEvent(died());

    expect(banner()?.action).toBeUndefined();
  });

  it('offers no door on a stale target reading — six minutes, the recommender’s bar', () => {
    useApp.setState({
      planUsageByProfile: {
        p1: reading(99),
        p2: { ...reading(20), fetchedAt: Date.now() - 7 * 60_000 },
      },
    } as never);

    handleAgentEvent(died());

    // A stale reading also drops the account out of the recommendation
    // entirely, so this holds by two independent gates — the point is that it
    // holds.
    expect(banner()?.action).toBeUndefined();
  });

  it('offers the door on an unchecked target and lets the click decide', async () => {
    // Nobody has probed p2 — the ordinary state on a fresh launch. The offer
    // stands (the probe is fired alongside it), and the *move* is where
    // signed-in is enforced: `handOffToProfile` probes and refuses.
    useApp.setState({ authByProfile: {} } as never);
    authAnswers = { p2: { loggedIn: false } };

    handleAgentEvent(died());
    expect(banner()?.action?.label).toBe('Continue on Work');

    banner()?.action?.run();
    await settled();

    // The probe answered "signed out", so nothing moved — and the refusal says
    // why rather than failing on credentials a prompt later.
    expect(paneState(focusedPane()).activeProfileId).toBe('p1');
    expect(banner()?.message).toContain('Could not hand off');
  });
});
