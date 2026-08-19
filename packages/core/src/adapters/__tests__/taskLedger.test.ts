/**
 * The task ledger: five provider messages, one row each.
 *
 * The rules worth arguing with, all of which come from the SDK's own contract
 * for these messages rather than from taste:
 *
 *  1. **The level decides membership.** `background_tasks_changed` is documented
 *     as a level with replace semantics, and as existing precisely so a consumer
 *     "cannot wedge a stale running indicator" by missing an edge. So a task it
 *     stops naming has ended, whether or not its notification arrived.
 *  2. **Edges may arrive in any order relative to it**, including for tasks it
 *     never names — a foreground subagent is delegated work and is not
 *     background work, so it is in no level payload at all.
 *  3. **A settled row stays**, because the moment work finishes is the moment
 *     its result is worth reading, and the oldest are evicted rather than kept
 *     for ever.
 *
 * These are driven by message literals on purpose: the whole point of making the
 * merge a pure object is that its state machine can be argued with in a list.
 */

import { describe, expect, it } from 'vitest';

import { SETTLED_LIMIT, TaskLedger } from '../taskLedger.js';

/** A clock the test moves by hand, so elapsed values are assertions not races. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const level = (...tasks: readonly { id: string; kind?: string; description?: string }[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: tasks.map((t) => ({
    task_id: t.id,
    task_type: t.kind ?? 'local_bash',
    description: t.description ?? 'a task',
  })),
});

const started = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  description: 'Audit the mapper',
  ...over,
});

const progress = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_progress',
  task_id: id,
  description: 'Audit the mapper',
  usage: { total_tokens: 24_100, tool_uses: 7, duration_ms: 72_000 },
  ...over,
});

const updated = (id: string, patch: Record<string, unknown>) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: id,
  patch,
});

const settled = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status: 'completed',
  output_file: '/tmp/task-1.md',
  summary: 'Found three seams',
  ...over,
});

describe('the task ledger', () => {
  it('builds a row from the level alone', () => {
    const ledger = new TaskLedger(clock().now);
    expect(ledger.observe(level({ id: 't1', description: 'Sleep 25 seconds' }))).toBe(true);

    expect(ledger.snapshot()).toEqual([
      {
        id: 't1',
        kind: 'local_bash',
        description: 'Sleep 25 seconds',
        status: 'running',
        startedAt: 1_000,
      },
    ]);
  });

  it('merges the detail the level does not carry', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }));
    ledger.observe(
      started('t1', {
        subagent_type: 'Explore',
        task_type: 'local_workflow',
        workflow_name: 'review-changes',
        prompt: 'Find the auth call sites',
      }),
    );
    ledger.observe(progress('t1', { last_tool_name: 'Grep', summary: 'reading auth.ts' }));

    expect(ledger.snapshot()[0]).toMatchObject({
      id: 't1',
      kind: 'local_workflow',
      subagentType: 'Explore',
      workflowName: 'review-changes',
      prompt: 'Find the auth call sites',
      lastToolName: 'Grep',
      summary: 'reading auth.ts',
      totalTokens: 24_100,
      toolUses: 7,
      durationMs: 72_000,
      status: 'running',
    });
  });

  it('takes an edge before the level, and does not make a second row of it', () => {
    // The SDK says ordering between the two is unspecified. Everything keys on
    // the task id for exactly this reason.
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('t1', { description: 'Audit the mapper' }));
    ledger.observe(level({ id: 't1', description: 'Audit the mapper' }));

    const rows = ledger.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 't1', status: 'running' });
  });

  it('settles a row the level has stopped naming, without waiting for its notification', () => {
    // The whole reason the level exists: a missed bookend must not wedge a
    // spinner. If this waited for `task_notification` it would give that up.
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }, { id: 't2' }));
    ledger.observe(level({ id: 't1' }));

    const rows = ledger.snapshot();
    expect(rows.find((r) => r.id === 't1')?.status).toBe('running');
    expect(rows.find((r) => r.id === 't2')?.status).toBe('stopped');
  });

  it('leaves a foreground task alone, since the level never names one', () => {
    // A subagent that runs inside its turn is delegated work and is not
    // *background* work. Settling it on the first level payload that arrived for
    // something else would mark live work as stopped.
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('foreground'));
    ledger.observe(level({ id: 'other' }));

    expect(ledger.snapshot().find((r) => r.id === 'foreground')?.status).toBe('running');
  });

  it('records how a task ended, and what it left behind', () => {
    const time = clock();
    const ledger = new TaskLedger(time.now);
    ledger.observe(level({ id: 't1' }));
    time.advance(72_000);
    ledger.observe(
      settled('t1', {
        status: 'failed',
        usage: { total_tokens: 30_000, tool_uses: 9, duration_ms: 71_500 },
      }),
    );

    expect(ledger.snapshot()[0]).toMatchObject({
      status: 'failed',
      endedAt: 73_000,
      outputFile: '/tmp/task-1.md',
      summary: 'Found three seams',
      totalTokens: 30_000,
      durationMs: 71_500,
    });
  });

  it('reads a stop and a kill as the same ending', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }, { id: 't2' }));
    ledger.observe(settled('t1', { status: 'stopped' }));
    ledger.observe(updated('t2', { status: 'killed' }));

    const rows = ledger.snapshot();
    expect(rows.map((r) => r.status)).toEqual(['stopped', 'stopped']);
  });

  it('merges a patch, including a pause', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }));
    ledger.observe(updated('t1', { status: 'paused', description: 'Waiting on a lock' }));

    // Paused is still live: it has not ended, and a row that read as finished
    // would lose the one thing a reader could act on.
    expect(ledger.snapshot()[0]).toMatchObject({
      status: 'paused',
      description: 'Waiting on a lock',
    });
    expect(ledger.liveCount).toBe(1);
  });

  it('carries the error text a failure arrives with', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }));
    ledger.observe(updated('t1', { status: 'failed', error: 'ENOENT: no such file' }));

    expect(ledger.snapshot()[0]).toMatchObject({
      status: 'failed',
      error: 'ENOENT: no such file',
    });
  });

  it('does not revive a settled row on a late progress message', () => {
    // The notification is the authority on how something ended. A progress
    // message after it is a message that took a different path through the CLI.
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }));
    ledger.observe(settled('t1'));
    ledger.observe(progress('t1', { last_tool_name: 'Read' }));

    expect(ledger.snapshot()[0]).toMatchObject({ status: 'completed', lastToolName: 'Read' });
  });

  it('does revive one the level names again', () => {
    // Unlike a stray progress message, this is the provider stating membership
    // outright — a foreground task that has just been backgrounded, for one.
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }));
    ledger.observe(level());
    expect(ledger.snapshot()[0]?.status).toBe('stopped');

    ledger.observe(level({ id: 't1' }));
    expect(ledger.snapshot()[0]).toMatchObject({ status: 'running', endedAt: undefined });
  });

  it('marks the ambient work the provider asks not to be shown inline', () => {
    // The SDK's own guidance for `skip_transcript`: hide from the transcript, and
    // a tasks panel may still show it. This is that panel's source.
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('t1', { skip_transcript: true }));

    expect(ledger.snapshot()[0]?.ambient).toBe(true);
  });

  it('keeps settled rows, but not for ever', () => {
    const ledger = new TaskLedger(clock().now);
    for (let i = 0; i < SETTLED_LIMIT + 4; i += 1) {
      ledger.observe(started(`t${String(i)}`, { description: `task ${String(i)}` }));
      ledger.observe(settled(`t${String(i)}`));
    }

    const rows = ledger.snapshot();
    expect(rows).toHaveLength(SETTLED_LIMIT);
    // The oldest go; the most recent — the ones a reader is plausibly looking at
    // — stay.
    expect(rows[rows.length - 1]?.id).toBe(`t${String(SETTLED_LIMIT + 3)}`);
  });

  it('never evicts a live row to make room', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('long-runner'));
    for (let i = 0; i < SETTLED_LIMIT + 4; i += 1) {
      ledger.observe(started(`t${String(i)}`));
      ledger.observe(settled(`t${String(i)}`));
    }

    expect(ledger.snapshot().find((r) => r.id === 'long-runner')?.status).toBe('running');
  });

  it('reports whether anything changed, so a quiet message costs no event', () => {
    const ledger = new TaskLedger(clock().now);

    expect(ledger.observe({ type: 'system', subtype: 'init' })).toBe(false);
    expect(ledger.observe({ type: 'assistant' })).toBe(false);
    // A patch for a task nothing has mentioned: not enough to build a row from,
    // since it carries neither a description nor a kind.
    expect(ledger.observe(updated('never-seen', { status: 'running' }))).toBe(false);
    expect(ledger.dirty).toBe(false);
  });

  it('clears its dirty flag when the snapshot is taken', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 't1' }));
    expect(ledger.dirty).toBe(true);

    ledger.snapshot();
    expect(ledger.dirty).toBe(false);
  });

  it('survives a payload the SDK has reshaped', () => {
    const ledger = new TaskLedger(clock().now);

    // Every one of these is nonsense, and none of them may throw inside the
    // pump — degrading to "no news" is the contract.
    expect(ledger.observe({ type: 'system', subtype: 'background_tasks_changed' })).toBe(false);
    expect(
      ledger.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: 'nope' }),
    ).toBe(false);
    expect(ledger.observe({ type: 'system', subtype: 'task_started' })).toBe(false);
    expect(ledger.observe({ type: 'system', subtype: 'task_updated', task_id: 't', patch: 3 })).toBe(
      false,
    );
    expect(ledger.snapshot()).toEqual([]);
  });

  it('names a task the level mentions without a description', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 't1' }],
    });

    // A row with no words on it is worse than a placeholder: the pane would show
    // an empty line and nothing to identify it by.
    expect(ledger.snapshot()[0]).toMatchObject({ description: 'unnamed task', kind: 'task' });
  });
});

/**
 * A workflow's own account of its agents.
 *
 * This arrives nested inside the workflow task's `task_progress`, which is what
 * makes the phase grouping possible at all — there is no parent-task field
 * anywhere in the task surface, so agents that arrived as siblings could never
 * be re-associated with the workflow that spawned them.
 *
 * The rule worth defending here is the retain: the provider sends the whole
 * array on a state change and at most every ten seconds during steady progress,
 * omitting the field on the messages in between. A ledger that wrote `undefined`
 * through would empty the pane several times a minute.
 */
