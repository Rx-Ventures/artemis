/**
 * @vitest-environment jsdom
 *
 * The queued-message strip under the transcript, and its "read it now" lever.
 *
 * A steer accepted into a running turn is read at the provider's next tool
 * break — or, if none comes, as the next turn. Until then it is queued, and
 * the composer says so where the user is already looking, with the one action
 * that changes the timing: interrupt the current step, which the queue
 * survives by design, so the provider takes the message immediately.
 *
 * What these pin: the strip exists exactly while steers are outstanding on a
 * live run, the button is the interrupt (not a second send), and a run that
 * ended — or a pane with nothing queued — shows no strip at all.
 *
 * As with the neighbouring composer tests, `renderer/tsconfig.json` excludes
 * these, so the assertions are behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Composer } from '@/components/Composer';
import { seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const interruptRun = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const submitPrompt = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const refreshCommands = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  interruptRun,
  submitPrompt,
  refreshCommands,
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

function setUp({
  queuedSteers = ['r1:prompt:2'] as readonly string[],
  status = 'running' as 'running' | 'ended',
} = {}): void {
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
    suggestion: null,
    run: {
      runId: 'r1',
      status,
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: CAPABILITIES,
      startedAt: 0,
      queuedSteers,
    },
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

const readNow = (): HTMLElement | null => screen.queryByRole('button', { name: /Read it now/ });

beforeEach(() => {
  interruptRun.mockClear();
  submitPrompt.mockClear();
  refreshCommands.mockClear();
});

afterEach(cleanup);

describe('the queued-message strip', () => {
  it('shows while a steer is outstanding on a live run, and counts them', () => {
    setUp({ queuedSteers: ['r1:prompt:2'] });
    mount(<Composer />);
    expect(screen.getByText(/1 message queued/)).toBeTruthy();

    cleanup();
    setUp({ queuedSteers: ['r1:prompt:2', 'r1:prompt:3'] });
    mount(<Composer />);
    expect(screen.getByText(/2 messages queued/)).toBeTruthy();
  });

  it('offers the interrupt, and the button is exactly that', () => {
    setUp({ queuedSteers: ['r1:prompt:2'] });
    mount(<Composer />);

    const button = readNow();
    expect(button).not.toBeNull();
    if (button === null) throw new Error('no button');
    fireEvent.click(button);

    expect(interruptRun).toHaveBeenCalledTimes(1);
    // The lever is the interrupt — nothing is re-sent on the user's behalf.
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it('is absent with nothing queued', () => {
    setUp({ queuedSteers: [] });
    mount(<Composer />);
    expect(screen.queryByText(/message(s)? queued/)).toBeNull();
    expect(readNow()).toBeNull();
  });

  it('does not outlive the run it describes', () => {
    // The count is zeroed when the continuation claims the pane; between the
    // run's end and that claim there is nothing live to interrupt, so the
    // strip must already be gone.
    setUp({ queuedSteers: ['r1:prompt:2', 'r1:prompt:3'], status: 'ended' });
    mount(<Composer />);
    expect(readNow()).toBeNull();
  });
});
