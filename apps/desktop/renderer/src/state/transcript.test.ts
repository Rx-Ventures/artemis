import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ToolEndStatus } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  isGroupId,
  frameScheduler,
  syncScheduler,
  type AssistantItem,
  type ToolItem,
} from './transcript';

const RUN = 'run_1';

/** Envelope filler, so the tests read as event bodies rather than plumbing. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: RUN, seq: index, ts: 1000 + index })) as AgentEvent[];
}

function build(): TranscriptModel {
  return new TranscriptModel(syncScheduler);
}

describe('TranscriptModel', () => {
  it('coalesces deltas into one block and leaves the list identity alone', () => {
    const model = build();
    const onList = vi.fn();
    model.subscribeList(onList);

    const [start, ...deltas] = stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Hel' },
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'lo ' },
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'world' },
    );
    model.apply(start as AgentEvent);

    const listAfterFirst = model.getListSnapshot();
    const listCalls = onList.mock.calls.length;
    const id = listAfterFirst[0] as string;

    const onItem = vi.fn();
    model.subscribeItem(id, onItem);
    for (const event of deltas) model.apply(event);

    // Two more deltas touched the item twice and the list not at all.
    expect(onItem).toHaveBeenCalledTimes(2);
    expect(onList.mock.calls.length).toBe(listCalls);
    expect(model.getListSnapshot()).toBe(listAfterFirst);

    const item = model.getItem(id) as AssistantItem;
    expect(item.text).toBe('Hello world');
    expect(item.streaming).toBe(true);
  });

  it('treats text.complete as authoritative and stops the stream', () => {
    const model = build();
    for (const event of stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'partial' },
      { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 0, text: 'partial answer' },
    )) {
      model.apply(event);
    }
    const ids = model.getListSnapshot();
    expect(ids).toHaveLength(1);
    const item = model.getItem(ids[0] as string) as AssistantItem;
    expect(item.text).toBe('partial answer');
    expect(item.streaming).toBe(false);
  });

  it('merges tool.start and tool.end into a single item', () => {
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'README.md', durationMs: 12 },
    )) {
      model.apply(event);
    }
    const ids = model.getListSnapshot();
    expect(ids).toHaveLength(1);
    const item = model.getItem(ids[0] as string) as ToolItem;
    expect(item.name).toBe('Bash');
    expect(item.status).toBe('ok');
    expect(item.resultText).toBe('README.md');
    expect(item.input).toEqual({ command: 'ls' });
  });

  it('never leaves a spinner running when a run ends mid-call', () => {
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'sleep 100' } },
      { type: 'run.end', reason: 'interrupted' },
    )) {
      model.apply(event);
    }
    const tool = model.getItem('t:c1') as ToolItem;
    expect(tool.status).toBe('cancelled');
  });

  it('reconciles the optimistic user message instead of duplicating it', () => {
    const model = build();
    model.pushUserMessage('run the tests');
    model.apply(
      stream({ type: 'text.complete', messageId: 'u1', role: 'user', text: 'run the tests' })[0] as AgentEvent,
    );
    const ids = model.getListSnapshot();
    expect(ids).toHaveLength(1);
    const item = model.getItem(ids[0] as string);
    expect(item).toMatchObject({ kind: 'user', text: 'run the tests', pending: false });
  });

  it('surfaces a gap in the event sequence', () => {
    const model = build();
    model.apply({ type: 'text.delta', runId: RUN, seq: 0, ts: 1, messageId: 'm', blockIndex: 0, text: 'a' });
    model.apply({ type: 'text.delta', runId: RUN, seq: 4, ts: 2, messageId: 'm', blockIndex: 0, text: 'b' });
    const notices = model
      .getListSnapshot()
      .map((id) => model.getItem(id))
      .filter((item) => item?.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'warn' });
  });
});

/**
 * Replaying a run that had prompts in it.
 *
 * ⌘R reloads the renderer without touching the main process, so the transcript
 * is rebuilt by replaying the run's retained events into an empty model. Before
 * `permission.resolved` existed, the history held only the *asking* — so every
 * prompt the user had already answered came back pending, and the user was
 * asked to approve a plan they had approved a minute earlier.
 */
