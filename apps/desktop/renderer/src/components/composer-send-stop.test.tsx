/**
 * @vitest-environment jsdom
 *
 * Which action the end of the composer is offering.
 *
 * One button carries both Send and Stop, so every one of these assertions is
 * about a state where the wrong glyph is a real mistake rather than a cosmetic
 * one:
 *
 *  - **Stop must be reachable for the whole of a live run.** Not through
 *    Escape alone — through something on screen. The failure mode is a run
 *    nobody can end from the window, which is the app wedged.
 *  - **A prompt being typed must not sit under a Stop.** Mid-run steering means
 *    the user is aiming at their own sentence; a button that fires an interrupt
 *    when they meant to send it is the worst outcome available here.
 *  - **Whitespace is not a prompt.** `send` refuses it, so a Send offered for
 *    it would be a button that does nothing while the only button that would
 *    have done something is hidden behind it.
 *
 * As with the other component tests, `renderer/tsconfig.json` excludes these,
 * so `pnpm typecheck` never sees them and the assertions stay behavioural.
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
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  interruptRun,
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

/** Seed a window with one provider, and a run only if `live`. */
function setUp({ live = false, steering = true, draft = '', stopping = false } = {}): void {
  const capabilities = { ...CAPABILITIES, midRunSteering: steering };
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/w',
    draft,
    permissionQueue: [],
    banners: [],
    promptHistory: [],
    run: live
      ? {
          runId: 'r1',
          status: 'running' as const,
          providerId: 'claude',
          profileId: 'p1',
          cwd: '/w',
          capabilities,
          startedAt: 0,
          ...(stopping ? { interruptRequested: true } : {}),
        }
      : null,
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

const send = (): HTMLElement | null => screen.queryByLabelText(/^Send the prompt/);
const stop = (): HTMLElement | null => screen.queryByLabelText(/^Stop the run/);

beforeEach(() => {
  interruptRun.mockClear();
  setUp();
});

afterEach(cleanup);

describe('the button at the end of the composer', () => {
  it('sends when nothing is running, whether or not anything is typed', () => {
    mount(<Composer />);

    expect(stop()).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } });

    expect(stop()).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it('stops when a run is live and there is nothing to send', () => {
    setUp({ live: true });
    mount(<Composer />);

    expect(send()).toBeNull();
    expect(stop()).not.toBeNull();

    fireEvent.click(stop() as HTMLElement);
    expect(interruptRun).toHaveBeenCalledTimes(1);
  });

  it('goes back to sending the moment there is something to steer with', () => {
    setUp({ live: true });
    mount(<Composer />);
    expect(stop()).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'also check the tests' } });

    // The user is aiming at their own sentence now. Firing an interrupt here
    // is the mistake this whole arrangement exists to avoid.
    expect(stop()).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not count whitespace as something to send', () => {
    setUp({ live: true });
    mount(<Composer />);

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '   \n  ' } });

    expect(send()).toBeNull();
    expect(stop()).not.toBeNull();
  });

  it('answers a stop that has been pressed, rather than offering it again', () => {
    // The seconds between the click and `run.end` belong to the provider, and
    // an unchanged Stop for all of them is the "SUPER slow and laggy" report:
    // a button that is working looking exactly like one that is broken. The
    // acknowledged state is read from the run — `interruptRun` writes it
    // synchronously — so this is what the click looks like one frame later.
    setUp({ live: true, stopping: true });
    mount(<Composer />);

    expect(send()).toBeNull();
    expect(stop()).toBeNull();
    const acknowledged = screen.getByLabelText('Stopping the run…') as HTMLButtonElement;
    expect(acknowledged.disabled).toBe(true);
  });

  it('keeps a run stoppable when the composer holds text it cannot send', () => {
    // A provider that cannot be steered disables the field mid-run, so whatever
    // was already in it is unsendable. Offering Send there would be a disabled
    // button where the only usable one should be — a live run with no way to
    // end it from the window.
    setUp({ live: true, steering: false, draft: 'typed before the run started' });
    mount(<Composer />);

    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).disabled).toBe(true);
    expect(send()).toBeNull();
    expect(stop()).not.toBeNull();
  });
});
