/**
 * @vitest-environment jsdom
 *
 * Following a file reference out of an answer and into the dock.
 *
 * The feature is two halves that meet at a callback, so the assertions are in
 * two groups that meet there too:
 *
 *  - **The link half.** Which fragments of an answer become clickable, and what
 *    they hand over when clicked. `filePaths.test.ts` pins the shape rule; what
 *    is pinned here is that the rule is actually consulted, that a fenced block
 *    is exempt from it, that a line number survives the trip — and that being
 *    path-shaped is not enough. A fragment is only underlined once the main
 *    process has said there is a file at the other end of it.
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
/** Batches the renderer asked the main process to check, in the order sent. */
let checked: string[][];
/** Which paths the fake disk has a file at. Everything else is not there. */
let onDisk: Set<string>;
/** What the fake main process answers a read with, per test. */
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
      check: async ({ paths }: { paths: string[] }) => {
        checked.push([...paths]);
        return { ok: true, value: { reachable: paths.filter((path) => onDisk.has(path)) } };
      },
    },
  },
});

const { DockPane } = await import('@/components/DockPane');
const { Markdown } = await import('@/components/Markdown');
const { closeFile, focusedPane, openFile, pinFile, useApp } = await import('@/state/store');
const { setPaneState } = await import('@/state/pane');
const { resetFileReach } = await import('@/lib/fileReach');

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

/**
 * Draw some markdown with links enabled, and let the reachability check land.
 *
 * The check is a round trip, so a link is never there on the first paint —
 * which is the behaviour, not an artefact of the test. The extra macrotask is
 * what `fileReach` coalesces a commit's worth of spans into.
 */
async function renderAnswer(text: string, open = vi.fn()): Promise<typeof open> {
  render(<Markdown files={{ cwd: '/Users/me/project', open }}>{text}</Markdown>);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return open;
}

beforeEach(() => {
  asked = [];
  checked = [];
  onDisk = new Set(['/Users/me/project/src/store.ts']);
  answer = fileAnswer();
  resetFileReach();
  useApp.setState({ previews: [], files: [], terminals: [], activeDockTab: null, visibleDockTabs: [] });
  setPaneState(focusedPane(), { cwd: '/Users/me/project', run: null, resumeSessionId: null });
});

afterEach(cleanup);