const agent = (over: Record<string, unknown> = {}) => ({
  type: 'workflow_agent',
  index: 1,
  label: 'build:chat-reliability',
  state: 'progress',
  phaseIndex: 0,
  phaseTitle: 'Chat reliability',
  model: 'claude-opus-5[1m]',
  ...over,
});

describe('a workflow’s agents', () => {
  it('are read off the progress message', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow', workflow_name: 'doctor' }));
    ledger.observe(progress('w1', { workflow_progress: [agent()] }));

    expect(ledger.snapshot()[0]?.workflowProgress).toEqual([
      {
        index: 1,
        label: 'build:chat-reliability',
        state: 'progress',
        phaseIndex: 0,
        phaseTitle: 'Chat reliability',
        model: 'claude-opus-5[1m]',
      },
    ]);
  });

  it('are retained when the next message omits them', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow' }));
    ledger.observe(progress('w1', { workflow_progress: [agent()] }));
    // The throttled message: same task, no `workflow_progress` at all.
    ledger.observe(progress('w1', { usage: { total_tokens: 30_000, tool_uses: 9 } }));

    expect(ledger.snapshot()[0]?.workflowProgress).toHaveLength(1);
    // …and the rest of the message still applied.
    expect(ledger.snapshot()[0]?.totalTokens).toBe(30_000);
  });

  it('are replaced, not merged, when a new array arrives', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow' }));
    ledger.observe(progress('w1', { workflow_progress: [agent({ index: 1 })] }));
    ledger.observe(
      progress('w1', {
        workflow_progress: [agent({ index: 1, state: 'done' }), agent({ index: 2, label: 'review' })],
      }),
    );

    const agents = ledger.snapshot()[0]?.workflowProgress ?? [];
    expect(agents).toHaveLength(2);
    expect(agents[0]?.state).toBe('done');
  });

  it('go genuinely empty when the array holds no agents', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow' }));
    ledger.observe(progress('w1', { workflow_progress: [agent()] }));
    // An array that said "here is everything" and listed nothing is an answer,
    // unlike an absent field — so this one is written through.
    ledger.observe(progress('w1', { workflow_progress: [] }));

    expect(ledger.snapshot()[0]?.workflowProgress).toEqual([]);
  });

  it('drop the script’s own log lines', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow' }));
    ledger.observe(
      progress('w1', {
        workflow_progress: [{ type: 'workflow_log', message: '3/10 found' }, agent()],
      }),
    );

    // A log line drawn as an agent row would have no label and no state.
    expect(ledger.snapshot()[0]?.workflowProgress).toHaveLength(1);
  });

  it('drop an entry that cannot be keyed', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow' }));
    ledger.observe(
      progress('w1', {
        workflow_progress: [
          agent({ index: undefined }),
          agent({ index: 2, label: undefined }),
          agent({ index: 3, state: undefined }),
          agent({ index: 4 }),
        ],
      }),
    );

    // `index` and `label` are what the pane keys and groups by.
    expect(ledger.snapshot()[0]?.workflowProgress).toHaveLength(1);
    expect(ledger.snapshot()[0]?.workflowProgress?.[0]?.index).toBe(4);
  });

  it('survives a garbage payload without losing the row', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow' }));
    ledger.observe(progress('w1', { workflow_progress: 'not an array' }));

    // Not an array is not an answer — it retains, like an absent field.
    expect(ledger.snapshot()[0]?.workflowProgress).toBeUndefined();
    expect(ledger.snapshot()).toHaveLength(1);
  });

  it('carries the whole entry through, not just what the pane draws today', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('w1', { task_type: 'local_workflow' }));
    ledger.observe(
      progress('w1', {
        workflow_progress: [
          agent({
            state: 'error',
            agentId: 'agent_01',
            agentType: 'Explore',
            isolation: 'worktree',
            cached: true,
            blocked: true,
            error: 'skipped by user',
            tokens: 196_900,
            toolCalls: 31,
            durationMs: 936_000,
          }),
        ],
      }),
    );

    expect(ledger.snapshot()[0]?.workflowProgress?.[0]).toMatchObject({
      agentId: 'agent_01',
      agentType: 'Explore',
      isolation: 'worktree',
      cached: true,
      blocked: true,
      error: 'skipped by user',
      tokens: 196_900,
      toolCalls: 31,
      durationMs: 936_000,
    });
  });
});

