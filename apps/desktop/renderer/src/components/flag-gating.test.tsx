/**
 * @vitest-environment jsdom
 *
 * Hidden when the provider cannot; disabled-and-explained when the model cannot.
 *
 * This is the one carve-out from the rule `capability-gating.test.tsx` enforces
 * everywhere else, and the carve-out is only defensible if the line is exact —
 * so both halves are asserted here, against the same store the app runs on.
 *
 * The reasoning, once: an explained-disabled control beats a hidden one because
 * the user can *act* on the explanation. "Opus does not accept fast mode" is
 * actionable — switch to a model that does. "Codex does not accept fast mode" is
 * not: no model this provider offers has the concept, so the switch would sit
 * dead forever under a sentence that reads like something went wrong. Fast mode
 * and ultracode are the only two flags in this position.
 *
 * Same caveat as its sibling: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type {
  Capabilities,
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderModelOption,
} from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { CommandPalette } from '@/components/CommandPalette';
import { ModelsSection } from '@/components/settings/ModelsSection';
import {
  providerOffersFastMode,
  providerOffersUltracode,
  thinkingLevels,
  useApp,
} from '@/state/store';
import { appSession, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const CAPS: Capabilities = { ...NO_CAPABILITIES, permissionModes: ['default'] };

/** Claude-shaped: one model offers both flags, one offers neither. */
const CLAUDE_MODELS: readonly ProviderModelOption[] = [
  {
    id: 'opus',
    label: 'Opus 5',
    note: 'Most capable.',
    supportsFastMode: true,
    supportsUltracode: true,
  },
  { id: 'haiku', label: 'Haiku 4.5', note: 'Fastest.' },
];

/** Codex-shaped: no model has ever heard of either flag. */
const CODEX_MODELS: readonly ProviderModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', note: 'Frontier model.' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', note: 'Faster and cheaper.' },
];

const EFFORTS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: 'Fastest.' },
  { id: 'high', label: 'High', note: 'Deepest.' },
];

function useModels(models: readonly ProviderModelOption[], selected: string | null): void {
  const provider: ProviderDescriptor = {
    id: 'claude',
    label: 'Test Provider',
    capabilities: CAPS,
    models,
    effortLevels: EFFORTS,
    available: true,
  };
  seedApp({
    providers: [provider],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    models: [],
    quickModelIds: [],
    model: selected,
    effort: null,
    fastMode: false,
    ultracode: false,
    paletteOpen: false,
    run: null,
    banners: [],
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

beforeEach(() => useModels(CLAUDE_MODELS, 'opus'));
afterEach(cleanup);

describe('providerOffersFastMode / providerOffersUltracode', () => {
  it('is true when any model in the catalogue offers the flag', () => {
    // Not the *selected* model — `haiku` offers neither, and the provider still
    // has the concept because `opus` does.
    useModels(CLAUDE_MODELS, 'haiku');
    expect(providerOffersFastMode(appSession())).toBe(true);
    expect(providerOffersUltracode(appSession())).toBe(true);
  });

  it('is false when no model does', () => {
    useModels(CODEX_MODELS, 'gpt-5.5');
    expect(providerOffersFastMode(appSession())).toBe(false);
    expect(providerOffersUltracode(appSession())).toBe(false);
  });
});

describe('thinking ladder / ultracode rung', () => {
  it('carries the rung, disabled, on a model that cannot but a provider that can', () => {
    useModels(CLAUDE_MODELS, 'haiku');
    const ultra = thinkingLevels(appSession()).find((l) => l.id === 'ultracode');
    expect(ultra).toBeDefined();
    expect(ultra?.available).toBe(false);
  });

  it('drops the rung entirely on a provider with no ultracode', () => {
    useModels(CODEX_MODELS, 'gpt-5.5');
    const levels = thinkingLevels(appSession());
    // The ladder still exists — Codex has effort levels — it just ends at its
    // own top rung instead of carrying one that could never be reached.
    expect(levels.length).toBe(EFFORTS.length);
    expect(levels.some((l) => l.id === 'ultracode')).toBe(false);
  });
});

describe('command palette / fast mode', () => {
  it('lists the command disabled when the selected model cannot', () => {
    useModels(CLAUDE_MODELS, 'haiku');
    seedApp({ paletteOpen: true });
    mount(<CommandPalette />);

    const item = screen.getByText('Turn fast mode on').closest('[role="option"]');
    expect(item?.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(/does not offer fast mode/).length).toBeGreaterThan(0);
  });

  it('does not list it at all when the provider has no fast mode', () => {
    useModels(CODEX_MODELS, 'gpt-5.5');
    seedApp({ paletteOpen: true });
    mount(<CommandPalette />);

    expect(screen.queryByText('Turn fast mode on')).toBeNull();
    // And nothing is left behind explaining an absence, which would be the
    // worst of both: a sentence about a control that is not there.
    expect(screen.queryByText(/does not offer fast mode/)).toBeNull();
  });
});

describe('settings / defaults for the next run', () => {
  it('shows both switches, and explains the one this model refuses', () => {
    useModels(CLAUDE_MODELS, 'haiku');
    mount(<ModelsSection />);

    expect(screen.getByLabelText('Fast mode')).toBeTruthy();
    expect(screen.getByLabelText('Ultracode')).toBeTruthy();
    expect(screen.getAllByText(/Haiku 4.5 does not accept/).length).toBe(2);
  });

  it('drops the whole group on a provider that has neither flag', () => {
    useModels(CODEX_MODELS, 'gpt-5.5');
    mount(<ModelsSection />);

    expect(screen.queryByLabelText('Fast mode')).toBeNull();
    expect(screen.queryByLabelText('Ultracode')).toBeNull();
    // The heading goes with them rather than sitting over nothing.
    expect(screen.queryByText('Defaults for the next run')).toBeNull();
    // The catalogue itself is untouched — this is about the flags, not the pane.
    expect(screen.getByText('GPT-5.5')).toBeTruthy();
  });
});
