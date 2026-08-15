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
import type { BackgroundTask, WorkflowAgent } from '@rx-artemis/protocol';

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
const { groupByPhase } = await import('@/components/TasksPane');
const { closePane, focusedPane, splitPane, toggleTasks, useApp } = await import('@/state/store');
const { paneState, setPaneState } = await import('@/state/pane');
const { forgetFolds } = await import('@/lib/foldMemory');

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
  // A fold is remembered by key, and the keys are stable across cases in this
  // file — so one test's click would leave the next test's section open.
  forgetFolds();
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

  /*
   * Finished work is kept, and kept *folded*. The pane is opened to answer "is
   * it still going", and settled rows are the half that pushes the live ones off
   * the bottom — so they are behind one click rather than gone.
   */
  it('keeps a finished row behind a fold, with where its output went', () => {
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

    // Shut by default: the count is on screen, the row is not.
    expect(screen.getByText('1 finished')).not.toBeNull();
    expect(screen.queryByText('Audit the mapper')).toBeNull();

    fireEvent.click(screen.getByText('1 finished'));

    expect(screen.getByText('Audit the mapper')).not.toBeNull();
    expect(screen.getByText(/Found three seams/).textContent).toContain('/tmp/task-1.md');
  });

  /*
   * The split itself, which is the point of the change: a settled task does not
   * sit between two running ones.
   */
  it('puts live work above the fold and settled work inside it', () => {
    renderDock();
    haveTasks(
      task({ id: 'task-live', description: 'Still running', status: 'running' }),
      task({ id: 'task-done', description: 'All done', status: 'completed', endedAt: Date.now() }),
    );
    fireEvent.click(screen.getByRole('tab', { name: /running/ }));

    expect(screen.getByText('Still running')).not.toBeNull();
    expect(screen.queryByText('All done')).toBeNull();
    expect(screen.getByText('1 finished')).not.toBeNull();
  });

  it('draws no finished section at all while everything is live', () => {
    renderDock();
    haveTasks(task({ status: 'running' }));
    fireEvent.click(screen.getByRole('tab', { name: /running/ }));

    expect(screen.queryByText(/finished/)).toBeNull();
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

/**
 * What a row says it is.
 *
 * The issue behind these asked for Claude's phase-grouped workflow panel. The
 * Agent SDK reports no phases and no per-agent rows — see the PR — so what is
 * pinned here is the part that *is* answerable from the task stream: a workflow
 * is recognisable as one, and named the way its author named it.
 */
describe('a row', () => {
  it('leads with a workflow’s name rather than its launch sentence', () => {
    renderDock();
    haveTasks(
      task({
        kind: 'local_workflow',
        workflowName: 'doctor-bug-fixes-build',
        description: 'Build the four fix packages for the doctor-reported bugs, back to back',
      }),
    );

    // The name is what you went looking for; the description runs to a paragraph.
    expect(screen.getByText('doctor-bug-fixes-build')).not.toBeNull();
  });

  it('keeps the description reachable as the row’s tooltip', () => {
    renderDock();
    haveTasks(
      task({
        kind: 'local_workflow',
        workflowName: 'doctor-bug-fixes-build',
        description: 'Build the four fix packages',
      }),
    );

    expect(screen.getByTitle('Build the four fix packages')).not.toBeNull();
  });

  it('says what kind of thing it is', () => {
    renderDock();
    haveTasks(task({ kind: 'local_workflow', workflowName: 'spec' }));

    // Without this a workflow and a backgrounded shell are the same row.
    expect(screen.getByText(/Workflow/)).not.toBeNull();
  });

  it('prints an unknown kind raw rather than bucketing it', () => {
    renderDock();
    haveTasks(task({ kind: 'local_sandbox' }));

    // The protocol calls `kind` an open string for exactly this reason: a row
    // reading `local_sandbox` is a fact, one reading "Task" is a shrug.
    expect(screen.getByText(/local_sandbox/)).not.toBeNull();
  });

  it('prefers a subagent’s type over the generic kind', () => {
    renderDock();
    haveTasks(task({ kind: 'local_subagent', subagentType: 'Explore' }));

    expect(screen.getByText(/Explore/)).not.toBeNull();
    expect(screen.queryByText(/Subagent/)).toBeNull();
  });

  it('counts the tool calls, which is the only size the SDK reports', () => {
    renderDock();
    haveTasks(task({ kind: 'local_workflow', workflowName: 'spec', toolUses: 47 }));

    expect(screen.getByText(/47 tools/)).not.toBeNull();
  });

  it('says “1 tool”, not “1 tools”', () => {
    renderDock();
    haveTasks(task({ toolUses: 1 }));

    expect(screen.getByText(/1 tool(?!s)/)).not.toBeNull();
  });

  it('draws no tool count before any tool has run', () => {
    renderDock();
    haveTasks(task({ toolUses: 0 }));

    // A row that says "0 tools" the instant work starts reads as a stall.
    expect(screen.queryByText(/0 tools/)).toBeNull();
  });

  it('still titles an ordinary task by its description', () => {
    renderDock();
    haveTasks(task({ description: 'Audit the mapper' }));

    expect(screen.getByText('Audit the mapper')).not.toBeNull();
  });
});

/**
 * A workflow's phases, which is what issue #125 was actually about.
 *
 * The data arrives nested inside the workflow task's own progress message —
 * `workflow_progress`, one entry per agent, each tagged with its phase — so the
 * grouping is a reading of one flat array rather than a correlation across
 * messages. `groupByPhase` is that reading, and it is exported and tested
 * directly because it is the whole of the feature's logic.
 */
describe('grouping a workflow’s agents', () => {
  const agent = (over: Partial<WorkflowAgent> = {}): WorkflowAgent => ({
    index: 1,
    label: 'build',
    state: 'done',
    ...over,
  });

  it('puts phases in declaration order, not start order', () => {
    // Two phases whose agents interleaved as they ran.
    const groups = groupByPhase([
      agent({ index: 3, phaseIndex: 1, phaseTitle: 'Approvals' }),
      agent({ index: 1, phaseIndex: 0, phaseTitle: 'Chat reliability' }),
      agent({ index: 2, phaseIndex: 1, phaseTitle: 'Approvals' }),
    ]);

    expect(groups.map((g) => g.title)).toEqual(['Chat reliability', 'Approvals']);
  });

  it('puts agents in index order inside a phase', () => {
    const groups = groupByPhase([
      agent({ index: 9, phaseIndex: 0, phaseTitle: 'P', label: 'late' }),
      agent({ index: 2, phaseIndex: 0, phaseTitle: 'P', label: 'early' }),
    ]);

    // A row that reorders as it settles moves under the pointer aiming at it.
    expect(groups[0]?.agents.map((a) => a.label)).toEqual(['early', 'late']);
  });

  it('keeps the phase title an earlier entry established', () => {
    const groups = groupByPhase([
      agent({ index: 1, phaseIndex: 0, phaseTitle: 'Check-ins' }),
      agent({ index: 2, phaseIndex: 0 }),
    ]);

    expect(groups[0]?.title).toBe('Check-ins');
  });

  it('collects unphased agents into one trailing group', () => {
    const groups = groupByPhase([
      agent({ index: 1, label: 'loose' }),
      agent({ index: 2, phaseIndex: 0, phaseTitle: 'Named' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[1]?.title).toBeUndefined();
    expect(groups[1]?.agents.map((a) => a.label)).toEqual(['loose']);
  });

  it('is empty for a task that is not a workflow', () => {
    expect(groupByPhase(undefined)).toEqual([]);
    expect(groupByPhase([])).toEqual([]);
  });
});

describe('the workflow panel', () => {
  const wf = (agents: readonly Partial<WorkflowAgent>[]): BackgroundTask =>
    task({
      kind: 'local_workflow',
      workflowName: 'doctor-bug-fixes-build',
      workflowProgress: agents.map((a, i) => ({
        index: i + 1,
        label: `agent-${String(i + 1)}`,
        state: 'done',
        ...a,
      })) as WorkflowAgent[],
    });

  it('draws a phase heading and its agents', () => {
    renderDock();
    haveTasks(
      wf([
        { label: 'build:chat-reliability', phaseIndex: 0, phaseTitle: 'Chat reliability' },
        { label: 'review:chat-reliability', phaseIndex: 0, phaseTitle: 'Chat reliability' },
      ]),
    );

    expect(screen.getByText('Chat reliability')).not.toBeNull();
    expect(screen.getByText('build:chat-reliability')).not.toBeNull();
    expect(screen.getByText('review:chat-reliability')).not.toBeNull();
  });

  it('counts how far through a phase is', () => {
    renderDock();
    haveTasks(
      wf([
        { phaseIndex: 0, phaseTitle: 'Check-ins', state: 'done' },
        { phaseIndex: 0, phaseTitle: 'Check-ins', state: 'progress' },
      ]),
    );

    expect(screen.getByText('1/2')).not.toBeNull();
  });

  it('counts a failed agent as settled, not as still running', () => {
    renderDock();
    haveTasks(
      wf([
        { phaseIndex: 0, phaseTitle: 'P', state: 'done' },
        { phaseIndex: 0, phaseTitle: 'P', state: 'error', error: 'boom' },
      ]),
    );

    // A phase where everything has stopped is finished, however it finished.
    expect(screen.getByText('2/2')).not.toBeNull();
  });

  it('shortens the model to what distinguishes it', () => {
    renderDock();
    haveTasks(wf([{ phaseIndex: 0, phaseTitle: 'P', model: 'claude-opus-5[1m]' }]));

    expect(screen.getByText('Opus 5 1M')).not.toBeNull();
  });

  it('passes an unrecognised model through whole', () => {
    renderDock();
    haveTasks(wf([{ phaseIndex: 0, phaseTitle: 'P', model: 'some-future-model' }]));

    // Better a long string than a confident mis-parse of a model nobody has
    // taught this table about yet.
    expect(screen.getByText('some-future-model')).not.toBeNull();
  });

  it('draws each agent’s tokens and time', () => {
    renderDock();
    haveTasks(wf([{ phaseIndex: 0, phaseTitle: 'P', tokens: 196_900, durationMs: 936_000 }]));

    expect(screen.getByText('196.9k')).not.toBeNull();
    expect(screen.getByText('15m36s')).not.toBeNull();
  });

  it('summarises what is inside before it is opened', () => {
    renderDock();
    haveTasks(
      wf([
        { phaseIndex: 0, phaseTitle: 'One' },
        { phaseIndex: 1, phaseTitle: 'Two' },
      ]),
    );

    expect(screen.getByText('2 phases · 2 agents')).not.toBeNull();
  });

  it('says only the agent count for a workflow with no phases', () => {
    renderDock();
    haveTasks(wf([{}]));

    // A script that never calls phase() has none, which is ordinary — and a
    // heading reading "undefined" would be the alternative.
    expect(screen.getByText('1 agent')).not.toBeNull();
  });

  it('draws nothing extra for a task that is not a workflow', () => {
    renderDock();
    haveTasks(task());

    expect(screen.queryByText(/agents?$/)).toBeNull();
  });
});
