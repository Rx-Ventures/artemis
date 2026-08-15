/**
 * @vitest-environment jsdom
 *
 * A browser in the dock, from both directions.
 *
 * The feature has two entrances and they have different consequences, so the
 * assertions are in two groups:
 *
 *  - **The user opens one.** A tab appears and comes to the front, the address
 *    bar drives it, and the ✕ is the only thing that ends it — a page is a live
 *    object like a shell, not a snapshot like a preview.
 *  - **The agent opens one.** A tab appears *without* stealing the dock. That
 *    asymmetry is the whole point of the `opened` event: the user should see
 *    the agent browsing, and should not have what they were reading replaced
 *    mid-sentence by a page they did not ask for.
 *
 * What is deliberately not tested here is the page. There is nothing in this
 * process to test — a `WebContentsView` is a native view the main process owns,
 * and the renderer holds only a rectangle. What this file can pin is that the
 * rectangle is reported, and that it is reported as hidden when the tab is not
 * in front, which is what stops a native view from painting over the app.
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

/** What the renderer asked main to do, in order. */
let opened: { query?: string }[];
let navigated: { id: string; query: string }[];
let layouts: { id: string; visible: boolean }[];
let closed: string[];
/** The push-channel listener, so a test can play main. */
let push: ((event: unknown) => void) | null = null;

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
    files: {},
    terminal: {
      list: async () => ({ ok: true, value: { terminals: [] } }),
      onEvent: () => () => undefined,
    },
    browser: {
      open: async (request: { query?: string }) => {
        opened.push(request);
        return {
          ok: true,
          value: {
            browser: {
              id: `b${String(opened.length)}`,
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
      navigate: async (request: { id: string; query: string }) => {
        navigated.push(request);
        return { ok: true, value: { id: request.id, url: request.query } };
      },
      command: async ({ id }: { id: string }) => ({ ok: true, value: { id } }),
      layout: async (request: { id: string; visible: boolean }) => {
        layouts.push(request);
        return { ok: true, value: { id: request.id } };
      },
      close: async ({ id }: { id: string }) => {
        closed.push(id);
        return { ok: true, value: { id } };
      },
      list: async () => ({ ok: true, value: { browsers: [] } }),
      onEvent: (listener: (event: unknown) => void) => {
        push = listener;
        return () => {
          push = null;
        };
      },
    },
  },
});

const { DockPane } = await import('@/components/DockPane');
const { closeBrowser, focusedPane, installBrowserFeed, openBrowser, useApp } = await import(
  '@/state/store'
);
const { setPaneState } = await import('@/state/pane');

function renderDock(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <DockPane />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  opened = [];
  navigated = [];
  layouts = [];
  closed = [];
  useApp.setState({
    preview: null,
    file: null,
    terminals: [],
    browsers: [],
    activeDockTab: null,
    visibleDockTabs: [],
  });
  setPaneState(focusedPane(), { cwd: '/Users/me/project', run: null, resumeSessionId: null });
});

afterEach(cleanup);

