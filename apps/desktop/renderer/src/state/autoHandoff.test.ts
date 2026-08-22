/**
 * @vitest-environment jsdom
 *
 * Handing the work over before the account runs out (issue #172).
 *
 * The decision itself is `handoffTrigger`, tested against literals in the
 * protocol package. What is left for here is everything that decision touches,
 * and the three properties that make the feature safe rather than merely
 * present:
 *
 *  - **It must not loop.** The handoff turn spends budget of its own, so the
 *    reading that fired it is still over the threshold when that turn ends. An
 *    unlatched implementation asks again, and again, each attempt eating the
 *    runway the first one existed to preserve.
 *  - **It must stop the conversation it saved.** Writing the document and then
 *    letting the next prompt through arrives at the same exhaustion one turn
 *    later, having spent a turn on a document nobody acted on.
 *  - **It must be escapable.** Stopping someone's work is the most intrusive
 *    thing this app does unasked, so "no" has to be final for the rest of the
 *    conversation rather than a question it keeps re-asking.
 *
 * Same caveat as its neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handoffThresholdsWith, NO_CAPABILITIES, type PlanUsage } from '@rx-artemis/protocol';

import {
  dismissHandoff,
  focusedPane,
  handleAgentEvent,
  installPlanUsageFeed,
  resetRunStreamState,
  setAutoHandoff,
  setHandoffThreshold,
  submitPrompt,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';
import { handoffPrompt, handoffStamp, handoffReason } from './autoHandoff';

/* -------------------------------------------------------------------------- */
/* A bridge that records the turns it was asked to start                      */
/* -------------------------------------------------------------------------- */

let started: string[] = [];
let interrupts = 0;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    start: async ({ input }: { input: { prompt: string; runId: string } }) => {
      started.push(input.prompt);
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'running',
            capabilities: NO_CAPABILITIES,
            startedAt: 1,
            sessionId: 's1',
          },
        },
      };
    },
    interrupt: async () => {
      interrupts += 1;
      return { ok: true, value: { runId: 'r1', stillQueued: [] } };
    },
    send: async () => ({ ok: true, value: { runId: 'r1', deliveredImmediately: true } }),
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
  usagePlan: {
    refresh: async () => ({ ok: true, value: { usage: null } }),
    cached: async () => ({ ok: true, value: { usage: null } }),
    // The listener is captured rather than dropped, so `reading` below can push
    // through the same channel the poll uses. Driving the store's own entry
    // point is the point: a test that wrote `planUsageByProfile` directly would
    // pass even if nothing were wired to it.
    onChange: (listener: (push: { profileId: string; usage: PlanUsage }) => void) => {
      pushUsage = listener;
      return () => {
        pushUsage = null;
      };
    },
  },
};

/** The plan-usage feed's listener, once `installPlanUsageFeed` has run. */
let pushUsage: ((push: { profileId: string; usage: PlanUsage }) => void) | null = null;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = 1_700_000_000_000;

/** A reading, as fresh as `fetchedAt` says. */
const usage = (utilization: number, fetchedAt = NOW): PlanUsage => ({
  available: true,
  windows: [{ id: 'five_hour', label: '5 hours', utilization, resetsAt: null }],
  fetchedAt,
});

/** Push a reading for the focused pane's account, the way the poll does. */
function reading(u: PlanUsage): void {
  pushUsage?.({ profileId: 'p1', usage: u });
}

const handoff = (): string => paneState(focusedPane()).handoff;

/** Torn down per test, so a stale listener cannot answer for the next one. */
let stopFeed: () => void = () => undefined;

beforeEach(() => {
  // Fixture run ids repeat across cases; production ids never do. See the
  // helper's own note in `store.ts`.
  resetRunStreamState();
  vi.setSystemTime(NOW);
  stopFeed();
  stopFeed = installPlanUsageFeed();
  started = [];
  interrupts = 0;
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    activeProfileId: 'p1',
    activeProviderId: 'claude',
    cwd: '/repo',
    run: null,
    permissionQueue: [],
    promptHistory: [],
    handoff: 'none',
  } as never);
  useApp.setState({
    banners: [],
    // Explicitly, not by trusting a fresh module: under `--localstorage-file`
    // the prefs blob survives between local runs and seeds the store.
    handoffThresholds: {},
    planUsageByProfile: {},
    providers: [{ id: 'claude', label: 'Claude', capabilities: NO_CAPABILITIES, models: [] }] as never,
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude' }] as never,
  });
  setAutoHandoff(false);
});

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

