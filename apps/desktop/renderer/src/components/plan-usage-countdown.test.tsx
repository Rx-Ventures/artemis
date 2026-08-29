/**
 * @vitest-environment jsdom
 *
 * The countdown beside a reset time keeps counting down.
 *
 * "resets 3:10 PM · in 4h 18m" — both halves of that come from one `resetsAt`,
 * so when they disagree one of them is arithmetic on a stale clock. The exact
 * time is the half that cannot rot: it is an absolute instant, formatted. The
 * countdown is `resetsAt - now`, and `now` was a `Date.now()` captured at mount
 * (the profile card) or during render (the status bar), with nothing in either
 * component to make it advance. A reading arrives every couple of minutes at
 * most, the poll skips cycles when no window is looking, and an unchanged
 * payload does not even change the identity of the store entry the meter
 * subscribes to — so "something else will re-render us" was never a clock.
 *
 * Left open, the pane drifted by exactly however long it had been open: a reset
 * two and three quarter hours away reported as four and a third, on a card whose
 * own wall-clock label said otherwise.
 *
 * Asserted here on the duration alone, never on the formatted time — that half
 * is the host's locale and timezone, and the bug was never in it.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { PlanUsage } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ProfilePlanUsage } from '@/components/PlanUsageMeter';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});

let answer: PlanUsage | null = null;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: answer } }),
    refresh: async () => ({ ok: true, value: { usage: answer } }),
  },
};

const MINUTE = 60_000;

/** The moment the user reported this from: 12:25, with a reset at 15:10. */
const MOUNTED_AT = Date.parse('2026-08-29T04:25:00.000Z');
const RESET_IN = 165 * MINUTE;

function usage(resetsAt: number): PlanUsage {
  return {
    available: true,
    subscriptionType: 'max',
    fetchedAt: MOUNTED_AT,
    windows: [{ id: 'five_hour', label: '5 hours', utilization: 61, resetsAt }],
  };
}

/** The countdown half of the hint, e.g. `2h 45m`. */
function countdown(): string {
  const hint = screen.getByText(/^resets .* · in /);
  return (hint.textContent ?? '').replace(/^.* · in /, '');
}

/** Mount and let the cached read resolve, without leaving fake timers behind. */
async function mount(): Promise<void> {
  render(
    <TooltipProvider delayDuration={0}>
      <ProfilePlanUsage profileId="p1" supported providerLabel="Claude" />
    </TooltipProvider>,
  );
  // The load is two awaited IPC calls deep; flushing microtasks inside `act` is
  // what `waitFor` would do, minus its own dependence on the timers being real.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MOUNTED_AT);
  answer = usage(MOUNTED_AT + RESET_IN);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the reset countdown', () => {
  it('starts at the true distance to the reset', async () => {
    await mount();
    expect(countdown()).toBe('2h 45m');
  });

  it('shrinks as the clock moves, with nothing else happening', async () => {
    // The whole bug. No refresh, no push, no remount — the pane simply stays
    // open, which is the state it was reported in.
    await mount();
    expect(countdown()).toBe('2h 45m');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
    });
    expect(countdown()).toBe('2h 15m');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * MINUTE);
    });
    expect(countdown()).toBe('15m');
  });

  it('never reports a reset as further away than it was a moment ago', async () => {
    // The direction that made it wrong rather than merely imprecise: a frozen
    // clock does not lag the truth, it *inflates* the distance to it, and the
    // longer the pane is open the more it inflates.
    await mount();

    let previous = Number.POSITIVE_INFINITY;
    for (let elapsed = 0; elapsed < RESET_IN; elapsed += 20 * MINUTE) {
      const [, hours = '0', minutes = '0'] = /^(?:(\d+)h )?(\d+)m$/.exec(countdown()) ?? [];
      const remaining = Number(hours) * 60 + Number(minutes);
      expect(remaining).toBeLessThanOrEqual(previous);
      expect(remaining).toBeLessThanOrEqual(Math.ceil((RESET_IN - elapsed) / MINUTE));
      previous = remaining;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20 * MINUTE);
      });
    }
  });

  it('says so once the window has actually reset', async () => {
    await mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESET_IN + MINUTE);
    });

    expect(screen.getByText('resetting now')).toBeTruthy();
  });
});
