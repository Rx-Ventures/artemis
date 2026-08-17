/**
 * @vitest-environment jsdom
 *
 * The plan tier on a picker row, and where it is allowed to come from.
 *
 * There are two sources for "what plan is this account on":
 *
 *  - **`authByProfile`**, from a direct sign-in probe. Filled by exactly one
 *    thing — a card mounting on the profiles screen — so it is empty until that
 *    screen has been opened, and empty again after every reload, because it is
 *    renderer state that nothing persists.
 *  - **`planUsageByProfile`**, from the plan poll. Filled for *every* account
 *    within a cycle of launch, with no extra subprocess.
 *
 * The row required the first to say `loggedIn === true` before it would show
 * either, so on a fresh launch it discarded a tier the app already knew and
 * every row came up unlabelled. That is backwards from the rule the bar states
 * for its own amber warning — *checked and signed out*, never merely unchecked
 * — and this file pins the corrected version in both directions.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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

/** A plan reading that reports a tier, as the poll delivers one. */
function reading(subscriptionType: string): Record<string, unknown> {
  return {
    available: true,
    subscriptionType,
    fetchedAt: 1_000,
    windows: [{ id: 'five_hour', label: '5 hours', utilization: 10, resetsAt: null }],
  };
}

function seed(
  planUsageByProfile: Record<string, unknown>,
  authByProfile: Record<string, unknown> = {},
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
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.p1' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.p2' },
    ],
    activeProfileId: 'p1',
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions: [],
    permissionQueue: [],
    banners: [],
    planUsageByProfile,
    authByProfile,
  });
}

function openProfileMenu(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <StatusLine />
    </TooltipProvider>,
  );
  fireEvent.pointerDown(
    screen.getByRole('button', { name: /Profile/ }),
    new PointerEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }),
  );
}

afterEach(cleanup);

describe('the tier on a picker row', () => {
  it('comes off the poll when nothing has probed sign-in', () => {
    // The bug, and the state every launch starts in. `authByProfile` is empty;
    // the poll knows both tiers; the rows must say so.
    seed({ p1: reading('max'), p2: reading('team') });
    openProfileMenu();

    expect(screen.getAllByText('max').length).toBeGreaterThan(0);
    expect(screen.getAllByText('team').length).toBeGreaterThan(0);
  });

  it('prefers the direct probe where there is one', () => {
    // The probe is the more direct read of the same fact, so it wins. Both are
    // present here and they disagree, which is the only way to tell.
    seed({ p1: reading('max') }, { p1: { loggedIn: true, subscriptionType: 'enterprise' } });
    openProfileMenu();

    expect(screen.getAllByText('enterprise').length).toBeGreaterThan(0);
    expect(screen.queryByText('max')).toBeNull();
  });

  it('falls back to the poll when the probe found no tier', () => {
    // A Console login reports `loggedIn` with no `subscriptionType`. That is not
    // a reason to drop a tier the plan reading did report.
    seed({ p1: reading('max') }, { p1: { loggedIn: true } });
    openProfileMenu();

    expect(screen.getAllByText('max').length).toBeGreaterThan(0);
  });

  it('says nothing for an account checked and found signed out', () => {
    // The one case that must stay silent. A tier next to "signed out" would be
    // the row contradicting itself.
    seed({ p1: reading('max') }, { p1: { loggedIn: false } });
    openProfileMenu();

    expect(screen.queryByText('max')).toBeNull();
    expect(screen.getAllByText('signed out').length).toBeGreaterThan(0);
  });

  it('says nothing when neither source knows', () => {
    seed({});
    openProfileMenu();

    // No tier text anywhere — and in particular not an empty badge.
    expect(screen.queryByText('max')).toBeNull();
    expect(screen.queryByText('team')).toBeNull();
  });

  it('does not let one account’s tier leak onto another row', () => {
    seed({ p1: reading('max') });
    openProfileMenu();

    // Exactly one row carries a tier, because exactly one account has a reading.
    expect(screen.getAllByText('max').length).toBe(1);
    expect(screen.queryByText('team')).toBeNull();
  });
});
