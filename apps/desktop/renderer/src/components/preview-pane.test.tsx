/**
 * @vitest-environment jsdom
 *
 * Previewing a page the agent wrote, from the transcript to the frame.
 *
 * The Electron half of this feature — the scheme, the two content policies, the
 * sandbox — cannot be reached from jsdom, and is verified where it lives. What
 * *this* file holds to account is the renderer's half, which has three claims
 * worth pinning because each fails silently:
 *
 *  - **The button appears only where it should.** On a page that was written,
 *    not on a page that was read, and not on a write that failed. The failure
 *    mode is an invitation to open a file that is not there.
 *  - **The path leaving the renderer is absolute.** The main process rejects
 *    anything else, so a relative path resolved wrongly here is a button that
 *    fails on click with a message about a rule the user never broke.
 *  - **The frame is sandboxed without `allow-same-origin`.** This is the line
 *    that keeps a generated page out of the transcript's DOM, and it is one
 *    attribute in one JSX file — exactly the kind of thing a refactor drops.
 *
 * As with the other component tests, the bridge is faked at `window.artemis` so
 * this runs through the real store: the real `openPreview`, the real `call()`.
 */

import type { AgentEvent, IpcResult, PreviewOpenResponse } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { forgetFolds } from '@/lib/foldMemory';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});

/** Paths the renderer actually asked to preview, in order. */
let asked: string[];
/** What the fake main process answers next. */
let answer: (path: string) => IpcResult<PreviewOpenResponse>;

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: {},
    preview: {
      open: async ({ path }: { path: string }) => {
        asked.push(path);
        return answer(path);
      },
    },
  },
});

const { Transcript } = await import('@/components/Transcript');
const { PreviewPane } = await import('@/components/PreviewPane');
const { DockPane } = await import('@/components/DockPane');
const { focusedPane, useApp } = await import('@/state/store');
const { appTranscript, seedApp } = await import('@/state/testkit');

const CAPABILITIES = {
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
};

function play(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): void {
  drafts.forEach((draft, index) => {
    appTranscript().apply({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index } as AgentEvent);
  });
  appTranscript().flush();
}

/** A completed write of `path` carrying `content`. */
function wrote(
  path: string,
  content = '<h1>hi</h1>',
  status = 'ok',
): Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>> {
  return [
    { type: 'tool.start', toolCallId: 'c1', name: 'Write', input: { file_path: path, content } },
    { type: 'tool.end', toolCallId: 'c1', status },
  ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
}

/** Open the activity marker, which is what the individual cards live behind. */
function openTheMarker(): void {
  fireEvent.click(screen.getByText(/^(Edited|Wrote|Read|Ran)/i));
}

/**
 * The pane on its own. It carries an `IconButton`, which is a tooltip trigger,
 * and Radix requires a provider above one — the app has it at the root.
 */
function renderPane(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <PreviewPane />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  asked = [];
  answer = (path) => ({
    ok: true,
    value: {
      kind: 'frame' as const,
      url: 'artemis-preview://abc123/',
      title: 'report.html',
      path,
      bytes: 1157,
    },
  });
  // A fresh transcript, and no memory of folds opened in the last test: fold
  // state is keyed by transcript id and these fixtures reuse ids.
  forgetFolds();
  appTranscript().reset();
  appTranscript().flush();
  useApp.setState({ preview: null });
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
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
    permissionQueue: [],
    conversationWidth: 'comfortable',
    runSummary: 'always',
  });
});

afterEach(cleanup);

describe('the Preview affordance', () => {
  it('appears on a page the agent wrote', () => {
    play(...wrote('/Users/me/project/report.html'));
    render(<Transcript />);
    openTheMarker();

    expect(screen.getByRole('button', { name: /preview/i })).not.toBeNull();
  });

  it('does not appear on a file that is not a page', () => {
    play(...wrote('/Users/me/project/index.ts', 'export const a = 1;'));
    render(<Transcript />);
    openTheMarker();

    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull();
  });

  /*
   * The one that matters most. A write that errored left no file — or left half
   * of one — so offering to open it is offering a failure.
   */
  it('does not appear on a write that failed', () => {
    play(...wrote('/Users/me/project/report.html', '<h1>hi</h1>', 'error'));
    render(<Transcript />);
    openTheMarker();

    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull();
  });

  it('sends the path as written when it is already absolute', async () => {
    play(...wrote('/Users/me/project/report.html'));
    render(<Transcript />);
    openTheMarker();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    });

    expect(asked).toEqual(['/Users/me/project/report.html']);
  });

  it('resolves a relative path against the column working directory', async () => {
    play(...wrote('out/report.html'));
    render(<Transcript />);
    openTheMarker();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    });

    // Not `out/report.html` — the main process would reject that outright.
    expect(asked).toEqual(['/Users/me/project/out/report.html']);
  });

  it('explains itself in the transcript when the file cannot be previewed', async () => {
    answer = () => ({
      ok: false,
      error: { code: 'invalid_request', message: 'There is no file at that path any more.' },
    });
    play(...wrote('/Users/me/project/report.html'));
    render(<Transcript />);
    openTheMarker();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    });

    // On the card, in the transcript — not on the window's error surface.
    await waitFor(() => {
      expect(screen.getByText('Could not preview this file')).not.toBeNull();
    });
    expect(useApp.getState().preview).toBeNull();
  });
});

