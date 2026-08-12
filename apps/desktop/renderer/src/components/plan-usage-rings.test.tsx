/**
 * @vitest-environment jsdom
 *
 * The status bar's three rings.
 *
 * The meter used to be one bar reporting one window, chosen in settings, and
 * the setting was the tell: the 5-hour limit, the weekly limit and the
 * per-model weekly answer different questions on different clocks, so picking
 * between them meant being blind to two. Three rings report all three.
 *
 * What is worth testing is the slot resolution rather than the drawing. Which
 * window lands in which ring is where this can be quietly wrong — a ring
 * showing the weekly number under a "5hr" label, or a permanent dash under
 * "Fable" on an account that meters Opus — and none of that is visible from the
 * geometry. The arc itself is one `stroke-dasharray` and is asserted only where
 * a zero-length one used to paint a dot.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** What the next `usagePlan` call answers. See the note in `models.test.ts`. */
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

function seed(providerLabel = 'Claude'): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: providerLabel,
        capabilities: CAPABILITIES,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.claude' }],
    activeProfileId: 'p1',
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions: [],
    permissionQueue: [],
    banners: [],
    planUsageByProfile: {},
  });
}

function mount(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <StatusLine />
    </TooltipProvider>,
  );
}

/** The trigger, which is where every ring's number is also spelled out. */
function meter(): HTMLElement {
  return screen.getByRole('button', { name: /Plan usage/ });
}

function window_(
  id: string,
  label: string,
  utilization: number | null,
): PlanUsage['windows'][number] {
  return { id, label, utilization, resetsAt: null };
}

afterEach(cleanup);

describe('the status bar rings', () => {
  it('reports the 5-hour, weekly and Fable windows side by side', async () => {
    seed();
    answer = {
      available: true,
      subscriptionType: 'max',
      fetchedAt: Date.now(),
      windows: [
        window_('five_hour', '5 hours', 61),
        window_('seven_day', '7 days', 23),
        window_('model_scoped:Fable', '7 days · Fable', 8),
      ],
    };
    mount();

    await waitFor(() => expect(meter().textContent).toContain('61'));
    // Label then number, three times over, in that order — a ring whose label
    // has drifted onto the wrong window is the failure this catches.
    expect(meter().textContent).toBe('5hr61Week23Fable8');
    expect(meter().getAttribute('aria-label')).toBe(
      'Plan usage — 5hr 61%, Week 23%, Fable 8%',
    );
  });

  it('takes Fable by name, not whichever per-model bucket is fullest', async () => {
    seed();
    answer = {
      available: true,
      fetchedAt: Date.now(),
      windows: [
        window_('five_hour', '5 hours', 10),
        window_('model_scoped:Opus', '7 days · Opus', 90),
        window_('model_scoped:Fable', '7 days · Fable', 12),
      ],
    };
    mount();

    // "Whichever is fullest" would have put Opus at 90 here. A ring is a thing
    // you learn the position of, so its subject does not change under you —
    // Opus is still one line down in the popover.
    await waitFor(() => expect(meter().textContent).toContain('Fable'));
    expect(meter().textContent).toBe('5hr10Fable12');
    expect(meter().textContent).not.toContain('Opus');
  });

  it('drops the third ring entirely on a plan with no Fable bucket', async () => {
    seed();
    answer = {
      available: true,
      fetchedAt: Date.now(),
      windows: [window_('seven_day', '7 days', 40), window_('model_scoped:Opus', '7 days · Opus', 55)],
    };
    mount();

    // Two rings, and no stand-in. Neither a dash under a name this plan has
    // never heard of, nor Opus wearing the slot Fable is read at.
    await waitFor(() => expect(meter().textContent).toBe('Week40'));
    expect(meter().textContent).not.toContain('Fable');
    expect(meter().textContent).not.toContain('Opus');
  });

  it('is one button — every ring opens the same popover', async () => {
    seed();
    answer = {
      available: true,
      fetchedAt: Date.now(),
      windows: [window_('five_hour', '5 hours', 61), window_('seven_day', '7 days', 23)],
    };
    mount();

    await waitFor(() => expect(meter().textContent).toContain('61'));
    // The rings are spans inside one trigger, not a row of controls: `getBy`
    // throws on a second match, and both readings are inside the one it found.
    expect(meter().querySelectorAll('button').length).toBe(0);
    expect(meter().getAttribute('aria-haspopup')).toBe('dialog');

    fireEvent.click(meter());

    // The popover is unchanged — context window first, then every window the
    // plan reports, including any that has no ring on the bar.
    expect(await screen.findByText('Context window')).toBeTruthy();
    expect(screen.getByText('5 hours')).toBeTruthy();
    expect(screen.getByText('7 days')).toBeTruthy();
  });

  it('draws no ring for a window the plan does not report', async () => {
    seed();
    answer = {
      available: true,
      fetchedAt: Date.now(),
      windows: [window_('five_hour', '5 hours', 44)],
    };
    mount();

    // An unfilled ring is indistinguishable from a ring at 0%, so a limit this
    // plan does not have must not render as a limit it has not touched.
    await waitFor(() => expect(meter().textContent).toContain('44'));
    expect(meter().textContent).toBe('5hr44');
  });

  it("falls back to a provider's own window when it meters by other names", async () => {
    seed('Codex');
    answer = {
      available: true,
      subscriptionType: 'team',
      fetchedAt: Date.now(),
      windows: [window_('primary', '7 days', 31), window_('secondary', '30 days', 12)],
    };
    mount();

    // Codex matches none of the three slots. Three dashes would be a lie about
    // an account whose usage was read perfectly well, so the window closest to
    // full gets the ring, under the provider's own name for it.
    await waitFor(() => expect(meter().textContent).toContain('31'));
    expect(meter().textContent).toBe('7 days31');
  });

  it('holds its place with dashes before a reading lands', () => {
    seed();
    answer = null;
    mount();

    // Rendered synchronously, before the first bridge call resolves: the
    // trigger is a control, and one that appears a second after launch shoves
    // the row sideways as it arrives.
    expect(meter().textContent).toBe('5hr—Week—Fable—');
    expect(meter().getAttribute('aria-label')).toBe(
      'Plan usage — 5hr unknown, Week unknown, Fable unknown',
    );
  });

  it('draws no arc at all on a window at zero', async () => {
    seed();
    answer = {
      available: true,
      fetchedAt: Date.now(),
      windows: [window_('five_hour', '5 hours', 0), window_('seven_day', '7 days', 50)],
    };
    mount();

    await waitFor(() => expect(meter().textContent).toBe('5hr0Week50'));
    // One arc, not two: a round cap on a zero-length dash paints a dot at
    // twelve o'clock, which reads as a sliver of usage on a window with none.
    expect(meter().querySelectorAll('circle[stroke-dasharray]').length).toBe(1);
  });
});
