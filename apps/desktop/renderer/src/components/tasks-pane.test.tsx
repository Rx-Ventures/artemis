/**
 * @vitest-environment jsdom
 *
 * The delegated-work pane, through the real store and the real dock.
 *
 * The claims here are the ones the issue was filed about, and each is a thing
 * the transcript gets wrong on its own:
 *
 *  - a backgrounded subagent is **still running**, and something says so while
 *    it is — the transcript's folded line says "delegated to 3 agents" in the
 *    past tense, with no dot and no count, while they work;
 *  - the tab **arrives by itself**, because nobody opens this one: the agent
 *    delegates something mid-turn and it appears;
 *  - a settled row **stays**, since the moment work finishes is the moment its
 *    result — what it cost, what it said, where it wrote its output — is worth
 *    reading;
 *  - a row can be **stopped**, and stopping it is a request rather than a claim;
 *  - the tab can be **shut**, and shutting it ends a view rather than the work —
 *    it stays shut through the progress messages that follow, and the next thing
 *    delegated brings it back.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BackgroundTask } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';

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
  writeToTerminal: vi.fn(),
  noteTerminalExit: vi.fn(),
  disposeTerminalSession: vi.fn(),
  setTerminalSessionHooks: vi.fn(),
  retheme: vi.fn(),
}));

/** What the fake main process was asked to stop. */
let stopped: Array<{ runId: string; taskId: string }>;

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    preview: {},
    terminal: { onEvent: () => () => undefined },
    runs: {
      stopTask: async ({ runId, taskId }: { runId: string; taskId: string }) => {
        stopped.push({ runId, taskId });
        return { ok: true, value: { runId, taskId } };
      },
      onEvent: () => () => undefined,
    },
  },
});

const { DockPane } = await import('@/components/DockPane');
const { closePane, focusedPane, splitPane, toggleTasks, useApp } = await import('@/state/store');
const { paneState, setPaneState } = await import('@/state/pane');

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 't1',
  kind: 'local_bash',
  description: 'Audit the mapper',
  status: 'running',
  startedAt: Date.now() - 72_000,
  ...over,
});

/** Put rows on the focused column, the way a `background.tasks` event does. */
function haveTasks(...tasks: readonly BackgroundTask[]): void {
  act(() => {
    setPaneState(focusedPane(), { tasks });
  });
}

function renderDock(): void {
  render(
    <TooltipProvider>
      <DockPane />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  stopped = [];
  // Back to one column, whatever the previous test left: the split test below
  // makes a second one, and a survivor would double every tab query after it.
  for (const extra of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    setPaneState(extra, { run: null, tasks: [], dismissedTasks: [] } as never);
    closePane(extra.id);
  }
  useApp.setState({
    preview: null,
    terminals: [],
    activeDockTab: null,
    visibleDockTabs: [],
    background: [],
  });
  setPaneState(focusedPane(), {
    cwd: '/Users/me/project',
    tasks: [],
    // Cleared with the rows, or a test that closes the tab would hide it from
    // the next one — the column is module-level and outlives each `it`.
    dismissedTasks: [],
    resumeSessionId: null,
    run: {
      runId: 'run-1',
      status: 'ended',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/Users/me/project',
      capabilities: { subagents: true } as never,
      startedAt: 0,
    },
  } as never);
});

afterEach(cleanup);

