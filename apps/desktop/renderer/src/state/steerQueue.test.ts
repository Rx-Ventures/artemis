/**
 * @vitest-environment jsdom
 *
 * The queued-steer set: what the composer's strip counts, and what the control
 * row under each of those messages reads.
 *
 * A steer accepted into a live run is not necessarily read by it — the
 * provider folds it in at a tool boundary or runs it as the next turn. The
 * pane tracks which ones are outstanding so both surfaces can say so and offer
 * the interrupt. What these pin is the set's lifecycle: it grows on the send
 * the provider queued, an entry leaves when the provider is *seen to read that
 * message* (`message.delivered`), and whatever is left dies with the turn that
 * consumed it (the continuation claim) — which also starts its own prompt
 * numbering from zero, so a steer into *it* claims `:prompt:1`, the identity
 * the registry will retain it under rather than the previous run's arithmetic.
 *
 * Identities and not a tally, because the tally was the bug. Nothing could
 * take one off a count: the fold is invisible from outside the provider
 * process, so "1 message queued" stood over a message the agent was plainly
 * acting on until the whole run ended.
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

/** The adapter's word that the provider has taken a message up. */
const delivered = (seq: number, messageId: string): unknown => ({
  type: 'message.delivered',
  runId: 'run-live',
  seq,
  ts: 200 + seq,
  messageId,
});

describe('a steer the provider queued', () => {
  it('joins the outstanding set under the identity it claimed', async () => {
    // `promptsSent: 1` on the seed, so this steer claims the second slot — the
    // same name `#recordPrompt` will file it under, and the same name a
    // delivery will arrive quoting.
    expect(await submitPrompt('also check the tests')).toBe(true);
    expect(sendResults).toEqual([{ runId: 'run-live', text: 'also check the tests' }]);
    expect(run()?.queuedSteers).toEqual(['run-live:prompt:2']);

    expect(await submitPrompt('and the docs')).toBe(true);
    expect(run()?.queuedSteers).toEqual(['run-live:prompt:2', 'run-live:prompt:3']);
  });

  it('leaves the set when the provider is seen to read it', async () => {
    await submitPrompt('also check the tests');
    await submitPrompt('and the docs');

    // The fold: the CLI took the first message at a tool boundary and said so.
    handleAgentEvent(delivered(7, 'run-live:prompt:2') as never);

    // Only that one. The strip counts one message still waiting, and the row
    // for the message that was read has stopped claiming it is queued —
    // which is the whole of the bug this replaced.
    expect(run()?.queuedSteers).toEqual(['run-live:prompt:3']);

    handleAgentEvent(delivered(8, 'run-live:prompt:3') as never);
    expect(run()?.queuedSteers).toEqual([]);
  });

  it('ignores a delivery naming a message it is not waiting on', async () => {
    await submitPrompt('also check the tests');
    // The opening prompt was never queued — it opened the turn. A delivery for
    // it must not take the count down with it.
    handleAgentEvent(delivered(7, 'run-live:prompt:1') as never);

    expect(run()?.queuedSteers).toEqual(['run-live:prompt:2']);
  });

  it('keeps a steer the interrupt receipt says is still queued', async () => {
    /*
     * `still_queued` names what an interrupt spared, in the ids the adapter
     * translated back for this window. Those messages have not been read, so
     * no delivery arrives for them and they stay — the strip goes on offering
     * to interrupt for a message that really is still waiting.
     */
    await submitPrompt('also check the tests');
    await submitPrompt('and the docs');
    handleAgentEvent(delivered(7, 'run-live:prompt:2') as never);

    expect(run()?.queuedSteers).toEqual(['run-live:prompt:3']);
  });

  it('is consumed by the continuation turn, which restarts the prompt numbering', () => {
    setPaneState(pane(), (s) => ({
      run: s.run
        ? {
            ...s.run,
            queuedSteers: ['run-live:prompt:2', 'run-live:prompt:3'],
            status: 'ended' as const,
          }
        : s.run,
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
    expect(run()?.queuedSteers).toEqual([]);
    // And its numbering is its own: the registry recorded no opening prompt
    // for a continuation, so the first steer into it claims `:prompt:1`.
    expect(run()?.promptsSent).toBe(0);
  });
});
