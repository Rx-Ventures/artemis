/**
 * @vitest-environment jsdom
 *
 * The mid-run message that survives a reload.
 *
 * Reported in the user's own words: "messages sent to Claude *during* runs keep
 * disappearing on refresh". Everything needed to prevent that was already
 * built — the registry retains every accepted prompt (`#recordPrompt`), and the
 * transcript merges a replayed prompt onto the optimistic row by identity
 * (`userClaims`) — and one line undid it. The retained prompt's `seq` is
 * *borrowed*: `#recordPrompt` reuses the run's current position rather than
 * consuming a slot from the adapter's dense numbering, so a steer sent after
 * forty events is stamped `40`, exactly the number the window has already
 * drawn. `applyAgentEvent`'s duplicate gate read that as "already seen" and
 * dropped it, every time, for every steer. The opening prompt escaped only
 * because it borrows seq 0 against a gate `attachRun` has just cleared.
 *
 * What these pin is the shape of that seq, not a particular number: a borrowed
 * user prompt goes through the gate, and everything else still stops at it.
 * Ordering is pinned too, because the borrow is what buys it — the prompt
 * lands where the registry retained it, between the events it was typed
 * between, rather than at the end of the transcript.
 *
 * Same caveat as the neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { focusedPane, handleAgentEvent, resetRunStreamState } from './store';
import { setPaneState } from './pane';
import { seedApp } from './testkit';

const STEERABLE = { ...NO_CAPABILITIES, midRunSteering: true, resumeSession: true };

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: { onEvent: () => () => undefined },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

const pane = () => focusedPane();

/** What the pane draws, in order, as `kind:text` pairs. */
function rows(): string[] {
  const model = pane().transcript;
  model.flush();
  return model.getListSnapshot().flatMap((id) => {
    const item = model.getItem(id);
    if (item === undefined) return [];
    if (item.kind === 'user') return [`user:${item.text}`];
    if (item.kind === 'assistant') return [`assistant:${item.text}`];
    return [item.kind];
  });
}

/** The registry's retained prompt: `replay`, and a seq it borrowed. */
function retainedPrompt(seq: number, n: number, text: string): unknown {
  return {
    type: 'text.complete',
    runId: 'run-live',
    seq,
    ts: 10 + n,
    messageId: `run-live:prompt:${String(n)}`,
    role: 'user',
    text,
    replay: true,
  };
}

const assistantText = (seq: number, text: string): unknown => ({
  type: 'text.complete',
  runId: 'run-live',
  seq,
  ts: 100 + seq,
  messageId: `msg-${String(seq)}`,
  role: 'assistant',
  text,
});

