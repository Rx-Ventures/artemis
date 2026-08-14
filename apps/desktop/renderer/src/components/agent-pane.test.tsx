/**
 * @vitest-environment jsdom
 *
 * Opening a delegated agent into a tab of its own.
 *
 * The claim behind this feature is that the delegated list is not enough. It
 * says what is running and what it cost; it cannot say what the agent is
 * *doing*, because the parent session does not contain that. A subagent writes
 * its own transcript and the delegating conversation keeps only the final
 * report — so a four-agent fan-out shows up in the main thread as one folded
 * line, and everything the agents actually did is in files nothing opens.
 *
 * What these pin down:
 *
 *  - a row that **has** a transcript is a control, and clicking it opens a tab
 *    holding that agent's own conversation;
 *  - a row that has none — a backgrounded command, a workflow, measured rather
 *    than assumed — is **not** offered as one, because a tab onto nothing is
 *    worse than no tab;
 *  - the tab's ✕ closes a *view*: the agent is not stopped and the row stays;
 *  - the read is **append-only**, so following a running agent costs the
 *    messages that are new rather than the whole conversation each poll.
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

/** Every subagent read the pane asked for, in order. */
let reads: Array<{ agentId: string; offset?: number; runId: string; sessionId: string }>;
/** What the fake main process was asked to stop. */
let stopped: Array<{ runId: string; taskId: string }>;

/**
 * The agent's stored conversation, as the provider would hand it back.
 *
 * Six messages, served in pages, so the append-only claim has something to be
 * true of: a second read from a non-zero offset must not repeat the first.
 */
const STORED = [
  { type: 'text.complete', messageId: 'a1', role: 'assistant', text: 'Reading the tooling files.' },
  { type: 'tool.start', toolCallId: 'c1', name: 'Read', input: { file_path: '/repo/a.ts' } },
  { type: 'tool.end', toolCallId: 'c1', status: 'ok', result: 'ok' },
  { type: 'text.complete', messageId: 'a2', role: 'assistant', text: 'Release script looks wrong.' },
];

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    preview: {},
    terminal: { onEvent: () => () => undefined },
    sessions: {
      subagentMessages: async ({
        agentId,
        offset = 0,
        limit,
        runId,
        sessionId,
      }: {
        agentId: string;
        offset?: number;
        limit?: number;
        runId: string;
        sessionId: string;
      }) => {
        reads.push({ agentId, offset, runId, sessionId });
        const page = STORED.slice(offset, limit === undefined ? undefined : offset + limit).map(
          (event, index) => ({ ...event, runId, seq: offset + index, ts: 0 }),
        );
        return {
          ok: true,
          value: { events: page, hasMore: false, consumed: page.length },
        };
      },
    },
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
const { closePane, focusedPane, useApp } = await import('@/state/store');
const { paneState, setPaneState } = await import('@/state/pane');

const CAPS = {
  interactivePermissions: false,
  partialMessages: false,
  midRunSteering: false,
  forkSession: false,
  listSessions: true,
  subagents: true,
  subagentTranscripts: true,
  renameSession: false,
  deleteSession: false,
  permissionModes: [],
  resumeSession: true,
  usageReporting: false,
  costReporting: false,
  planUsageReporting: false,
  systemPromptAppend: false,
  imageInput: false,
  fileInput: false,
};

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'task-1',
  // The kind a `Task`/`Agent` call produces — the one with a transcript.
  kind: 'local_agent',
  description: 'Audit the tooling',
  status: 'running',
  startedAt: Date.now() - 5_000,
  ...over,
});

/**
 * A column that has delegated something, on a provider that keeps transcripts.
 *
 * The run is `ended` on purpose: that is the ordinary state of a conversation
 * whose agents are still going, and it is the state the whole feature is for.
 */
function haveDelegated(...tasks: readonly BackgroundTask[]): void {
  act(() => {
    setPaneState(focusedPane(), {
      tasks,
      dismissedTasks: [],
      activeProfileId: 'p1',
      cwd: '/repo',
      run: {
        runId: 'run-1',
        status: 'ended',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/repo',
        capabilities: CAPS,
        startedAt: 1,
        sessionId: 'sess-1',
        endReason: 'completed',
      },
    } as never);
  });
}

function renderDock(): void {
  render(
    <TooltipProvider>
      <DockPane />
    </TooltipProvider>,
  );
}

/** Let the fetch behind an opened tab land. */
const settled = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

