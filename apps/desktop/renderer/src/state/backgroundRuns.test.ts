/**
 * @vitest-environment jsdom
 *
 * Leaving a conversation does not stop it.
 *
 * Three actions used to end a live run outright — starting a new session,
 * opening another one from the sidebar, and closing a column — because each
 * called `runs.dispose` on the way past. From the user's side that read as "the
 * agent dies whenever I look at something else", and the work it was halfway
 * through (edits, a running command, a permission prompt waiting for an answer)
 * went with it.
 *
 * The rule these assertions pin down is deliberately absolute: **nothing except
 * an interrupt or quitting stops a run.** So the tests below check both halves
 * of that — that the run survives the navigation, and that coming back to its
 * session gets the *same* conversation rather than a re-read of the provider's
 * file, which for a still-running session would be a partial copy of something
 * already in memory.
 *
 * `runs.dispose` is asserted on directly rather than through a symptom. It is
 * the one call that cannot be made here, and a future refactor that re-adds it
 * somewhere sensible-looking should fail on this file rather than on a bug
 * report three weeks later.
 *
 * Same caveat as `cwd.test.ts`: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities, SessionSummary } from '@rx-artemis/protocol';

import {
  allPanes,
  bootstrap,
  closePane,
  deleteSession,
  focusedPane,
  handleAgentEvent,
  newSession,
  openSessionBeside,
  resumeSession,
  splitPane,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';
import { seedApp } from './testkit';

/* -------------------------------------------------------------------------- */
/* A bridge that records what was asked of it                                 */
/* -------------------------------------------------------------------------- */

/*
 * One mutable stub installed once, because `resolveBridge` memoises its binding
 * on the first call — a second `window.artemis` would never be seen. Same
 * pattern as `models.test.ts` and `sessionSelection.test.ts`.
 */
const disposed = vi.fn();
const messagesFor = vi.fn();

/** What the main process claims is still running, and what it has retained. */
let mainProcessRuns: readonly unknown[] = [];
let retainedEvents: Record<string, readonly unknown[]> = {};
/** How many stored messages the fake session file holds. */
let storedMessageCount = 0;

/**
 * A stored session, one assistant message per stored record.
 *
 * `limit` is honoured rather than ignored, because that is the whole point of
 * the seam: a caller asking for the turns before a live run must not be handed
 * the live run's own half-written turn back.
 */
function storedMessages(runId: string, limit?: number): readonly unknown[] {
  const total = limit === undefined ? storedMessageCount : Math.min(limit, storedMessageCount);
  return Array.from({ length: total }, (_, i) => ({
    type: 'text.complete',
    runId,
    seq: i,
    ts: 1,
    messageId: `stored-${String(i)}`,
    role: 'assistant',
    text: `turn ${String(i + 1)}`,
  }));
}

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    dispose: async ({ runId }: { runId: string }) => {
      disposed(runId);
      return { ok: true, value: { runId } };
    },
    interrupt: async ({ runId }: { runId: string }) => ({ ok: true, value: { runId } }),
    list: async () => ({ ok: true, value: { runs: mainProcessRuns } }),
    events: async ({ runId }: { runId: string }) => ({
      ok: true,
      value: { runId, events: retainedEvents[runId] ?? [], truncated: false },
    }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    delete: async () => ({ ok: true, value: { deleted: true } }),
    messages: async (request: { sessionId: string; runId: string; limit?: number }) => {
      messagesFor(request.sessionId, request.limit);
      return {
        ok: true,
        value: { events: storedMessages(request.runId, request.limit), hasMore: false },
      };
    },
  },
  profiles: {
    list: async () => ({
      ok: true,
      value: {
        profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' }],
      },
    }),
  },
  providers: {
    list: async () => ({ ok: true, value: { providers: [CLAUDE_DESCRIPTOR] } }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
  },
  usagePlan: { cached: async () => ({ ok: true, value: { usage: null } }) },
  workspace: { describe: async () => ({ ok: true, value: { workspace: null } }) },
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CAPS = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
} as unknown as Capabilities;

const CLAUDE_DESCRIPTOR = {
  id: 'claude',
  label: 'Claude',
  capabilities: CAPS,
  models: [],
  effortLevels: [],
  available: true,
};

/** A run that is still going, bound to `sessionId`. */
function liveRun(runId: string, sessionId: string) {
  return {
    runId,
    status: 'running',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    capabilities: CAPS,
    startedAt: 1_000,
    sessionId,
  } as const;
}

