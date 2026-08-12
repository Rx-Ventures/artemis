/**
 * @vitest-environment jsdom
 *
 * The update banner is a pure function of the updater's pushed state.
 *
 * The updater itself is not exercised here — it needs a packaged bundle and a
 * release feed, which is `scripts/verify-package.ts` territory. What this file
 * pins is the renderer's half of the contract: nothing renders while idle, an
 * offer shows its version and both actions, the actions call the right bridge
 * channels, and a dismissal names the version the banner was showing rather
 * than whatever arrived last.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UpdateState } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { UpdateBanner } from '@/components/UpdateBanner';

const ok = <T,>(value: T) => ({ ok: true as const, value });

const restartCalls: unknown[] = [];

const IDLE: UpdateState = { phase: 'idle', version: null, message: null, releaseUrl: null };

/** The listener the component registered, for pushing states mid-test. */
let pushState: ((state: UpdateState) => void) | null = null;
const installCalls: unknown[] = [];
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

function renderBanner() {
  return render(
    <TooltipProvider>
      <UpdateBanner />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  installCalls.length = 0;
  restartCalls.length = 0;
  dismissCalls.length = 0;
});

describe('UpdateBanner', () => {
  it('renders nothing while idle', async () => {
    const { container } = renderBanner();
    await act(async () => {});
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('offers an available version with install and dismiss', async () => {
    renderBanner();
    await act(async () => {
      pushState?.({ phase: 'available', version: '0.3.0', message: null, releaseUrl: null });
    });
    expect(screen.getByText(/Artemis 0\.3\.0 is available/)).toBeTruthy();

    screen.getByRole('button', { name: 'Update now' }).click();
    expect(installCalls.length).toBe(1);

    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(dismissCalls).toEqual([{ version: '0.3.0' }]);
  });

  it('shows progress with no actions while working', async () => {
    renderBanner();
    await act(async () => {
      pushState?.({ phase: 'working', version: '0.3.0', message: null, releaseUrl: null });
    });
    expect(screen.getByText(/Updating to 0\.3\.0/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('parks at ready with a restart that is the only path forward', async () => {
    renderBanner();
    await act(async () => {
      pushState?.({ phase: 'ready', version: '0.3.0', message: null, releaseUrl: null });
    });
    expect(screen.getByText(/installed — restart when you're ready/)).toBeTruthy();
    // No dismiss and no install: the one action is the user's restart.
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();

    screen.getByRole('button', { name: 'Restart now' }).click();
    expect(restartCalls.length).toBe(1);
  });

  it('surfaces an error with the manual path when main supplied one', async () => {
    renderBanner();
    await act(async () => {
      pushState?.({
        phase: 'error',
        version: '0.3.0',
        message: 'The update could not be installed.',
        releaseUrl: 'https://github.com/Rx-Ventures/artemis/releases',
      });
    });
    expect(screen.getByText(/could not be installed/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open releases page' });
    expect(link.getAttribute('href')).toBe('https://github.com/Rx-Ventures/artemis/releases');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('disappears when a push returns it to idle', async () => {
    const { container } = renderBanner();
    await act(async () => {
      pushState?.({ phase: 'available', version: '0.3.0', message: null, releaseUrl: null });
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      pushState?.(IDLE);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
