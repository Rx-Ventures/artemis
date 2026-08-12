/**
 * @vitest-environment jsdom
 *
 * What the profile picker shows once accounts can be shelved.
 *
 * A profile has two availability flags and they do different jobs.
 * `autoSelect: false` takes an account out of the *pool* Artemis picks from and
 * changes nothing about the menu — that half is tested next door, in
 * `recommended-profile.test.tsx`, because it is only ever visible as an absence
 * in the Recommended section. `disabled: true` takes it out of the *menu*, and
 * that is what this file is about.
 *
 * The interesting cases are all the edges of one filter:
 *
 *  - the ordinary hide, which is the whole feature;
 *  - the account that is hidden *and running*, which cannot be filtered out
 *    without leaving a radio group with nothing checked and no way off it;
 *  - every account hidden, which is a dead end the user built and so needs a
 *    different sentence from the dead end of having no accounts at all.
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

function seed(profiles: readonly Record<string, unknown>[], activeProfileId: string | null): void {
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
    planUsageByProfile: {},
  });
}

const personal = { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.personal' };
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

describe('the profile picker', () => {
  it('leaves a disabled account out of the list', () => {
    seed([personal, { ...work, disabled: true }], 'p1');
    openProfileMenu();

    expect(screen.getAllByText('Personal').length).toBeGreaterThan(0);
    expect(screen.queryByText('Work')).toBeNull();
  });

  it('keeps an account that opted out of the pool but was not hidden', () => {
    // The distinction the two flags exist to draw: this one is still a thing
    // you can pick, it is just not one that gets picked for you.
    seed([personal, { ...work, autoSelect: false }], 'p1');
    openProfileMenu();

    expect(screen.getAllByText('Work').length).toBe(1);
  });

  it('still lists the running account after it is disabled, and says so', () => {
    // Disabling the profile you are working in is the ordinary way to say
    // "finish here, then stop using this". Dropping the row would leave the
    // radio group with no checked value — the menu would answer "which account
    // am I in?" with silence — and nothing to move off it with.
    seed([personal, { ...work, disabled: true }], 'p2');
    openProfileMenu();

    expect(screen.getAllByText('Work').length).toBeGreaterThan(0);
    expect(screen.getByText('disabled')).not.toBeNull();
  });

  it('does not carry that exception to the other accounts', () => {
    seed([{ ...personal, disabled: true }, { ...work, disabled: true }], 'p2');
    openProfileMenu();

    // Only the running one comes back. A single exception, not a mode.
    expect(screen.queryByText('Personal')).toBeNull();
    expect(screen.getAllByText('Work').length).toBeGreaterThan(0);
  });

  it('distinguishes “none exist” from “you disabled them all”', () => {
    seed([{ ...personal, disabled: true }, { ...work, disabled: true }], null);
    openProfileMenu();

    // Telling someone with two accounts that no profile exists would be a lie
    // about their own setup, at the moment they most need to be pointed at the
    // screen where they can undo it.
    expect(screen.getByText(/Every profile is disabled/)).not.toBeNull();
    expect(screen.queryByText(/No profile exists yet/)).toBeNull();
  });

  it('says nothing exists when nothing does', () => {
    seed([], null);
    openProfileMenu();

    expect(screen.getByText(/No profile exists yet/)).not.toBeNull();
  });
});
