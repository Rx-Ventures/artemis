/**
 * @vitest-environment jsdom
 *
 * A provider's own window names survive to the screen.
 *
 * The meter used to keep a shortlist of window ids — `five_hour`, `seven_day*`,
 * model-scoped — which quietly made it Claude-only. Codex reports `primary` and
 * `secondary`, matched none of them, and an account whose limits had been
 * fetched perfectly well rendered "No limits reported for this plan". The
 * protocol calls `PlanUsageWindowId` open-ended precisely so a provider can
 * bring its own vocabulary, so the filter is now a deny-list of known noise.
 *
 * Both directions are asserted: the unfamiliar window is shown, and the two
 * genuinely noisy Claude windows are still dropped.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

/** What the next `usagePlan` call answers. See the note in `models.test.ts`. */
let answer: PlanUsage | null = null;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: answer } }),
    refresh: async () => ({ ok: true, value: { usage: answer } }),
  },
};

/** Transcribed from a live `account/rateLimits/read` against codex-cli. */
const CODEX_USAGE: PlanUsage = {
  available: true,
  subscriptionType: 'team',
  windows: [{ id: 'primary', label: '7 days', utilization: 12, resetsAt: Date.now() + 86_400_000 }],
  fetchedAt: Date.now(),
};

const CLAUDE_USAGE: PlanUsage = {
  available: true,
  subscriptionType: 'max',
  windows: [
    { id: 'five_hour', label: '5 hours', utilization: 61, resetsAt: Date.now() + 3_600_000 },
    { id: 'seven_day', label: '7 days', utilization: 23, resetsAt: Date.now() + 86_400_000 },
    { id: 'seven_day_oauth_apps', label: '7 days', utilization: 4, resetsAt: null },
    { id: 'extra_usage', label: 'Extra usage', utilization: 0, resetsAt: null },
    // An internal experiment flag that arrives as a real window object — the
    // only one of its codename family that does — and drew a permanent 0% bar.
    { id: 'nimbus_quill', label: 'nimbus quill', utilization: 0, resetsAt: null },
    // Usage credits at zero: the state most accounts are permanently in.
    { id: 'spend', label: 'Usage Credits', utilization: 0, resetsAt: null },
  ],
  fetchedAt: Date.now(),
};

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

afterEach(cleanup);

describe('plan usage windows', () => {
  it('renders a window whose id this app has never heard of', async () => {
    answer = CODEX_USAGE;
    mount(<ProfilePlanUsage profileId="p1" supported providerLabel="Codex" />);

    await waitFor(() => expect(screen.getByText('team plan')).toBeTruthy());
    expect(screen.getByText('7 days')).toBeTruthy();
    expect(screen.getByText('12%')).toBeTruthy();
    // The message this bug actually produced, on an account that had limits.
    expect(screen.queryByText('No limits reported for this plan.')).toBeNull();
  });

  it('still drops the windows nobody asks about mid-run', async () => {
    answer = CLAUDE_USAGE;
    mount(<ProfilePlanUsage profileId="p2" supported providerLabel="Claude" />);

    await waitFor(() => expect(screen.getByText('max plan')).toBeTruthy());
    expect(screen.getByText('61%')).toBeTruthy();
    expect(screen.getByText('23%')).toBeTruthy();
    expect(screen.queryByText('Extra usage')).toBeNull();
    // Two `7 days` rows would mean the oauth-apps window came through with it.
    expect(screen.getAllByText('7 days').length).toBe(1);
    // An experiment flag is not a limit, whatever shape it arrives in.
    expect(screen.queryByText('nimbus quill')).toBeNull();
    // Credits at zero are the permanent state of most accounts, not news.
    expect(screen.queryByText('Usage Credits')).toBeNull();
  });

  it('shows Usage Credits once there is actually spend to report', async () => {
    answer = {
      ...CLAUDE_USAGE,
      windows: CLAUDE_USAGE.windows.map((w) =>
        w.id === 'spend' ? { ...w, utilization: 12 } : w,
      ),
    };
    mount(<ProfilePlanUsage profileId="p4" supported providerLabel="Claude" />);

    await waitFor(() => expect(screen.getByText('Usage Credits')).toBeTruthy());
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('says so plainly when a plan really reports nothing', async () => {
    answer = {
      available: false,
      unavailableReason: 'Usage on the team plan is metered rather than capped.',
      windows: [],
      fetchedAt: Date.now(),
    };
    mount(<ProfilePlanUsage profileId="p3" supported providerLabel="Codex" />);

    await waitFor(() =>
      expect(screen.getByText(/metered rather than capped/)).toBeTruthy(),
    );
  });
});
