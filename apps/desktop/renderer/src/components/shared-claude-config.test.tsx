/**
 * @vitest-environment jsdom
 *
 * The Advanced pane, and the one property it exists to hold: the script is not
 * on screen until the user has answered the warning.
 *
 * The generator itself is tested against a real filesystem in
 * `lib/sharedClaudeConfig.test.ts` — whether the shell is correct is settled
 * there. What is left for this file is the gate, and the gate is the whole
 * point of the feature's design: a wall of `ln -s` reads as boilerplate, and
 * the consequence that surprises people (one shared `projects/`, so history
 * stops being per-account) is not visible anywhere in it. If the script can be
 * reached without the dialog, the dialog is decoration.
 *
 * The three states are asserted separately because they are three different
 * panes wearing one switch: never-accepted shows no script, on shows the share
 * script, and off-after-on shows the undo. That middle transition is the one a
 * refactor breaks — collapsing the two flags into one makes a fresh install
 * offer an undo for something it never did.
 *
 * Same caveat as the sibling component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { AdvancedSection } from '@/components/settings/AdvancedSection';
import { seedApp } from '@/state/testkit';
import { setSharedClaudeConfig, useApp } from '@/state/store';

const CLAUDE_PROFILES = [
  { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.personal' },
  { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
];

function renderPane(): void {
  render(
    <TooltipProvider>
      <AdvancedSection />
    </TooltipProvider>,
  );
}

const toggle = (): HTMLElement =>
  screen.getByRole('switch', { name: 'Share one ~/.claude across profiles' });

/** The generated script, or null when no script is on screen. */
function script(): string | null {
  const block = document.querySelector('pre');
  return block?.textContent ?? null;
}

beforeEach(() => {
  // Both flags down: a user who has never met this feature.
  useApp.setState({ sharedClaudeConfig: false, sharedClaudeConfigAcknowledged: false });
  seedApp({ profiles: CLAUDE_PROFILES as never });
});

afterEach(() => {
  cleanup();
  useApp.setState({ sharedClaudeConfig: false, sharedClaudeConfigAcknowledged: false });
});

describe('the warning gate', () => {
  it('shows no script before the switch is touched', () => {
    renderPane();
    expect(script()).toBeNull();
  });

  it('does not enable or reveal anything when the warning is cancelled', () => {
    renderPane();
    fireEvent.click(toggle());

    // The dialog is up and naming the consequence, not just saying "advanced".
    // A shared store is listed once per conversation rather than once per
    // profile, so the first consequence is the merged history itself.
    expect(screen.getByText(/Every account’s history arrives in one list/)).toBeTruthy();
    // The count is still stated where it is still true: a plugin expecting to
    // be alone sees every profile sharing the directory, and a user with two
    // accounts is told "2 profiles" rather than "several".
    expect(screen.getByText(/all 2 profiles/)).toBeTruthy();
    expect(screen.getByText(/Plugins and skills are shared wholesale/)).toBeTruthy();
    expect(script()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(useApp.getState().sharedClaudeConfig).toBe(false);
    expect(useApp.getState().sharedClaudeConfigAcknowledged).toBe(false);
    expect(script()).toBeNull();
  });

  it('reveals the sharing script once the warning is accepted', () => {
    renderPane();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Show me the script' }));

    expect(useApp.getState().sharedClaudeConfig).toBe(true);

    const text = script() ?? '';
    // Both profile directories, quoted, and the entries the user asked for.
    expect(text).toContain("profile '/home/u/.personal'");
    expect(text).toContain("profile '/home/u/.work'");
    expect(text).toContain(
      'SHARED_DIRS="commands ide plans plugins skills todos session-env projects"',
    );
    expect(text).toContain('SHARED_FILES="CLAUDE.md"');
  });
});

describe('backing out', () => {
  it('offers the undo script after the switch goes down', () => {
    renderPane();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Show me the script' }));
    fireEvent.click(toggle());

    expect(useApp.getState().sharedClaudeConfig).toBe(false);
    // The acknowledgement latches — it is what makes the undo reachable at all.
    expect(useApp.getState().sharedClaudeConfigAcknowledged).toBe(true);
    expect(script() ?? '').toContain('Stop sharing the Claude config');
  });

  it('turning it off does not ask for confirmation', () => {
    setSharedClaudeConfig(true);
    renderPane();
    fireEvent.click(toggle());

    // Nothing is at stake in asking for the undo, so no dialog stands in front
    // of the exit.
    expect(screen.queryByRole('button', { name: 'Show me the script' })).toBeNull();
    expect(useApp.getState().sharedClaudeConfig).toBe(false);
  });
});

describe('what the pane covers', () => {
  it('leaves out profiles belonging to another provider', () => {
    seedApp({
      profiles: [
        ...CLAUDE_PROFILES,
        { id: 'p3', label: 'Codex', providerId: 'codex', configDir: '/home/u/.codex' },
      ] as never,
    });
    setSharedClaudeConfig(true);
    renderPane();

    // The entry names are Claude's vocabulary and mean nothing elsewhere.
    expect(script() ?? '').not.toContain('/home/u/.codex');
  });

  it('says so rather than emitting an empty script when there are no Claude profiles', () => {
    seedApp({ profiles: [] as never });
    setSharedClaudeConfig(true);
    renderPane();

    expect(screen.getByText('No Claude profiles to name')).toBeTruthy();
    expect(script()).toBeNull();
  });
});

describe('copying', () => {
  it('reports a refused clipboard instead of ticking', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    setSharedClaudeConfig(true);
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the sharing script' }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    // The button must not claim success the write never had.
    expect(screen.queryByText('Copied')).toBeNull();

    vi.unstubAllGlobals();
  });
});
