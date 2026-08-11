/**
 * The context readout needs two numbers that arrive at different times:
 * `contextTokens` on every streaming `delta`, and `contextWindow` only on the
 * `final` snapshot at run end. Both of the bugs these tests cover were the same
 * shape — one of the pair going missing, leaving the readout permanently blank.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type { AgentEvent, RunId, UsageSnapshot } from '@rx-artemis/protocol';

import { handleAgentEvent, useApp, type RunState } from './store';

const RUN = 'run-1' as RunId;

const BASE: RunState = {
  runId: RUN,
  status: 'running',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/w',
  capabilities: NO_CAPABILITIES,
  startedAt: 0,
  model: 'claude-opus-5',
};

function usageEvent(usage: UsageSnapshot, seq: number): AgentEvent {
  return { type: 'usage', runId: RUN, seq, ts: seq, usage } as AgentEvent;
}

const TOKENS = { inputTokens: 10, outputTokens: 5 };

describe('usage / context readout', () => {
  beforeEach(() => {
    useApp.setState({ run: { ...BASE }, contextWindows: {} });
  });

  it('keeps contextTokens when the final snapshot replaces the deltas', () => {
    // `final` is authoritative for totals and is the only snapshot carrying
    // contextWindow — but it has no contextTokens. Replacing wholesale left the
    // pair never present at once, so the row rendered "no run yet" forever.
    handleAgentEvent(usageEvent({ scope: 'delta', tokens: TOKENS, contextTokens: 84_000 }, 0));
    handleAgentEvent(usageEvent({ scope: 'final', tokens: TOKENS, contextWindow: 200_000 }, 1));

    const usage = useApp.getState().run?.usage;
    expect(usage?.contextTokens).toBe(84_000);
    expect(usage?.contextWindow).toBe(200_000);
  });

  it('remembers the window per model so it survives the next run', () => {
    // `run` resets every turn, and the window is only ever learned at run end.
    // Without this the readout could never render mid-stream.
    handleAgentEvent(usageEvent({ scope: 'final', tokens: TOKENS, contextWindow: 200_000 }, 0));

    expect(useApp.getState().contextWindows['claude-opus-5']).toBe(200_000);
  });

  it('keeps windows separate per model', () => {
    // The window belongs to the model, not the session: after a switch, showing
    // the previous model's window would be a confidently wrong number.
    handleAgentEvent(usageEvent({ scope: 'final', tokens: TOKENS, contextWindow: 200_000 }, 0));
    useApp.setState({ run: { ...BASE, model: 'claude-sonnet-5' } });
    handleAgentEvent(usageEvent({ scope: 'final', tokens: TOKENS, contextWindow: 1_000_000 }, 1));

    expect(useApp.getState().contextWindows).toEqual({
      'claude-opus-5': 200_000,
      'claude-sonnet-5': 1_000_000,
    });
  });
});
