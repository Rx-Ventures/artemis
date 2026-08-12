/**
 * @vitest-environment jsdom
 *
 * The dock, end to end through the real store.
 *
 * `dock.test.ts` pins the rules in isolation; this pins the thing the feature
 * was actually asked for, which is a claim about *lifetime*:
 *
 *  - a terminal opens on the conversation's working directory,
 *  - its tab disappears when that conversation leaves the screen **and the shell
 *    keeps running**,
 *  - the tab comes back when the conversation does,
 *  - and the ✕ — and only the ✕ — kills the shell.
 *
 * The distinction in the middle is the one that cannot be caught by types and
 * would be caught by nobody until a `pnpm dev` died from a sidebar click, so the
 * fake bridge below records `close` calls and the assertions are as much about
 * what was *not* called as about what was.
 *
 * xterm is stubbed out entirely. It needs real layout — a canvas, measurable
 * boxes, a font — none of which jsdom has, and none of which these claims are
 * about. What is left is the store, the tab strip and the wiring between them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);

/**
 * The renderer's half of a terminal, replaced wholesale.
 *
 * Everything here is about the *element*, and jsdom has no layout — a real
 * `FitAddon` would compute a 0×0 terminal and a real `Terminal` would ask for a
 * canvas context that does not exist. Stubbing at this seam keeps the store and
 * the strip real, which is where every claim in this file lives.
 */
vi.mock('@/lib/terminalSessions', () => ({
  ensureTerminalSession: vi.fn(),
  attachTerminal: vi.fn(() => null),
  detachTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  focusTerminal: vi.fn(),
  requestTerminalFocus: vi.fn(),
  writeToTerminal: vi.fn(),
  noteTerminalExit: vi.fn(),
  disposeTerminalSession: vi.fn(),
  setTerminalSessionHooks: vi.fn(),
}));

/** Terminals the fake main process is holding, and what was asked of them. */
let started: Array<{ id: string; cwd: string }>;
let closed: string[];
let counter: number;

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: {},
    preview: {},
    terminal: {
      start: async ({ cwd }: { cwd: string }) => {
        counter += 1;
        const id = `t${String(counter)}`;
        started.push({ id, cwd });
        return {
          ok: true,
          value: {
            terminal: { id, shell: '/bin/zsh', cwd, startedAt: 0, exited: false },
          },
        };
      },
      close: async ({ id }: { id: string }) => {
        closed.push(id);
        return { ok: true, value: { id } };
      },
      write: async ({ id }: { id: string }) => ({ ok: true, value: { id } }),
      resize: async ({ id }: { id: string }) => ({ ok: true, value: { id } }),
      list: async () => ({ ok: true, value: { terminals: [] } }),
      replay: async ({ id }: { id: string }) => ({
        ok: true,
        value: { id, data: '', truncated: false },
      }),
      onEvent: () => () => undefined,
    },
  },
});

const { DockPane } = await import('@/components/DockPane');
const { closeTerminal, focusedPane, openTerminal, useApp } = await import('@/state/store');
const { setPaneState } = await import('@/state/pane');

function renderDock(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <DockPane />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  started = [];
  closed = [];
  counter = 0;
  useApp.setState({ preview: null, terminals: [], activeDockTab: null, visibleDockTabs: [] });
  setPaneState(focusedPane(), { cwd: '/Users/me/project', run: null, resumeSessionId: null });
});

afterEach(cleanup);