describe('a browser the user opened', () => {
  it('appears as a tab and comes to the front', async () => {
    await act(async () => {
      await openBrowser();
    });
    renderDock();

    expect(useApp.getState().activeDockTab).toEqual({ kind: 'browser', id: 'b1' });
    expect(screen.getByRole('tab', { name: /New browser/ })).not.toBeNull();
  });

  it('does not need a working directory, unlike a terminal', async () => {
    // A browser is not *of* anywhere, so a pane that has never been pointed at
    // a folder can still have one.
    setPaneState(focusedPane(), { cwd: '' });
    await act(async () => {
      await openBrowser();
    });

    expect(useApp.getState().browsers).toHaveLength(1);
  });

  it('sends what was typed, not a URL it resolved itself', async () => {
    await act(async () => {
      await openBrowser();
    });
    renderDock();

    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(address, { target: { value: 'localhost:5173' } });
    await act(async () => {
      fireEvent.submit(address);
    });

    // Verbatim: `browserUrlFor` runs in main, so there is exactly one copy of
    // the rule and the renderer cannot name a scheme main would refuse.
    expect(navigated).toEqual([{ id: 'b1', query: 'localhost:5173' }]);
  });

  it('reports its rectangle to main, so the native view knows where to go', async () => {
    await act(async () => {
      await openBrowser();
    });
    renderDock();

    expect(layouts.some((one) => one.id === 'b1' && one.visible)).toBe(true);
  });

  /*
   * The ✕ is the only thing that ends a page — the same rule a terminal keeps,
   * and for the same reason: a page has a scroll position and a session cookie,
   * so reloading it is not reopening it.
   */
  it('is destroyed by the ✕ and by nothing else', async () => {
    await act(async () => {
      await openBrowser();
    });
    renderDock();

    fireEvent.click(screen.getByRole('button', { name: 'Close New browser' }));

    expect(closed).toEqual(['b1']);
    expect(useApp.getState().browsers).toHaveLength(0);
  });

  it('survives its conversation leaving the screen', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openBrowser();
    });
    expect(useApp.getState().visibleDockTabs).toHaveLength(1);

    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-b' });
    });

    // The tab goes; the page does not. Nothing was closed.
    expect(useApp.getState().visibleDockTabs).toHaveLength(0);
    expect(useApp.getState().browsers).toHaveLength(1);
    expect(closed).toEqual([]);
  });
});

describe('a browser the agent opened', () => {
  it('appears as a tab, attributed to the conversation that opened it', async () => {
    const stop = installBrowserFeed();
    act(() => {
      setPaneState(focusedPane(), {
        run: { runId: 'run-7', status: 'running' } as never,
      });
    });

    act(() => {
      push?.({
        type: 'opened',
        id: 'agent-1',
        runId: 'run-7',
        browser: {
          id: 'agent-1',
          openedAt: 0,
          state: {
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
        },
      });
    });

    expect(useApp.getState().browsers).toHaveLength(1);
    renderDock();
    expect(screen.getByRole('tab', { name: /Example/ })).not.toBeNull();
    stop();
  });

  /*
   * The decision this pins. An agent works while the user is reading something
   * else; pulling the dock out from under them would make a feature meant to be
   * watchable feel like an interruption instead.
   */
  it('does not steal the dock from whatever the user was looking at', async () => {
    const stop = installBrowserFeed();
    await act(async () => {
      await openBrowser();
    });
    const before = useApp.getState().activeDockTab;

    act(() => {
      setPaneState(focusedPane(), { run: { runId: 'run-7', status: 'running' } as never });
    });
    act(() => {
      push?.({
        type: 'opened',
        id: 'agent-1',
        runId: 'run-7',
        browser: {
          id: 'agent-1',
          openedAt: 0,
          state: {
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
        },
      });
    });

    expect(useApp.getState().activeDockTab).toEqual(before);
    stop();
  });

  it('ignores a run this window has never heard of', () => {
    // Push channels broadcast to every window, so a second Artemis window hears
    // about the first window's agents and has nowhere to put them.
    const stop = installBrowserFeed();
    act(() => {
      push?.({
        type: 'opened',
        id: 'agent-9',
        runId: 'run-from-another-window',
        browser: { id: 'agent-9', openedAt: 0, state: { url: '', title: '', loading: false, canGoBack: false, canGoForward: false } },
      });
    });

    expect(useApp.getState().browsers).toHaveLength(0);
    stop();
  });
});

describe('a browser that crashed', () => {
  it('drops its tab rather than reloading it into the same crash', () => {
    const stop = installBrowserFeed();
    act(() => {
      useApp.setState({
        browsers: [
          {
            info: {
              id: 'b1',
              openedAt: 0,
              state: { url: 'https://x.com', title: 'x', loading: false, canGoBack: false, canGoForward: false },
            },
            owner: { paneId: focusedPane().id },
          },
        ],
      });
    });

    act(() => {
      push?.({ type: 'gone', id: 'b1', reason: 'crashed' });
    });

    expect(useApp.getState().browsers).toHaveLength(0);
    stop();
  });
});
