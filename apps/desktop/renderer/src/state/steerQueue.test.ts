/**
 * @vitest-environment jsdom
 *
 * The queued-steer count: what the composer's strip renders.
 *
 * A steer accepted into a live run is not necessarily read by it — the
 * provider folds it in at a tool boundary or runs it as the next turn. The
 * pane tracks how many are outstanding so the strip can say so and offer the
 * interrupt. What these pin is the count's lifecycle: it rises on the send the
 * provider queued, it dies with the turn that consumed it (the continuation
 * claim), and the continuation starts its own prompt numbering from zero so a
 * steer into *it* claims `:prompt:1` — the identity the registry will retain
 * it under, not the previous run's arithmetic.
 *
 * Same caveat as the neighbours: `renderer/tsconfig.json` excludes test files,
 * so the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { focusedPane, handleAgentEvent, resetRunStreamState, submitPrompt } from './store';
import { paneState, setPaneState } from './pane';
import { seedApp } from './testkit';

const STEERABLE = { ...NO_CAPABILITIES, midRunSteering: true, resumeSession: true };

/** What the adapter answers for a mid-turn send: accepted, and queued. */
let sendResults: { runId: string; text: string }[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    send: async ({ runId, text }: { runId: string; text: string }) => {
      sendResults.push({ runId, text });
      return { ok: true, value: { runId, deliveredImmediately: false } };
    },
    onEvent: () => () => undefined,
  },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

const pane = () => focusedPane();
const run = () => paneState(pane()).run;

beforeEach(() => {
  resetRunStreamState();
  sendResults = [];
  pane().transcript.reset();
  seedApp({
    providers: [
      { id: 'claude', label: 'Claude', capabilities: STEERABLE, models: [] },
    ] as never,
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude' }] as never,
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/repo',
    permissionQueue: [],
    promptHistory: [],
    resumeSessionId: null,
    run: {
      runId: 'run-live',
      status: 'running',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/repo',
      capabilities: STEERABLE,
      startedAt: 1,
      sessionId: 'sess-1',
      promptsSent: 1,
    } as never,
  });
});

describe('a steer the provider queued', () => {
  it('raises the outstanding count on the run it went into', async () => {
    expect(await submitPrompt('also check the tests')).toBe(true);
    expect(sendResults).toEqual([{ runId: 'run-live', text: 'also check the tests' }]);
    expect(run()?.steersQueued).toBe(1);

    expect(await submitPrompt('and the docs')).toBe(true);
    expect(run()?.steersQueued).toBe(2);
  });

  it('is consumed by the continuation turn, which restarts the prompt numbering', () => {
    setPaneState(pane(), (s) => ({
      run: s.run ? { ...s.run, steersQueued: 2, status: 'ended' as const } : s.run,
    }));

    // The queued turn opens — the same conversation, a new run. The claim is
    // `claimContinuation`'s: it fires on the session.started of a run this
    // window has never held.
    handleAgentEvent({
      type: 'session.started',
      runId: 'run-continuation',
      seq: 0,
      ts: 2,
      sessionId: 'sess-1',
    } as never);

    expect(run()?.runId).toBe('run-continuation');
    // The steers became this turn — nothing is waiting any more.
    expect(run()?.steersQueued).toBe(0);
    // And its numbering is its own: the registry recorded no opening prompt
    // for a continuation, so the first steer into it claims `:prompt:1`.
    expect(run()?.promptsSent).toBe(0);
  });
});