describe('the dock', () => {
  it('renders nothing at all when there is nothing in it', () => {
    const { container } = renderDock();
    expect(container.firstChild).toBeNull();
  });

  it('opens a shell on the conversation’s working directory', async () => {
    await act(async () => {
      await openTerminal();
    });

    expect(started).toEqual([{ id: 't1', cwd: '/Users/me/project' }]);
    renderDock();
    expect(screen.getByRole('tab', { name: /zsh/ })).not.toBeNull();
  });

  it('gives each terminal its own tab, and switches between them', async () => {
    await act(async () => {
      await openTerminal();
      await openTerminal();
    });
    renderDock();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    // The newest is in front: opening a terminal is a request to use it.
    expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't2' });

    fireEvent.click(tabs[0] as HTMLElement);
    expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't1' });
  });

  /*
   * The load-bearing claim. Everything else in the dock is chrome; this is the
   * promise that makes a terminal usable at all — that glancing at another
   * conversation does not kill the server running in it.
   */
  it('hides a tab when its session leaves, without killing the shell', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openTerminal();
    });
    expect(useApp.getState().visibleDockTabs).toHaveLength(1);

    // The column moves to a different conversation, which is what clicking
    // another row in the sidebar does to the pane this terminal belongs to.
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-b' });
    });

    expect(useApp.getState().visibleDockTabs).toEqual([]);
    // The record survives, and nothing was killed.
    expect(useApp.getState().terminals).toHaveLength(1);
    expect(closed).toEqual([]);

    const { container } = renderDock();
    expect(container.firstChild).toBeNull();
  });

  it('brings the tab back when the session comes back', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openTerminal();
    });
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-b' });
    });
    expect(useApp.getState().visibleDockTabs).toEqual([]);

    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });

    expect(useApp.getState().visibleDockTabs).toEqual([{ kind: 'terminal', id: 't1' }]);
    expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't1' });
  });

  /*
   * The degenerate case, and the reason `ownerIsShown` has a third branch: a
   * terminal opened before there is any conversation belongs to the *column*.
   *
   * There is no session for it to leave with, so the alternatives were both bad
   * — vanish the moment the first prompt starts a run, or attach to whichever
   * session happened to be opened next and die with that. Staying put is the
   * only reading that does not surprise someone who pressed ⌘J on a fresh
   * window and then got to work.
   */
  it('keeps a terminal opened before there was a session, as the column is used', async () => {
    await act(async () => {
      await openTerminal();
    });

    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    expect(useApp.getState().visibleDockTabs).toHaveLength(1);
    // And it does not quietly become that session's terminal.
    expect(useApp.getState().terminals[0]?.owner.sessionId).toBeUndefined();
  });

  it('kills the shell when the tab is closed, and only then', async () => {
    await act(async () => {
      await openTerminal();
    });
    renderDock();

    fireEvent.click(screen.getByRole('button', { name: 'Close zsh' }));

    expect(closed).toEqual(['t1']);
    expect(useApp.getState().terminals).toEqual([]);
    expect(useApp.getState().visibleDockTabs).toEqual([]);
  });

  it('closes on a middle click, as every other tab strip does', async () => {
    await act(async () => {
      await openTerminal();
    });
    renderDock();

    // `auxclick` rather than `click`, because a middle button never produces a
    // `click` — and dispatched by hand, because `fireEvent` has no helper for it.
    const tab = screen.getByRole('tab', { name: /zsh/ }).parentElement as HTMLElement;
    fireEvent(tab, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));

    expect(closed).toEqual(['t1']);
  });

  it('activates the neighbour on the left when the active tab is closed', async () => {
    await act(async () => {
      await openTerminal();
      await openTerminal();
      await openTerminal();
    });
    act(() => {
      useApp.setState({ activeDockTab: { kind: 'terminal', id: 't2' } });
    });

    act(() => {
      closeTerminal('t2');
    });

    expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't1' });
  });

  it('offers a way to open another one', async () => {
    await act(async () => {
      await openTerminal();
    });
    renderDock();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open another terminal' }));
    });

    expect(started).toHaveLength(2);
    expect(useApp.getState().terminals).toHaveLength(2);
  });

  /*
   * A shell that has ended keeps its tab so its last words stay readable — a
   * failed `exec` or a stack trace is exactly the thing you want to read after
   * the process is gone.
   */
  it('keeps the tab of a shell that has exited', async () => {
    await act(async () => {
      await openTerminal();
    });
    const { markTerminalExited } = await import('@/state/store');

    act(() => {
      markTerminalExited('t1');
    });

    expect(useApp.getState().visibleDockTabs).toHaveLength(1);
    expect(useApp.getState().terminals[0]?.exited).toBe(true);
    renderDock();
    expect(screen.getByRole('tab', { name: /zsh/ })).not.toBeNull();
  });

  it('renames a tab when the program running in it says so', async () => {
    await act(async () => {
      await openTerminal();
    });
    const { setTerminalTitle } = await import('@/state/store');

    act(() => {
      setTerminalTitle('t1', 'vim README.md');
    });
    renderDock();

    expect(screen.getByRole('tab', { name: /vim README\.md/ })).not.toBeNull();
  });
});

describe('the dock with both kinds in it', () => {
  const preview = {
    kind: 'markdown' as const,
    text: '# hi',
    title: 'NOTES.md',
    path: '/Users/me/project/NOTES.md',
    bytes: 4,
  };

  it('shows a preview and a terminal side by side, each with its own close', async () => {
    await act(async () => {
      await openTerminal();
    });
    act(() => {
      useApp.setState({ preview: { ...preview, owner: { paneId: focusedPane().id } } });
    });
    renderDock();

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Close NOTES.md' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Close zsh' })).not.toBeNull();
  });

  /*
   * The asymmetry, asserted directly. A preview is a snapshot and is destroyed
   * when its conversation leaves; a terminal is a process and is not.
   */
  it('destroys the preview but not the terminal when the conversation leaves', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openTerminal();
    });
    act(() => {
      useApp.setState({
        preview: { ...preview, owner: { paneId: focusedPane().id, sessionId: 'sess-a' } },
      });
    });

    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-b' });
    });

    expect(useApp.getState().preview).toBeNull();
    expect(useApp.getState().terminals).toHaveLength(1);
    expect(closed).toEqual([]);
  });
});
