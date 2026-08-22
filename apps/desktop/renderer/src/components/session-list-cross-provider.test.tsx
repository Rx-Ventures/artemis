/**
 * @vitest-environment jsdom
 *
 * The sidebar spans providers; its rows must be judged by their own.
 *
 * The defect this pins: every row control was gated on the *active* pane's
 * provider, so selecting a llama.cpp profile — whose adapter honestly
 * declares `resumeSession: false` — disabled the entire session list. Every
 * Claude conversation in the sidebar refused its click with "llama.cpp does
 * not support resuming a session", a sentence that is true and irrelevant:
 * nobody was asking llama.cpp to resume them. The only way back to any
 * conversation was to switch the account at the bottom first.
 *
 * The rule the fix establishes: a row's controls answer to
 * `session.providerId`. The active provider still governs what it should —
 * the "its own sessions are not in this list" note — and nothing else here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Capabilities, ProviderDescriptor, SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionList } from '@/components/SessionList';
import { focusedPane, useApp } from '@/state/store';
import { ALL_CAPABILITIES } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** Claude, as the descriptor list reports it: everything on. */
const CLAUDE: ProviderDescriptor = {
  id: 'claude',
  label: 'Claude',
  capabilities: ALL_CAPABILITIES,
  models: [],
  effortLevels: [],
  available: true,
};

/** llama.cpp's honest answer: no session store, so none of the session verbs. */
const LLAMACPP_CAPS: Capabilities = {
  ...ALL_CAPABILITIES,
  listSessions: false,
  resumeSession: false,
  renameSession: false,
  deleteSession: false,
  tagSession: false,
};

const LLAMACPP: ProviderDescriptor = {
  id: 'llamacpp',
  label: 'llama.cpp',
  capabilities: LLAMACPP_CAPS,
  models: [],
  effortLevels: [],
  available: true,
};

const CLAUDE_SESSION: SessionSummary = {
  id: 'sess-claude-1',
  providerId: 'claude',
  profileId: 'p-claude',
  cwd: '/w',
  title: 'Claude conversation',
  updatedAt: Date.now(),
};

/** A row whose *own* provider cannot resume, for the inverse assertion. */
const LOCAL_SESSION: SessionSummary = {
  id: 'sess-local-1',
  providerId: 'llamacpp',
  profileId: 'p-local',
  cwd: '/w',
  title: 'Local conversation',
  updatedAt: Date.now() - 1_000,
};

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  version: '0.0.0',
  platform: 'darwin',
  runs: { list: async () => ({ ok: true, value: { runs: [] } }), onEvent: () => () => {} },
  sessions: {
    listAll: async () => ({
      ok: true,
      value: { sessions: useApp.getState().sessions, hasMore: false },
    }),
  },
};

function seed(activeProviderId: 'claude' | 'llamacpp'): void {
  useApp.setState({
    // Window-level facts; `mirrorToPanes` copies these into every pane.
    providers: [CLAUDE, LLAMACPP],
    profiles: [
      { id: 'p-claude', label: 'Work', providerId: 'claude', configDir: '/Users/me/.claude' },
      { id: 'p-local', label: 'RX AI', providerId: 'llamacpp', configDir: '' },
    ],
    sessions: [CLAUDE_SESSION, LOCAL_SESSION],
    sessionsLoading: false,
    sessionsError: null,
    collapsedProjects: [],
    archivedSessions: [],
    archivedExpanded: false,
    pinnedSessions: [],
    pinnedCollapsed: false,
    banners: [],
  });
  /*
   * The selection is *pane* state, not window state — seeding it on `useApp`
   * writes a key nobody reads, which is exactly how a test here could pass
   * against the pane's default provider while claiming to have switched it.
   * This is the seam the whole file exists to exercise, so it is written
   * where the component actually looks.
   */
  focusedPane().store.setState({
    activeProviderId,
    activeProfileId: activeProviderId === 'claude' ? 'p-claude' : 'p-local',
    cwd: '/w',
    run: null,
    resumeSessionId: null,
  });
}

function mount(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <SessionList />
    </TooltipProvider>,
  );
}

function rowButton(title: string): HTMLElement {
  const label = screen.getByText(title);
  const button = label.closest('button');
  if (button === null) throw new Error(`No row button holds "${title}"`);
  return button;
}

afterEach(cleanup);

describe('with a local profile active', () => {
  it('leaves every other provider’s conversation clickable', () => {
    // The regression: this row was aria-disabled with llama.cpp's reason.
    seed('llamacpp');
    mount();

    const row = rowButton('Claude conversation');
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.hasAttribute('disabled')).toBe(false);
  });

  it('says nothing about rows it no longer governs', () => {
    // The banner that declared the whole list unclickable. The listSessions
    // note above it survives — that one really is about the active provider.
    seed('llamacpp');
    mount();

    expect(screen.queryByText(/would not carry the conversation forward/)).toBeNull();
    expect(screen.getByText(/Its own sessions are not in this list/)).toBeTruthy();
  });
});

describe('the row’s own provider still governs it', () => {
  it('keeps a session disabled when its provider cannot resume, whoever is active', () => {
    // The inverse must hold or the fix is just a looser gate: a llama.cpp
    // session stays unresumable even from a Claude profile, and the reason
    // names llama.cpp — the provider that actually cannot do it.
    seed('claude');
    mount();

    const row = rowButton('Local conversation');
    expect(row.getAttribute('aria-disabled')).toBe('true');
  });

  it('and stays enabled for its own provider’s rows under any selection', () => {
    seed('claude');
    mount();

    expect(rowButton('Claude conversation').getAttribute('aria-disabled')).toBeNull();
  });
});