describe('handoffReason', () => {
  const base = {
    enabled: true,
    session: { handoff: 'none' as const, activeProfileId: 'p1' },
    now: NOW,
  };

  it('is silent below the threshold', () => {
    expect(handoffReason({ ...base, usageByProfile: { p1: usage(80) } })).toBeNull();
  });

  it('fires above it', () => {
    expect(handoffReason({ ...base, usageByProfile: { p1: usage(93) } })?.utilization).toBe(93);
  });

  it('will not stop a working agent on a stale reading', () => {
    // The recommender's own bar, for the recommender's own reason: interrupting
    // real work on a figure that might be three polls out of date is worse than
    // the exhaustion it is trying to avoid, because the exhaustion at least
    // happens for a reason.
    const old = usage(99, NOW - 60 * 60_000);
    expect(handoffReason({ ...base, usageByProfile: { p1: old } })).toBeNull();
  });

  it('says nothing once the conversation has already been through this', () => {
    for (const state of ['asked', 'done', 'dismissed'] as const) {
      expect(
        handoffReason({
          ...base,
          session: { handoff: state, activeProfileId: 'p1' },
          usageByProfile: { p1: usage(99) },
        }),
      ).toBeNull();
    }
  });

  it('reads the pane’s own account and not somebody else’s', () => {
    // Two columns, two accounts. A conversation is not stopped because the
    // profile in the next column is nearly spent.
    expect(handoffReason({ ...base, usageByProfile: { p2: usage(99) } })).toBeNull();
  });

  it('does nothing at all while the feature is off', () => {
    expect(
      handoffReason({ ...base, enabled: false, usageByProfile: { p1: usage(99) } }),
    ).toBeNull();
  });

  it('holds the reading to the thresholds it is given, not the shipped ones', () => {
    const lowered = handoffThresholdsWith({ five_hour: 70 });
    expect(handoffReason({ ...base, usageByProfile: { p1: usage(75) } })).toBeNull();
    expect(
      handoffReason({ ...base, usageByProfile: { p1: usage(75) }, thresholds: lowered })
        ?.threshold.id,
    ).toBe('five_hour');
  });
});

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

describe('the prompt', () => {
  it('names the file, the reason and the number', () => {
    const text = handoffPrompt(
      {
        threshold: { id: 'five_hour', label: '5-hour', at: 90, match: { kind: 'window', id: 'five_hour' } },
        window: { id: 'five_hour', label: '5 hours', utilization: 93, resetsAt: null },
        utilization: 93,
      },
      '2026-08-19T1407',
    );

    expect(text).toContain('5-hour limit is at 93%');
    expect(text).toContain('.artemis/handoff-2026-08-19T1407.md');
    // The instruction that stops the handoff from becoming another turn of work.
    expect(text).toContain('do not start the next piece of work');
  });

  it('stamps a filename nothing has to be escaped in', () => {
    // A colon is legal on macOS and not on Windows, and the document travels
    // with the repository.
    const stamp = handoffStamp(NOW);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{4}$/);
  });
});

/* -------------------------------------------------------------------------- */
/* What actually happens                                                      */
/* -------------------------------------------------------------------------- */

describe('when an account crosses its threshold', () => {
  it('does nothing while the feature is off', async () => {
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('none'));
    expect(started).toEqual([]);
  });

  it('asks for the document, once', async () => {
    setAutoHandoff(true);
    reading(usage(99));

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
    expect(handoff()).toBe('asked');

    // The latch. A second reading — the poll ticks every thirty seconds — must
    // not start a second handoff.
    reading(usage(99));
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('asked'));
    expect(started).toHaveLength(1);
  });

  it('interrupts a run that is still going, and waits for it to be over', async () => {
    setAutoHandoff(true);
    setPaneState(focusedPane(), {
      run: { runId: 'r1', status: 'running', profileId: 'p1', cwd: '/repo', capabilities: NO_CAPABILITIES, startedAt: 1 },
    } as never);
    reading(usage(99));

    await vi.waitFor(() => expect(interrupts).toBe(1));

    // Nothing yet, and this is the assertion that matters. `interruptRun`
    // returns when main *accepts* the interrupt; the pane is live until the
    // `run.end` that follows. Asking in that gap would take the steer path and
    // fold the request into the turn being abandoned — no document, no stop.
    expect(started).toEqual([]);

    handleAgentEvent({ type: 'run.end', runId: 'r1', seq: 1, ts: 0, reason: 'interrupted' } as never);

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
  });

  it('gives up rather than blocking when the run will not stop', async () => {
    // Bounded on purpose, and the *outcome* of the bound is the point. A
    // provider that ignores the interrupt leaves nowhere to put the request, so
    // no document is written — and blocking the conversation over a handover
    // that does not exist would punish the user for the provider's behaviour.
    // One attempt, one explanation, then out of the way.
    vi.useFakeTimers();
    try {
      setAutoHandoff(true);
      setPaneState(focusedPane(), {
        run: { runId: 'r1', status: 'running', profileId: 'p1', cwd: '/repo', capabilities: NO_CAPABILITIES, startedAt: 1 },
      } as never);
      reading(usage(99));

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(11_000);

      expect(interrupts).toBe(1);
      expect(started).toEqual([]);
      // Not `done`, which would refuse the next prompt.
      expect(handoff()).toBe('dismissed');
    } finally {
      vi.useRealTimers();
    }

    // And the composer still works once the stuck run finally does end, which
    // is the property that matters: nothing was blocked.
    handleAgentEvent({ type: 'run.end', runId: 'r1', seq: 1, ts: 0, reason: 'completed' } as never);
    expect(handoff()).toBe('dismissed');
    expect(await submitPrompt('carry on')).toBe(true);
  });

  it('turning the setting on judges the readings already in hand', async () => {
    // Someone who switches this on while sitting at 96% meant it to apply to
    // the account they are looking at, not to the one after the next poll.
    reading(usage(96));
    expect(started).toEqual([]);

    setAutoHandoff(true);
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });
});