function summary(id: string): SessionSummary {
  return {
    id,
    title: id,
    cwd: '/a',
    profileId: 'p1',
    updatedAt: 1_000,
    providerId: 'claude',
  } as SessionSummary;
}

const pane = () => focusedPane();
const state = () => paneState(pane());
const background = () => useApp.getState().background;

/** Let the microtasks a navigation kicks off settle. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 8));

/** True when the provider's session file was read for this session, at all. */
const readHistoryFor = (sessionId: string): boolean =>
  messagesFor.mock.calls.some(([id]) => id === sessionId);

/**
 * The transcript's row list, flushed first.
 *
 * The model coalesces one flush per animation frame — that is the whole reason
 * streaming is cheap — so a snapshot read straight after a write is legitimately
 * empty. Forcing the flush keeps the assertion about what the transcript *has*
 * rather than about how long a frame took.
 */
function rows(of: ReturnType<typeof focusedPane>): readonly string[] {
  of.transcript.flush();
  return of.transcript.getRowsSnapshot();
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  disposed.mockClear();
  messagesFor.mockClear();
  mainProcessRuns = [];
  retainedEvents = {};
  storedMessageCount = 0;

  // Back to one column with nothing in flight, whatever the previous test left.
  for (const extra of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    setPaneState(extra, { run: null });
    closePane(extra.id);
  }
  useApp.setState({ background: [], runningSessions: [], banners: [] });

  seedApp({
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' }],
    providers: [CLAUDE_DESCRIPTOR],
    sessions: [],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
    permissionQueue: [],
  });
  pane().transcript.reset();
});

/* -------------------------------------------------------------------------- */

describe('a live run when the user navigates away', () => {
  it('survives ⌘N and keeps its transcript', async () => {
    const working = pane();
    setPaneState(working, { run: liveRun('run-a', 'sess-a') });
    working.transcript.note('info', 'half a refactor');

    const fresh = newSession();
    await settled();

    expect(disposed).not.toHaveBeenCalled();
    // A different column now, holding nothing — and the old one is still alive.
    expect(fresh.id).not.toBe(working.id);
    expect(paneState(fresh).run).toBeNull();
    expect(background().map((p) => p.id)).toEqual([working.id]);
    expect(paneState(working).run?.runId).toBe('run-a');
    expect(rows(working).length).toBeGreaterThan(0);
  });

  it('survives opening another session from the sidebar', async () => {
    const working = pane();
    setPaneState(working, { run: liveRun('run-a', 'sess-a') });

    resumeSession(summary('sess-b'));
    await settled();

    expect(disposed).not.toHaveBeenCalled();
    expect(background().map((p) => p.id)).toEqual([working.id]);
    expect(state().resumeSessionId).toBe('sess-b');
  });

  it('survives closing its column', async () => {
    const working = pane();
    setPaneState(working, { run: liveRun('run-a', 'sess-a') });
    splitPane('right', working);

    closePane(working.id);
    await settled();

    expect(disposed).not.toHaveBeenCalled();
    expect(background().map((p) => p.id)).toEqual([working.id]);
  });

  it('is reported as running so the sidebar can mark its row', () => {
    setPaneState(pane(), { run: liveRun('run-a', 'sess-a') });

    expect(useApp.getState().runningSessions).toEqual(['sess-a']);
  });
});

