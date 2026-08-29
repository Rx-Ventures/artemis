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
  terminalHasFocus: vi.fn(() => false),
  writeToTerminal: vi.fn(),
  noteTerminalExit: vi.fn(),
  disposeTerminalSession: vi.fn(),
  setTerminalSessionHooks: vi.fn(),
  retheme: vi.fn(),
  // `null` is the state before any terminal has fitted — the store falls back
  // to its 80×24 guess, which is what the `started` ledger asserts against.
  preferredTerminalSize: vi.fn(() => null),
  getTerminalSelection: vi.fn(() => ''),
  onTerminalSelectionChange: vi.fn(() => () => undefined),
}));

/** Terminals the fake main process is holding, and what was asked of them. */
let started: Array<{ id: string; cwd: string }>;
let closed: string[];
/** Pages told to go away — the browser half of the same ledger. */
let closedBrowsers: string[];
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
    // Only what `closeBrowser` reaches for. Nothing here opens a page — the
    // records are injected straight into the store, because these tests are
    // about what happens to a page that exists, not about opening one.
    browser: {
      close: async ({ id }: { id: string }) => {
        closedBrowsers.push(id);
        return { ok: true, value: { id } };
      },
      onEvent: () => () => undefined,
    },
  },
});

const { DockPane } = await import('@/components/DockPane');
const {
  closePane,
  closeTerminal,
  focusedPane,
  focusPane,
  openTerminal,
  splitPane,
  toggleBrowser,
  toggleTerminal,
  useApp,
} = await import('@/state/store');
const { setPaneState } = await import('@/state/pane');
const { registerComposer } = await import('@/lib/composerFocus');
// The module the store actually calls — mocked above, so its fns are spies.
const terminalSessions = await import('@/lib/terminalSessions');

type Pane = ReturnType<typeof focusedPane>;

function renderDock(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <DockPane />
    </TooltipProvider>,
  );
}

beforeEach(async () => {
  // Back to one column, whatever the previous test left: several tests split,
  // and a surviving column would shift every owner badge and tab count after
  // it — the pane cleanup `tasks-pane.test.tsx` also does, for the reason it
  // gives. *Before* the ledgers are reset, and with a tick for the fake
  // bridge's promises to land: retiring a pane closes its unowned shells, and
  // those closes must not be mistaken for the next test's.
  for (const extra of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    setPaneState(extra, { run: null, resumeSessionId: null });
    closePane(extra.id);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  started = [];
  closed = [];
  closedBrowsers = [];
  counter = 0;
  useApp.setState({
    previews: [],
    files: [],
    terminals: [],
    browsers: [],
    activeDockTab: null,
    visibleDockTabs: [],
    // The 2.0 default, restated so a test that widened the scope cannot leak
    // into its neighbours.
    dockScope: 'pane',
    terminalSplits: [],
  });
  setPaneState(focusedPane(), { cwd: '/Users/me/project', run: null, resumeSessionId: null });
  vi.mocked(terminalSessions.terminalHasFocus).mockReturnValue(false);
  vi.mocked(terminalSessions.requestTerminalFocus).mockClear();
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

  /*
   * One button, one action.
   *
   * This was briefly a menu when the rail grew a second kind of live thing, and
   * a menu is the wrong shape for `+` on a tab strip: two items behind a click
   * is more work than the action it replaced, and `+` already means "another of
   * these" everywhere else. The browser is reached from the header instead.
   */
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
   * The `+` used to live inside the scrolling tab column, which put it
   * wherever the ninth tab pushed it — including past the fold, where the one
   * control for "another of these" was the thing that scrolled away. It is a
   * footer under the list now, and this pins the structure that keeps it one:
   * in the rail, outside the thing that scrolls.
   */
  it('keeps the + outside the scrolling tab list, so a tall strip cannot scroll it away', async () => {
    await act(async () => {
      await openTerminal();
    });
    renderDock();

    const plus = screen.getByRole('button', { name: 'Open another terminal' });
    expect(plus.closest('[role="tablist"]')).toBeNull();
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
      useApp.setState({ previews: [{ ...preview, id: 'p1', owner: { paneId: focusedPane().id } }] });
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
        previews: [
          { ...preview, id: 'p1', owner: { paneId: focusedPane().id, sessionId: 'sess-a' } },
        ],
      });
    });

    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-b' });
    });

    expect(useApp.getState().previews).toEqual([]);
    expect(useApp.getState().terminals).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  /*
   * The de-singletoning, asserted at the layer the bug lived: two panes, two
   * previews, and the second's arrival leaves the first exactly where it was.
   * Injected as records rather than through `openPreview` because the fake
   * bridge here has no preview half — what is under test is the state model.
   */
  it('lets each conversation keep its own preview', async () => {
    // Captured before the split: `splitPane` focuses the pane it creates.
    const main = focusedPane();
    let side!: Pane;
    act(() => {
      const pane = splitPane('right');
      if (pane === null) throw new Error('the grid refused the split this test needs');
      side = pane;
    });
    act(() => {
      useApp.setState({
        previews: [
          { ...preview, id: 'p1', owner: { paneId: main.id } },
          { ...preview, path: '/tmp/other.md', title: 'OTHER.md', id: 'p2', owner: { paneId: side.id } },
        ],
        dockScope: 'all',
      });
    });

    // Both drawn, each under its own conversation.
    expect(
      useApp.getState().visibleDockTabs.filter((tab) => tab.kind === 'preview'),
    ).toHaveLength(2);

    act(() => {
      closePane(side.id);
    });

    // Pane B's preview died with its conversation; pane A's is untouched.
    expect(useApp.getState().previews.map((one) => one.id)).toEqual(['p1']);
  });
});

