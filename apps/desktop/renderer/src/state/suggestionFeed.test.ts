/**
 * @vitest-environment jsdom
 *
 * Predicted next prompts, from the push channel to the composer's chip.
 *
 * The feature's whole risk is staleness — a prediction is generated after a
 * turn ends and arrives seconds later, into a window where anything may have
 * happened since. What these pin is the two-part answer: the feed's write gate
 * (only the pane still showing that ended run takes the write at all) and
 * `offeredSuggestion`'s read gate (the pair stops being offered the moment the
 * run on screen is not the one it followed). Accept and dismiss are one-shot.
 *
 * Same caveat as the neighbouring files: `renderer/tsconfig.json` excludes
 * test files, so the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { RunSuggestion } from '@rx-artemis/protocol';

import {
  acceptSuggestion,
  dismissSuggestion,
  focusedPane,
  installSuggestionFeed,
  offeredSuggestion,
} from './store';
import { setPaneState, type Pane, type RunState } from './pane';
import { ALL_CAPABILITIES, seedApp } from './testkit';

const pane = (): Pane => focusedPane();

/** The listener `installSuggestionFeed` registered, captured by the fake bridge. */
let feed: ((suggestion: RunSuggestion) => void) | null = null;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    onSuggestion: (listener: (suggestion: RunSuggestion) => void) => {
      feed = listener;
      return () => {
        feed = null;
      };
    },
  },
};

function endedRun(runId: string): RunState {
  return {
    runId,
    status: 'ended',
    capabilities: ALL_CAPABILITIES,
    startedAt: 1,
  } as unknown as RunState;
}

function push(runId: string, text: string): void {
  if (feed === null) throw new Error('the feed was never installed');
  feed({ kind: 'run-suggestion', runId, suggestion: text } as RunSuggestion);
}

const state = () => pane().store.getState();

beforeEach(() => {
  installSuggestionFeed();
  seedApp({ run: null, suggestion: null, draft: '' });
});

describe('the write gate', () => {
  it('routes a prediction to the pane whose ended run it followed', () => {
    setPaneState(pane(), { run: endedRun('run-1') });
    push('run-1', 'Now add a regression test');
    expect(state().suggestion).toEqual({ runId: 'run-1', text: 'Now add a regression test' });
    expect(offeredSuggestion(state())).toBe('Now add a regression test');
  });

  it('drops one for a run this window does not hold', () => {
    setPaneState(pane(), { run: endedRun('run-1') });
    // Push channels broadcast to every window; a second window hears about the
    // first window's runs and must have nowhere to put them.
    push('run-elsewhere', 'A guess about someone else');
    expect(state().suggestion).toBeNull();
  });

  it('refuses one for a turn still visibly running', () => {
    setPaneState(pane(), {
      run: { ...endedRun('run-1'), status: 'running' } as unknown as RunState,
    });
    push('run-1', 'Too early');
    expect(state().suggestion).toBeNull();
  });
});

describe('the read gate', () => {
  it('retires the offer the moment the next run starts', () => {
    setPaneState(pane(), { run: endedRun('run-1') });
    push('run-1', 'Stale in a moment');
    expect(offeredSuggestion(state())).toBe('Stale in a moment');

    // No clearing choreography: the pair simply stops describing the run on
    // screen, and the gate is what notices.
    setPaneState(pane(), {
      run: { ...endedRun('run-2'), status: 'running' } as unknown as RunState,
    });
    expect(offeredSuggestion(state())).toBeNull();
    expect(state().suggestion).not.toBeNull();
  });

  it('offers nothing when the column has let go of its run', () => {
    setPaneState(pane(), { run: endedRun('run-1') });
    push('run-1', 'Orphaned');
    setPaneState(pane(), { run: null });
    expect(offeredSuggestion(state())).toBeNull();
  });
});

describe('accept and dismiss', () => {
  it('accepts into the draft exactly once, replacing what was there', () => {
    setPaneState(pane(), { run: endedRun('run-1'), draft: 'half-typed' });
    push('run-1', 'The predicted message');

    acceptSuggestion(pane());
    expect(state().draft).toBe('The predicted message');
    expect(state().suggestion).toBeNull();

    // One-shot: a second accept has nothing to accept and touches nothing.
    setPaneState(pane(), { draft: 'edited since' });
    acceptSuggestion(pane());
    expect(state().draft).toBe('edited since');
  });

  it('refuses to accept a stale offer', () => {
    setPaneState(pane(), { run: endedRun('run-1'), draft: '' });
    push('run-1', 'From the last turn');
    setPaneState(pane(), {
      run: { ...endedRun('run-2'), status: 'running' } as unknown as RunState,
    });

    acceptSuggestion(pane());
    expect(state().draft).toBe('');
  });

  it('dismisses without touching the draft', () => {
    setPaneState(pane(), { run: endedRun('run-1'), draft: 'mine' });
    push('run-1', 'Unwanted');

    dismissSuggestion(pane());
    expect(state().suggestion).toBeNull();
    expect(state().draft).toBe('mine');
  });
});