describe('coming back to a session that never stopped', () => {
  it('hands the same conversation back rather than re-reading it', async () => {
    const working = pane();
    setPaneState(working, { run: liveRun('run-a', 'sess-a') });
    working.transcript.note('info', 'half a refactor');

    newSession();
    await settled();
    expect(background().map((p) => p.id)).toEqual([working.id]);

    resumeSession(summary('sess-a'));
    await settled();

    // The original pane is back in the grid with its run and its transcript.
    expect(focusedPane().id).toBe(working.id);
    expect(state().run?.runId).toBe('run-a');
    expect(rows(working).length).toBeGreaterThan(0);
    expect(background()).toHaveLength(0);
    // And nothing was replayed from the provider's file: it is still being
    // written, so a read would have produced a second, partial copy.
    expect(readHistoryFor('sess-a')).toBe(false);
  });

  it('still reads history for a session that is not running', async () => {
    resumeSession(summary('sess-old'));
    await settled();

    expect(readHistoryFor('sess-old')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

/*
 * Deleting a session must unhook it from every conversation, and "every"
 * includes the ones the user has navigated away from. The sweep used to walk
 * the grid alone, so a backgrounded column kept its `resumeSessionId` — and
 * coming back to that conversation aimed its next prompt at a transcript that
 * had just been destroyed.
 */
describe('deleting a session some conversation still points at', () => {
  it('clears the resume pointer of a backgrounded pane too', async () => {
    const working = pane();
    setPaneState(working, { run: liveRun('run-a', 'sess-a'), resumeSessionId: 'sess-a' });
    newSession();
    await settled();
    expect(background().map((p) => p.id)).toEqual([working.id]);

    // The visible column points at it as well, so the assertion below can tell
    // "cleared everywhere" apart from "cleared whatever happened to be on
    // screen" — the distinction the bug lived in.
    setPaneState(focusedPane(), { resumeSessionId: 'sess-a' });

    expect(await deleteSession(summary('sess-a'))).toBe(true);

    expect(paneState(focusedPane()).resumeSessionId).toBeNull();
    expect(paneState(working).resumeSessionId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/*
 * The same rule for a conversation that never left the screen.
 *
 * "Is this still running?" used to be asked of `background` alone, so a run in a
 * column the user was looking at was invisible to it and clicking its row fell
 * through to the resume path: the run was pushed into the background, a blank
 * column took its place, and the provider's half-written file was replayed into
 * it. The pane in front of the user then sat there looking finished while the
 * agent carried on working somewhere they could not see — and clicking the row
 * again, which *did* find it in the background by then, brought it back. That
 * click-to-kill / click-again-to-restore pair is what these pin shut.
 */
describe('a session running in a column that is already on screen', () => {
  it('is not disturbed by clicking its own row', async () => {
    const working = pane();
    setPaneState(working, { run: liveRun('run-a', 'sess-a'), resumeSessionId: 'sess-a' });
    working.transcript.note('info', 'half a refactor');

    resumeSession(summary('sess-a'));
    await settled();

    // Same column, same run, same transcript — and nothing in the background.
    expect(focusedPane().id).toBe(working.id);
    expect(state().run?.runId).toBe('run-a');
    expect(background()).toHaveLength(0);
    expect(rows(working).length).toBeGreaterThan(0);
    // The file is still being appended to, so replaying it would have shown a
    // partial copy of a conversation already in memory.
    expect(readHistoryFor('sess-a')).toBe(false);
  });

  it('is revealed rather than opened again in the other column', async () => {
    const left = pane();
    const right = splitPane('right', left);
    if (!right) throw new Error('expected a second column');
    setPaneState(right, { run: liveRun('run-b', 'sess-b'), resumeSessionId: 'sess-b' });
    useApp.setState({ focusedPaneId: left.id });

    resumeSession(summary('sess-b'), left);
    await settled();

    // The focus moves to the column already holding it; this one is untouched.
    expect(focusedPane().id).toBe(right.id);
    expect(paneState(left).resumeSessionId).toBeNull();
    expect(paneState(left).run).toBeNull();
    expect(paneState(right).run?.runId).toBe('run-b');
    expect(readHistoryFor('sess-b')).toBe(false);
    // One pane pointed at the session, not two: a prompt sent from a second one
    // would start a run appending to a transcript file this run already owns.
    expect(allPanes().filter((p) => paneState(p).resumeSessionId === 'sess-b')).toHaveLength(1);
  });

  it('is found by the run’s own id before the session has been selected', async () => {
    // A brand-new conversation: `resumeSessionId` is null until the run ends, and
    // it is the window in which a user is most likely to click away and back.
    const left = pane();
    const right = splitPane('right', left);
    if (!right) throw new Error('expected a second column');
    setPaneState(right, { run: liveRun('run-b', 'sess-b'), resumeSessionId: null });
    useApp.setState({ focusedPaneId: left.id });

    resumeSession(summary('sess-b'), left);
    await settled();

    expect(focusedPane().id).toBe(right.id);
    expect(paneState(left).resumeSessionId).toBeNull();
    expect(readHistoryFor('sess-b')).toBe(false);
  });

  it('is revealed by “open beside” instead of splitting a second copy off', async () => {
    const left = pane();
    const right = splitPane('right', left);
    if (!right) throw new Error('expected a second column');
    setPaneState(right, { run: liveRun('run-b', 'sess-b'), resumeSessionId: null });
    useApp.setState({ focusedPaneId: left.id });

    const landed = openSessionBeside(summary('sess-b'), 'right', left);
    await settled();

    expect(landed?.id).toBe(right.id);
    expect(allPanes()).toHaveLength(2);
  });

  it('comes home into the new column when “open beside” finds it backgrounded', async () => {
    const working = pane();
    setPaneState(working, { run: liveRun('run-a', 'sess-a') });
    newSession();
    await settled();
    expect(background().map((p) => p.id)).toEqual([working.id]);

    const landed = openSessionBeside(summary('sess-a'), 'right', focusedPane());
    await settled();

    // The split column is where it lands, and the returned pane is the one that
    // ended up holding it rather than the blank that was minted for the split.
    expect(landed?.id).toBe(working.id);
    expect(paneState(working).run?.runId).toBe('run-a');
    expect(background()).toHaveLength(0);
    expect(allPanes()).toHaveLength(2);
    expect(readHistoryFor('sess-a')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('after ⌘R reloads the window', () => {
  /*
   * ⌘R reloads the renderer and leaves the main process — where runs actually
   * live — untouched. The page used to come back with a blank grid and adopt at
   * most one run, without replaying a word of it, so an agent that was still
   * working was indistinguishable from one that had been killed. These are the
   * two properties that make a reload survivable: every run is picked up, and
   * each one's transcript is rebuilt from what the registry retained.
   */
  it('re-attaches every live run and replays what it has already said', async () => {
    mainProcessRuns = [liveRun('run-a', 'sess-a'), liveRun('run-b', 'sess-b')];
    retainedEvents = {
      'run-a': [
        { type: 'text.delta', runId: 'run-a', seq: 0, ts: 1, blockId: 'b1', text: 'still here' },
        { type: 'text.complete', runId: 'run-a', seq: 1, ts: 2, blockId: 'b1', text: 'still here' },
      ],
    };

    await bootstrap();
    await settled();

    // The open column took the first run; the second is running in the
    // background rather than being dropped on the floor.
    expect(state().run?.runId).toBe('run-a');
    expect(background().map((p) => paneState(p).run?.runId)).toEqual(['run-b']);
    // Both are marked as working, which is what puts them back within reach.
    expect([...useApp.getState().runningSessions].sort()).toEqual(['sess-a', 'sess-b']);
    // And the conversation is on screen again, not an empty pane: the text the
    // run had already produced is back in the transcript it belongs to.
    const replayed = rows(pane())
      .map((id) => pane().transcript.getItem(id))
      .filter((item) => item?.kind === 'assistant');
    expect(JSON.stringify(replayed)).toContain('still here');
  });

  /*
   * The reported bug, end to end.
   *
   * The column that took the *first* run replayed fine, because bootstrap hands
   * `adoptLiveRuns` a pane that is already in the grid. Every run after it got a
   * pane from `openPane`, which registers nothing — a pane reaches
   * `allLivePanes` only once it has been written into the grid or into
   * `background`, and that write happened after the whole loop had finished
   * attaching. So `paneForRun` could not find the pane the replay was for and
   * `applyAgentEvent` dropped every event of it on the floor.
   *
   * What made it read as "working, but never prints anything" is that the run
   * state arrived anyway: `attachRun` writes that through the pane object it was
   * handed rather than by routing, so the column came back marked live with an
   * empty transcript. And it stayed that way — `adoptLiveRuns` is the only thing
   * that reads the registry, and it runs once, at boot.
   */
  it('replays what the backgrounded runs said, not only the first one', async () => {
    mainProcessRuns = [liveRun('run-a', 'sess-a'), liveRun('run-b', 'sess-b')];
    retainedEvents = {
      'run-a': [
        { type: 'text.complete', runId: 'run-a', seq: 0, ts: 1, blockId: 'b1', text: 'first column' },
      ],
      'run-b': [
        { type: 'text.complete', runId: 'run-b', seq: 0, ts: 1, blockId: 'b2', text: 'second column' },
      ],
    };

    await bootstrap();
    await settled();

    const backgrounded = background()[0];
    expect(backgrounded).toBeDefined();
    if (!backgrounded) return;
    expect(paneState(backgrounded).run?.runId).toBe('run-b');

    const shown = JSON.stringify(
      rows(backgrounded).map((id) => backgrounded.transcript.getItem(id)),
    );
    expect(shown).toContain('second column');
  });

  it('draws the earlier turns from the session file and the live one from the buffer', async () => {
    /*
     * The session holds five stored messages; this run began after the third.
     * So turns 1-3 are history and turns 4-5 are the provider's half-written
     * copy of what the replay is about to render properly. Reading the file
     * without the seam would show turns 4 and 5 twice.
     */
    storedMessageCount = 5;
    mainProcessRuns = [{ ...liveRun('run-a', 'sess-a'), historyOffset: 3 }];
    retainedEvents = {
      'run-a': [
        { type: 'text.delta', runId: 'run-a', seq: 0, ts: 1, blockId: 'b1', text: 'live output' },
        { type: 'text.complete', runId: 'run-a', seq: 1, ts: 2, blockId: 'b1', text: 'live output' },
      ],
    };

    await bootstrap();
    await settled();

    expect(messagesFor).toHaveBeenCalledWith('sess-a', 3);
    const shown = JSON.stringify(rows(pane()).map((id) => pane().transcript.getItem(id)));
    expect(shown).toContain('turn 1');
    expect(shown).toContain('turn 3');
    expect(shown).toContain('live output');
    // The seam held: nothing past the offset came out of the file.
    expect(shown).not.toContain('turn 4');
  });

  /*
   * The reported bug: ⌘R on a session that had only just started came back with
   * the agent working away under no question at all.
   *
   * The prompt was only ever a renderer-side row, drawn optimistically the
   * moment it was typed — the Claude mapper drops the provider's echo of it
   * precisely because that row already exists. A reload throws the row away, and
   * neither source `attachRun` reads could put it back: a new session has a
   * `historyOffset` of 0, so there is no file to read, and the registry's buffer
   * held only what the adapter emitted. The registry now records the prompt into
   * that buffer itself, which is why this asserts on a *user* row rather than on
   * the text being present somewhere.
   */
  it('replays the prompt the run was started with', async () => {
    mainProcessRuns = [{ ...liveRun('run-a', 'sess-a'), historyOffset: 0 }];
    retainedEvents = {
      'run-a': [
        {
          type: 'text.complete',
          runId: 'run-a',
          seq: 0,
          ts: 1,
          messageId: 'run-a:prompt:1',
          role: 'user',
          text: 'find the bug',
          replay: true,
        },
        {
          type: 'text.complete',
          runId: 'run-a',
          seq: 1,
          ts: 2,
          messageId: 'm1',
          role: 'assistant',
          text: 'looking now',
        },
      ],
    };

    await bootstrap();
    await settled();

    const items = rows(pane()).map((id) => pane().transcript.getItem(id));
    expect(items.map((item) => item?.kind)).toEqual(['user', 'assistant']);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'find the bug', pending: false });
  });

  it('shows the run alone when the provider could not measure the seam', async () => {
    // No `historyOffset` on the handle — a provider that cannot count its own
    // stored messages. Reading the file here would duplicate the live turn, so
    // the run is shown on its own instead.
    storedMessageCount = 5;
    mainProcessRuns = [liveRun('run-a', 'sess-a')];

    await bootstrap();
    await settled();

    expect(readHistoryFor('sess-a')).toBe(false);
  });

  it('leaves the column alone when nothing was running', async () => {
    await bootstrap();
    await settled();

    expect(state().run).toBeNull();
    expect(background()).toHaveLength(0);
  });

  /*
   * The reported bug, end to end.
   *
   * The retained history holds the *asking*, and for a long time it held nothing
   * else — answering a prompt was an IPC call, and a call leaves no trace on the
   * stream. So a reload replayed every prompt the run had ever raised as though
   * it were still open: the user approved a plan, pressed ⌘R, and was asked to
   * approve the same plan again. Worse, the ghost could not be answered, because
   * the registry had settled it a minute earlier and rejects an id it no longer
   * holds.
   *
   * `permission.resolved` is the other half of the pair, and these two tests are
   * the difference between "still parked" and "already dealt with" surviving the
   * page.
   */
  const planRequest = {
    id: 'perm-1',
    runId: 'run-a',
    toolName: 'ExitPlanMode',
    input: { plan: '# Do the thing' },
    plan: { plan: '# Do the thing' },
    requestedAt: 1,
  };

  it('does not re-ask a prompt that was already answered', async () => {
    mainProcessRuns = [liveRun('run-a', 'sess-a')];
    retainedEvents = {
      'run-a': [
        { type: 'permission.request', runId: 'run-a', seq: 0, ts: 1, requestId: 'perm-1', request: planRequest },
        { type: 'permission.resolved', runId: 'run-a', seq: 1, ts: 2, requestId: 'perm-1', outcome: 'allowed' },
      ],
    };

    await bootstrap();
    await settled();

    // Nothing is parked, so no card demands an answer and the composer is free.
    expect(state().permissionQueue).toHaveLength(0);
    expect(state().run?.status).not.toBe('awaiting_permission');
    // The decision is still on the record, which is what the transcript is for.
    const card = rows(pane())
      .map((id) => pane().transcript.getItem(id))
      .find((item) => item?.kind === 'permission');
    expect(card).toMatchObject({ state: 'allowed' });
  });

  it('brings back a prompt that really is still open', async () => {
    mainProcessRuns = [liveRun('run-a', 'sess-a')];
    retainedEvents = {
      'run-a': [
        { type: 'permission.request', runId: 'run-a', seq: 0, ts: 1, requestId: 'perm-1', request: planRequest },
      ],
    };

    await bootstrap();
    await settled();

    // The run is genuinely parked on this one. Re-attaching has to hand it back
    // answerable, or the reload strands an agent that is waiting on a person.
    expect(state().permissionQueue.map((r) => r.id)).toEqual(['perm-1']);
    expect(state().run?.status).toBe('awaiting_permission');
  });
});

/* -------------------------------------------------------------------------- */
/* Coming back to a conversation only the registry is holding                 */
/* -------------------------------------------------------------------------- */

/*
 * A turn started by a scheduled wakeup between reloads, a pane evicted by
 * `pruneBackground`, another window's conversation: the run is live in main and
 * no pane in this window holds it. Clicking its sidebar row used to paint the
 * stored file — a snapshot nothing could ever update, because events route by
 * run id to a pane that does not exist, the stall sweep skips a pane with
 * `run: null`, and `claimContinuation` only fires on a `session.started` that
 * has already gone by. The one recovery was ⌘R, whose `adoptLiveRuns` is the
 * only other reader of the registry — so the resume path now asks the same
 * question at the same seam, per click instead of per boot.
 */
describe('resuming a session whose live run no pane holds', () => {
  const startedEvent = (runId: string, sessionId: string, seq: number) =>
    ({
      type: 'session.started',
      runId,
      seq,
      ts: 1,
      sessionId,
    }) as never;

  const sayLive = (runId: string, seq: number, text: string) =>
    ({
      type: 'text.complete',
      runId,
      seq,
      ts: 1,
      messageId: `live-${runId}-${String(seq)}`,
      role: 'assistant',
      text,
    }) as never;

  /** Everything the pane's transcript says, as text — row keys tell no story. */
  const textOf = (target: ReturnType<typeof focusedPane>): string => {
    target.transcript.flush();
    return target.transcript
      .getListSnapshot()
      .map((id) => (target.transcript.getItem(id) as { text?: string } | undefined)?.text ?? '')
      .join('\n');
  };

  it('attaches the live run instead of painting a snapshot nothing can update', async () => {
    mainProcessRuns = [liveRun('run-live', 'sess-live')];
    retainedEvents = {
      'run-live': [
        startedEvent('run-live', 'sess-live', 0),
        sayLive('run-live', 1, 'already midway through'),
      ],
    };

    resumeSession(summary('sess-live'));
    await settled();

    // The pane holds the *run*, not a static copy of the session.
    expect(state().run?.runId).toBe('run-live');
    expect(state().run?.status).toBe('running');
    expect(textOf(pane())).toContain('already midway through');

    // And the stream lands from here on — the whole point of holding it.
    handleAgentEvent(sayLive('run-live', 2, 'and still talking'));
    expect(textOf(pane())).toContain('and still talking');

    // The stored file was never painted over the live conversation.
    expect(readHistoryFor('sess-live')).toBe(false);
  });

  it('still reads the stored file when nothing is live', async () => {
    storedMessageCount = 2;
    mainProcessRuns = [];

    resumeSession(summary('sess-cold'));
    await settled();

    expect(state().run).toBeNull();
    expect(readHistoryFor('sess-cold')).toBe(true);
    expect(textOf(pane())).toContain('turn 1');
  });
});
