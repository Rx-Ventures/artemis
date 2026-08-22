/**
 * @vitest-environment jsdom
 *
 * A finished run re-reads the account it just spent.
 *
 * The poll walks every profile serially — one CLI at a time, deliberately — so
 * with eight accounts any given one is re-read about every six minutes. That is
 * the blind window, and a run ending is the worst moment to be inside it.
 *
 * While the run was live, `planLoad`'s reservation covered it: the ranking knew
 * work was committed to that account even though the reading did not show it.
 * The moment it ends that cover is correctly withdrawn — and the account falls
 * back to being ranked on a reading taken *before any of the work happened*. So
 * it reads emptiest exactly when it has just been drained, and wins the next
 * session. That is the residual half of #146.
 *
 * What is asserted here is the trigger and its economy: the right account, once
 * per burst, after a settle, and never on the wrong event.
 *
 * Same caveat as the other state tests: `renderer/tsconfig.json` excludes test
 * files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  focusedPane,
  handleAgentEvent,
  resetPlanUsageSoon,
  resetRunStreamState,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

/** Every profile the app asked to have re-read, in order. */
let refreshed: string[] = [];
/** What the stub answers with. `null` models a read that learned nothing. */
let refreshAnswer: unknown = {
  available: true,
  subscriptionType: 'max',
  fetchedAt: 2_000,
  windows: [{ id: 'five_hour', label: '5 hours', utilization: 42, resetsAt: null }],
};

/*
 * One mutable stub installed once, because `resolveBridge` memoises its binding
 * on the first call — the constraint every state test in this directory is
 * written around.
 */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: { list: async () => ({ ok: true, value: { runs: [] } }), onEvent: () => () => undefined },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
  usagePlan: {
    refresh: async ({ profileId }: { profileId: string }) => {
      refreshed.push(profileId);
      return { ok: true, value: { usage: refreshAnswer } };
    },
    cached: async () => ({ ok: true, value: { usage: null } }),
    onChange: () => () => undefined,
  },
};

const pane = () => focusedPane();

/** A live run on `profileId`, as the pane holds one. */
const live = (runId: string, profileId: string) =>
  ({
    runId,
    status: 'running',
    providerId: 'claude',
    profileId,
    cwd: '/a',
    capabilities: NO_CAPABILITIES,
    startedAt: 1,
    sessionId: 'sess-1',
  }) as never;

const ended = (runId: string) =>
  ({ type: 'run.end', runId, seq: 1, ts: 0, reason: 'completed' }) as never;

beforeEach(() => {
  // Fixture run ids repeat across cases; production ids never do. See the
  // helper's own note in `store.ts`.
  resetRunStreamState();
  vi.useFakeTimers();
  refreshed = [];
  refreshAnswer = {
    available: true,
    subscriptionType: 'max',
    fetchedAt: 2_000,
    windows: [{ id: 'five_hour', label: '5 hours', utilization: 42, resetsAt: null }],
  };
  resetPlanUsageSoon();
  useApp.setState({ planUsageByProfile: {}, banners: [] });
  setPaneState(pane(), { activeProfileId: 'p1', run: null });
  pane().transcript.reset();
});

afterEach(() => {
  resetPlanUsageSoon();
  vi.useRealTimers();
});

/** Let the settle timer fire and the async read that follows it resolve. */
async function settle(): Promise<void> {
  await vi.runAllTimersAsync();
}

