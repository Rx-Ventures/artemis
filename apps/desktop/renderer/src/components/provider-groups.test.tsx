/**
 * @vitest-environment jsdom
 *
 * The two halves of the provider picker.
 *
 * Hosted providers are entered through an account and a config directory; local
 * ones through an address. That is a different enough thing that they are shown
 * apart, and the split is driven by each descriptor's `kind` rather than by a
 * list kept in the component — so a seventh provider lands in the right half
 * without this file or `ProfilesScreen` being edited.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.stubGlobal('artemis', {
  version: 'test',
  platform: 'darwin',
  profiles: {
    list: async () => ({ ok: true, value: { profiles: [] } }),
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

const provider = (
  id: string,
  label: string,
  kind: 'hosted' | 'local' | undefined,
  available = true,
): Record<string, unknown> => ({
  id,
  label,
  ...(kind === undefined ? {} : { kind }),
  available,
  ...(available ? {} : { unavailableReason: `${label} is not answering.` }),
  capabilities: {},
});

function seed(providers: readonly Record<string, unknown>[]): void {
  seedApp({
    providers,
    profiles: [],
    activeProviderId: 'claude',
    activeProfileId: null,
    platform: 'darwin',
    sessions: [],
    banners: [],
  });
}

/**
 * Show the create form, which is the only place the provider is chosen.
 *
 * No click needed: with no profiles seeded the pane opens straight into the
 * form, because an empty screen whose only affordance is a button is a dead end
 * for a first run.
 */
function openForm(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <ProfilesSection />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  seed([
    provider('claude', 'Claude', undefined),
    provider('codex', 'Codex', 'hosted'),
    provider('lmstudio', 'LM Studio', 'local'),
    provider('ollama', 'Ollama', 'local', false),
  ]);
});
afterEach(cleanup);

describe('the provider picker splits hosted from local', () => {
  it('shows both headings', () => {
    openForm();

    expect(screen.getByText(/Hosted — signed in to an account/)).toBeTruthy();
    expect(screen.getByText(/Local — a server on this machine/)).toBeTruthy();
  });

  it('DEFAULT: a descriptor with no kind is hosted, not dropped', () => {
    // Claude's descriptor predates `kind`. Treating an absent value as anything
    // other than hosted would make an existing provider vanish from the form.
    openForm();

    expect(screen.getByRole('button', { name: 'Claude' })).toBeTruthy();
  });

  it('puts every provider in exactly one half, and none of them nowhere', () => {
    openForm();

    for (const label of ['Claude', 'Codex', 'LM Studio', 'Ollama']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('orders hosted above local, because local is the deliberate choice', () => {
    openForm();

    const body = document.body.textContent ?? '';
    expect(body.indexOf('Hosted —')).toBeLessThan(body.indexOf('Local —'));
  });

  it('CHOOSABLE: an unreachable local server can still have a profile made for it', () => {
    /*
     * This used to assert the opposite, and the opposite was a dead end.
     *
     * A local profile *is* an address — nothing to install, nothing to sign
     * into — so whether the server answers right now says nothing about
     * whether the profile can exist. Worse, the availability probe only ever
     * asks the provider's *default* port: anyone running LM Studio on another
     * port, or on the machine beside them, could never reach the form where
     * they would say so. You had to already be reachable at the address you
     * were trying to change.
     *
     * The hosted half keeps the old rule, and correctly: a CLI that is not
     * installed cannot have an account, and neither the install nor the sign-in
     * can happen from this form.
     */
    openForm();
    const ollama = screen.getByRole('button', { name: 'Ollama' });

    expect(ollama.getAttribute('aria-disabled')).toBeNull();
    expect(ollama.hasAttribute('disabled')).toBe(false);

    fireEvent.click(ollama);
    expect(ollama.getAttribute('aria-pressed')).toBe('true');
  });

  it('says what the probe found, without making it a wall', () => {
    // Reported rather than enforced: the reason is worth reading — you may
    // simply need to start the server — but it is not a refusal.
    openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Ollama' }));

    expect(screen.getByText(/Ollama is not answering/)).toBeTruthy();
    expect(screen.getByText(/it is an address, not an installation/)).toBeTruthy();
  });

  it('still refuses a hosted provider that is not installed', () => {
    // The rule that has not changed, pinned beside the one that did.
    seed([provider('codex', 'Codex', 'hosted', false)]);
    openForm();
    const codex = screen.getByRole('button', { name: 'Codex' });

    expect(codex.getAttribute('aria-disabled')).toBe('true');
  });

  it('describes a local profile as an address rather than an account', () => {
    openForm();
    fireEvent.click(screen.getByRole('button', { name: 'LM Studio' }));

    expect(screen.getByText(/nothing to sign in to/i)).toBeTruthy();
  });

  it('describes a hosted profile as an account with a config directory', () => {
    openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

    expect(screen.getByText(/Which CLI this account belongs to/i)).toBeTruthy();
  });

  it('omits a half nobody has a provider for, rather than an empty heading', () => {
    cleanup();
    seed([provider('claude', 'Claude', 'hosted')]);
    openForm();

    expect(screen.queryByText(/Local — a server on this machine/)).toBeNull();
  });
});