describe('once the document is written', () => {
  async function handOver(): Promise<void> {
    setAutoHandoff(true);
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('asked'));
    // The handoff turn ends, which is what makes the document exist.
    handleAgentEvent({
      type: 'run.end',
      runId: paneState(focusedPane()).run?.runId,
      seq: 1,
      ts: 0,
      reason: 'completed',
    } as never);
  }

  it('stops the conversation rather than letting it spend the runway', async () => {
    await handOver();
    expect(handoff()).toBe('done');

    // False: nothing reached the transcript, so the composer keeps the prompt
    // and one dismissal is enough to send it.
    expect(await submitPrompt('carry on')).toBe(false);
    expect(started).toHaveLength(1);
    expect(useApp.getState().banners.map((b) => b.message)).toContain(
      'This conversation has been handed over',
    );
  });

  it('lets the user overrule it, and does not ask again', async () => {
    await handOver();
    dismissHandoff();

    expect(await submitPrompt('carry on anyway')).toBe(true);
    expect(started).toHaveLength(2);

    // And the door stays open. A safeguard that re-arms after being told no is
    // an obstacle rather than a safeguard.
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('dismissed'));
    expect(started).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Where the thresholds are set                                               */
/* -------------------------------------------------------------------------- */

describe('the threshold sliders', () => {
  const overrides = (): Readonly<Record<string, number>> => useApp.getState().handoffThresholds;

  it('moves where the feed hands over', async () => {
    setAutoHandoff(true);
    setHandoffThreshold('five_hour', 60);

    // Under the moved threshold: still nothing to say.
    reading(usage(55));
    await vi.waitFor(() => expect(handoff()).toBe('none'));
    expect(started).toEqual([]);

    // Over it — far under the shipped 90 — and the handover fires, naming the
    // number it actually judged by.
    reading(usage(65));
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('65%');
  });

  it('dragging the slider under the needle judges the readings already in hand', async () => {
    // The same courtesy `setAutoHandoff(true)` extends, for the same reason:
    // someone lowering the threshold below where the account already sits
    // meant it to apply to that account, not to the one after the next poll.
    setAutoHandoff(true);
    reading(usage(80));
    await vi.waitFor(() => expect(handoff()).toBe('none'));

    setHandoffThreshold('five_hour', 75);
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });

  it('clamps what it stores, so a wild value cannot disable the rule', () => {
    setHandoffThreshold('five_hour', 400);
    expect(overrides()).toEqual({ five_hour: 100 });
  });

  it('parked on the default, the override is removed rather than pinned', () => {
    // The rule goes back to *following* the default: an installation that
    // returns a slider to 90 should pick up a later release's judgement, not
    // freeze the number that happened to ship today.
    setHandoffThreshold('five_hour', 60);
    expect(overrides()).toEqual({ five_hour: 60 });

    setHandoffThreshold('five_hour', 90);
    expect(overrides()).toEqual({});
  });

  it('drops an id that names no rule', () => {
    setHandoffThreshold('a_rule_that_never_was', 60);
    expect(overrides()).toEqual({});
  });

  it('persists the move on its own, so it survives a relaunch', () => {
    // The blob is removed first: every other setter also saves the whole
    // state, and without this a setter that forgot to persist would hide
    // behind whichever save ran before it.
    globalThis.localStorage.removeItem('artemis.prefs.v1');

    setHandoffThreshold('five_hour', 60);

    const blob = JSON.parse(globalThis.localStorage.getItem('artemis.prefs.v1') ?? '{}') as {
      handoffThresholds?: Record<string, number>;
    };
    expect(blob.handoffThresholds).toEqual({ five_hour: 60 });
  });
});