describe('TranscriptModel permission replay', () => {
  const REQUEST = {
    id: 'perm-1',
    runId: RUN,
    toolName: 'Bash',
    input: { command: 'ls' },
    requestedAt: 1,
  };

  function replay(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): TranscriptModel {
    const model = build();
    for (const event of stream(...drafts)) model.apply(event);
    return model;
  }

  function card(model: TranscriptModel) {
    return model
      .getListSnapshot()
      .map((id) => model.getItem(id))
      .find((item) => item?.kind === 'permission');
  }

  it('settles a replayed prompt instead of asking again', () => {
    const model = replay(
      { type: 'permission.request', requestId: 'perm-1', request: REQUEST },
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'allowed' },
    );
    expect(card(model)).toMatchObject({ state: 'allowed' });
  });

  it('keeps a prompt that was still open when the window went away', () => {
    const model = replay({ type: 'permission.request', requestId: 'perm-1', request: REQUEST });
    // The run really is still parked on this one, so it has to come back as a
    // live card — the whole point of re-attaching is that the user can answer it.
    expect(card(model)).toMatchObject({ state: 'pending' });
  });

  it('records a denial with the reason that was given', () => {
    const model = replay(
      { type: 'permission.request', requestId: 'perm-1', request: REQUEST },
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'denied', note: 'not that one' },
    );
    expect(card(model)).toMatchObject({ state: 'denied', note: 'not that one' });
  });

  /**
   * A question is answered, not "allowed" — and a replayed record has to show
   * which options were picked, or the transcript loses what the conversation
   * actually decided.
   */
  it('replays an answered question as answered, with the answers', () => {
    const question = {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'one' },
            { label: 'Luxon', description: 'two' },
          ],
        },
      ],
    };
    const model = replay(
      {
        type: 'permission.request',
        requestId: 'perm-1',
        request: { ...REQUEST, toolName: 'AskUserQuestion', question },
      },
      {
        type: 'permission.resolved',
        requestId: 'perm-1',
        outcome: 'allowed',
        answers: [{ question: 'Which library?', options: ['Luxon'] }],
      },
    );
    expect(card(model)).toMatchObject({
      state: 'answered',
      answers: [{ question: 'Which library?', options: ['Luxon'] }],
    });
  });

  it('replays an unanswered question as skipped', () => {
    const question = {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'one' },
            { label: 'Luxon', description: 'two' },
          ],
        },
      ],
    };
    const model = replay(
      {
        type: 'permission.request',
        requestId: 'perm-1',
        request: { ...REQUEST, toolName: 'AskUserQuestion', question },
      },
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'allowed', answers: [] },
    );
    expect(card(model)).toMatchObject({ state: 'skipped' });
  });

  /**
   * The local record wins. Whoever sent the decision knows things the event
   * does not — the scope the user picked, for one — so a resolution arriving
   * after the card has already settled must not overwrite it.
   */
  it('does not overwrite a card that was already settled locally', () => {
    const model = build();
    for (const event of stream({
      type: 'permission.request',
      requestId: 'perm-1',
      request: REQUEST,
    })) {
      model.apply(event);
    }
    model.resolvePermission('perm-1', 'allowed', 'allowed for this session');
    model.apply({
      type: 'permission.resolved',
      runId: RUN,
      seq: 1,
      ts: 2,
      requestId: 'perm-1',
      outcome: 'allowed',
    });
    expect(card(model)).toMatchObject({ state: 'allowed', note: 'allowed for this session' });
  });

  /**
   * The retained history is bounded, so a long run can drop the request and
   * keep the resolution. There is no card to settle, and inventing one would
   * put a decision in the transcript with no ask above it.
   */
  it('ignores a resolution for a request it never saw', () => {
    const model = replay({ type: 'permission.resolved', requestId: 'perm-9', outcome: 'allowed' });
    expect(card(model)).toBeUndefined();
  });
});

