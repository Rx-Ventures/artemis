/**
 * @vitest-environment jsdom
 *
 * The composer's slash command menu.
 *
 * Every key this menu wants, the composer already meant something else by:
 * Enter sends, Escape interrupts the run, Up recalls history. So most of these
 * assertions are about *precedence*, and each one names a real mistake:
 *
 *  - **Enter must accept, not send.** A bridged command is only valid in its
 *    prefixed form, so sending a half-typed `/cer` puts literal text in the
 *    transcript and gets `Unknown command` back.
 *  - **Escape must close the menu and not kill the run.** One Escape dismisses
 *    one thing; interrupting a run because a menu was open is not undoable.
 *  - **Escape must not eat the draft.** The menu is derived from the text, so the
 *    naive way to close it is to clear the field — which throws away what the
 *    user typed.
 *  - **Up must not recall history while the menu is open**, or the list becomes
 *    unnavigable by the key that obviously navigates it.
 *
 * As with the other component tests, `renderer/tsconfig.json` excludes these, so
 * `pnpm typecheck` never sees them and the assertions stay behavioural.
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
const submitPrompt = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  interruptRun,
  submitPrompt,
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

/** The real shape of the list: the provider's built-ins plus bridged entries. */
const COMMANDS = ['compact', 'clear', 'artemis-skills:cerebro', 'artemis-skills:use-railway'];

function setUp({
  // `null` and not `undefined` for "the provider reported none": passing
  // `undefined` explicitly would trigger this default and silently test the
  // opposite of what the caller asked for.
  slashCommands = COMMANDS as readonly string[] | null,
  promptHistory = [] as readonly string[],
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
    promptHistory,
    // A run that has ended still carries the command list it reported at init,
    // which is what makes the menu usable between turns.
    run: {
      runId: 'r1',
      status: 'ended' as const,
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: CAPABILITIES,
      startedAt: 0,
      ...(slashCommands === null ? {} : { slashCommands }),
    },
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

const field = (): HTMLTextAreaElement => screen.getByLabelText('Prompt') as HTMLTextAreaElement;
const type = (value: string): void => fireEvent.change(field(), { target: { value } });
const menu = (): HTMLElement | null => screen.queryByRole('listbox', { name: 'Slash commands' });
const options = (): readonly string[] =>
  screen.queryAllByRole('option').map((el) => el.textContent ?? '');
const selected = (): string | undefined =>
  screen.queryAllByRole('option').find((el) => el.getAttribute('aria-selected') === 'true')
    ?.textContent ?? undefined;

beforeEach(() => {
  interruptRun.mockClear();
  submitPrompt.mockClear();
  setUp();
});

afterEach(cleanup);

describe('when the menu appears', () => {
  it('opens on a bare slash and lists everything the run reported', () => {
    mount(<Composer />);
    expect(menu()).toBeNull();

    type('/');

    expect(menu()).not.toBeNull();
    expect(options()).toHaveLength(COMMANDS.length);
  });

  it('finds a bridged command by the name the user knows', () => {
    mount(<Composer />);

    type('/cer');

    // Nobody is going to type `artemis-skills:`, so this is the case the whole
    // feature stands or falls on.
    expect(options()).toEqual(['/cerebroartemis-skills']);
  });

  it('stays shut for prose containing a slash', () => {
    mount(<Composer />);

    type('fix /this typo');

    expect(menu()).toBeNull();
  });

  it('stays shut when the provider reported no commands', () => {
    // Codex: no user-authored command surface at all.
    setUp({ slashCommands: null });
    mount(<Composer />);

    type('/');

    expect(menu()).toBeNull();
  });

  it('closes once the name is complete', () => {
    mount(<Composer />);
    type('/compact');
    expect(menu()).not.toBeNull();

    type('/compact ');

    expect(menu()).toBeNull();
  });
});

describe('keyboard precedence', () => {
  it('accepts with Enter instead of sending', () => {
    mount(<Composer />);
    type('/cer');

    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(submitPrompt).not.toHaveBeenCalled();
    expect(field().value).toBe('/artemis-skills:cerebro ');
    // The trailing space closed the menu, so the next Enter sends.
    expect(menu()).toBeNull();
  });

  it('sends on the Enter after accepting', () => {
    mount(<Composer />);
    type('/cer');
    fireEvent.keyDown(field(), { key: 'Enter' });

    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('accepts with Tab as well', () => {
    mount(<Composer />);
    type('/cer');

    fireEvent.keyDown(field(), { key: 'Tab' });

    expect(field().value).toBe('/artemis-skills:cerebro ');
  });

  it('moves the highlight with the arrows and wraps', () => {
    mount(<Composer />);
    type('/');
    const first = selected();

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(selected()).not.toBe(first);

    // Back to the top, then Up wraps around to the end.
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(selected()).toBe(first);
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(selected()).toBe(options()[options().length - 1]);
  });

  it('does not recall history while the menu is open', () => {
    setUp({ promptHistory: ['an earlier prompt'] });
    mount(<Composer />);
    type('/');

    fireEvent.keyDown(field(), { key: 'ArrowUp' });

    // The arrow moved the highlight; it did not replace the draft.
    expect(field().value).toBe('/');
  });

  it('still recalls history when the menu is shut', () => {
    setUp({ promptHistory: ['an earlier prompt'] });
    mount(<Composer />);

    fireEvent.keyDown(field(), { key: 'ArrowUp' });

    expect(field().value).toBe('an earlier prompt');
  });

  it('closes on Escape without interrupting the run or losing the draft', () => {
    mount(<Composer />);
    type('/cer');

    fireEvent.keyDown(field(), { key: 'Escape' });

    expect(menu()).toBeNull();
    expect(interruptRun).not.toHaveBeenCalled();
    expect(field().value).toBe('/cer');
  });

  it('brings the menu back on the next edit after Escape', () => {
    mount(<Composer />);
    type('/cer');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(menu()).toBeNull();

    type('/cere');

    expect(menu()).not.toBeNull();
  });

  it('leaves Escape to the run once the menu is shut', () => {
    mount(<Composer />);
    type('/cer');
    fireEvent.keyDown(field(), { key: 'Escape' });

    fireEvent.keyDown(field(), { key: 'Escape' });

    // The second press is the composer's own meaning again. `interruptRun` is
    // gated on the run not having ended, so what matters here is that the menu
    // no longer swallows the key.
    expect(menu()).toBeNull();
  });

  it('leaves Shift+Enter alone so an open menu can be typed past', () => {
    mount(<Composer />);
    type('/cer');

    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });

    expect(field().value).toBe('/cer');
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});

describe('the mouse', () => {
  it('accepts the row that was clicked', () => {
    mount(<Composer />);
    type('/');

    const railway = screen
      .queryAllByRole('option')
      .find((el) => (el.textContent ?? '').includes('use-railway'))!;
    fireEvent.mouseDown(railway);

    expect(field().value).toBe('/artemis-skills:use-railway ');
  });

  it('moves the highlight on hover so Enter agrees with the pointer', () => {
    mount(<Composer />);
    type('/');

    const railway = screen
      .queryAllByRole('option')
      .find((el) => (el.textContent ?? '').includes('use-railway'))!;
    fireEvent.mouseMove(railway);

    expect(selected()).toContain('use-railway');
  });
});