beforeEach(() => {
  reads = [];
  stopped = [];
  globalThis.localStorage?.clear();
  for (let guard = 0; guard < 8 && useApp.getState().grid.flatMap((r) => r.panes).length > 1; guard += 1) {
    const panes = useApp.getState().grid.flatMap((r) => r.panes);
    const last = panes[panes.length - 1];
    if (last) act(() => closePane(last.id));
  }
  useApp.setState({ agentViews: [], preview: null, terminals: [], activeDockTab: null, visibleDockTabs: [] });
  focusedPane().transcript.reset();
  setPaneState(focusedPane(), { tasks: [], dismissedTasks: [], run: null } as never);
});

afterEach(cleanup);

describe('a delegated row with a transcript behind it', () => {
  it('opens that agent’s own conversation in a tab', async () => {
    haveDelegated(task());
    renderDock();

    fireEvent.click(screen.getByRole('button', { name: 'Audit the tooling' }));
    await settled();

    // The tab exists, named after the work — not after the agent type, which is
    // not what the user clicked.
    expect(screen.getByRole('tab', { name: /Audit the tooling/ })).toBeTruthy();
    // And it is showing that agent's transcript, which the parent session does
    // not contain: this text exists only in the subagent's own file.
    expect(screen.getByText('Release script looks wrong.')).toBeTruthy();

    // Addressed by task id, which is the agent id — the identity the whole
    // feature rests on.
    expect(reads[0]?.agentId).toBe('task-1');
    expect(reads[0]?.sessionId).toBe('sess-1');
  });

  it('reads under a run id that belongs to no run', async () => {
    haveDelegated(task());
    renderDock();
    fireEvent.click(screen.getByRole('button', { name: 'Audit the tooling' }));
    await settled();

    // Replayed pages restart their `seq`, and the transcript answers a sequence
    // it cannot explain by asking the store whether that run is still alive. On
    // the *owning* run id that path can settle the user's live conversation as
    // though its end had been dropped, so this must never be `run-1`.
    expect(reads[0]?.runId).not.toBe('run-1');
    expect(reads[0]?.runId).toContain('task-1');
  });

  it('asks only for what it does not already have', async () => {
    haveDelegated(task());
    renderDock();
    fireEvent.click(screen.getByRole('button', { name: 'Audit the tooling' }));
    await settled();

    const first = reads.length;
    expect(reads[0]?.offset).toBe(0);

    // A poll on a settled agent, forced by hand rather than by waiting on the
    // timer. It must resume from the cursor, not re-read the conversation.
    const { refreshAgentView } = await import('@/state/store');
    await act(async () => {
      await refreshAgentView(`${focusedPane().id}:task-1`);
    });

    expect(reads.length).toBeGreaterThan(first);
    expect(reads[reads.length - 1]?.offset).toBe(STORED.length);
  });

  it('closes the view without stopping the agent', async () => {
    haveDelegated(task());
    renderDock();
    fireEvent.click(screen.getByRole('button', { name: 'Audit the tooling' }));
    await settled();

    fireEvent.click(screen.getByRole('button', { name: 'Close Audit the tooling' }));

    expect(screen.queryByRole('tab', { name: /Audit the tooling/ })).toBeNull();
    // The two things the ✕ must not have done: stopped the work, or taken the
    // row away. The list is still there and the agent is still running.
    expect(stopped).toEqual([]);
    expect(paneState(focusedPane()).tasks).toHaveLength(1);
  });
});

describe('a delegated row with no transcript behind it', () => {
  it('is not offered as a control', () => {
    // A backgrounded command is a process, not a conversation.
    haveDelegated(task({ kind: 'local_bash', description: 'pnpm dev' }));
    renderDock();

    expect(screen.queryByRole('button', { name: 'pnpm dev' })).toBeNull();
    expect(screen.getByText('pnpm dev')).toBeTruthy();
  });

  it('is not offered for a workflow, whose own id files nothing', () => {
    // Measured against a real session: a workflow's agents each write a
    // transcript under an id of their own, and the workflow task id has none.
    haveDelegated(task({ kind: 'local_workflow', description: 'review-changes' }));
    renderDock();

    expect(screen.queryByRole('button', { name: 'review-changes' })).toBeNull();
  });

  it('is not offered when the provider keeps no subagent transcripts', () => {
    haveDelegated(task());
    act(() => {
      const state = paneState(focusedPane());
      setPaneState(focusedPane(), {
        run: { ...state.run, capabilities: { ...CAPS, subagentTranscripts: false } },
      } as never);
    });
    renderDock();

    expect(screen.queryByRole('button', { name: 'Audit the tooling' })).toBeNull();
  });
});
