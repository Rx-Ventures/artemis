import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ToolEndStatus } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  isGroupId,
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

describe('TranscriptModel tool groups', () => {
  /** `tool.start` + `tool.end` for one call, as a pair of event drafts. */
  function call(id: string, name: string, status: ToolEndStatus = 'ok') {
    return [
      { type: 'tool.start', toolCallId: id, name, input: {} },
      { type: 'tool.end', toolCallId: id, status },
    ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
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

  it('breaks a group when something that is not a tool comes between', () => {
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'halfway' },
      ...call('c2', 'Read'),
    )) {
      model.apply(event);
    }

    const rows = model.getRowsSnapshot();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('g:t:c1');
    expect(isGroupId(rows[1] as string)).toBe(false);
    expect(rows[2]).toBe('g:t:c2');
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
