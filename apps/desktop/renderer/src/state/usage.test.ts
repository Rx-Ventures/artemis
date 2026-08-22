/**
 * The context readout needs two numbers that arrive at different times:
 * `contextTokens` on every streaming `delta`, and `contextWindow` only on the
 * `final` snapshot at run end. Both of the bugs these tests cover were the same
 * shape — one of the pair going missing, leaving the readout permanently blank.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type { AgentEvent, RunId, UsageSnapshot } from '@rx-artemis/protocol';

import {
  focusedPane,
  handleAgentEvent,
  resetRunStreamState,
  type RunState,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

/*
 * The run belongs to a column; the learned window belongs to the window.
 *
 * That division is the thing worth asserting here, and it is not incidental: a
 * context window is a fact about a *model*, so the right column benefits from
 * what the left one learned, while the run that reported it is one column's
 * alone. See the `usage` case in `handleAgentEvent`.
 */
const pane = () => focusedPane();
const session = () => paneState(pane());
const setSession = (patch) => setPaneState(pane(), patch);

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
  // Fixture run ids repeat across cases; production ids never do. See the
  // helper's own note in `store.ts`.
  resetRunStreamState();
    useApp.setState({ contextWindows: {} });
    setSession({ run: { ...BASE } });
  });

  it('keeps contextTokens when the final snapshot replaces the deltas', () => {
    // `final` is authoritative for totals and is the only snapshot carrying
    // contextWindow — but it has no contextTokens. Replacing wholesale left the
    // pair never present at once, so the row rendered "no run yet" forever.
    handleAgentEvent(usageEvent({ scope: 'delta', tokens: TOKENS, contextTokens: 84_000 }, 0));
    handleAgentEvent(usageEvent({ scope: 'final', tokens: TOKENS, contextWindow: 200_000 }, 1));

    const usage = session().run?.usage;
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
    setSession({ run: { ...BASE, model: 'claude-sonnet-5' } });
    handleAgentEvent(usageEvent({ scope: 'final', tokens: TOKENS, contextWindow: 1_000_000 }, 1));

    expect(useApp.getState().contextWindows).toEqual({
      'claude-opus-5': 200_000,
      'claude-sonnet-5': 1_000_000,
    });
  });
});