/**
 * Stamp a preview with the conversation that owns it.
 *
 * The tests below write `preview` straight into the store rather than going
 * through `openPreview`, which is what makes them tests of the *pane* and not of
 * the IPC round trip. They still have to name an owner, because a preview
 * belonging to no conversation is one the store is entitled to close — that is
 * the whole of `reconcilePreview`, and it runs on every store write.
 */
function owned<T extends object>(preview: T): T & { readonly owner: { readonly paneId: string } } {
  return { ...preview, owner: { paneId: focusedPane().id } };
}

describe('the preview pane', () => {
  it('renders nothing at all until something is being previewed', () => {
    const { container } = renderPane();
    expect(container.firstChild).toBeNull();
  });

  it('frames the URL the main process returned, and never a path', () => {
    useApp.setState({
      preview: owned({
        kind: 'frame' as const,
        url: 'artemis-preview://abc123/',
        title: 'report.html',
        path: '/Users/me/project/report.html',
        bytes: 1157,
      }),
    });
    renderPane();

    const frame = screen.getByTitle('report.html');
    expect(frame.getAttribute('src')).toBe('artemis-preview://abc123/');
  });

  /*
   * The containment line. `allow-scripts` has to be there — an artifact is
   * script — and `allow-same-origin` must never join it: together they would
   * give a generated page the parent's origin and the run of the transcript's
   * DOM. Either alone is inert.
   */
  it('sandboxes the frame with scripts but never with same-origin', () => {
    useApp.setState({
      preview: owned({
        kind: 'frame' as const,
        url: 'artemis-preview://abc123/',
        title: 'report.html',
        path: '/Users/me/project/report.html',
        bytes: 1157,
      }),
    });
    renderPane();

    const sandbox = screen.getByTitle('report.html').getAttribute('sandbox') ?? '';
    expect(sandbox.split(/\s+/)).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  /*
   * Markdown takes the other path entirely: no frame, no URL, no scheme. The
   * text is rendered here by the same pipeline the transcript uses, which is
   * what makes a `<script>` in a `.md` file inert — `react-markdown` without
   * `rehype-raw` shows raw HTML as text rather than running it.
   */
  it('renders markdown in place rather than framing it', () => {
    useApp.setState({
      preview: owned({
        kind: 'markdown',
        text: '# Release notes\n\nShipped **today**.',
        title: 'NOTES.md',
        path: '/Users/me/project/NOTES.md',
        bytes: 36,
      }),
    });
    renderPane();

    expect(screen.getByRole('heading', { name: 'Release notes' })).not.toBeNull();
    expect(screen.getByText('today').tagName).toBe('STRONG');
    // No frame at all — nothing was served, so there is nothing to sandbox.
    expect(screen.queryByTitle('NOTES.md')).toBeNull();
  });

  it('shows HTML written into markdown as text, never as markup', () => {
    useApp.setState({
      preview: owned({
        kind: 'markdown',
        text: 'before\n\n<script>window.stolen = 1;</script>\n\nafter',
        title: 'NOTES.md',
        path: '/Users/me/project/NOTES.md',
        bytes: 48,
      }),
    });
    const { container } = renderPane();

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('window.stolen');
  });

  /**
   * The ✕ is on the *tab*, not on the pane.
   *
   * It used to be part of `PreviewPane`'s own header; that header is now
   * `DockPane`'s tab strip, because the rail is shared with the user's
   * terminals. The behaviour is unchanged and still worth pinning — closing is
   * the entire contract between the renderer and a preview, since main retires
   * what it granted on its own — so the assertion follows the button rather
   * than being dropped with the header.
   */
  it('closes from its tab, which is all the renderer has to do', () => {
    useApp.setState({
      preview: owned({
        kind: 'frame' as const,
        url: 'artemis-preview://abc123/',
        title: 'report.html',
        path: '/Users/me/project/report.html',
        bytes: 1157,
      }),
    });
    render(
      <TooltipProvider>
        <DockPane />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close report.html' }));
    expect(useApp.getState().preview).toBeNull();
  });
});