beforeEach(() => {
  resetRunStreamState();
  pane().transcript.reset();
  seedApp({
    providers: [{ id: 'claude', label: 'Claude', capabilities: STEERABLE, models: [] }] as never,
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

describe('replaying a run into a window that lost its transcript', () => {
  it('draws the mid-run steer the registry retained', () => {
    // A ⌘R replay, in the order `eventsSince` returns it: the opening prompt
    // borrows seq 0, the turn runs, and the steer borrows the position the run
    // had reached when the user pressed Enter.
    handleAgentEvent(retainedPrompt(0, 1, 'start the refactor') as never);
    handleAgentEvent({
      type: 'session.started',
      runId: 'run-live',
      seq: 0,
      ts: 100,
      sessionId: 'sess-1',
    } as never);
    handleAgentEvent(assistantText(1, 'on it') as never);
    handleAgentEvent(retainedPrompt(1, 2, 'actually, do the tests first') as never);
    handleAgentEvent(assistantText(2, 'switching to the tests') as never);

    expect(rows()).toEqual([
      'user:start the refactor',
      'assistant:on it',
      'user:actually, do the tests first',
      'assistant:switching to the tests',
    ]);
  });

  it('keeps several steers, each where it was typed', () => {
    handleAgentEvent(retainedPrompt(0, 1, 'one') as never);
    handleAgentEvent({
      type: 'session.started',
      runId: 'run-live',
      seq: 0,
      ts: 100,
      sessionId: 'sess-1',
    } as never);
    handleAgentEvent(assistantText(1, 'a') as never);
    handleAgentEvent(retainedPrompt(1, 2, 'two') as never);
    handleAgentEvent(assistantText(2, 'b') as never);
    handleAgentEvent(retainedPrompt(2, 3, 'three') as never);

    expect(rows()).toEqual(['user:one', 'assistant:a', 'user:two', 'assistant:b', 'user:three']);
  });

  it('is idempotent: the stall sweep re-applying the same replay draws it once', () => {
    const replay = [
      retainedPrompt(0, 1, 'start the refactor'),
      {
        type: 'session.started',
        runId: 'run-live',
        seq: 0,
        ts: 100,
        sessionId: 'sess-1',
      },
      assistantText(1, 'on it'),
      retainedPrompt(1, 2, 'actually, do the tests first'),
    ];
    for (const event of replay) handleAgentEvent(event as never);
    // The sweep fetches the whole retained buffer again and applies it through
    // the same door. Identity, not the gate, is what makes this cost nothing.
    for (const event of replay) handleAgentEvent(event as never);

    expect(rows()).toEqual([
      'user:start the refactor',
      'assistant:on it',
      'user:actually, do the tests first',
    ]);
  });

  it('merges onto the optimistic row a live window already drew', () => {
    // No reset: this window watched the user type, so the row is on screen
    // under the id the registry will retain it as. The sweep's replay must
    // find it rather than draw a second copy underneath.
    const id = pane().transcript.pushUserMessage('mid-run words', undefined, 'run-live:prompt:2');
    pane().transcript.confirmUserMessage(id);
    handleAgentEvent(assistantText(4, 'working') as never);
    handleAgentEvent(retainedPrompt(4, 2, 'mid-run words') as never);

    expect(rows()).toEqual(['user:mid-run words', 'assistant:working']);
  });

  it('draws no second row when the provider reports reading the steer', () => {
    /*
     * The delivery report and the retained prompt name the same message, and
     * only one of them is a thing that was said. `message.delivered` is news
     * about *timing* — it is what takes the message out of the pane's queued
     * set — and a transcript that grew a row for it would be a record of a
     * message being read, sitting under the record of it being sent, saying
     * the same sentence twice.
     *
     * Worth pinning here rather than only in the store: this file is about the
     * one door every event comes through, and the prompt is the event that
     * door has always been most likely to duplicate.
     */
    const id = pane().transcript.pushUserMessage('mid-run words', undefined, 'run-live:prompt:2');
    pane().transcript.confirmUserMessage(id);
    handleAgentEvent(assistantText(4, 'working') as never);
    handleAgentEvent({
      type: 'message.delivered',
      runId: 'run-live',
      seq: 5,
      ts: 500,
      messageId: 'run-live:prompt:2',
    } as never);
    // And the reload's replay of the same prompt, after it: still one row.
    handleAgentEvent(retainedPrompt(5, 2, 'mid-run words') as never);

    expect(rows()).toEqual(['user:mid-run words', 'assistant:working']);
  });

  it('still stops an ordinary event the window has already drawn', () => {
    // The gate's own job, unchanged: only the borrowed-seq prompt is exempt.
    handleAgentEvent(assistantText(1, 'first') as never);
    handleAgentEvent(assistantText(2, 'second') as never);
    handleAgentEvent(assistantText(1, 'first') as never);

    expect(rows()).toEqual(['assistant:first', 'assistant:second']);
  });

  it('does not let a replayed prompt spend the gate slot its seq borrowed', () => {
    // The reason `recordApplied` skips these: a prompt at seq 0 arrives ahead
    // of `session.started` at seq 0, and a gate that remembered the prompt
    // would swallow the run's own opening.
    setPaneState(pane(), (s) => ({ run: s.run ? { ...s.run, sessionId: undefined } : s.run }));
    handleAgentEvent(retainedPrompt(0, 1, 'opening') as never);
    handleAgentEvent({
      type: 'session.started',
      runId: 'run-live',
      seq: 0,
      ts: 100,
      sessionId: 'sess-9',
    } as never);

    expect(rows()).toEqual(['user:opening']);
  });
});
