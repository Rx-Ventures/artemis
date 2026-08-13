/**
 * @vitest-environment jsdom
 *
 * Pane-scoped selectors must be identity-stable across panes.
 * ============================================================================
 *
 * `store.ts` has a standing rule: any selector that *constructs* a value has to
 * cache it on its inputs, because selectors are read through zustand hooks that
 * decide whether to re-render by comparing the result by identity. A fresh
 * array on every read is an unbounded render loop, not a wasted allocation.
 *
 * Split view added a second half to that rule which the first version missed. A
 * selector over the *window* can hold one cached result and always hit — there
 * is one grid. A selector over a *pane* cannot: `SessionState` has up to
 * `MAX_PANES` instances, and `refreshModels` is per pane by design, so two
 * columns signed in as two accounts hold two distinct `models` arrays even when
 * the accounts offer identical models.
 *
 * With one cache slot and several panes, the columns evict each other and each
 * one's value changes identity without its state changing at all — React
 * re-renders A, which evicts B, which re-renders B, which evicts A, until it
 * gives up with "Maximum update depth exceeded" and the window goes blank.
 *
 * These tests are written the way the bug reproduces rather than the way the
 * cache is implemented: they interleave reads from two panes and assert the
 * identity holds, and they mount a full window of real panes and assert React
 * survives it. Both counts derive from `MAX_PANES` rather than a literal, so
 * raising the ceiling keeps testing the ceiling.
 * A future rewrite of the memo is free to change shape as long as both hold.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type {
  ProfileMetadata,
  ProviderDescriptor,
  ProviderModelOption,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkingArea } from '@/components/WorkingArea';
import { createPane, setPaneState, type SessionState } from '@/state/pane';
import { MAX_PANES, quickModels, thinkingLevels, useApp } from '@/state/store';

/* Radix's floating layer needs observers jsdom does not implement. */
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const PROFILE: ProfileMetadata = {
  id: 'p1',
  label: 'P',
  providerId: 'claude',
  configDir: '/Users/me/.claude',
};

const DESCRIPTOR: ProviderDescriptor = {
  id: 'claude',
  label: 'Test Provider',
  capabilities: { ...NO_CAPABILITIES, permissionModes: ['default', 'plan'] },
  models: [{ id: 'sonnet', label: 'Sonnet', note: 'Balanced.' }],
  effortLevels: [
    { id: 'low', label: 'Low', note: 'Fastest.' },
    { id: 'high', label: 'High', note: 'Deepest.' },
  ],
  available: true,
};

/**
 * A catalogue equal to every other one and identical to none.
 *
 * This is the shape `refreshModels` leaves behind: it fetches per pane, so the
 * arrays are siblings rather than the same reference. Building them separately
 * here is the whole point of the fixture — a shared constant would pass against
 * the one-slot cache the fix replaced.
 */
function freshCatalogue(): readonly ProviderModelOption[] {
  return [
    { id: 'sonnet', label: 'Sonnet', note: 'Balanced.' },
    { id: 'opus', label: 'Opus', note: 'Most capable.' },
  ];
}

/** As many panes as a window will hold — `[0, 1, … MAX_PANES - 1]`. */
function fullWindow(): readonly number[] {
  return Array.from({ length: MAX_PANES }, (_, i) => i);
}

/** One pane's state, with its own catalogue and its own selected model. */
function paneWith(model: string | null): SessionState {
  return {
    providers: [DESCRIPTOR],
    profiles: [PROFILE],
    sessions: [],
    contextWindows: {},
    // A pinned shortlist, so `quickModels` actually builds an array. With no
    // picks it returns the catalogue unchanged and never consults the cache.
    quickModelIds: ['sonnet'],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/w',
    workspace: null,
    permissionMode: 'default',
    model,
    effort: null,
    fastMode: false,
    ultracode: false,
    forkOnResume: false,
    resumeSessionId: null,
    models: freshCatalogue(),
    modelsLoading: false,
    modelsError: null,
    run: null,
    permissionQueue: [],
    tasks: [],
    promptHistory: [],
    draft: '',
  };
}

describe('pane-scoped selectors under a split window', () => {
  it('quickModels holds its identity when two panes interleave reads', () => {
    const a = paneWith(null);
    const b = paneWith(null);

    // One pane on its own: the property the single-pane window relied on.
    expect(quickModels(a)).toBe(quickModels(a));

    // Two panes, as two mounted status lines do on every render pass.
    const first = quickModels(a);
    quickModels(b);
    expect(quickModels(a)).toBe(first);
  });

  it('thinkingLevels holds its identity when two panes interleave reads', () => {
    const a = paneWith('sonnet');
    const b = paneWith('opus');

    const first = thinkingLevels(a);
    thinkingLevels(b);
    expect(thinkingLevels(a)).toBe(first);
  });

  it('holds every pane at once, not just the last two to render', () => {
    // A full window's worth, derived from the ceiling rather than a literal:
    // the cache is bounded by `MAX_PANES`, so a fixed count here would stop
    // testing residency at the limit the moment the limit moved.
    const panes = fullWindow().map((i) => paneWith(i % 2 === 0 ? 'sonnet' : 'opus'));
    const first = panes.map((pane) => thinkingLevels(pane));

    // A full sweep, then another: nothing may have been evicted in between.
    for (const pane of panes) thinkingLevels(pane);
    panes.forEach((pane, i) => expect(thinkingLevels(pane)).toBe(first[i]));
  });

  it('renders a full window of panes without exceeding React’s update depth', () => {
    const panes = fullWindow().map((i) =>
      createPane(paneWith(i % 2 === 0 ? 'sonnet' : 'opus')),
    );

    // Stacked rows of two rather than one long row, because that is the shape a
    // full window actually takes: `SPLIT_MIN_WIDTH` is a pixel floor, so the
    // columns run out of room long before the pane count does.
    const grid = [];
    for (let i = 0; i < panes.length; i += 2) {
      grid.push({ id: `row${i / 2}`, panes: panes.slice(i, i + 2) as never });
    }

    useApp.setState({
      grid: grid as never,
      focusedPaneId: panes[0]!.id,
      providers: [DESCRIPTOR],
      profiles: [PROFILE],
      quickModelIds: ['sonnet'],
      booted: true,
    });

    expect(() => {
      render(
        <TooltipProvider>
          <WorkingArea />
        </TooltipProvider>,
      );

      // `mirrorToPanes` is subscribed to the app store and writes into every
      // pane, so any window-level change at all — a banner, a session-list
      // refresh, a profile edit — puts every column through a render together.
      // That is the pass the one-slot cache could not survive.
      act(() => {
        for (const pane of panes) setPaneState(pane, { workspace: null });
      });
    }).not.toThrow();

    cleanup();
  });
});
