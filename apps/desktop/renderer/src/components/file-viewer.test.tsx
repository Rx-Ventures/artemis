/**
 * @vitest-environment jsdom
 *
 * Following a file reference out of an answer and into the dock.
 *
 * The feature is two halves that meet at a callback, so the assertions are in
 * two groups that meet there too:
 *
 *  - **The link half.** Which fragments of an answer become clickable, and what
 *    they hand over when clicked. `filePaths.test.ts` pins the rule itself; what
 *    is pinned here is that the rule is actually consulted, that a fenced block
 *    is exempt from it, and that a line number survives the trip.
 *  - **The dock half.** That a click resolves the path against the *conversation's*
 *    directory, opens a tab in front, draws the file with numbered lines, and
 *    lives and dies by the same rules the preview does.
 *
 * The last of those is the one worth the setup. A file view is a snapshot, so it
 * is destroyed when its conversation leaves the screen — unlike a terminal, which
 * keeps running. Getting that backwards would leave a stale file captioned as the
 * current one under a conversation it has nothing to do with.
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
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** Paths the renderer actually asked the main process to read. */
let asked: string[];
/** What the fake main process answers with, per test. */
let answer: { ok: true; value: Record<string, unknown> } | { ok: false; error: { message: string } };

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
    terminal: { list: async () => ({ ok: true, value: { terminals: [] } }), onEvent: () => () => undefined },
    files: {
      read: async ({ path }: { path: string }) => {
        asked.push(path);
        return answer;
      },
    },
  },
});

const { DockPane } = await import('@/components/DockPane');
const { Markdown } = await import('@/components/Markdown');
const { closeFile, focusedPane, openFile, useApp } = await import('@/state/store');
const { setPaneState } = await import('@/state/pane');

function fileAnswer(over: Record<string, unknown> = {}): typeof answer {
  return {
    ok: true,
    value: {
      path: '/Users/me/project/src/store.ts',
      title: 'store.ts',
      bytes: 42,
      text: 'one\ntwo\nthree\n',
      truncated: false,
      ...over,
    },
  };
}

function renderDock(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <DockPane />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  asked = [];
  answer = fileAnswer();
  useApp.setState({ preview: null, file: null, terminals: [], activeDockTab: null, visibleDockTabs: [] });
  setPaneState(focusedPane(), { cwd: '/Users/me/project', run: null, resumeSessionId: null });
});

afterEach(cleanup);

describe('a file reference in an answer', () => {
  it('is a control, and hands over what it parsed', () => {
    const opened = vi.fn();
    render(<Markdown onOpenFile={opened}>{'I changed `src/store.ts:88` for it.'}</Markdown>);

    fireEvent.click(screen.getByRole('button', { name: 'src/store.ts:88' }));
    expect(opened).toHaveBeenCalledWith({ path: 'src/store.ts', line: 88 });
  });

  it('leaves a fragment that is not a path as plain code', () => {
    const opened = vi.fn();
    render(<Markdown onOpenFile={opened}>{'Call `useCopy` when you mean it.'}</Markdown>);

    expect(screen.queryByRole('button', { name: 'useCopy' })).toBeNull();
  });

  it('leaves a path inside a fenced block alone', () => {
    const opened = vi.fn();
    // The block is a snippet to be copied, not a set of links — and its `code`
    // element goes through the same component as an inline span.
    render(<Markdown onOpenFile={opened}>{'```\nsrc/store.ts\n```'}</Markdown>);

    expect(screen.queryByRole('button', { name: 'src/store.ts' })).toBeNull();
    // The copy control is still there, so the fence is being rendered as a fence.
    expect(screen.getByRole('button', { name: 'Copy this code' })).not.toBeNull();
  });

  it('is not offered at all where the caller wants no links', () => {
    // The preview pane and the plan card both render markdown with no `onOpenFile`.
    render(<Markdown>{'I changed `src/store.ts` for it.'}</Markdown>);
    expect(screen.queryByRole('button', { name: 'src/store.ts' })).toBeNull();
  });
});

describe('opening a file into the dock', () => {
  it('resolves a relative path against the conversation’s directory', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });

    expect(asked).toEqual(['/Users/me/project/src/store.ts']);
  });

  it('leaves an absolute path alone', async () => {
    await act(async () => {
      await openFile({ path: '/tmp/report.md' });
    });

    expect(asked).toEqual(['/tmp/report.md']);
  });

  it('opens the tab in front, and draws the file with numbered lines', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    renderDock();

    expect(useApp.getState().activeDockTab).toEqual({ kind: 'file' });
    expect(screen.getByRole('tab', { name: /store\.ts/ })).not.toBeNull();
    expect(screen.getByText('two')).not.toBeNull();
    // The gutter is drawn, and is its own element so a selection skips it.
    expect(screen.getByText('3')).not.toBeNull();
  });

  it('says how much of a clipped file it is showing, and offers no copy of it', async () => {
    answer = fileAnswer({ truncated: true, bytes: 47 * 1024 * 1024 });
    await act(async () => {
      await openFile({ path: 'huge.log' });
    });
    renderDock();

    expect(screen.getByText('partial')).not.toBeNull();
    // Copying would put a truncated file on the clipboard under a button that
    // says nothing about it.
    expect(screen.queryByRole('button', { name: 'Copy this file' })).toBeNull();
  });

  it('offers a copy of a whole file', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    renderDock();

    expect(screen.getByRole('button', { name: 'Copy this file' })).not.toBeNull();
  });

  it('does not open a tab for a file it could not read', async () => {
    answer = { ok: false, error: { message: 'There is no file at /Users/me/project/nope.ts.' } };
    await act(async () => {
      await openFile({ path: 'nope.ts' });
    });

    expect(useApp.getState().file).toBeNull();
    const { container } = renderDock();
    // Nothing in the dock at all, rather than an empty tab named after a file
    // that is not there.
    expect(container.firstChild).toBeNull();
  });

  it('closes on the ✕, leaving the rest of the dock alone', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    renderDock();

    fireEvent.click(screen.getByRole('button', { name: 'Close store.ts' }));
    expect(useApp.getState().file).toBeNull();
  });

  /*
   * The lifetime claim, and the one place this differs from a terminal: a
   * snapshot goes when its conversation does, because the link that opened it is
   * still in the transcript and reopening costs one click.
   */
  it('is destroyed when its conversation leaves the screen', async () => {
    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });
    });
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    expect(useApp.getState().visibleDockTabs).toHaveLength(1);

    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 'sess-b' });
    });

    expect(useApp.getState().file).toBeNull();
    expect(useApp.getState().visibleDockTabs).toHaveLength(0);
  });

  it('replaces the file it was showing, rather than stacking tabs', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    answer = fileAnswer({ path: '/Users/me/project/src/dock.ts', title: 'dock.ts' });
    await act(async () => {
      await openFile({ path: 'src/dock.ts' });
    });
    renderDock();

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(useApp.getState().file?.title).toBe('dock.ts');
  });

  it('forgets the line when the next link names none', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts', line: 2 });
    });
    expect(useApp.getState().file?.line).toBe(2);

    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    // Stale marks are worse than none: the reader would be told line 2 mattered
    // for a link that said nothing about it.
    expect(useApp.getState().file?.line).toBeUndefined();
  });

  it('closeFile is a no-op when nothing is open', () => {
    const before = useApp.getState();
    closeFile();
    expect(useApp.getState()).toBe(before);
  });
});
