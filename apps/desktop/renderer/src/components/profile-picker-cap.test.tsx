/**
 * @vitest-environment jsdom
 *
 * How full each account is, on the row you pick it from.
 *
 * The picker could always answer "which accounts do I have" and the rings beside
 * it could always answer "how full is the one I am in". Neither answered the
 * question that actually arrives with a fistful of accounts — *which of these
 * has room right now* — because that is a comparison, and nothing in the menu
 * carried a number to compare (#143).
 *
 * ## What is asserted, and why each one is a wrong answer avoided
 *
 *  - **The binding window, not the first.** A plan is as full as its tightest
 *    limit. An account at 5% weekly and 98% five-hourly has no room, and a row
 *    reading "5%" would send someone to the account that is about to stop them.
 *  - **Nothing, rather than zero, when nothing is known.** A reading arrives on
 *    a five-minute poll and never arrives at all for metered billing. "0%" on
 *    either would be a confident claim of an empty account, which is the most
 *    expensive direction to be wrong in.
 *  - **The tone matches the rings.** Same bar, same account, same thresholds —
 *    see `toneFor`, which both surfaces now import rather than each spelling out.
 *  - **Ten accounts.** The reported configuration, and the case the feature is
 *    for: with two accounts you can hold both in your head, with ten the menu is
 *    the only place the comparison can happen.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
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

/** A reading with one window at `utilization`. */
function usage(utilization: number | null, label = '5 hours'): Record<string, unknown> {
  return {
    available: true,
    subscriptionType: 'max',
    windows: [{ id: 'five_hour', label, utilization, resetsAt: null }],
    fetchedAt: 1_000,
  };
}

function seed(
  profiles: readonly Record<string, unknown>[],
  planUsageByProfile: Record<string, unknown>,
  activeProfileId: string | null = 'p1',
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
    activeProfileId,
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions: [],
    permissionQueue: [],
    banners: [],
    planUsageByProfile,
  });
}

const personal = {
  id: 'p1',
  label: 'Personal',
  providerId: 'claude',
  configDir: '/home/u/.personal',
};
const work = { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' };

afterEach(cleanup);

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

describe('the cap on a picker row', () => {
  it('shows each account’s reading', () => {
    seed([personal, work], { p1: usage(12), p2: usage(64) });
    openProfileMenu();

    expect(screen.getByText('12%')).not.toBeNull();
    expect(screen.getByText('64%')).not.toBeNull();
  });

  it('reports the window closest to full, not the first one listed', () => {
    seed([personal], {
      p1: {
        available: true,
        windows: [
          { id: 'seven_day', label: '7 days', utilization: 5, resetsAt: null },
          { id: 'five_hour', label: '5 hours', utilization: 98, resetsAt: null },
        ],
        fetchedAt: 1_000,
      },
    });
    openProfileMenu();

    // 5% is true and useless: this account stops you in the next few minutes.
    expect(screen.getByText('98%')).not.toBeNull();
    expect(screen.queryByText('5%')).toBeNull();
  });

  it('shows nothing for an account the poll has not reached yet', () => {
    seed([personal, work], { p1: usage(30) });
    openProfileMenu();

    expect(screen.getByText('30%')).not.toBeNull();
    // Not "0%" — nobody has looked, and a zero would read as a fresh account.
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('shows nothing on metered billing, where there is no cap to report', () => {
    seed([personal], {
      p1: {
        available: false,
        unavailableReason: 'Usage is metered on this account.',
        windows: [],
        fetchedAt: 1_000,
      },
    });
    openProfileMenu();

    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it('shows nothing when the provider omits the number', () => {
    seed([personal], { p1: usage(null) });
    openProfileMenu();

    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it('colours by pressure, on the same thresholds as the rings', () => {
    seed([personal, work, { id: 'p3', label: 'Third', providerId: 'claude', configDir: '/c' }], {
      p1: usage(20),
      p2: usage(80),
      p3: usage(95),
    });
    openProfileMenu();

    expect(screen.getByText('20%').className).toContain('text-ink-muted');
    expect(screen.getByText('80%').className).toContain('text-amber');
    expect(screen.getByText('95%').className).toContain('text-signal');
  });
});

describe('with ten accounts sharing the machine', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `p${String(i + 1)}`);

  it('gives every account its own number', () => {
    // Each account is at a different point in its window, which is the whole
    // reason the menu is where the choice gets made.
    const readings = Object.fromEntries(ids.map((id, i) => [id, usage(i * 9)]));
    seed(
      ids.map((id, i) => ({
        id,
        label: `Claude ${String(i + 1)}x`,
        providerId: 'claude',
        configDir: `/home/u/.c${id}`,
      })),
      readings,
    );
    openProfileMenu();

    for (let i = 0; i < ids.length; i += 1) {
      expect(screen.getByText(`${String(i * 9)}%`)).not.toBeNull();
    }
  });

  it('leaves the accounts nobody has read blank rather than guessing them', () => {
    // A cycle walks the accounts serially, so with ten of them the tail of the
    // list is genuinely unknown for the first minute after launch. Blank says
    // so; a zero would point the user at whichever account was polled last.
    const readings = { p1: usage(44), p2: usage(51) };
    seed(
      ids.map((id, i) => ({
        id,
        label: `Claude ${String(i + 1)}x`,
        providerId: 'claude',
        configDir: `/home/u/.c${id}`,
      })),
      readings,
    );
    openProfileMenu();

    expect(screen.getByText('44%')).not.toBeNull();
    expect(screen.getByText('51%')).not.toBeNull();
    expect(screen.queryAllByText(/^\d+%$/).length).toBe(2);
  });
});