/**
 * Reading the rows and *announcing* them are different acts.
 *
 * `snapshot` clears `dirty` because its only caller is about to put what it
 * returns on the stream. Once anything else reads the ledger — the reload path
 * asks it directly, since no event is going to carry these rows — that coupling
 * becomes a hazard: a reader that clears the flag marks an unsent change as
 * sent, the `background.tasks` event it was owed is never emitted, and every
 * window's rows sit frozen until something unrelated dirties the ledger again.
 *
 * So `peek` exists, and the thing worth pinning down is what it does *not* do.
 */
describe('reading the ledger without claiming to have sent it', () => {
  it('leaves a pending change pending', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('task_1'));
    expect(ledger.dirty).toBe(true);

    // The poll reads it. The turn that has not opened yet is still owed an event.
    expect(ledger.peek()).toHaveLength(1);

    expect(ledger.dirty).toBe(true);
    expect(ledger.snapshot()).toHaveLength(1);
    expect(ledger.dirty).toBe(false);
  });

  it('reports the same rows as the emitting read', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(level({ id: 'task_1' }));
    ledger.observe(progress('task_1'));

    expect(ledger.peek()).toEqual(ledger.snapshot());
  });

  it('hands back a copy rather than the ledger’s own list', () => {
    const ledger = new TaskLedger(clock().now);
    ledger.observe(started('task_1'));

    const rows = ledger.peek() as { id: string }[];
    rows.length = 0;

    // A caller that mutates what it was given must not empty the ledger.
    expect(ledger.peek()).toHaveLength(1);
  });
});
