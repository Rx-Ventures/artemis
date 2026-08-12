/**
 * @vitest-environment jsdom
 *
 * The profile menu's "Recommended" section, and the two claims it can make.
 *
 * The section exists because nothing in the app had ever read an account other
 * than the active one, so "my five-hour window is nearly gone, where should I
 * go?" had no answer. A poller in the main process now reads every profile and
 * pushes the readings; this is the part that turns them into advice.
 *
 * What is worth testing is almost entirely the *restraint*. The row itself is
 * deliberately bare — swatch and name, the same anatomy as the list below it,
 * with the numbers that argued for the pick kept to the tooltip — and there
 * are several cases where the honest output is nothing at all: one account,
 * stale readings, metered billing. Those absences are the feature.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PlanUsage } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusLine } from '@/components/StatusLine';
import { seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

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

const PROFILES = [
  { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.personal' },
  { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
];

/** A reading fresh enough to advise on, at `utilization` on its five-hour window. */
function reading(utilization: number, subscriptionType?: string): PlanUsage {
  return {
    available: true,
    fetchedAt: Date.now(),
    windows: [{ id: 'five_hour', label: '5 hours', utilization, resetsAt: null }],
    ...(subscriptionType === undefined ? {} : { subscriptionType }),
  };
}

function seed(
  planUsageByProfile: Record<string, PlanUsage>,
  profiles: readonly Record<string, unknown>[] = PROFILES,
): void {
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
    profiles,
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

afterEach(cleanup);

function openProfileMenu(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <StatusLine />
    </TooltipProvider>,
  );
  // Radix mounts the menu's content on open, which is deliberate — it is what
  // makes the staleness rule re-judged at the moment the user looks.
  fireEvent.pointerDown(
    screen.getByRole('button', { name: /Profile/ }),
    new PointerEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }),
  );
}

describe('the Recommended section', () => {
  beforeEach(() => {
    seed({});
  });

  it('names the account with the most room, as a bare profile row', () => {
    seed({ p1: reading(80, 'max'), p2: reading(20, 'max') });
    openProfileMenu();

    expect(screen.getByText('Recommended')).not.toBeNull();
    // 80% used on the active account, 20% on the other: the other wins by 60,
    // and appears twice — once as the recommendation, once in the list proper.
    expect(screen.getAllByText('Work').length).toBe(2);
    // The row is just the profile. The numbers that argued for it live in the
    // tooltip, not on the row — the markup that used to carry them is gone.
    expect(screen.queryByText(/free/)).toBeNull();
    const row = screen.getAllByText('Work')[0]!.closest('[role="menuitem"]');
    expect(row?.getAttribute('title')).toMatch(/80% free on its 5 hours limit/);
  });

  it('still names a winner across two different plans', () => {
    // Percentages of two different ceilings are still ranked — the row just no
    // longer editorialises about it on-screen; the tooltip carries the why.
    seed({ p1: reading(60, 'max'), p2: reading(40, 'team') });
    openProfileMenu();

    expect(screen.getByText('Recommended')).not.toBeNull();
    expect(screen.getAllByText('Work').length).toBe(2);
  });

  it('still recommends the account you are already in', () => {
    // Confirmation, not ceremony: the row rendering your current account says
    // "you are on the right one" without a subtitle to say it with.
    seed({ p1: reading(20, 'max'), p2: reading(60, 'team') });
    openProfileMenu();

    expect(screen.getByText('Recommended')).not.toBeNull();
    // Three, not two: the winner is the *active* account here, so it is also
    // the trigger's own label — trigger, recommendation, list row.
    expect(screen.getAllByText('Personal').length).toBe(3);
  });

  it('says nothing when only one account has plan limits', () => {
    // The remaining account bills per token. Recommending it would answer "my
    // plan is full" with a silent switch to metered billing.
    seed({
      p1: reading(90, 'max'),
      p2: { available: false, windows: [], fetchedAt: Date.now() },
    });
    openProfileMenu();

    expect(screen.queryByText('Recommended')).toBeNull();
  });

  it('says nothing when the readings are too old to advise on', () => {
    const old = { ...reading(20, 'max'), fetchedAt: Date.now() - 60 * 60_000 };
    seed({ p1: { ...reading(80, 'max'), fetchedAt: Date.now() - 60 * 60_000 }, p2: old });
    openProfileMenu();

    expect(screen.queryByText('Recommended')).toBeNull();
  });

  it('says nothing before any reading has arrived', () => {
    openProfileMenu();
    expect(screen.queryByText('Recommended')).toBeNull();
  });

  it('says nothing once the only other account has opted out of the pool', () => {
    // The reading is fine and the account is one click away in the list below.
    // It is simply not one Artemis may reach for, which leaves one candidate —
    // and a "Recommended" heading over the account you are already in repeats
    // the trigger above it.
    seed({ p1: reading(80, 'max'), p2: reading(20, 'max') }, [
      PROFILES[0]!,
      { ...PROFILES[1]!, autoSelect: false },
    ]);
    openProfileMenu();

    expect(screen.queryByText('Recommended')).toBeNull();
    // Still listed, though: opting out of the pool is not being hidden.
    expect(screen.getAllByText('Work').length).toBe(1);
  });

  it('passes over an opted-out account to name the next best one', () => {
    // Work has the most room and is out of the pool; Spare is second and is
    // not. The winner is Spare rather than nothing — this is a filter on the
    // candidates, not a veto on the section.
    seed({ p1: reading(80, 'max'), p2: reading(10, 'max'), p3: reading(40, 'max') }, [
      PROFILES[0]!,
      { ...PROFILES[1]!, autoSelect: false },
      { id: 'p3', label: 'Spare', providerId: 'claude', configDir: '/home/u/.spare' },
    ]);
    openProfileMenu();

    expect(screen.getByText('Recommended')).not.toBeNull();
    expect(screen.getAllByText('Spare').length).toBe(2);
    // Two candidates were compared, not three: an account that could never win
    // is not one the winner beat.
    const row = screen.getAllByText('Spare')[0]!.closest('[role="menuitem"]');
    expect(row?.getAttribute('title')).toMatch(/across 2 accounts/);
  });

  it('never recommends a disabled account, whatever its own flag says', () => {
    seed({ p1: reading(80, 'max'), p2: reading(20, 'max') }, [
      PROFILES[0]!,
      { ...PROFILES[1]!, disabled: true, autoSelect: true },
    ]);
    openProfileMenu();

    // Recommending an account that has been hidden from the menu doing the
    // recommending is the one combination the two flags must not produce.
    expect(screen.queryByText('Recommended')).toBeNull();
  });

  it('switches the account when the row is chosen', () => {
    seed({ p1: reading(80, 'max'), p2: reading(20, 'max') });
    openProfileMenu();

    fireEvent.click(screen.getAllByText('Work')[0]!.closest('[role="menuitem"]')!);

    // The row is a shortcut into the list below it, not a fifth state of the
    // choice — selecting it does what selecting "Work" would have done.
    expect(screen.getAllByText('Work').length).toBeGreaterThan(0);
  });
});
