/**
 * @vitest-environment jsdom
 *
 * Which conversations are waiting on you, seen from outside them.
 *
 * A pane parked on a permission is obvious while you are looking at it — the
 * foot of its transcript says so in as many words. The problem this projection
 * exists for is the other case: that pane is in the second column, or behind
 * the one you are reading, and the agent has been stopped for four minutes
 * waiting for an answer nobody knows it wants.
 *
 * The fact lives in a *pane's* store and the sidebar and header live in the
 * window's, so it is copied across rather than reached for — a selector
 * spanning the two would only re-evaluate when the window changed, and a run
 * parking on a permission does not change the window. `syncRunningSessions`
 * already does this for "running"; waiting rides in the same walk.
 *
 * The ordering is the load-bearing part and is asserted here: waiting outranks
 * running, because a provider that has asked for something and is technically
 * still `running` is, to the person who has to answer it, waiting.
 *
 * Same caveat as its neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { focusedPane, useApp } from './store';
import { paneState, setPaneState } from './pane';

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: { list: async () => ({ ok: true, value: { runs: [] } }), onEvent: () => () => undefined },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

/** A run in whatever condition the test needs. */
const run = (over: Record<string, unknown>) =>
  ({
    runId: 'r1',
    status: 'running',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/repo',
    capabilities: NO_CAPABILITIES,
    startedAt: 1,
    sessionId: 'sess-1',
    ...over,
  }) as never;

const waiting = (): readonly string[] => useApp.getState().waitingSessions;
const running = (): readonly string[] => useApp.getState().runningSessions;

beforeEach(() => {
  setPaneState(focusedPane(), {
    run: null,
    permissionQueue: [],
    resumeSessionId: null,
  } as never);
});

describe('the waiting projection', () => {
  it('is empty while nothing is parked', () => {
    setPaneState(focusedPane(), { run: run({}), permissionQueue: [] } as never);
    expect(waiting()).toEqual([]);
  });

  it('names the session when the renderer is holding a request', () => {
    setPaneState(focusedPane(), {
      run: run({}),
      permissionQueue: [{ id: 'p1' }],
    } as never);
    expect(waiting()).toEqual(['sess-1']);
  });

  it('names it when the provider reports the wait itself', () => {
    // Two spellings of one condition — the provider's status and the renderer's
    // queue — and either is enough. `activityOf` treats them the same, and this
    // must not be the place they diverge.
    setPaneState(focusedPane(), {
      run: run({ status: 'awaiting_permission' }),
      permissionQueue: [],
    } as never);
    expect(waiting()).toEqual(['sess-1']);
  });

  it('outranks running, which is the whole reason there are two colours', () => {
    setPaneState(focusedPane(), {
      run: run({ status: 'running' }),
      permissionQueue: [{ id: 'p1' }],
    } as never);

    // Both are true of this pane and the sidebar draws one dot. Amber wins:
    // nothing is progressing, and the run cannot progress until it is answered.
    expect(waiting()).toContain('sess-1');
  });

  it('clears when the request is answered', () => {
    setPaneState(focusedPane(), {
      run: run({}),
      permissionQueue: [{ id: 'p1' }],
    } as never);
    expect(waiting()).toEqual(['sess-1']);

    setPaneState(focusedPane(), { permissionQueue: [] } as never);
    expect(waiting()).toEqual([]);
  });

  it('falls back to the resumable id before the run has one of its own', () => {
    // The gap before `session.started` arrives: the run is real and can already
    // be parked on a permission, but has no session id yet. Marking nothing
    // there would leave a conversation waiting behind a row that looks idle.
    setPaneState(focusedPane(), {
      run: run({ sessionId: undefined }),
      resumeSessionId: 'sess-old',
      permissionQueue: [{ id: 'p1' }],
    } as never);
    expect(waiting()).toEqual(['sess-old']);
  });

  it('says nothing about a settled conversation', () => {
    setPaneState(focusedPane(), {
      run: run({ status: 'ended' }),
      permissionQueue: [],
    } as never);
    expect(waiting()).toEqual([]);
    expect(running()).toEqual([]);
  });

  it('leaves the pane state it read untouched', () => {
    // A projection, not a mutation. This runs on every keystroke in a composer
    // — the same store holds `draft` — so it must be free of side effects on
    // the thing it is summarising.
    setPaneState(focusedPane(), {
      run: run({}),
      permissionQueue: [{ id: 'p1' }],
    } as never);
    const before = paneState(focusedPane());
    expect(waiting()).toEqual(['sess-1']);
    expect(paneState(focusedPane())).toBe(before);
  });
});
