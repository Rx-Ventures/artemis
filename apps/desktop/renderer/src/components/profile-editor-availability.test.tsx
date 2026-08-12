/**
 * @vitest-environment jsdom
 *
 * The two availability switches in the profile editor, and what they send.
 *
 * The picker's half of this feature is tested by rendering the picker
 * (`profile-availability.test.tsx`); this is the other half — the control that
 * writes the flags. Three things here are worth pinning down and none of them
 * is the switch moving:
 *
 *  - **Both values are always sent.** A boolean with a default has no "absent"
 *    for a form to mean, so a patch that only carried the interesting value
 *    would save every other field and silently drop the one the user just
 *    turned back on.
 *  - **The switches read the same direction.** Both are stored as opt-outs and
 *    shown as availability, so the form holds the positive of what it saves.
 *    An inversion here is invisible until someone hides the wrong account.
 *  - **Hiding settles the other question.** `isProfileAutoSelectable` makes
 *    `disabled` dominate, so the suggestion switch goes inert rather than
 *    staying live and implying an account can be picked for you while it is not
 *    in the menu.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProfilePatch } from '@rx-artemis/protocol';

const patches: { id: string; patch: ProfilePatch }[] = [];

let stored = [
  { id: 'p1', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' } as Record<
    string,
    unknown
  >,
];

/*
 * A bridge stub installed before anything resolves one. `resolveBridge` reads
 * `window.artemis` on its first call and memoises the answer, so this has to be
 * in place before the first store action rather than merely before the render.
 */
vi.stubGlobal('artemis', {
  version: 'test',
  platform: 'darwin',
  profiles: {
    list: async () => ({ ok: true, value: { profiles: stored } }),
    update: async ({ id, patch }: { id: string; patch: ProfilePatch }) => {
      patches.push({ id, patch });
      stored = stored.map((p) =>
        p['id'] === id
          ? { ...p, autoSelect: patch.autoSelect, disabled: patch.disabled }
          : p,
      );
      return { ok: true, value: { profile: stored[0] } };
    },
    suggestDir: async () => ({ ok: true, value: { configDir: '/home/u/.work' } }),
  },
  auth: { status: async () => ({ ok: true, value: { status: null } }) },
  sessions: { list: async () => ({ ok: true, value: { sessions: [] } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
});

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const { ProfilesSection } = await import('@/components/ProfilesScreen');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { seedApp } = await import('@/state/testkit');

function seed(profile: Record<string, unknown>): void {
  stored = [profile];
  seedApp({
    providers: [],
    profiles: [profile],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    platform: 'darwin',
    sessions: [],
    banners: [],
  });
}

/** Open the editor for the one seeded profile. */
function openEditor(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <ProfilesSection />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
}

beforeEach(() => {
  patches.length = 0;
});
afterEach(cleanup);

const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
};

describe('the availability switches', () => {
  it('start on for a profile with neither flag set', () => {
    seed({ id: 'p1', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' });
    openEditor();

    expect(screen.getByLabelText('Suggest automatically').getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.getByLabelText('Show in the profile picker').getAttribute('data-state')).toBe(
      'checked',
    );
  });

  it('sends both flags on save, so neither can be silently dropped', async () => {
    seed({ id: 'p1', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' });
    openEditor();
    save();

    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]?.patch.autoSelect).toBe(true);
    expect(patches[0]?.patch.disabled).toBe(false);
  });

  it('takes the account out of the pool without hiding it', async () => {
    seed({ id: 'p1', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' });
    openEditor();
    fireEvent.click(screen.getByLabelText('Suggest automatically'));
    save();

    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]?.patch.autoSelect).toBe(false);
    // The blunt flag is untouched — these are two requests, not two points on
    // one scale.
    expect(patches[0]?.patch.disabled).toBe(false);
  });

  it('hides the account, and stops asking about suggestions', async () => {
    seed({ id: 'p1', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' });
    openEditor();
    fireEvent.click(screen.getByLabelText('Show in the profile picker'));

    // Inert rather than merely ignored: an account that is not in the menu is
    // not one Artemis reaches for either, and a live switch would say otherwise.
    expect(screen.getByLabelText('Suggest automatically').getAttribute('data-state')).toBe(
      'unchecked',
    );
    expect(screen.getByLabelText('Suggest automatically').hasAttribute('disabled')).toBe(true);

    save();
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]?.patch.disabled).toBe(true);
  });

  it('restores what the user had chosen when the account comes back', async () => {
    // Hiding an account does not reset its pool setting — turning it back on
    // has to return it to the state it was in, not to the default.
    seed({
      id: 'p1',
      label: 'Work',
      providerId: 'claude',
      configDir: '/home/u/.work',
      autoSelect: false,
      disabled: true,
    });
    openEditor();
    fireEvent.click(screen.getByLabelText('Show in the profile picker'));

    expect(screen.getByLabelText('Suggest automatically').getAttribute('data-state')).toBe(
      'unchecked',
    );

    save();
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]?.patch.disabled).toBe(false);
    expect(patches[0]?.patch.autoSelect).toBe(false);
  });

  it('seeds both switches off for an account that is shelved', () => {
    seed({
      id: 'p1',
      label: 'Work',
      providerId: 'claude',
      configDir: '/home/u/.work',
      autoSelect: false,
      disabled: true,
    });
    openEditor();

    expect(screen.getByLabelText('Show in the profile picker').getAttribute('data-state')).toBe(
      'unchecked',
    );
  });
});