describe('TranscriptModel activity groups', () => {
  /** `tool.start` + `tool.end` for one call, as a pair of event drafts. */
  function call(id: string, name: string, status: ToolEndStatus = 'ok') {
    return [
      { type: 'tool.start', toolCallId: id, name, input: {} },
      { type: 'tool.end', toolCallId: id, status },
    ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
  }

  /** One whole thinking block, the way a provider that does not stream sends it. */
  function thought(messageId: string, blockIndex: number, text: string) {
    return { type: 'thinking.delta', messageId, blockIndex, text } as Omit<
      AgentEvent,
      'runId' | 'seq' | 'ts'
    >;
  }

  it('folds a run of tool calls into one row and counts it by category', () => {
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      ...call('c2', 'Bash'),
      ...call('c3', 'Read'),
      ...call('c4', 'mcp__github__create_issue'),
    )) {
      model.apply(event);
    }

    const rows = model.getRowsSnapshot();
    expect(rows).toEqual(['g:t:c1']);
    expect(model.getListSnapshot()).toHaveLength(4);

    const group = model.getGroup('g:t:c1');
    expect(group?.ids).toEqual(['t:c1', 't:c2', 't:c3', 't:c4']);
    expect(group?.counts).toEqual({ command: 2, read: 1, mcp: 1 });
    expect(group?.running).toBe(0);
    expect(group?.failed).toBe(0);
  });

  it('does not break the work up when the agent says something mid-run', () => {
    /*
     * This asserted the opposite until the machinery moved to the foot of the
     * run, and the opposite is what it was reported as: a paragraph, a
     * `Ran 3 commands` bar, the rest of the paragraph. The prose is what the
     * reader came for, and a marker between its halves interrupts the one thing
     * the transcript exists to carry.
     *
     * So a message no longer splits the work in two. It flows on, and every
     * call in the run collects into one marker underneath it.
     */
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'halfway' },
      ...call('c2', 'Read'),
    )) {
      model.apply(event);
    }

    const rows = model.getRowsSnapshot();
    expect(rows).toHaveLength(2);
    // The message first, uninterrupted; one marker for both calls after it.
    expect(isGroupId(rows[0] as string)).toBe(false);
    expect(rows[1]).toBe('g:t:c1');
  });

  it('leaves the thinking between two calls in the thread, and sinks the calls', () => {
    const model = build();
    for (const event of stream(
      thought('m1', 0, 'where does this live'),
      ...call('c1', 'Grep'),
      thought('m1', 1, 'now the other file'),
      ...call('c2', 'Read'),
      thought('m1', 2, 'that explains it'),
    )) {
      model.apply(event);
    }

    // The interleaving the marker used to swallow whole. Reasoning is what the
    // model was working out and reads in order with the prose around it; the
    // calls are the account of how, and collect underneath.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'k:m1:1', 'k:m1:2', 'g:t:c1']);

    const group = model.getGroup('g:t:c1');
    expect(group?.ids).toEqual(['t:c1', 't:c2']);
    expect(group?.counts).toEqual({ search: 1, read: 1 });
    expect(group?.running).toBe(0);
  });

  it('leaves thinking that did no work exactly where it happened', () => {
    /*
     * Reasoning before an answer, which is the commonest shape there is: the
     * model works out what to say and then says it, and read in that order it
     * is a conversation. Sinking it under the answer — which this briefly did,
     * back when reasoning and calls were one category — put the working-out
     * after the working-out's conclusion.
     */
    const model = build();
    for (const event of stream(
      thought('m1', 0, 'the user wants the short answer'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 1, text: 'no' },
    )) {
      model.apply(event);
    }

    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'a:m1:1']);
  });

  it('gives no row to a thinking block that arrives empty', () => {
    const model = build();
    for (const event of stream(
      thought('m1', 0, ''),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 1, text: 'no' },
    )) {
      model.apply(event);
    }

    // The fold would have said "thinking…" and opened onto nothing.
    expect(model.getRowsSnapshot()).toEqual(['a:m1:1']);
    expect(model.getItem('k:m1:0')).toBeUndefined();
  });

  it('keeps the redaction notice, which is not the same as empty', () => {
    const model = build();
    const [event] = stream({
      type: 'thinking.delta',
      messageId: 'm1',
      blockIndex: 0,
      text: '',
      redacted: true,
    });
    model.apply(event as AgentEvent);

    // Empty text, but it says something: the provider encrypted this one.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);
  });

  /*
   * The two kinds of row, interleaved every way a run interleaves them. The
   * Appearance switch no longer reaches this level at all — it decides whether
   * a reasoning row arrives expanded, not where it goes — so what these pin is
   * the rule itself: reasoning in place, calls at the foot, whatever order they
   * arrived in.
   */
  describe('reasoning against the work it happened between', () => {
    it('keeps both thoughts in the thread and folds the three calls beneath', () => {
      const model = build();
      for (const event of stream(
        thought('m1', 0, 'where does this live'),
        ...call('c1', 'Grep'),
        ...call('c2', 'Grep'),
        thought('m1', 1, 'now the other file'),
        ...call('c3', 'Read'),
      )) {
        model.apply(event);
      }

      // Both thoughts keep their place in order, and the three calls that used
      // to be two markers around them are one marker underneath.
      expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'k:m1:1', 'g:t:c1']);
      expect(model.getGroup('g:t:c1')?.counts).toEqual({ search: 2, read: 1 });
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2', 't:c3']);
    });

    it('holds the thought that lands after the last call', () => {
      // The tail case: a run whose reasoning arrives *between* the work and the
      // answer. The marker is named for the first call, so a thought after it
      // does not move the marker's id — an expanded one must not collapse.
      const model = build();
      for (const event of stream(
        ...call('c1', 'Grep'),
        thought('m1', 0, 'now the other file'),
        ...call('c2', 'Read'),
        thought('m1', 1, 'that explains it'),
      )) {
        model.apply(event);
      }

      expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'k:m1:1', 'g:t:c1']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2']);
    });

    it('closes the marker when the model stops, and opens a fresh one for the next ask', () => {
      /*
       * The break. The model said its piece and is waiting, so the account of
       * how it got there is complete — and what is asked next is a new
       * question with a new account.
       */
      const model = build();
      for (const event of stream(
        ...call('c1', 'Grep'),
        { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'found it' },
        { type: 'run.end', reason: 'completed' },
        { type: 'text.complete', messageId: 'u2', role: 'user', text: 'now fix it' },
        ...call('c2', 'Bash'),
        { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'done' },
      )) {
        model.apply(event);
      }

      const rows = model.getRowsSnapshot();
      // Two markers, one per turn, each under the answer it belongs to.
      expect(rows.filter((id) => id.startsWith('g:'))).toEqual(['g:t:c1', 'g:t:c2']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1']);
      expect(model.getGroup('g:t:c2')?.ids).toEqual(['t:c2']);
    });

    it('carries the accumulation across an interruption, because that is not a break', () => {
      /*
       * Stopping a run to redirect it is one request being steered, not two.
       * Splitting here would report the reader's impatience as a boundary in
       * what the agent did.
       */
      const model = build();
      for (const event of stream(
        ...call('c1', 'Grep'),
        { type: 'run.end', reason: 'interrupted' },
        { type: 'text.complete', messageId: 'u2', role: 'user', text: 'no, the other file' },
        ...call('c2', 'Read'),
        { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'got it' },
        { type: 'run.end', reason: 'completed' },
      )) {
        model.apply(event);
      }

      const rows = model.getRowsSnapshot();
      expect(rows.filter((id) => id.startsWith('g:'))).toEqual(['g:t:c1']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2']);
      // The interruption itself is still on the record — it happened, and the
      // transcript is the record. It just is not a boundary.
      expect(rows.filter((id) => id.startsWith('e:'))).toHaveLength(2);
    });

    it('gives a run that only thought no marker at all', () => {
      // Nothing was done, so there is nothing to account for. A marker here
      // would be a fold over an empty list.
      const model = build();
      for (const event of stream(thought('m1', 0, 'hmm'))) model.apply(event);

      expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);
    });
  });

  it('creates the block on the delta that first carries text', () => {
    const model = build();
    for (const event of stream(thought('m1', 0, ''), thought('m1', 0, 'here it is'))) {
      model.apply(event);
    }

    expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);
    expect(model.getItem('k:m1:0')).toMatchObject({ kind: 'thinking', text: 'here it is' });
  });

  it('gives an empty block no row of its own to stand in', () => {
    const model = build();
    for (const event of stream(
      thought('m1', 0, 'first, look'),
      ...call('c1', 'Grep'),
      thought('m1', 1, ''),
      ...call('c2', 'Read'),
    )) {
      model.apply(event);
    }

    // `k:m1:1` never became an item — a fold that says "thinking…" and opens
    // onto nothing is worse than no row.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
    expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2']);
  });

  it('leaves a lone thinking row alone when a call arrives after it', () => {
    const model = build();
    model.apply(stream(thought('m1', 0, 'let me look'))[0] as AgentEvent);
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);

    for (const event of stream(...call('c1', 'Read'))) model.apply(event);

    // The row the reader was already looking at keeps its id and its place. It
    // used to be swallowed into a marker at this moment, which moved text off
    // the screen as the agent worked.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
  });

  it('stays silent while a thinking block inside it streams', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'), thought('m1', 0, 'so far so good'))) {
      model.apply(event);
    }

    const groupId = model.getRowsSnapshot()[0] as string;
    const before = model.getGroup(groupId);
    const onGroup = vi.fn();
    model.subscribeGroup(groupId, onGroup);

    // The per-token path, now running through a member of the group. The
    // summary holds counters and no text, so nothing about it moved.
    model.apply(stream(thought('m1', 0, ' — keep going'))[0] as AgentEvent);

    expect(model.getGroup(groupId)).toBe(before);
    expect(onGroup).not.toHaveBeenCalled();
  });

  it('keeps a group id stable as the burst grows, so an open marker stays open', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'))) model.apply(event);
    const first = model.getRowsSnapshot()[0];

    for (const event of stream(...call('c2', 'Bash'), ...call('c3', 'Grep'))) model.apply(event);

    expect(model.getRowsSnapshot()).toEqual([first]);
    expect(model.getGroup(first as string)?.ids).toHaveLength(3);
  });

  it('reports work in flight, and a failure that must not stay hidden', () => {
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: {} },
      { type: 'tool.end', toolCallId: 'c1', status: 'error' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: {} },
    )) {
      model.apply(event);
    }
    const group = model.getGroup('g:t:c1');
    expect(group?.failed).toBe(1);
    expect(group?.running).toBe(1);
  });

  it('holds the snapshot identity steady while a sibling streams', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'))) model.apply(event);

    const groupId = model.getRowsSnapshot()[0] as string;
    const before = model.getGroup(groupId);
    const onGroup = vi.fn();
    model.subscribeGroup(groupId, onGroup);

    // Text arriving elsewhere is the per-token path: it must not touch the
    // group's identity and must not notify its subscriber.
    model.apply(
      stream({ type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'thinking out loud' })[0] as AgentEvent,
    );

    expect(model.getGroup(groupId)).toBe(before);
    expect(onGroup).not.toHaveBeenCalled();
  });

  it('notifies a group when one of its own calls finishes', () => {
    const model = build();
    model.apply(stream({ type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: {} })[0] as AgentEvent);

    const groupId = model.getRowsSnapshot()[0] as string;
    const before = model.getGroup(groupId);
    const onGroup = vi.fn();
    model.subscribeGroup(groupId, onGroup);

    model.apply({ type: 'tool.end', runId: RUN, seq: 1, ts: 2, toolCallId: 'c1', status: 'ok' });

    expect(onGroup).toHaveBeenCalledTimes(1);
    const after = model.getGroup(groupId);
    expect(after).not.toBe(before);
    expect(after?.running).toBe(0);
  });

  it('drops its groups on reset', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'))) model.apply(event);
    expect(model.getRowsSnapshot()).toHaveLength(1);

    model.reset();
    model.flush();

    expect(model.getRowsSnapshot()).toEqual([]);
    expect(model.getGroup('g:t:c1')).toBeUndefined();
  });
});

