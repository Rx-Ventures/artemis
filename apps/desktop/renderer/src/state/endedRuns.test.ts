/**
 * @vitest-environment jsdom
 *
 * A run that has ended stays ended.
 *
 * Two ways a finished conversation used to come back to life, both through the
 * event stream rather than through anything the user did:
 *
 *  - **A permission request straggling in after `run.end`.** The handler set
 *    `awaiting_permission` unconditionally, so a re-ordered transport — or a
 *    replay that happened to end on the asking — flipped an ended run back to
 *    live, locking the composer on a wait nothing could ever answer.
 *  - **The `run.end` itself being dropped in transit.** The transcript notes a
 *    `seq` gap and carries on, which is right for text and fatal for the one
 *    event nothing else ever repeats: a pane that never hears the end stays
 *    live forever — Stop in the composer, the session feed pinned to its fast
 *    poll. The store now answers a detected drop by asking the registry whether
 *    the run still exists, and settles the pane locally when it does not.
 *
 * Same caveat as `continuationRuns.test.ts`: `renderer/tsconfig.json` excludes
 * test files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { focusedPane, handleAgentEvent, isLive, useApp } from './store';
import { paneState, setPaneState } from './pane';

/* -------------------------------------------------------------------------- */
/* A bridge whose run registry the tests control                              */
/* -------------------------------------------------------------------------- */

/*
 * One mutable stub installed once, because `resolveBridge` memoises its binding
 * on the first call — the same constraint every state test in this directory is
 * written around.
 */

/** What the main process claims is still running. */
let mainProcessRuns: readonly unknown[] = [];
/** How many times the drop reconcile actually asked. */
let listCalls = 0;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => {
      listCalls += 1;
      return { ok: true, value: { runs: mainProcessRuns } };
    },
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
  },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const running = (runId: string) =>
  ({
    runId,
    status: 'running',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/repo',
    capabilities: NO_CAPABILITIES,
    startedAt: 1,
    sessionId: 'sess-1',
  }) as never;

const said = (runId: string, seq: number) =>
  ({
    type: 'text.complete',
    runId,
    seq,
    ts: 0,
    role: 'assistant',
    messageId: `m-${String(seq)}`,
    blockIndex: 0,
    text: `words at ${String(seq)}`,
  }) as never;

const ended = (runId: string, seq: number) =>
  ({ type: 'run.end', runId, seq, ts: 0, reason: 'completed', sessionId: 'sess-1' }) as never;

const asked = (runId: string, seq: number) =>
  ({
    type: 'permission.request',
    runId,
    seq,
    ts: 0,
    requestId: 'perm-1',
    request: {
      id: 'perm-1',
      runId,
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      toolCallId: 'call-1',
      requestedAt: 1,
    },
  }) as never;

/** Let the reconcile's `runs.list` round-trip land. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 8));

beforeEach(() => {
  globalThis.localStorage?.clear();
  mainProcessRuns = [];
  listCalls = 0;
  useApp.setState({ background: [], runningSessions: [], banners: [] });
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    run: running('run-1'),
    resumeSessionId: null,
    permissionQueue: [],
    activeProfileId: 'p1',
    cwd: '/repo',
  } as never);
});

/* -------------------------------------------------------------------------- */

describe('a permission request arriving after run.end', () => {
  it('does not flip the run back to live', () => {
    const pane = focusedPane();

    handleAgentEvent(ended('run-1', 0));
    expect(paneState(pane).run?.status).toBe('ended');

    handleAgentEvent(asked('run-1', 1));

    // The same guard `session.started` applies: `ended` survives. A run the
    // registry has retired cannot be waiting on anyone, and a pane resurrected
    // here would lock its composer on an answer with nowhere to go.
    expect(paneState(pane).run?.status).toBe('ended');
    expect(isLive(paneState(pane))).toBe(false);
  });

  it('still parks a request on a run that is genuinely live', () => {
    const pane = focusedPane();

    handleAgentEvent(asked('run-1', 0));

    // The guard must not eat the ordinary case: a live run parked on a request
    // is exactly what `awaiting_permission` is for.
    expect(paneState(pane).run?.status).toBe('awaiting_permission');
  });
});

/* -------------------------------------------------------------------------- */

describe('a run whose run.end was dropped in transit', () => {
  it('is settled once the registry no longer holds the run', async () => {
    const pane = focusedPane();
    // The registry has already retired it — the end happened, this window just
    // never heard.
    mainProcessRuns = [];

    handleAgentEvent(said('run-1', 0));
    // seq 1-4 never arrive; among them was `run.end`.
    handleAgentEvent(said('run-1', 5));
    await settled();

    // Ended locally, through the same path a failed start takes — which is what
    // unlocks the composer and lets the session feed drop to its idle poll.
    expect(paneState(pane).run?.status).toBe('ended');
    expect(isLive(paneState(pane))).toBe(false);
  });

  it('leaves a run alone while the registry still holds it live', async () => {
    const pane = focusedPane();
    mainProcessRuns = [running('run-1')];

    handleAgentEvent(said('run-1', 0));
    handleAgentEvent(said('run-1', 5));
    await settled();

    // The gap swallowed something, but not the end: declaring this run dead
    // would strand an agent that is still working.
    expect(paneState(pane).run?.status).toBe('running');
  });

  it('asks the registry once per drop burst', async () => {
    mainProcessRuns = [running('run-1')];

    // Three gaps in one synchronous burst. Every one asks the same question
    // about the same run, so only the first is allowed to place the call.
    handleAgentEvent(said('run-1', 0));
    handleAgentEvent(said('run-1', 3));
    handleAgentEvent(said('run-1', 6));
    handleAgentEvent(said('run-1', 9));
    await settled();

    expect(listCalls).toBe(1);
  });
});
