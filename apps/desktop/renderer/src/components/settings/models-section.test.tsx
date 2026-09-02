/**
 * @vitest-environment jsdom
 *
 * The Models pane opens for an account that has pinned nothing.
 *
 * That sentence is the whole test, and it describes the state most accounts are
 * in. The pane read its pins with `useApp((s) => … ?? [])`, and a zustand
 * selector's result is compared by identity: the fallback allocated a new array
 * on every read, so `useSyncExternalStore` saw a changed snapshot on every
 * check, React looped to its update-depth ceiling and unmounted the tree.
 * Settings did not open — the window went blank, on a machine that had done
 * nothing more unusual than never pinning a model (React error #185, reported
 * from two machines on 2.4.5).
 *
 * Two properties are pinned here, and the second is why the bug survived a
 * suite that already rendered every settings pane:
 *
 *  - **A catalogue is present.** The pins selector lives inside `Catalogue`,
 *    which is only mounted when there are models to list. A pane rendered
 *    against an empty store draws the empty state instead and never reaches the
 *    hook, so "every section renders" passed throughout.
 *  - **The rows are asserted, not the chrome.** A pane that renders nothing at
 *    all still has a title. The models have to be on screen.
 *
 * The loop is caught rather than described: React throws on the update-depth
 * ceiling, so a regression fails this file loudly instead of leaving a subtly
 * wrong render to interpret.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import type { ProviderModelOption } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ModelsSection } from '@/components/settings/ModelsSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const MODELS: readonly ProviderModelOption[] = [
  { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1', note: 'The one that started this.' },
  { id: 'opus[1m]', label: 'Opus 5', note: 'The most capable general model.' },
];

const PROFILE = {
  id: 'p1',
  label: 'storrence.dev',
  providerId: 'claude',
  configDir: '/Users/me/.claude',
};

const PROVIDER = {
  id: 'claude',
  label: 'Claude',
  capabilities: {
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
  },
  models: MODELS,
  effortLevels: [],
  available: true,
};

/** The pane, with a catalogue to list and the pins map in some state. */
function mount(quickModelIdsByProfile: Record<string, readonly string[]>): void {
  seedApp({
    providers: [PROVIDER],
    profiles: [PROFILE],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    models: MODELS,
    modelsLoading: false,
    modelsError: null,
    quickModelIdsByProfile,
    run: null,
    permissionQueue: [],
  });
  render(
    <TooltipProvider>
      <ModelsSection />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  seedApp({ quickModelIdsByProfile: {} });
});

afterEach(cleanup);

describe('the Models pane', () => {
  it('lists the catalogue for an account that has pinned nothing', () => {
    // The reported crash, in the state that produced it: a real catalogue and
    // no entry at all in the pins map.
    mount({});

    expect(screen.getByText('Fable 5.1')).not.toBeNull();
    expect(screen.getByText('Opus 5')).not.toBeNull();
  });

  it('lists it for a profile whose entry exists but is empty', () => {
    // The other allocating branch: an entry that is present and empty is a
    // different path through the fallback, and unpinning your last model is how
    // an account arrives here.
    mount({ p1: [] });

    expect(screen.getByText('Fable 5.1')).not.toBeNull();
  });

  it('lists it for a profile that has pins', () => {
    // The state that always worked — a stored array is read straight out of the
    // store and has a stable identity. Kept so the fix cannot be "make the
    // pinned case allocate too".
    mount({ p1: ['opus[1m]'] });

    expect(screen.getByText('Fable 5.1')).not.toBeNull();
    expect(screen.getByText('Opus 5')).not.toBeNull();
  });
});