/*
 * ⌘J. A focus toggle, and the operative word is *focus*: the second press used
 * to call `closeTerminal`, which made the key that opens a shell also the only
 * thing besides the ✕ that could kill one — from muscle memory, since the
 * press that killed felt identical to the press that opened. The tests here
 * walk the key through all three of its states and assert, at every one of
 * them, that nothing was closed.
 */
describe('⌘J, the focus toggle', () => {
  it('opens a shell when the conversation has none', async () => {
    await act(async () => {
      toggleTerminal(focusedPane());
      // `toggleTerminal` fires `openTerminal` without awaiting it; a timer
      // flush is what lets the fake bridge's promise chain land.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(started).toHaveLength(1);
    expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't1' });
  });

  it('brings the existing tab forward instead of opening a second', async () => {
    await act(async () => {
      await openTerminal();
      await openTerminal();
    });
    // The newest is in front; the pane's *first* shell is the one ⌘J owns.
    expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't2' });

    act(() => {
      toggleTerminal(focusedPane());
    });

    expect(started).toHaveLength(2);
    expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't1' });
    expect(closed).toEqual([]);
  });

  it('asks for the caret when the tab is in front but the caret is elsewhere', async () => {
    await act(async () => {
      await openTerminal();
    });
    vi.mocked(terminalSessions.requestTerminalFocus).mockClear();
    vi.mocked(terminalSessions.terminalHasFocus).mockReturnValue(false);

    act(() => {
      toggleTerminal(focusedPane());
    });

    expect(terminalSessions.requestTerminalFocus).toHaveBeenCalledWith('t1');
    expect(closed).toEqual([]);
  });

  /*
   * The pin this whole describe exists for. The old behaviour reached this
   * exact state — terminal in front, caret in it — and killed the shell.
   */
  it('NEVER closes: a press on the focused terminal hands the caret to the composer', async () => {
    await act(async () => {
      await openTerminal();
    });
    vi.mocked(terminalSessions.terminalHasFocus).mockReturnValue(true);

    const caretCameHome = vi.fn();
    const unregister = registerComposer(focusedPane().id, caretCameHome);
    try {
      act(() => {
        toggleTerminal(focusedPane());
        toggleTerminal(focusedPane());
        toggleTerminal(focusedPane());
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // However many times it is pressed: the caret moves, the shell lives.
      expect(caretCameHome).toHaveBeenCalled();
      expect(closed).toEqual([]);
      expect(started).toHaveLength(1);
      expect(useApp.getState().terminals).toHaveLength(1);
      expect(useApp.getState().activeDockTab).toEqual({ kind: 'terminal', id: 't1' });
    } finally {
      unregister();
    }
  });
});

/*
 * What `retirePane` does to the surfaces a closed column leaves behind.
 *
 * The line it draws is the one `ownerIsShown` already draws: a record whose
 * owner learned a session id can be re-shown by resuming that session into any
 * column, so it survives; one whose owner never learned an id has no way back
 * once its pane is gone, and keeping it would be a live shell running with no
 * tab that can ever reach it — invisible until quit.
 */
