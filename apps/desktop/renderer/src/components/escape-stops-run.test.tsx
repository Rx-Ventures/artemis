/**
 * @vitest-environment jsdom
 *
 * Turning off Escape-stops-the-run (issue #165), without turning off Escape.
 *
 * Escape does four things in this app, and only one of them was objected to.
 * It closes the command palette, it closes a dialog, it denies a permission the
 * agent is parked on, and it interrupts a live run. The last is destructive and
 * shares a key with three reflexes that are not — reaching for Escape to
 * dismiss something that has already gone stops the agent's work instead — so
 * it is the one that got a switch.
 *
 * Which makes the interesting assertions the *negative* ones: with the setting
 * off, the other three must still happen. A preference that quietly disabled
 * the key would trade one complaint for a worse one, since denying a parked
 * permission is how you unblock a provider that is waiting on you.
 *
 * There are two handlers to keep honest, not one. The global hotkey ignores
 * text fields on purpose, so the composer has its own copy — and the composer
 * is where the user's hands are. Both are covered here; a fix applied to one is
 * exactly the sort of thing that leaves the other behind.
 *
 * As with the other component tests, `renderer/tsconfig.json` excludes these, so
 * `pnpm typecheck` never sees this file and the assertions are behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Composer } from '@/components/Composer';
import { seedApp } from '@/state/testkit';
import { focusedPane, setEscapeStopsRun, useApp } from '@/state/store';
import { setPaneState } from '@/state/pane';
import { pressEscape } from '@/App';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const interruptRun = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const denyPendingPermission = vi.hoisted(() => vi.fn(() => Promise.resolve(false)));
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  interruptRun,
  denyPendingPermission,
}));

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default', 'plan'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
  imageInput: true,
  fileInput: true,
};

function setUp(): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/w',
    draft: '',
    permissionQueue: [],
    banners: [],
    promptHistory: [],
    run: {
      runId: 'r1',
      status: 'running' as const,
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: CAPABILITIES,
      startedAt: 0,
    },
  } as never);
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/** Escape, pressed where the user's hands actually are. */
function escapeInComposer(): void {
  fireEvent.keyDown(screen.getByLabelText('Prompt'), { key: 'Escape' });
}

beforeEach(() => {
  interruptRun.mockClear();
  denyPendingPermission.mockClear();
  denyPendingPermission.mockImplementation(() => Promise.resolve(false));
  setUp();
  setEscapeStopsRun(true);
});

afterEach(cleanup);

describe('Escape stops the run', () => {
  it('is on by default, because that is how the key already behaved', () => {
    // A preference that silently changed an existing reflex on upgrade would be
    // worse than not having one.
    expect(useApp.getState().escapeStopsRun).toBe(true);
  });

  it('interrupts while it is on', async () => {
    mount(<Composer />);
    escapeInComposer();

    await vi.waitFor(() => expect(interruptRun).toHaveBeenCalledTimes(1));
  });

  it('does not interrupt while it is off', async () => {
    setEscapeStopsRun(false);
    mount(<Composer />);
    escapeInComposer();

    // Waited on rather than asserted immediately: the composer's handler runs
    // after the deny resolves, so a synchronous check would pass by being early
    // rather than by being right.
    await vi.waitFor(() => expect(denyPendingPermission).toHaveBeenCalled());
    expect(interruptRun).not.toHaveBeenCalled();
  });

  it('still denies a parked permission while it is off', async () => {
    // The branch that must survive the setting. A provider waiting on an answer
    // is blocked until one arrives, and Escape is how you give it — taking that
    // away in the name of "do not stop the run" would strand the very run the
    // setting exists to protect.
    setEscapeStopsRun(false);
    denyPendingPermission.mockImplementation(() => Promise.resolve(true));
    mount(<Composer />);
    escapeInComposer();

    await vi.waitFor(() => expect(denyPendingPermission).toHaveBeenCalledTimes(1));
    expect(interruptRun).not.toHaveBeenCalled();
  });

  it('leaves the Stop button alone', () => {
    // The setting is about the *key*, not about the ability to stop. A run with
    // no way to end it from the window is the app wedged.
    setEscapeStopsRun(false);
    mount(<Composer />);

    const stop = screen.queryByLabelText(/^Stop the run/);
    expect(stop).not.toBeNull();
    fireEvent.click(stop as HTMLElement);
    expect(interruptRun).toHaveBeenCalledTimes(1);
  });

  it('persists, because it is a standing preference about a reflex', () => {
    setEscapeStopsRun(false);
    const raw = JSON.parse(localStorage.getItem('artemis.prefs.v1') ?? '{}');
    expect(raw.escapeStopsRun).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The other handler                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The global binding, which is a different code path with the same job.
 *
 * `useHotkeys` ignores text fields, so this one fires everywhere the composer's
 * does not — the transcript, the sidebar, the dock. Both were changed; only
 * testing one would leave the app answering Escape differently depending on
 * where the caret happened to be, which is precisely the confusion the shared
 * rule exists to prevent.
 */
describe('the global Escape binding', () => {
  it('interrupts while the setting is on', async () => {
    pressEscape();
    await vi.waitFor(() => expect(interruptRun).toHaveBeenCalledTimes(1));
  });

  it('does not, while it is off', () => {
    setEscapeStopsRun(false);
    pressEscape();
    expect(interruptRun).not.toHaveBeenCalled();
  });

  it('still denies a parked permission while it is off', () => {
    setEscapeStopsRun(false);
    setPaneState(focusedPane(), { permissionQueue: [{ id: 'p1' }] } as never);
    pressEscape();

    expect(denyPendingPermission).toHaveBeenCalledTimes(1);
    expect(interruptRun).not.toHaveBeenCalled();
  });
});
