/**
 * @vitest-environment jsdom
 *
 * The six conditions, and the two rankings that matter: waiting outranks
 * running, and a requested stop outranks them both.
 *
 * `activityOf` is a pure function of the run and the queue length precisely so
 * this can be exhaustive without mounting anything. The rendering tests below
 * cover the two things a pure function cannot: that a settled pane renders
 * nothing at all, and that the counter ticks.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityIndicator, ActivityRule, activityOf, formatElapsed } from '@/components/Activity';
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

  it('reports stopping the moment a stop has been asked for', () => {
    // The request, not the outcome: `run.end` is seconds away on a busy turn,
    // and "running" for all of them is the stop button reading as broken.
    expect(activityOf(run({ status: 'running', interruptRequested: true }), 0).kind).toBe(
      'stopping',
    );
  });

  it('lets a requested stop outrank a parked permission', () => {
    // The interrupt withdraws the question — the adapter denies pending
    // prompts on the way down — so sending the user to answer it would send
    // them to answer nothing.
    expect(
      activityOf(run({ status: 'awaiting_permission', interruptRequested: true }), 1).kind,
    ).toBe('stopping');
  });

  it('does not let a stale stop flag outlive the run it stopped', () => {
    expect(activityOf(run({ status: 'ended', interruptRequested: true }), 0).kind).toBe(
      'settled',
    );
  });

  it('keeps the clock climbing while the provider winds down', () => {
    // The counter is the proof the renderer is alive; freezing it on the click
    // would make a working stop indistinguishable from a hang.
    expect(activityOf(run({ status: 'running', interruptRequested: true }), 0).since).toBe(AT);
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

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The border above the composer, which is the same five conditions drawn as a
 * line.
 *
 * Asserted on classes, which this suite otherwise avoids — but the whole claim
 * here *is* the geometry and the colour: a border that did not grow would clip
 * the animation it exists to carry, and one that stayed put at rest would be a
 * 3px bar under every idle conversation.
 */
describe('ActivityRule', () => {
  afterEach(cleanup);

  const mount = (): HTMLElement => {
    const { container } = render(
      <PaneProvider pane={focusedPane()}>
        <ActivityRule />
      </PaneProvider>,
    );
    return container.firstElementChild as HTMLElement;
  };

  it('is an ordinary hairline while nothing is running', () => {
    seedApp({ run: null, permissionQueue: [] });
    const rule = mount();

    expect(rule.dataset['activityRule']).toBe('settled');
    expect(rule.className).toContain('h-px');
    expect(rule.className).toContain('bg-line');
    expect(rule.className).not.toContain('shuttle');
  });

  it('grows and carries the shuttle while a run is in flight', () => {
    seedApp({ run: { status: 'running', startedAt: AT } as never, permissionQueue: [] });
    const rule = mount();

    expect(rule.dataset['activityRule']).toBe('running');
    // 3px, because that is what the animation needs. A shuttle drawn inside a
    // 1px border would either clip or straddle the seam.
    expect(rule.className).toContain('h-[3px]');
    expect(rule.className).toContain('shuttle');
  });

  it('goes amber, and still, while something is parked on an answer', () => {
    seedApp({
      run: { status: 'running', startedAt: AT } as never,
      permissionQueue: [{ id: 'p1' }] as never,
    });
    const rule = mount();

    // Not moving: nothing is progressing until it is answered, and a shuttle
    // would say the opposite in the most visible place in the window.
    expect(rule.dataset['activityRule']).toBe('waiting');
    expect(rule.className).toContain('bg-amber');
    expect(rule.className).not.toContain('shuttle');
  });

  it('says nothing out loud, because the indicator already does', () => {
    seedApp({ run: { status: 'running', startedAt: AT } as never, permissionQueue: [] });
    const rule = mount();

    // Two live regions for one fact is how a screen reader ends up announcing
    // every turn twice.
    expect(rule.getAttribute('aria-hidden')).toBe('true');
    expect(rule.getAttribute('role')).toBeNull();
  });
});
