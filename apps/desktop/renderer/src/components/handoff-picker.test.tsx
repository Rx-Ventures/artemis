/**
 * @vitest-environment jsdom
 *
 * The picker's face: the question, the facts, and the three ways out.
 *
 * The flow behind it — trigger, interrupt, settle, offer, the gates on the
 * move — is pinned in `state/handoffPicker.test.ts`. What only a render can
 * pin is the ADR's surface contract: the dialog says *what happened* (which
 * window, at what reading, when it resets), every candidate is present with
 * its live facts — the blocked ones disabled with their reason, never hidden —
 * and declining or staying are real buttons, not an implied Escape.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HandoffPicker } from '@/components/HandoffPicker';
import { PaneProvider } from '@/state/paneContext';
import { focusedPane } from '@/state/store';
import { paneState, setPaneState } from '@/state/pane';
import { capabilities, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);

/* -------------------------------------------------------------------------- */
/* Bridge                                                                     */
/* -------------------------------------------------------------------------- */

let started: string[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    start: async ({ input }: { input: { prompt: string; runId: string } }) => {
      started.push(input.prompt);
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'running',
            capabilities: capabilities(),
            startedAt: 1,
            sessionId: 'sess-1',
          },
        },
      };
    },
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    list: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    listAll: async () => ({ ok: true, value: { sessions: [], unreadableProfiles: [] } }),
  },
  providers: {
    list: async () => ({ ok: true, value: { providers: [] } }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
  },
  auth: { status: async () => ({ ok: false as const, error: { code: 'unknown', message: 'stub' } }) },
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: null } }),
    refresh: async () => ({ ok: true, value: { usage: null } }),
    onChange: () => () => undefined,
  },
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = 1_700_000_000_000;

const TRIGGER = {
  threshold: { id: 'five_hour', label: '5-hour', at: 90, match: { kind: 'window', id: 'five_hour' } },
  window: { id: 'five_hour', label: '5 hours', utilization: 93, resetsAt: NOW + 3 * 3600_000 },
  utilization: 93,
};

const SHARED_ROW = {
  id: 'sess-1',
  providerId: 'claude',
  profileId: 'p1',
  alsoInProfiles: ['p2', 'p3'],
  cwd: '/repo',
  title: 'One conversation',
  updatedAt: 10,
};

const fresh = (utilization: number) => ({
  available: true,
  subscriptionType: 'max',
  windows: [{ id: 'five_hour', label: '5 hours', utilization, resetsAt: NOW + 3600_000 }],
  fetchedAt: NOW,
});

function seedOffer(): void {
  seedApp({
    banners: [],
    sessions: [SHARED_ROW],
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.p2' },
      { id: 'p3', label: 'Backup', providerId: 'claude', configDir: '/u/.p3' },
    ],
    providers: [{ id: 'claude', label: 'Claude', capabilities: capabilities(), models: [] }],
    planUsageByProfile: { p2: fresh(20), p3: fresh(35) },
    authByProfile: { p2: { loggedIn: true }, p3: { loggedIn: false } },
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/repo',
    run: null,
    models: [],
    resumeSessionId: 'sess-1',
    handoff: 'offered',
    handoffOffer: { kind: 'limit', trigger: TRIGGER, at: NOW },
  } as never);
}

const mount = (): void => {
  render(
    <PaneProvider pane={focusedPane()}>
      <HandoffPicker />
    </PaneProvider>,
  );
};

beforeEach(() => {
  vi.setSystemTime(NOW);
  started = [];
  focusedPane().transcript.reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */

describe('HandoffPicker', () => {
  it('renders nothing while no question is open', () => {
    seedOffer();
    setPaneState(focusedPane(), { handoffOffer: null, handoff: 'none' } as never);
    mount();
    expect(screen.queryByText('Hand off this conversation?')).toBeNull();
  });

  it('says what happened: the window, the reading, the reset', () => {
    seedOffer();
    mount();

    expect(screen.getByText('Hand off this conversation?')).toBeTruthy();
    const description = screen.getByText(/5-hour limit is at 93%/);
    expect(description.textContent).toContain('Personal’s');
    expect(description.textContent).toContain('resets');
  });

  it('shows every candidate with its live meter, the blocked ones disabled with reasons', () => {
    seedOffer();
    mount();

    // Work: signed in, fresh, 20% on its binding window — chooseable.
    const work = screen.getByRole('button', { name: /Work/ });
    expect(work.hasAttribute('disabled')).toBe(false);
    expect(work.textContent).toContain('20%');

    // Backup: known signed out — present, struck, reason inline. A row that
    // vanished would read as an account taken away (the GatedItem precedent).
    const backup = screen.getByRole('button', { name: /Backup/ });
    expect(backup.hasAttribute('disabled')).toBe(true);
    expect(backup.textContent).toContain('signed out');
  });

  it('moves the conversation when a candidate is chosen', async () => {
    seedOffer();
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Work/ }));

    await waitFor(() => expect(paneState(focusedPane()).activeProfileId).toBe('p2'));
    expect(paneState(focusedPane()).resumeSessionId).toBe('sess-1');
    expect(paneState(focusedPane()).handoffOffer).toBeNull();
    // No continuity note was started — nothing was lost, so nothing is written.
    expect(started).toEqual([]);
  });

  it('declines to the continuity note through a real button', async () => {
    seedOffer();
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Write a continuity note instead' }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
    expect(paneState(focusedPane()).handoffOffer).toBeNull();
  });

  it('stays put through a real button, and latches the no', () => {
    seedOffer();
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Keep working here' }));

    expect(paneState(focusedPane()).handoff).toBe('dismissed');
    expect(paneState(focusedPane()).handoffOffer).toBeNull();
    expect(paneState(focusedPane()).activeProfileId).toBe('p1');
    expect(started).toEqual([]);
  });
});
