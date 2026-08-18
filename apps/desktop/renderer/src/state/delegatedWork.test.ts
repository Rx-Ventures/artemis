/**
 * @vitest-environment jsdom
 *
 * A session with agents still working reads as working.
 *
 * The `Agent` tool backgrounds by default and `Workflow` is always async, so
 * the run that launched them is routinely over minutes before the work is. The
 * delegated pane covers the conversation while it is on screen; the sidebar's
 * working marker is the only thing that can say so once the user navigates
 * away — and it used to read run liveness alone, so an ultracode workflow
 * twenty minutes into its run showed nothing anywhere the moment its launching
 * turn ended.
 *
 * What these pin down: live delegated work keeps a session in
 * `runningSessions` after `run.end`, and the same `background.tasks` event
 * that settles the rows is what turns the marker off.
 *
 * Same caveat as `endedRuns.test.ts`: `renderer/tsconfig.json` excludes test
 * files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  allPanes,
  closePane,
  focusedPane,
  handleAgentEvent,
  newSession,
  paneCount,
  splitPane,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
  },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

const running = (runId: string) =>
  ({
    runId,
    status: 'running',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/repo',
    capabilities: NO_CAPABILITIES,
    startedAt: 1,
    sessionId: 'sess-1',
  }) as never;

const task = (status: string) => ({
  id: 'task-1',
  kind: 'local_workflow',
  description: 'probe workflow',
  status,
  startedAt: 1,
});

const tasksEvent = (seq: number, statuses: readonly string[]) =>
  ({
    type: 'background.tasks',
    runId: 'run-1',
    seq,
    ts: 0,
    tasks: statuses.map((status) => task(status)),
  }) as never;

const ended = (seq: number) =>
  ({ type: 'run.end', runId: 'run-1', seq, ts: 0, reason: 'completed', sessionId: 'sess-1' }) as never;

beforeEach(() => {
  globalThis.localStorage?.clear();
  // Collapse whatever grid a previous test left behind, the way
  // `continuationRuns.test.ts` does, so the focused pane is the only one.
  for (let guard = 0; guard < 20 && paneCount() > 1; guard += 1) {
    const last = allPanes()[paneCount() - 1];
    if (last) closePane(last.id);
  }
  useApp.setState({ background: [], runningSessions: [], banners: [], sessionsHoldingWork: [] });
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    run: running('run-1'),
    resumeSessionId: null,
    tasks: [],
    dismissedTasks: [],
    activeProfileId: 'p1',
    cwd: '/repo',
  } as never);
});

describe('the working marker while work is delegated', () => {
  it('stays on after run.end while a task is still live', () => {
    handleAgentEvent(tasksEvent(0, ['running']));
    handleAgentEvent(ended(1));

    // The turn is over; the workflow is not. The run state says ended — the
    // composer is free — and the session still reads as working.
    expect(paneState(focusedPane()).run?.status).toBe('ended');
    expect(useApp.getState().runningSessions).toContain('sess-1');
  });

  it('turns off when the provider reports the work settled', () => {
    handleAgentEvent(tasksEvent(0, ['running']));
    handleAgentEvent(ended(1));
    // Settled rows stay in the list — the pane still shows what it cost and
    // where its output went — but nothing is *live* any more.
    handleAgentEvent(tasksEvent(2, ['completed']));

    expect(useApp.getState().runningSessions).not.toContain('sess-1');
  });

  it('is off for an ended run that never delegated anything', () => {
    handleAgentEvent(ended(0));

    expect(useApp.getState().runningSessions).not.toContain('sess-1');
  });
});

/**
 * Closing a column must not destroy the conversation that was in it.
 *
 * The gap the working marker above cannot close: `runningSessions` is computed
 * from `hasLiveWork`, which is this window's own snapshot of rows that stopped
 * being updated when the turn ended — `background.tasks` is run-scoped and the
 * adapter refuses to emit one after `run.end`, while `#holdsWork` keeps the
 * process alive for exactly that work. So the marker can read "idle" for a
 * workflow that is still going, and anything that *destroys* on that reading is
 * destroying on a guess.
 *
 * `retirePane` closes the conversation's agent tabs and resets its transcript,
 * and nothing reaches a pane that is gone: `openAgentTab` resolves its owner
 * through `allLivePanes`, and the delegated button has no rows left to show. The
 * observed failure was a workflow tab that shut on navigation and could not be
 * reopened, while the run carried on untouched in main.
 */