describe('closing a pane', () => {
  /** Split a column off to the right, for a test that will close it. */
  function sideColumn(): Pane {
    const pane = splitPane('right');
    if (pane === null) throw new Error('the grid refused the split this test needs');
    return pane;
  }

  it('disposes a shell and a page that no session ever learned about', async () => {
    let side!: Pane;
    await act(async () => {
      side = sideColumn();
      // No run, no session: the column is disposable, and the shell's owner
      // is the pane alone.
      setPaneState(side, { run: null, resumeSessionId: null });
      await openTerminal(side);
      useApp.setState((s) => ({
        browsers: [
          ...s.browsers,
          {
            info: {
              id: 'b1',
              openedAt: 0,
              state: { url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
            },
            owner: { paneId: side.id },
          },
        ],
      }));
    });

    await act(async () => {
      closePane(side.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(closed).toEqual(['t1']);
    expect(closedBrowsers).toEqual(['b1']);
    expect(useApp.getState().terminals).toEqual([]);
    expect(useApp.getState().browsers).toEqual([]);
  });

  it('keeps a session-attributed shell through retirement, and re-shows it with its session', async () => {
    // A conversation with a session opens a shell, then leaves the screen.
    await act(async () => {
      const side = sideColumn();
      setPaneState(side, { resumeSessionId: 'sess-live' });
      await openTerminal(side);
      closePane(side.id);
    });
    expect(useApp.getState().terminals[0]?.owner.sessionId).toBe('sess-live');

    /*
     * Now retire it for real. Backgrounded conversations are only destroyed by
     * eviction past the background ceiling, so this walks eight more ended
     * conversations through the column — the terminal's owner is the oldest
     * and goes first.
     */
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        const filler = sideColumn();
        setPaneState(filler, { resumeSessionId: `sess-filler-${String(i)}` });
        closePane(filler.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Retired — and the shell survived it, because its session can come back.
    expect(closed).toEqual([]);
    expect(useApp.getState().terminals).toHaveLength(1);

    // And when the session does come back, in a different column, so does the
    // tab — that is the promise that made keeping the record correct.
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-live' });
    });
    expect(useApp.getState().visibleDockTabs).toEqual([{ kind: 'terminal', id: 't1' }]);
  });
});

/** A browser record, injected: these tests are about what happens to a page
 *  that exists, and the fake bridge here has no `browser.open`. */
function aBrowser(id: string, paneId: string): void {
  useApp.setState((s) => ({
    browsers: [
      ...s.browsers,
      {
        info: {
          id,
          openedAt: 0,
          state: { url: 'https://x.example', title: 'X', loading: false, canGoBack: false, canGoForward: false },
        },
        owner: { paneId },
      },
    ],
  }));
}

/*
 * ⌘⇧B. The ⌘J bug's twin, recorded when PR #271 fixed the shell half and left
 * deliberately for the rebuild: `toggleBrowser`'s second press called
 * `closeBrowser`, which destroyed the page — scroll position, session cookie,
 * half-filled form — from the same muscle memory that used to kill shells.
 * The walk below is the ⌘J walk: at every state, nothing is destroyed.
 */
describe('⌘⇧B, the browser focus toggle', () => {
  it('brings the existing page forward instead of destroying anything', () => {
    act(() => {
      aBrowser('b1', focusedPane().id);
      useApp.setState({ activeDockTab: null });
    });

    act(() => {
      toggleBrowser(focusedPane());
    });

    expect(useApp.getState().activeDockTab).toEqual({ kind: 'browser', id: 'b1' });
    expect(closedBrowsers).toEqual([]);
  });

  it('NEVER closes: a press on the front browser hands the caret back, and the page lives', async () => {
    act(() => {
      aBrowser('b1', focusedPane().id);
    });
    act(() => {
      useApp.setState({ activeDockTab: { kind: 'browser', id: 'b1' } });
    });

    const caretCameHome = vi.fn();
    const unregister = registerComposer(focusedPane().id, caretCameHome);
    try {
      act(() => {
        toggleBrowser(focusedPane());
        toggleBrowser(focusedPane());
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // However many times it is pressed: the caret moves, the page lives.
      expect(caretCameHome).toHaveBeenCalled();
      expect(closedBrowsers).toEqual([]);
      expect(useApp.getState().browsers).toHaveLength(1);
      expect(useApp.getState().activeDockTab).toEqual({ kind: 'browser', id: 'b1' });
    } finally {
      unregister();
    }
  });
});

/*
 * The scope: the strip follows the focused conversation, with `all` as the
 * explicit everything view. The claims here are the store-level halves of what
 * `dock.test.ts` pins for the pure rules — that focus moves the strip, that
 * nothing is destroyed by being out of scope, and that the strip's own actions
 * follow the scope in view rather than silently acting on the focused column.
 */
describe('the dock scoped to the focused conversation', () => {
  function twoColumnsWithShells(): Promise<{ left: Pane; right: Pane }> {
    const left = focusedPane();
    return (async () => {
      await openTerminal(left);
      const right = splitPane('right');
      if (right === null) throw new Error('the grid refused the split this test needs');
      setPaneState(right, { cwd: '/Users/me/elsewhere', run: null, resumeSessionId: null });
      await openTerminal(right);
      return { left, right };
    })();
  }

  it('shows only the focused conversation’s tabs, and follows focus', async () => {
    let panes!: { left: Pane; right: Pane };
    await act(async () => {
      panes = await twoColumnsWithShells();
    });

    // The split focused the right pane, so the strip is the right pane's dock.
    expect(useApp.getState().visibleDockTabs).toEqual([{ kind: 'terminal', id: 't2' }]);

    act(() => {
      focusPane(panes.left.id);
    });

    // Focus moved; the strip followed. Nothing was closed on the way.
    expect(useApp.getState().visibleDockTabs).toEqual([{ kind: 'terminal', id: 't1' }]);
    expect(useApp.getState().terminals).toHaveLength(2);
    expect(closed).toEqual([]);
  });

  it('widens to every conversation on the chip, and narrows back', async () => {
    await act(async () => {
      await twoColumnsWithShells();
    });
    renderDock();

    // The chip exists only when there is a second conversation to widen into.
    const chip = screen.getByRole('button', { name: 'Show every conversation’s tabs' });
    await act(async () => {
      fireEvent.click(chip);
    });

    expect(useApp.getState().dockScope).toBe('all');
    expect(useApp.getState().visibleDockTabs).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show only this conversation’s tabs' }));
    });
    expect(useApp.getState().visibleDockTabs).toHaveLength(1);
  });

  it('labels every tab with its owner in the all view', async () => {
    await act(async () => {
      await twoColumnsWithShells();
    });
    act(() => {
      useApp.setState({ dockScope: 'all' });
    });
    renderDock();

    // Four identical terminal icons in a split was the recorded failure; the
    // badge is the fix, so it is part of the accessible name, not decoration.
    expect(screen.getByRole('tab', { name: /zsh \(pane 1\)/ })).not.toBeNull();
    expect(screen.getByRole('tab', { name: /zsh \(pane 2\)/ })).not.toBeNull();
  });

  it('opens the + in the conversation in view, not the focused one', async () => {
    let panes!: { left: Pane; right: Pane };
    await act(async () => {
      panes = await twoColumnsWithShells();
    });
    // Widen the scope, focus the left column, and bring the *right* column's
    // shell forward — the exact arrangement where "the focused pane" is the
    // wrong answer.
    act(() => {
      useApp.setState({ dockScope: 'all' });
      focusPane(panes.left.id);
      useApp.setState({ activeDockTab: { kind: 'terminal', id: 't2' } });
    });
    renderDock();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open another terminal' }));
    });

    // The new shell opened where the user was looking: the right column's
    // directory, not the focused left one's.
    expect(started[2]).toEqual({ id: 't3', cwd: '/Users/me/elsewhere' });
  });
});

/*
 * The split: a conversation's shells side by side. A view toggle over mounted
 * slots — the tabs stay, the processes are untouched, and folding back is the
 * same button. What is worth pinning is the store half: the split keys on the
 * conversation, and the toggle never closes anything.
 */
describe('splitting a conversation’s terminals', () => {
  it('offers the split once the conversation has two shells, and splits them', async () => {
    await act(async () => {
      await openTerminal();
      await openTerminal();
    });
    renderDock();

    const split = screen.getByRole('button', { name: 'Split the terminals' });
    await act(async () => {
      fireEvent.click(split);
    });

    // The split is on, keyed to the conversation, and nothing was killed —
    // both tabs are still there and both shells still running.
    expect(useApp.getState().terminalSplits).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(screen.getAllByRole('tab')).toHaveLength(2);

    // And folding back is the same control, still killing nothing.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fold the terminals back into tabs' }));
    });
    expect(useApp.getState().terminalSplits).toHaveLength(0);
    expect(closed).toEqual([]);
  });

  it('does not offer a split to a conversation with one shell', async () => {
    await act(async () => {
      await openTerminal();
    });
    renderDock();

    expect(screen.queryByRole('button', { name: 'Split the terminals' })).toBeNull();
  });
});