describe('the delegated-work pane', () => {
  it('is not there until something is delegated', () => {
    renderDock();
    expect(screen.queryByRole('tab', { name: /running|Delegated/ })).toBeNull();
  });

  it('appears by itself when the agent delegates something', () => {
    renderDock();
    haveTasks(task());

    // Nobody opened this. It is the only tab in the strip that arrives on its
    // own, which is why it pins to the end rather than shifting the others.
    expect(screen.getByRole('tab', { name: /1 running/ })).not.toBeNull();
  });

  it('counts the live work on the tab, so the strip answers without being opened', () => {
    renderDock();
    haveTasks(task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c', status: 'completed' }));

    // Two of three, and the count is of what is *running* — a tab reading "3"
    // over one finished row would be the same past-tense lie the transcript
    // tells with "delegated to 3 agents".
    expect(screen.getByRole('tab', { name: /2 running/ })).not.toBeNull();
  });

  it('shows what each task is doing, and what it has spent', () => {
    renderDock();
    haveTasks(
      task({
        description: 'auth call sites',
        subagentType: 'Explore',
        lastToolName: 'Grep',
        totalTokens: 24_100,
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: /1 running/ }));

    expect(screen.getByText('auth call sites')).not.toBeNull();
    const detail = screen.getByText(/Grep/);
    expect(detail.textContent).toContain('Explore');
    expect(detail.textContent).toContain('24.1k tok');
  });

  it('keeps a finished row, with where its output went', () => {
    renderDock();
    haveTasks(
      task({
        status: 'completed',
        endedAt: Date.now(),
        summary: 'Found three seams',
        outputFile: '/tmp/task-1.md',
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Delegated/ }));

    expect(screen.getByText('Audit the mapper')).not.toBeNull();
    expect(screen.getByText(/Found three seams/).textContent).toContain('/tmp/task-1.md');
  });

  it('offers a stop on live work and not on settled work', () => {
    renderDock();
    haveTasks(task({ id: 'live' }), task({ id: 'done', status: 'completed' }));
    fireEvent.click(screen.getByRole('tab', { name: /1 running/ }));

    // One row can be stopped; the other has already finished, and a button that
    // did nothing would be worse than no button.
    expect(screen.getAllByRole('button', { name: /^Stop / })).toHaveLength(1);
  });

  it('asks the provider to stop, through the run holding the task', async () => {
    renderDock();
    haveTasks(task({ id: 'b5hyzk8n3' }));
    fireEvent.click(screen.getByRole('tab', { name: /1 running/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop / }));
    });

    expect(stopped).toEqual([{ runId: 'run-1', taskId: 'b5hyzk8n3' }]);
  });

  it('stops the task through the column that owns it, not the focused one', async () => {
    // A split: the focused column has its own run and nothing delegated; the
    // *other* column owns the task. Clicking a dock tab brings a view forward
    // without moving pane focus, so a stop routed through "the focused pane"
    // — the default every other session-scoped action gets away with — would
    // ask run-1 to stop a task it has never heard of.
    const left = focusedPane();
    const right = splitPane('right', left);
    if (right === null) throw new Error('expected a second column');
    setPaneState(right, {
      tasks: [task({ id: 'elsewhere' })],
      dismissedTasks: [],
      run: { ...paneState(left).run, runId: 'run-2' },
    } as never);
    useApp.setState({ focusedPaneId: left.id });

    renderDock();
    fireEvent.click(screen.getByRole('tab', { name: /1 running/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop / }));
    });

    // The premise first — the tab click left focus where it was — then the
    // claim: the stop was addressed through the owning column's run.
    expect(focusedPane().id).toBe(left.id);
    expect(stopped).toEqual([{ runId: 'run-2', taskId: 'elsewhere' }]);
  });

  it('does not strike the row through until the provider says it stopped', async () => {
    renderDock();
    haveTasks(task({ id: 'b5hyzk8n3' }));
    fireEvent.click(screen.getByRole('tab', { name: /1 running/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop / }));
    });

    // Still running, because it is: the row settles when a `background.tasks`
    // event says so, through the same path a natural finish takes. Marking it
    // here would make a stop that silently failed look like one that worked.
    expect(screen.getByRole('tab', { name: /1 running/ })).not.toBeNull();
    expect(screen.getAllByRole('button', { name: /^Stop / })).toHaveLength(1);
  });

  it('can be dismissed, and the work it was describing does not notice', () => {
    renderDock();
    haveTasks(task());
    fireEvent.click(screen.getByRole('tab', { name: /1 running/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide delegated work' }));

    // The ✕ beside this one on a terminal kills a shell. This one closes a view:
    // the pane never owned the rows, and the subagent it was describing is still
    // running in the provider afterwards.
    expect(screen.queryByRole('tab', { name: /running|Delegated/ })).toBeNull();
    expect(paneState(focusedPane()).tasks).toHaveLength(1);
  });

  it('stays shut through the progress messages that follow', () => {
    renderDock();
    haveTasks(task({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide delegated work' }));

    // The set is replaced wholesale several times a second while anything runs.
    // A dismissal recorded as a flag would be cleared by the first of these, and
    // the tab would come back a moment after the user closed it.
    haveTasks(task({ id: 'a', lastToolName: 'Grep' }));
    haveTasks(task({ id: 'a', status: 'completed', endedAt: Date.now() }));

    expect(screen.queryByRole('tab', { name: /running|Delegated/ })).toBeNull();
  });

  it('is reopened by the header button, which is the ✕’s way back', () => {
    renderDock();
    haveTasks(task());
    fireEvent.click(screen.getByRole('button', { name: 'Hide delegated work' }));

    act(() => {
      toggleTasks(focusedPane());
    });

    // Without this the ✕ is a trapdoor. Nobody opens this tab by hand — there is
    // no tile in the transcript to click, the way there is for a preview — so a
    // dismissal would otherwise hold until the agent happened to delegate
    // something else.
    expect(screen.getByRole('tab', { name: /1 running/ })).not.toBeNull();
    expect(screen.getByText('Audit the mapper')).not.toBeNull();
  });

  it('is shut again by the same button, because it sits next to a toggle', () => {
    renderDock();
    haveTasks(task());

    // The tab arrived and, being the only one, is already in front — so this
    // press is the second one. A button beside ⌘J's that opened but never closed
    // would read as broken.
    act(() => {
      toggleTasks(focusedPane());
    });

    expect(screen.queryByRole('tab', { name: /running|Delegated/ })).toBeNull();
    expect(paneState(focusedPane()).tasks).toHaveLength(1);
  });

  it('comes back when something new is delegated', () => {
    renderDock();
    haveTasks(task({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide delegated work' }));
    haveTasks(task({ id: 'a' }), task({ id: 'b' }));

    // The only way back, and the same way it arrived the first time: nobody
    // opens this tab by hand, so a dismissal that outlived the work it was about
    // would hide the next agent too.
    expect(screen.getByRole('tab', { name: /2 running/ })).not.toBeNull();
  });

  it('survives the run that launched the work ending', () => {
    renderDock();
    haveTasks(task());
    act(() => {
      setPaneState(focusedPane(), { run: null });
    });

    // The tasks worth showing are the ones that outlived their turn, so the list
    // cannot be tied to the run — which is the defect the whole feature is about,
    // one layer up.
    expect(screen.getByRole('tab', { name: /1 running/ })).not.toBeNull();
  });
});