describe('leaving a column whose work this window cannot see', () => {
  it('backgrounds a conversation that reads as idle rather than retiring it', () => {
    const pane = focusedPane();
    // The rows this window last saw say the workflow finished. Main may well
    // disagree, and this is precisely the state it cannot be asked about.
    handleAgentEvent(tasksEvent(0, ['completed']));
    handleAgentEvent(ended(1));
    expect(useApp.getState().runningSessions).not.toContain('sess-1');

    // A second column, so closing this one is allowed at all — `closePane`
    // refuses to close the last.
    expect(splitPane('right')).not.toBeNull();
    // The conversation names a session it could resume, which is what makes it
    // something to come back to.
    setPaneState(pane, { resumeSessionId: 'sess-1' } as never);
    closePane(pane.id);

    expect(useApp.getState().background.some((p) => p.id === pane.id)).toBe(true);
  });

  it('backgrounds a conversation the main process still holds work for', () => {
    const pane = focusedPane();
    // Everything this window was told says the workflow finished. It is wrong,
    // and between turns nothing will correct it — `background.tasks` stopped
    // arriving at `run.end`. The poll is the only thing that knows better.
    handleAgentEvent(tasksEvent(0, ['completed']));
    handleAgentEvent(ended(1));
    useApp.setState({ sessionsHoldingWork: ['sess-1'] as never });

    newSession();

    expect(useApp.getState().background.some((p) => p.id === pane.id)).toBe(true);
    // The rows go with it, which is what the delegated tab is drawn from.
    expect(paneState(pane).tasks).toHaveLength(1);
  });

  it('marks a session the main process reports, with no live rows to show for it', () => {
    const pane = focusedPane();
    handleAgentEvent(tasksEvent(0, ['completed']));
    handleAgentEvent(ended(1));
    expect(useApp.getState().runningSessions).not.toContain('sess-1');

    useApp.setState({ sessionsHoldingWork: ['sess-1'] as never });
    // A pane write is what drives the marker; the poll calls the same sync
    // directly, which is why it does not have to wait for one.
    setPaneState(pane, { draft: 'x' } as never);

    expect(useApp.getState().runningSessions).toContain('sess-1');
  });

  it('still retires a column that never held a conversation', () => {
    const pane = focusedPane();
    // No run and no session to resume: there was never anything here to lose,
    // which is the one case destroying is right.
    setPaneState(pane, { run: null, resumeSessionId: null } as never);

    expect(splitPane('right')).not.toBeNull();
    closePane(pane.id);

    expect(useApp.getState().background.some((p) => p.id === pane.id)).toBe(false);
  });
});

describe('leaving a conversation whose delegated work is still going', () => {
  it('backgrounds it instead of retiring it', () => {
    const pane = focusedPane();
    handleAgentEvent(tasksEvent(0, ['running']));
    handleAgentEvent(ended(1));

    newSession();

    // The turn was over, so the old rule — keep only live *runs* — retired the
    // pane here, and with it went the task rows, the tab they feed, and the
    // place the settle turn would have landed. The workflow is still running;
    // the conversation waits in the background with its rows intact.
    expect(useApp.getState().background.some((p) => p.id === pane.id)).toBe(true);
    expect(paneState(pane).tasks).toHaveLength(1);
    expect(useApp.getState().runningSessions).toContain('sess-1');
  });

  it('retires it once the work has settled', () => {
    const pane = focusedPane();
    handleAgentEvent(tasksEvent(0, ['running']));
    handleAgentEvent(ended(1));
    handleAgentEvent(tasksEvent(2, ['completed']));

    newSession();

    // Nothing is running any more: the transcript is on disk, and holding the
    // pane would only be a memory cost. Same outcome as before the fix.
    expect(useApp.getState().background.some((p) => p.id === pane.id)).toBe(false);
  });

  it('does not hand a fresh session the old conversation’s settled rows', () => {
    const pane = focusedPane();
    handleAgentEvent(tasksEvent(0, ['completed']));
    handleAgentEvent(ended(1));

    const fresh = newSession();

    // The idle path clears in place, so `fresh` is the same pane object — and
    // its delegated list must start empty rather than inheriting rows from the
    // conversation that was just erased.
    expect(fresh.id).toBe(pane.id);
    expect(paneState(fresh).tasks).toHaveLength(0);
  });
});