describe('when a run ends', () => {
  it('re-reads the account it was billing', async () => {
    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent(ended('r1'));

    await settle();

    expect(refreshed).toEqual(['p1']);
  });

  it('waits, because the provider is still accounting for the last turn', async () => {
    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent(ended('r1'));

    // Nothing yet: a read taken now returns the figure from before the work,
    // which is the staleness this exists to remove — bought at the price of a
    // subprocess. See `PLAN_USAGE_SETTLE_MS`.
    expect(refreshed).toEqual([]);

    await settle();
    expect(refreshed).toEqual(['p1']);
  });

  it('writes what came back into the map the ranking reads', async () => {
    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent(ended('r1'));
    await settle();

    expect(useApp.getState().planUsageByProfile['p1']?.windows[0]?.utilization).toBe(42);
  });

  it('bills the account the run started on, not the one the pane moved to', async () => {
    // A run belongs to the account it started on for its whole life. Reading
    // the pane's current selection would re-read an account that spent nothing
    // and leave the one that did stale — the bug, with an extra subprocess.
    setPaneState(pane(), { run: live('r1', 'p1'), activeProfileId: 'p2' });
    handleAgentEvent(ended('r1'));

    await settle();

    expect(refreshed).toEqual(['p1']);
  });

  it('reads once for a burst on the same account', async () => {
    // A split view, or an ultracode fan-out settling: several runs on one
    // account finish within a second. Each would otherwise spawn its own CLI to
    // ask the same question.
    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent(ended('r1'));
    setPaneState(pane(), { run: live('r2', 'p1') });
    handleAgentEvent(ended('r2'));
    setPaneState(pane(), { run: live('r3', 'p1') });
    handleAgentEvent(ended('r3'));

    await settle();

    expect(refreshed).toEqual(['p1']);
  });

  it('still reads every account that actually finished something', async () => {
    // The other half of the de-duplication: collapsing a burst must not collapse
    // two *different* accounts into one read.
    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent(ended('r1'));
    setPaneState(pane(), { run: live('r2', 'p2') });
    handleAgentEvent(ended('r2'));

    await settle();

    expect([...refreshed].sort()).toEqual(['p1', 'p2']);
  });

  it('leaves the previous reading alone when the read learns nothing', async () => {
    // `null` is "nothing was learned", not "nothing is used". Writing it in
    // would replace a good reading with an absence and drop the account out of
    // the ranking altogether.
    useApp.setState({
      planUsageByProfile: {
        p1: {
          available: true,
          fetchedAt: 1,
          windows: [{ id: 'five_hour', label: '5 hours', utilization: 7, resetsAt: null }],
        },
      } as never,
    });
    refreshAnswer = null;

    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent(ended('r1'));
    await settle();

    expect(refreshed).toEqual(['p1']);
    expect(useApp.getState().planUsageByProfile['p1']?.windows[0]?.utilization).toBe(7);
  });

  it('says nothing to the user when the read fails', async () => {
    // A background correction to a number the poll will fix on its own within
    // minutes. A banner for it would be an error about something nobody asked
    // for.
    (globalThis.window as unknown as { artemis: { usagePlan: Record<string, unknown> } }).artemis.usagePlan.refresh =
      async () => ({ ok: false, error: { code: 'internal', message: 'no' } });

    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent(ended('r1'));
    await settle();

    expect(useApp.getState().banners).toEqual([]);

    // Put the recording stub back for whatever runs next.
    (globalThis.window as unknown as { artemis: { usagePlan: Record<string, unknown> } }).artemis.usagePlan.refresh =
      async ({ profileId }: { profileId: string }) => {
        refreshed.push(profileId);
        return { ok: true, value: { usage: refreshAnswer } };
      };
  });
});

describe('when nothing finished', () => {
  it('does not read on an ordinary event', async () => {
    setPaneState(pane(), { run: live('r1', 'p1') });
    handleAgentEvent({
      type: 'text.complete',
      runId: 'r1',
      seq: 1,
      ts: 0,
      role: 'assistant',
      messageId: 'm1',
      blockIndex: 0,
      text: 'still working',
    } as never);

    await settle();

    expect(refreshed).toEqual([]);
  });

  it('does not read for a run no pane is holding', async () => {
    // An event for a conversation this window closed. There is no run to read a
    // profile off, and guessing one would re-read an unrelated account.
    setPaneState(pane(), { run: null });
    handleAgentEvent(ended('r-unknown'));

    await settle();

    expect(refreshed).toEqual([]);
  });
});
