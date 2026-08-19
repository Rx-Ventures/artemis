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

  it('EXPLAINS: an unreachable local server is offered and explained, not hidden', () => {
    // A missing row is not something a user can act on; "Ollama is not
    // answering" is. Same rule the hosted half already follows.
    //
    // Asserted on `aria-disabled` rather than `disabled`, which is the point of
    // `ReasonButton`: a genuinely disabled button fires no hover events, so an
    // *explained* one stays focusable and keeps its reason reachable.
    openForm();
    const ollama = screen.getByRole('button', { name: 'Ollama' });

    expect(ollama.getAttribute('aria-disabled')).toBe('true');
    expect(ollama.hasAttribute('disabled')).toBe(false);
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
