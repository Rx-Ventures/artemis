/**
 * Two cadences, and the cost model that justifies the faster one.
 *
 * Automatic handoff decides when to stop from these readings, so the poll was
 * tightened from five minutes to two. On its own that would be a straight
 * multiplication of the thing the poller's header is most careful about: a
 * reading spawns the provider's CLI, once per profile, so a machine with eight
 * accounts would go from eight subprocesses every five minutes to eight every
 * two.
 *
 * It does not, because the fast tick between sweeps reads only the profiles
 * that have a run on them. Those are the only accounts whose numbers can move
 * without anyone touching the app, and they are the ones a handoff is about. So
 * the assertions here are mostly about what is *not* read: an idle machine must
 * cost nothing extra, and a busy one must pay for the accounts doing work
 * rather than for every account configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** How many windows the app thinks are open. Reassigned per test. */
let openWindows = 1;

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => Array.from({ length: openWindows }, () => ({})) },
}));
vi.mock('./ipc.js', () => ({
  broadcast: (channel: string, payload: unknown) => {
    broadcasts.push({ channel, payload });
  },
}));
vi.mock('./redact.js', () => ({
  assertNoSecrets: () => undefined,
  RESPONSE_SCAN_POLICY: {},
}));

const { startPlanUsagePolling } = await import('./planUsagePoll');

/* -------------------------------------------------------------------------- */
/* A stand-in engine that records what was asked of it                        */
/* -------------------------------------------------------------------------- */

/** Every push that went out, across the poll and the live stream. */
const broadcasts: { channel: string; payload: unknown }[] = [];

/** Every profile whose usage was read, in order, across all cycles. */
let reads: string[] = [];
/** What `listRuns` answers with — the profiles currently doing work. */
let liveProfiles: string[] = [];
/** The live-merge listener the poller registered, so a test can feed it. */
let liveListener: ((push: { profileId: string; usage: unknown }) => void) | null = null;
/** Whether the poller unsubscribed from the live stream on stop. */
let liveUnsubscribed = false;

function engineHost(profiles: string[]): never {
  const engine = {
    listProfiles: () => Promise.resolve(profiles.map((id) => ({ id }))),
    listRuns: () => Promise.resolve(liveProfiles.map((profileId) => ({ profileId }))),
    refreshPlanUsage: ({ profileId }: { profileId: string }) => {
      reads.push(profileId);
      return Promise.resolve({ available: true, windows: [], fetchedAt: 0 });
    },
    subscribePlanUsage: (listener: (push: { profileId: string; usage: unknown }) => void) => {
      liveListener = listener;
      return () => {
        liveUnsubscribed = true;
      };
    },
  };
  return { ready: true, require: () => engine } as never;
}

/** Advance fake time and let every promise chained off a timer settle. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const SWEEP = 120_000;
const FAST = 30_000;

beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  broadcasts.length = 0;
  liveProfiles = [];
  liveListener = null;
  liveUnsubscribed = false;
  openWindows = 1;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the plan usage poll', () => {
  it('sweeps every profile on the first cycle', async () => {
    const stop = startPlanUsagePolling(engineHost(['a', 'b', 'c']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });

    await tick(1_000);
    expect(reads).toEqual(['a', 'b', 'c']);
    stop();
  });

  it('costs nothing between sweeps while nothing is running', async () => {
    // The whole justification for the faster tick. An idle machine with eight
    // profiles must not pay eight subprocesses every thirty seconds.
    const stop = startPlanUsagePolling(engineHost(['a', 'b', 'c']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });

    await tick(1_000);
    reads = [];
    await tick(FAST * 3);

    expect(reads).toEqual([]);
    stop();
  });

  it('reads only the accounts with work on them between sweeps', async () => {
    const stop = startPlanUsagePolling(engineHost(['a', 'b', 'c']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });

    await tick(1_000);
    reads = [];
    liveProfiles = ['b'];
    await tick(FAST);

    expect(reads).toEqual(['b']);
    stop();
  });

  it('reads a busy account once however many panes are running on it', async () => {
    // Several panes on one profile is the ordinary case, and reading it four
    // times would spend four subprocesses learning one number.
    const stop = startPlanUsagePolling(engineHost(['a', 'b']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });

    await tick(1_000);
    reads = [];
    liveProfiles = ['b', 'b', 'b'];
    await tick(FAST);

    expect(reads).toEqual(['b']);
    stop();
  });

  it('comes back round to a full sweep when one is due', async () => {
    const stop = startPlanUsagePolling(engineHost(['a', 'b']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });

    await tick(1_000);
    reads = [];
    await tick(SWEEP + FAST);

    expect(reads).toEqual(['a', 'b']);
    stop();
  });

  it('reads nothing at all while no window is open', async () => {
    // Unchanged, and worth pinning: on macOS the app outlives its last window,
    // and a reading taken then would be stale before anyone could see it.
    openWindows = 0;
    liveProfiles = ['a'];
    const stop = startPlanUsagePolling(engineHost(['a', 'b']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });

    await tick(1_000 + FAST * 4);
    expect(reads).toEqual([]);
    stop();
  });

  it('stops when it is stopped', async () => {
    const stop = startPlanUsagePolling(engineHost(['a']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });

    await tick(1_000);
    reads = [];
    stop();
    liveProfiles = ['a'];
    await tick(SWEEP * 2);

    expect(reads).toEqual([]);
  });

  it('forwards a live merge onto the push channel without a poll', async () => {
    const stop = startPlanUsagePolling(engineHost(['a', 'b']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });
    broadcasts.length = 0;

    const usage = { available: true, windows: [], fetchedAt: 5 };
    liveListener?.({ profileId: 'b', usage });

    // No timer advanced, no CLI read: the reading already existed in the
    // engine's cache, and forwarding it is the whole cost.
    expect(reads).toEqual([]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.payload).toEqual({ profileId: 'b', usage });
    stop();
  });

  it('drops live merges after stop, and lets the engine subscription go', async () => {
    const stop = startPlanUsagePolling(engineHost(['a']), {
      intervalMs: SWEEP,
      activeIntervalMs: FAST,
      firstDelayMs: 1_000,
    });
    stop();
    expect(liveUnsubscribed).toBe(true);

    broadcasts.length = 0;
    // A merge that races the shutdown — the engine-side unsubscribe has
    // happened, but a listener already mid-call must still land nowhere.
    liveListener?.({ profileId: 'a', usage: { available: true, windows: [], fetchedAt: 1 } });
    expect(broadcasts).toEqual([]);
  });
});