describe('a file reference in an answer', () => {
  it('is a control, and hands over what it parsed', async () => {
    const opened = await renderAnswer('I changed `src/store.ts:88` for it.');

    fireEvent.click(screen.getByRole('button', { name: 'src/store.ts:88' }));
    expect(opened).toHaveBeenCalledWith({ path: 'src/store.ts', line: 88 });
  });

  it('asks about the path resolved against the conversation’s directory', async () => {
    await renderAnswer('I changed `src/store.ts:88` for it.');

    // The same resolution the click will do. Asking about the bare `src/store.ts`
    // would be asking about a file in whatever directory main was launched from.
    expect(checked).toEqual([['/Users/me/project/src/store.ts']]);
  });

  it('leaves a fragment that is not a path as plain code', async () => {
    await renderAnswer('Call `useCopy` when you mean it.');

    expect(screen.queryByRole('button', { name: 'useCopy' })).toBeNull();
    // And is not worth a round trip: the shape rule refuses it before the disk
    // is ever consulted, which is what keeps a paragraph of prose from being a
    // request.
    expect(checked).toEqual([]);
  });

  /*
   * The bug this whole channel exists for. Every fragment below is path-shaped,
   * and `parseFileReference` says yes to all of them; only one is a file.
   */
  it('leaves a path-shaped fragment with no file behind it as plain code', async () => {
    await renderAnswer('I read `src/store.ts`, and `e.g` I will add `src/dock.ts` next.');

    expect(screen.getByRole('button', { name: 'src/store.ts' })).not.toBeNull();
    // A Latin abbreviation the shape rule admits it gets wrong, and a file the
    // agent has only said it is going to write. Neither is underlined.
    expect(screen.queryByRole('button', { name: 'e.g' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'src/dock.ts' })).toBeNull();
  });

  it('asks once per answer rather than once per path', async () => {
    await renderAnswer('Both `src/store.ts` and `src/dock.ts` moved, unlike `src/pane.ts`.');

    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveLength(3);
  });

  it('does not underline anything while it is still asking', async () => {
    // The order matters: a link that appeared and then went away would be worse
    // than one that arrived a frame late, because the reader may have clicked it.
    render(<Markdown files={{ cwd: '/Users/me/project', open: vi.fn() }}>
      {'I changed `src/store.ts` for it.'}
    </Markdown>);

    expect(screen.queryByRole('button', { name: 'src/store.ts' })).toBeNull();
  });

  it('leaves a path inside a fenced block alone', async () => {
    // The block is a snippet to be copied, not a set of links — and its `code`
    // element goes through the same component as an inline span.
    await renderAnswer('```\nsrc/store.ts\n```');

    expect(screen.queryByRole('button', { name: 'src/store.ts' })).toBeNull();
    // The copy control is still there, so the fence is being rendered as a fence.
    expect(screen.getByRole('button', { name: 'Copy this code' })).not.toBeNull();
  });

  it('is not offered at all where the caller wants no links', async () => {
    // The preview pane and the plan card both render markdown with no `files`.
    render(<Markdown>{'I changed `src/store.ts` for it.'}</Markdown>);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByRole('button', { name: 'src/store.ts' })).toBeNull();
    expect(checked).toEqual([]);
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

    expect(useApp.getState().activeDockTab?.kind).toBe('file');
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

    expect(useApp.getState().files).toEqual([]);
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
    expect(useApp.getState().files).toEqual([]);
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

    expect(useApp.getState().files).toEqual([]);
    expect(useApp.getState().visibleDockTabs).toHaveLength(0);
  });

  /*
   * The claim this surface was rebuilt for. It used to replace: following a
   * second link dropped the first file, so two could not be read together —
   * which is most of what reading code is. The strip runs down the side now,
   * so a second tab costs 34 vertical pixels in a column that scrolls.
   */
  /*
   * The transient slot — e-catch's cap on skim debris. A file opened from a
   * link is following the reading, so the next file *replaces* it: one tab
   * follows the skim, and forty links across a long session stay one tab.
   */
  it('replaces a transient file with the next one, in the same slot', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    expect(useApp.getState().files[0]?.pinned).toBe(false);

    answer = fileAnswer({ path: '/Users/me/project/src/dock.ts', title: 'dock.ts' });
    await act(async () => {
      await openFile({ path: 'src/dock.ts' });
    });
    renderDock();

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(useApp.getState().files.map((one) => one.title)).toEqual(['dock.ts']);
  });

  it('opens a second file beside a pinned first, rather than replacing it', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    // The pin is the reader saying "this one stays" — after it, the transient
    // slot is free again and the next file gets a tab of its own. Reading two
    // files together is one pin away, which is the price of the cap above.
    act(() => {
      pinFile(useApp.getState().files[0]?.id ?? '');
    });
    answer = fileAnswer({ path: '/Users/me/project/src/dock.ts', title: 'dock.ts' });
    await act(async () => {
      await openFile({ path: 'src/dock.ts' });
    });
    renderDock();

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(useApp.getState().files.map((one) => one.title)).toEqual(['store.ts', 'dock.ts']);
    // The one just asked for is in front; the first is still a click away.
    expect(screen.getByText('two')).not.toBeNull();
  });

  it('brings a file already open to the front instead of opening it twice — and pins it', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    const first = useApp.getState().files[0]?.id;
    act(() => {
      pinFile(first ?? '');
    });

    answer = fileAnswer({ path: '/Users/me/project/src/dock.ts', title: 'dock.ts' });
    await act(async () => {
      await openFile({ path: 'src/dock.ts' });
    });

    // Back to the first, by the path a link would carry.
    answer = fileAnswer();
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    renderDock();

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    // Same tab, same id: the strip must not reshuffle under a click that only
    // asked to look at something.
    expect(useApp.getState().files[0]?.id).toBe(first);
    expect(useApp.getState().activeDockTab).toEqual({ kind: 'file', id: first });
    // And coming back is the promotion: a file reached for twice is being
    // read, not skimmed, so it leaves the transient slot on its own.
    expect(useApp.getState().files[0]?.pinned).toBe(true);
  });

  it('closes one tab without touching the other', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    act(() => {
      pinFile(useApp.getState().files[0]?.id ?? '');
    });
    answer = fileAnswer({ path: '/Users/me/project/src/dock.ts', title: 'dock.ts' });
    await act(async () => {
      await openFile({ path: 'src/dock.ts' });
    });
    renderDock();

    fireEvent.click(screen.getByRole('button', { name: 'Close dock.ts' }));

    expect(useApp.getState().files.map((one) => one.title)).toEqual(['store.ts']);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('forgets the line when the next link names none', async () => {
    await act(async () => {
      await openFile({ path: 'src/store.ts', line: 2 });
    });
    expect(useApp.getState().files[0]?.line).toBe(2);

    await act(async () => {
      await openFile({ path: 'src/store.ts' });
    });
    // Stale marks are worse than none: the reader would be told line 2 mattered
    // for a link that said nothing about it. Same tab either way — the line is
    // a property of the *link*, not of the file being open.
    expect(useApp.getState().files).toHaveLength(1);
    expect(useApp.getState().files[0]?.line).toBeUndefined();
  });

  it('closeFile is a no-op when that file is not open', () => {
    const before = useApp.getState();
    closeFile('file-that-never-was');
    expect(useApp.getState()).toBe(before);
  });
});
