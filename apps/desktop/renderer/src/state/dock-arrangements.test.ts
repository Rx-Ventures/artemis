/**
 * @vitest-environment jsdom
 *
 * Per-session persistence, end to end through the real store.
 *
 * `dock-layout.test.ts` pins the parsing; this pins the lifecycle ADR 0002
 * asks for — that each *conversation's* arrangement survives, not just the
 * focused pane's:
 *
 *  - what a conversation has open is filed under its **session id** at save,
 *  - a conversation emptied by hand loses its entry rather than having it
 *    resurrected at the next launch,
 *  - resuming a session gives it its arrangement back — as fresh shells and
 *    reopened URLs, an arrangement and not a session — exactly once,
 *  - and surfaces no session ever learned about stay in the legacy
 *    window-level field, which is the only place that can still name them.
 *
 * The prefs file is stubbed at `window.artemis.prefsFile`, which is the real
 * write path: what is asserted against is the JSON the next launch would read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);

vi.mock('@/lib/terminalSessions', () => ({
  ensureTerminalSession: vi.fn(),
  attachTerminal: vi.fn(() => null),
  detachTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  focusTerminal: vi.fn(),
  requestTerminalFocus: vi.fn(),
  terminalHasFocus: vi.fn(() => false),
  writeToTerminal: vi.fn(),
  noteTerminalExit: vi.fn(),
  disposeTerminalSession: vi.fn(),
  setTerminalSessionHooks: vi.fn(),
  retheme: vi.fn(),
  preferredTerminalSize: vi.fn(() => null),
  getTerminalSelection: vi.fn(() => ''),
  onTerminalSelectionChange: vi.fn(() => () => undefined),
}));

/** The preferences file, as the next launch would read it. */
let storedPrefs = JSON.stringify({
  /*
   * Seeded before the store module loads, because that is when a real launch
   * reads it: the arrangement below is what the restore tests hand back.
   */
  dockLayouts: {
    'sess-restored': {
      browsers: ['https://kept.example'],
      terminals: 2,
      files: [],
      preview: null,
      activeKind: 'terminal',
    },
  },
});

/** What the renderer asked main to do, in order. */
let started: Array<{ id: string; cwd: string }>;
let openedBrowsers: string[];
let closed: string[];
let counter: number;

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    preview: {},
    files: {},
    prefsFile: {
      read: () => storedPrefs,
      write: (text: string) => {
        storedPrefs = text;
      },
    },
    sessions: {
      list: async () => ({ ok: true, value: { sessions: [] } }),
      messages: async () => ({ ok: true, value: { events: [], hasMore: false } }),
    },
    runs: {
      list: async () => ({ ok: true, value: { runs: [] } }),
      onEvent: () => () => undefined,
    },
    terminal: {
      start: async ({ cwd }: { cwd: string }) => {
        counter += 1;
        const id = `t${String(counter)}`;
        started.push({ id, cwd });
        return {
          ok: true,
          value: { terminal: { id, shell: '/bin/zsh', cwd, startedAt: 0, exited: false } },
        };
      },
      close: async ({ id }: { id: string }) => {
        closed.push(id);
        return { ok: true, value: { id } };
      },
      write: async ({ id }: { id: string }) => ({ ok: true, value: { id } }),
      resize: async ({ id }: { id: string }) => ({ ok: true, value: { id } }),
      list: async () => ({ ok: true, value: { terminals: [] } }),
      replay: async ({ id }: { id: string }) => ({ ok: true, value: { id, data: '', truncated: false } }),
      onEvent: () => () => undefined,
    },
    browser: {
      open: async (request: { query?: string }) => {
        openedBrowsers.push(request.query ?? '');
        return {
          ok: true,
          value: {
            browser: {
              id: `b${String(openedBrowsers.length)}`,
              openedAt: 0,
              state: {
                url: request.query ?? '',
                title: '',
                loading: false,
                canGoBack: false,
                canGoForward: false,
              },
            },
          },
        };
      },
      close: async ({ id }: { id: string }) => ({ ok: true, value: { id } }),
      layout: async ({ id }: { id: string }) => ({ ok: true, value: { id } }),
      list: async () => ({ ok: true, value: { browsers: [] } }),
      onEvent: () => () => undefined,
    },
  },
});