/*
 * Artifacts leave the fold — and the fold survives them leaving.
 *
 * The model is asked the question through an injected test, so these drive it
 * with a stand-in rather than the real `detectArtifact`: what is being pinned
 * here is the row arithmetic, and `artifact-tile.test.tsx` is where the real
 * predicate and the tile it produces are covered.
 */
describe('TranscriptModel artifacts', () => {
  function call(id: string, name: string, input: Record<string, unknown> = {}) {
    return [
      { type: 'tool.start', toolCallId: id, name, input },
      { type: 'tool.end', toolCallId: id, status: 'ok' },
    ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
  }

  function thought(messageId: string, blockIndex: number, text: string) {
    return { type: 'thinking.delta', messageId, blockIndex, text } as Omit<
      AgentEvent,
      'runId' | 'seq' | 'ts'
    >;
  }

  /** Every finished `Write` is an artifact. Enough to exercise the split. */
  function withArtifacts(): TranscriptModel {
    const model = build();
    model.setArtifactTest((item: ToolItem) => item.name === 'Write' && item.status === 'ok');
    return model;
  }

  it('lifts them out without breaking the burst in two', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Bash'),
      ...call('c2', 'Write', { file_path: '/tmp/report.html' }),
      ...call('c3', 'Bash'),
    )) {
      model.apply(event);
    }

    // One marker for both commands, then the tile. Not marker/tile/marker.
    expect(model.getRowsSnapshot()).toEqual(['g:t:c1', 't:c2']);
    const group = model.getGroup('g:t:c1');
    expect(group?.ids).toEqual(['t:c1', 't:c3']);
    // The lifted call is not a member, so the summary does not claim it too.
    expect(group?.counts).toEqual({ command: 2 });
  });

  it('keeps every artifact of a long burst, in order', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Bash'),
      thought('m1', 0, 'now the html'),
      ...call('c2', 'Write', { file_path: '/tmp/a.html' }),
      thought('m1', 1, 'now the svg'),
      ...call('c3', 'Write', { file_path: '/tmp/b.svg' }),
      thought('m1', 2, 'now the md'),
      ...call('c4', 'Write', { file_path: '/tmp/c.md' }),
    )) {
      model.apply(event);
    }

    // The three thoughts stay in the thread in the order the model wrote them;
    // the marker and its tiles land beneath the lot, and the tiles are still in
    // the order they were made rather than interleaved with the reasoning.
    expect(model.getRowsSnapshot()).toEqual([
      'k:m1:0',
      'k:m1:1',
      'k:m1:2',
      'g:t:c1',
      't:c2',
      't:c3',
      't:c4',
    ]);
  });

  it('produces no marker when the burst was nothing but artifacts', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Write', { file_path: '/tmp/a.html' }),
      ...call('c2', 'Write', { file_path: '/tmp/b.html' }),
    )) {
      model.apply(event);
    }

    // Nothing is left hidden, so there is nothing to summarise.
    expect(model.getRowsSnapshot()).toEqual(['t:c1', 't:c2']);
  });

  it('surfaces the tile the moment the write finishes', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Bash'),
      { type: 'tool.start', toolCallId: 'c2', name: 'Write', input: { file_path: '/tmp/a.html' } },
    )) {
      model.apply(event);
    }

    // Still running, so still ordinary work, so still folded.
    expect(model.getRowsSnapshot()).toEqual(['g:t:c1']);

    // Seq 3 continues the stream above — a gap would be a dropped event, and
    // the model would correctly add a notice row that has nothing to do with
    // what this is testing.
    model.apply({ type: 'tool.end', runId: RUN, seq: 3, ts: 1003, toolCallId: 'c2', status: 'ok' });
    model.flush();

    // `tool.end` is the verdict, and it has to restructure the rows to show it.
    expect(model.getRowsSnapshot()).toEqual(['g:t:c1', 't:c2']);
  });

  it('folds exactly as before when no test is installed', () => {
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      ...call('c2', 'Write', { file_path: '/tmp/report.html' }),
    )) {
      model.apply(event);
    }

    expect(model.getRowsSnapshot()).toEqual(['g:t:c1']);
  });
});

