/**
 * @vitest-environment jsdom
 *
 * The rings follow the poll.
 *
 * Artemis holds "how full is this account" in two places, and for a while they
 * were not connected:
 *
 *  - the meter's **own state**, filled on mount, on a profile change, and when
 *    the popover opens;
 *  - **`planUsageByProfile`** in the app store, which the main process's poll
 *    pushes into every few minutes for every account.
 *
 * The rings rendered the first and never read the second, so the three numbers
 * on the status bar were frozen at whatever the last load returned. Sit on one
 * account while an agent works through a long job and the 5-hour ring would not
 * move — though the true figure was in the store the whole time. Reloading the
 * window fixed it, because that remounts the meter, which is exactly the "I have
 * to refresh to see changes" this was reported as (#146).
 *
 * Neither source subsumes the other, so the rule is *the newer of the two*, and
 * that is what these assert — in both directions, because a rule that always
 * preferred the store would break the manual refresh button that sits under
 * these same rings.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { PlanUsage } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusLine } from '@/components/StatusLine';
import { seedApp } from '@/state/testkit';
import { useApp } from '@/state/store';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** What the meter's own `cached`/`refresh` calls answer. */
let answer: PlanUsage | null = null;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: answer } }),
    refresh: async () => ({ ok: true, value: { usage: answer } }),
  },
};

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

/** A reading of the 5-hour window, stamped so the two sources can be ordered. */
function reading(utilization: number, fetchedAt: number): PlanUsage {
  return {
    available: true,
    subscriptionType: 'max',
    fetchedAt,
    windows: [{ id: 'five_hour', label: '5 hours', utilization, resetsAt: null }],
  };
}

function seed(planUsageByProfile: Record<string, PlanUsage> = {}): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.claude' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
    ],
    activeProfileId: 'p1',
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions: [],
    permissionQueue: [],
    banners: [],
    planUsageByProfile,
  });
}

function mount(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <StatusLine />
    </TooltipProvider>,
  );
}

/** The trigger, whose accessible name spells out every ring's number. */
function meter(): HTMLElement {
  return screen.getByRole('button', { name: /Plan usage/ });
}

afterEach(() => {
  cleanup();
  answer = null;
});

describe('a reading pushed by the poll', () => {
  it('reaches the rings without anything being clicked', async () => {
    // The whole bug. Nothing here opens the popover, switches account or
    // reloads; the poll simply pushes, and the number has to move.
    answer = null;
    seed();
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('—'));

    act(() => {
      useApp.setState({ planUsageByProfile: { p1: reading(61, 5_000) } });
    });

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('61'));
  });

  it('keeps moving as the account fills up', async () => {
    // A long session on one account: several cycles land while the user does
    // nothing. Each has to be visible, not just the first.
    seed({ p1: reading(20, 1_000) });
    mount();
    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('20'));

    for (const [utilization, at] of [
      [45, 2_000],
      [72, 3_000],
      [91, 4_000],
    ] as const) {
      act(() => {
        useApp.setState({ planUsageByProfile: { p1: reading(utilization, at) } });
      });
      await waitFor(() =>
        expect(meter().getAttribute('aria-label')).toContain(String(utilization)),
      );
    }
  });

  it('is ignored when it is older than what the meter already read', async () => {
    // The other direction, and the reason this is `newerReading` rather than a
    // preference for the store. The manual refresh button under these rings
    // writes to the meter's own state; a stale cycle landing afterwards must not
    // undo it.
    answer = reading(88, 9_000);
    seed();
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('88'));

    act(() => {
      useApp.setState({ planUsageByProfile: { p1: reading(12, 1_000) } });
    });

    // Still the newer figure, a tick later.
    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('88'));
    expect(meter().getAttribute('aria-label')).not.toContain('12');
  });

  it('is used when the meter has nothing of its own', async () => {
    // The first cycle after launch, before the popover has ever been opened.
    answer = null;
    seed({ p1: reading(33, 5_000) });
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('33'));
  });

  it('is read for the account in front of the user, not some other one', async () => {
    // The map holds every profile. Selecting the wrong entry would put another
    // account's limits under this account's name — the mislabelling the
    // in-flight guard beside this already exists to prevent.
    seed({ p1: reading(15, 5_000), p2: reading(97, 6_000) });
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('15'));
    expect(meter().getAttribute('aria-label')).not.toContain('97');
  });
});
