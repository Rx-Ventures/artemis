/**
 * @vitest-environment jsdom
 *
 * The five conditions, and the one that matters most: waiting outranks running.
 *
 * `activityOf` is a pure function of the run and the queue length precisely so
 * this can be exhaustive without mounting anything. The rendering tests below
 * cover the two things a pure function cannot: that a settled pane renders
 * nothing at all, and that the counter ticks.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityIndicator, activityOf, formatElapsed } from '@/components/Activity';
import { PaneProvider } from '@/state/paneContext';
import { focusedPane } from '@/state/store';
import { seedApp } from '@/state/testkit';

const AT = 1_700_000_000_000;

const run = (over: Record<string, unknown> = {}) =>
  ({ status: 'running', startedAt: AT, ...over }) as Parameters<typeof activityOf>[0];

describe('activityOf', () => {
  it('is settled when there is no run', () => {
    expect(activityOf(null, 0)).toEqual({ kind: 'settled', because: '', since: null });
  });

  it.each([
    ['starting', 'starting'],
    ['running', 'running'],
  ])('reports %s', (status, kind) => {
    expect(activityOf(run({ status }), 0).kind).toBe(kind);
  });

  it('reports waiting when the provider says so', () => {
    expect(activityOf(run({ status: 'awaiting_permission' }), 0).kind).toBe('waiting');
  });

  it('reports waiting when the renderer holds a queued request', () => {
    // The provider can still be reporting `running` while it waits on us. To
    // the person looking at the pane that is waiting, not working, so the queue
    // has to win — this is the case the old indicator got wrong.
    expect(activityOf(run({ status: 'running' }), 1).kind).toBe('waiting');
  });

  it('counts the queue when more than one request is parked', () => {
    expect(activityOf(run({ status: 'running' }), 3).because).toBe('3 requests need an answer');
    expect(activityOf(run({ status: 'running' }), 1).because).toBe(
      'needs your answer to continue',
    );
  });

  it('separates a failure from a clean finish', () => {
    expect(activityOf(run({ status: 'ended' }), 0).kind).toBe('settled');
    expect(activityOf(run({ status: 'ended', endReason: 'error' }), 0).kind).toBe('failed');
  });

  it('quotes the error rather than saying something failed', () => {
    const state = activityOf(
      run({ status: 'ended', error: { message: '  spawn opencode ENOENT  ' } }),
      0,
    );
    expect(state.kind).toBe('failed');
    expect(state.because).toBe('spawn opencode ENOENT');
  });

  it('falls back to its own words when the error carries no message', () => {
    expect(activityOf(run({ status: 'ended', error: {} }), 0).because).toBe(
      'the run ended with an error',
    );
  });

  it('stops the clock on the conditions that are not elapsing', () => {
    expect(activityOf(run({ status: 'running' }), 0).since).toBe(AT);
    expect(activityOf(run({ status: 'ended', endReason: 'error' }), 0).since).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('never shows a bare zero, which reads as stalled', () => {
    expect(formatElapsed(0)).toBe('1s');
    expect(formatElapsed(400)).toBe('1s');
  });

  it('shows seconds, then minutes and padded seconds', () => {
    expect(formatElapsed(41_000)).toBe('41s');
    expect(formatElapsed(59_400)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(134_000)).toBe('2m 14s');
  });
});

describe('ActivityIndicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const mount = (): void => {
    render(
      <PaneProvider pane={focusedPane()}>
        <ActivityIndicator />
      </PaneProvider>,
    );
  };

  it('renders nothing when the pane has settled', () => {
    seedApp({ run: null, permissionQueue: [] });
    mount();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('climbs while a run is in flight', async () => {
    vi.setSystemTime(AT);
    seedApp({
      run: { status: 'running', startedAt: AT - 41_000 } as never,
      permissionQueue: [],
    });
    mount();
    expect(screen.getByRole('status').textContent).toContain('41s');

    // The counter is the proof the renderer is alive; a spinner alone animates
    // just as smoothly in a hung app as in a working one.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status').textContent).toContain('43s');
  });

  it('says it is waiting, and why, while a request is parked', () => {
    seedApp({
      run: { status: 'running', startedAt: AT } as never,
      permissionQueue: [{ id: 'p1' }] as never,
    });
    mount();
    const status = screen.getByRole('status');
    expect(status.dataset['activity']).toBe('waiting');
    expect(status.textContent).toContain('needs your answer to continue');
  });
});