/*
 * The stall this suite exists to prevent.
 *
 * `markPending` latches on a single deferred flush, so whatever the scheduler
 * is must be *guaranteed* to run it. A window that stops producing frames —
 * occluded behind another Artemis window, minimised, on another Space — stops
 * running `requestAnimationFrame` callbacks, and a latch that is never cleared
 * silences the model permanently: every later event short-circuits, nothing is
 * notified, and the agent's work piles up invisibly until a reload dumps it in
 * one go. `startSessionFeed` already refuses to gate on visibility for exactly
 * this reason; the transcript has to hold the same line.
 */
describe('flush scheduling', () => {
  it('keeps notifying when animation frames stop arriving', () => {
    // Stands in for the timer half of the scheduler: the frame half never runs.
    const timers: Array<() => void> = [];
    const model = new TranscriptModel((flush) => timers.push(flush));

    const onList = vi.fn();
    model.subscribeList(onList);

    const [first, second] = stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'one' },
      { type: 'text.delta', messageId: 'm2', blockIndex: 0, text: 'two' },
    );

    model.apply(first as AgentEvent);
    expect(timers).toHaveLength(1);
    (timers.shift() as () => void)();
    expect(onList).toHaveBeenCalledTimes(1);

    // And the model is unlatched, so the next event schedules again rather than
    // being swallowed by a `pending` flag nothing will ever clear.
    model.apply(second as AgentEvent);
    expect(timers).toHaveLength(1);
    (timers.shift() as () => void)();
    expect(onList).toHaveBeenCalledTimes(2);
  });

  it('frameScheduler runs the flush even when no frame is ever produced', async () => {
    const realRaf = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    // A window that is not being composited: the callback is accepted and
    // dropped, which is what Chromium does for an occluded or minimised window.
    globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;

    try {
      const flush = vi.fn();
      frameScheduler(flush);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    }
  });

  it('flushes once when the frame arrives first, and does not flush twice', async () => {
    const flush = vi.fn();
    frameScheduler(flush);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
