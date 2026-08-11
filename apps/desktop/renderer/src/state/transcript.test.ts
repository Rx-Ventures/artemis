import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';
import { TranscriptModel, syncScheduler, type AssistantItem, type ToolItem } from './transcript';

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
