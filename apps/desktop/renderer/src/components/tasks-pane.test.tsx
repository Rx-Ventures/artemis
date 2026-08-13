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
 *  - a row can be **stopped**, and stopping it is a request rather than a claim.
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
const { focusedPane, useApp } = await import('@/state/store');
const { setPaneState } = await import('@/state/pane');

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
  useApp.setState({ preview: null, terminals: [], activeDockTab: null, visibleDockTabs: [] });
  setPaneState(focusedPane(), {
    cwd: '/Users/me/project',
    tasks: [],
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

  it('cannot be dismissed, because its rows are not the user’s to reopen', () => {
    renderDock();
    haveTasks(task());
    fireEvent.click(screen.getByRole('tab', { name: /1 running/ }));

    // Every other tab in this strip holds something that can be got back — a
    // preview is one click on the tile still in the transcript, a terminal is a
    // shell the user opened. This one holds the only record of work they did not
    // start, so the ✕ is absent rather than disabled.
    expect(screen.queryByRole('button', { name: /^Close/ })).toBeNull();
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
