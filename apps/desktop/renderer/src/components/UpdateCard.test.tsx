/**
 * @vitest-environment jsdom
 *
 * The update card is a pure function of the updater's pushed state, and it is
 * where the update lives while the sidebar is showing.
 *
 * The updater itself is not exercised here — it needs a packaged bundle and a
 * release feed, which is `scripts/verify-package.ts` territory. What this file
 * pins is the renderer's half: nothing renders while idle, an offer shows its
 * version and both actions, `ready` offers the restart and *only* the restart,
 * the actions reach the right bridge channels, and a dismissal names the version
 * the card was showing rather than whatever arrived last.
 *
 * The last two cases are placement rather than behaviour, for the reason
 * `directory-placement` gives: the row this card replaced left no failing test
 * behind when it came back, and the card silently not being mounted looks like
 * an app with no updates.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UpdateState } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from '@/components/Sidebar';
import { UpdateCard } from '@/components/UpdateCard';
import { seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ok = <T,>(value: T) => ({ ok: true as const, value });

const IDLE: UpdateState = { phase: 'idle', version: null, message: null, releaseUrl: null };

/** The listener the component registered, for pushing states mid-test. */
let pushState: ((state: UpdateState) => void) | null = null;
const installCalls: unknown[] = [];
const restartCalls: unknown[] = [];
const dismissCalls: { version: string }[] = [];

/**
 * Installed before the first render: `resolveBridge` memoises its binding on
 * first use, so a later assignment would never be seen.
 */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  updates: {
    state: async () => ok({ state: IDLE }),
    install: async (request: unknown) => {
      installCalls.push(request);
      return ok({ state: IDLE });
    },
    restart: async (request: unknown) => {
      restartCalls.push(request);
      return ok({ state: IDLE });
    },
    dismiss: async (request: { version: string }) => {
      dismissCalls.push(request);
      return ok({ state: IDLE });
    },
    onChange: (listener: (state: UpdateState) => void) => {
      pushState = listener;
      return () => {
        pushState = null;
      };
    },
  },
};

function renderCard() {
  return render(
    <TooltipProvider>
      <UpdateCard />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  seedApp({ cwd: '/w', sessions: [], sidebarCollapsed: false });
});

afterEach(() => {
  cleanup();
  installCalls.length = 0;
  restartCalls.length = 0;
  dismissCalls.length = 0;
});

describe('UpdateCard', () => {
  it('renders nothing while idle', async () => {
    const { container } = renderCard();
    await act(async () => {});
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('offers an available version with install and dismiss', async () => {
    renderCard();
    await act(async () => {
      pushState?.({ phase: 'available', version: '0.4.0', message: null, releaseUrl: null });
    });
    expect(screen.getByText(/is available/)).toBeTruthy();
    expect(screen.getByText('Artemis 0.4.0')).toBeTruthy();

    screen.getByRole('button', { name: 'Update now' }).click();
    expect(installCalls.length).toBe(1);

    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(dismissCalls).toEqual([{ version: '0.4.0' }]);
  });

  it('shows progress with no actions while working', async () => {
    renderCard();
    await act(async () => {
      pushState?.({ phase: 'working', version: '0.4.0', message: null, releaseUrl: null });
    });
    expect(screen.getByText(/keep Artemis open/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('parks at ready with a restart that is the only path forward', async () => {
    renderCard();
    await act(async () => {
      pushState?.({ phase: 'ready', version: '0.4.0', message: null, releaseUrl: null });
    });
    expect(screen.getByText(/Restart to finish/)).toBeTruthy();
    // No dismiss and no install: the one action is the user's restart.
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();

    screen.getByRole('button', { name: 'Restart now' }).click();
    expect(restartCalls.length).toBe(1);
  });

  it('surfaces an error with the manual path when main supplied one', async () => {
    renderCard();
    await act(async () => {
      pushState?.({
        phase: 'error',
        version: '0.4.0',
        message: 'The update could not be installed.',
        releaseUrl: 'https://github.com/seth-torrence/artemis/releases',
      });
    });
    expect(screen.getByText(/could not be installed/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open releases page' });
    expect(link.getAttribute('href')).toBe('https://github.com/seth-torrence/artemis/releases');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('disappears when a push returns it to idle', async () => {
    const { container } = renderCard();
    await act(async () => {
      pushState?.({ phase: 'available', version: '0.4.0', message: null, releaseUrl: null });
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      pushState?.(IDLE);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe('the foot of the sidebar', () => {
  it('holds nothing while the updater is idle', async () => {
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    await act(async () => {});

    // The row that used to be a permanent fixture here. It is reachable twice
    // over now — a session row for history, the chip above the composer for a
    // fresh start anywhere — and bringing it back would cost the card its spot.
    expect(screen.queryByText('Start somewhere else')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('grows the card when an update arrives', async () => {
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    await act(async () => {
      pushState?.({ phase: 'ready', version: '0.4.0', message: null, releaseUrl: null });
    });

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeTruthy();
  });
});