const {
  closeBrowser,
  closeTerminal,
  focusedPane,
  markTerminalExited,
  openTerminal,
  resumeSession,
  setDockScope,
  useApp,
} = await import('@/state/store');
const { setPaneState } = await import('@/state/pane');
const { ALL_CAPABILITIES, seedApp } = await import('@/state/testkit');

/** The stored preferences, parsed — what the next launch would see. */
function stored(): Record<string, unknown> {
  return JSON.parse(storedPrefs) as Record<string, unknown>;
}

/** Any exported saver works; the scope setter is the lightest one there is. */
function save(): void {
  setDockScope(useApp.getState().dockScope);
}

/** A session row, as the sidebar would hand it to `resumeSession`. */
function summary(id: string): Parameters<typeof resumeSession>[0] {
  return {
    id,
    providerId: 'claude',
    profileId: 'p1',
    title: 'A conversation',
    cwd: '/Users/me/project',
    updatedAt: 1000,
  } as Parameters<typeof resumeSession>[0];
}

beforeEach(() => {
  started = [];
  openedBrowsers = [];
  closed = [];
  counter = 0;
  useApp.setState({
    previews: [],
    files: [],
    terminals: [],
    browsers: [],
    activeDockTab: null,
    visibleDockTabs: [],
    dockScope: 'pane',
  });
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: ALL_CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/Users/me/project',
    run: null,
    resumeSessionId: null,
    permissionQueue: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capturing per session', () => {
  it('files each conversation’s surfaces under its session id', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openTerminal();
      await openTerminal();
    });

    save();

    const map = stored()['dockLayouts'] as Record<string, { terminals: number }>;
    expect(map['sess-a']?.terminals).toBe(2);
  });

  it('counts working shells only — an exited tab is not part of the arrangement', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openTerminal();
      await openTerminal();
    });
    act(() => {
      markTerminalExited('t1');
    });

    save();

    const map = stored()['dockLayouts'] as Record<string, { terminals: number }>;
    // The exited shell keeps its tab on screen — its last words stay readable
    // — but a restore reopens *working* shells, and it is not one.
    expect(map['sess-a']?.terminals).toBe(1);
  });

  it('deletes the entry of a conversation whose dock was emptied by hand', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openTerminal();
    });
    save();
    expect((stored()['dockLayouts'] as Record<string, unknown>)['sess-a']).toBeDefined();

    act(() => {
      closeTerminal('t1');
    });
    save();

    // The ✕ was the user saying what this conversation's dock should be:
    // empty. Restoring the shell anyway next launch would overrule them.
    expect((stored()['dockLayouts'] as Record<string, unknown>)['sess-a']).toBeUndefined();
  });

  it('keeps surfaces no session ever learned about in the window-level field', async () => {
    // A shell on a blank column — no conversation, so no session id to file
    // it under. The legacy field is the only address that can still name it.
    await act(async () => {
      await openTerminal();
    });

    save();

    expect((stored()['dockLayout'] as { terminals: number }).terminals).toBe(1);
    expect(stored()['dockLayouts']).not.toHaveProperty('sess-a');
  });
});

describe('restoring on resume', () => {
  it('gives a conversation its arrangement back when it is opened', async () => {
    await act(async () => {
      resumeSession(summary('sess-restored'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Two fresh shells in the conversation's own directory and the kept page —
    // an arrangement, not a session: nothing here claims to be the old work.
    expect(started).toEqual([
      { id: 't1', cwd: '/Users/me/project' },
      { id: 't2', cwd: '/Users/me/project' },
    ]);
    expect(openedBrowsers).toEqual(['https://kept.example']);
    // The stored front kind came back in front.
    expect(useApp.getState().activeDockTab?.kind).toBe('terminal');
    // And everything reopened belongs to the session, so it will follow the
    // conversation and be captured under the same key at the next save.
    expect(useApp.getState().terminals.every((one) => one.owner.sessionId === 'sess-restored')).toBe(
      true,
    );
  });

  it('restores once: coming back to the conversation does not duplicate its dock', async () => {
    await act(async () => {
      resumeSession(summary('sess-restored'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const openedOnce = started.length;

    // Away to another conversation, and back.
    await act(async () => {
      resumeSession(summary('sess-elsewhere'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      resumeSession(summary('sess-restored'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The live records re-shown by `ownerIsShown` are the truth now; a second
    // restore on top of them would be two more shells nobody asked for.
    expect(started.length).toBe(openedOnce);
    expect(closed).toEqual([]);
  });
});
