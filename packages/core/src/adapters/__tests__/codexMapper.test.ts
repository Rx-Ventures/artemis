/**
 * Tests for the Codex ⇄ Artemis translation.
 *
 * The mapping is the part of the adapter most likely to be wrong and most worth
 * testing, so — like the Claude mapper — it is driven entirely with fixture
 * notifications and never spawns a process.
 *
 * The fixtures are transcribed from real `codex app-server` output, including
 * the event order observed for a live turn.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, JsonValue, RunId } from '@rx-artemis/protocol';

import {
  createCodexMapperState,
  finalizeCodexRun,
  flushCodexToolCalls,
  mapCodexNotification,
  nextCodexEventEnvelope,
  replayCodexItem,
} from '../codexMapper.js';
import type { CodexMapperState } from '../codexMapper.js';

const RUN_ID = 'run-1' as RunId;

/** A state with a deterministic clock, so `ts` is assertable. */
function makeState(options?: Parameters<typeof createCodexMapperState>[1]): CodexMapperState {
  let tick = 1_000;
  return createCodexMapperState(RUN_ID, {
    now: () => {
      tick += 1;
      return tick;
    },
    ...options,
  });
}

/** Feed a notification and collect what it produced. */
function feed(
  state: CodexMapperState,
  method: string,
  params: unknown,
): readonly AgentEvent[] {
  return mapCodexNotification(method, params as JsonValue, state);
}

/** The event sequence a real single-message turn produces, in observed order. */
function runSimpleTurn(state: CodexMapperState): AgentEvent[] {
  const events: AgentEvent[] = [];
  const push = (produced: readonly AgentEvent[]): void => {
    events.push(...produced);
  };

  push(feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/work', cliVersion: '0.142.3' } }));
  push(feed(state, 'turn/started', { threadId: 'th-1', turn: { id: 'tu-1', status: 'inProgress' } }));
  push(feed(state, 'item/started', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'it-1', text: '' } }));
  push(feed(state, 'item/agentMessage/delta', { threadId: 'th-1', turnId: 'tu-1', itemId: 'it-1', delta: 'P' }));
  push(feed(state, 'item/agentMessage/delta', { threadId: 'th-1', turnId: 'tu-1', itemId: 'it-1', delta: 'ONG' }));
  push(feed(state, 'item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'it-1', text: 'PONG' } }));
  push(
    feed(state, 'thread/tokenUsage/updated', {
      threadId: 'th-1',
      turnId: 'tu-1',
      tokenUsage: {
        total: { totalTokens: 13853, inputTokens: 13820, cachedInputTokens: 9600, outputTokens: 33 },
        last: { totalTokens: 13853, inputTokens: 13820, cachedInputTokens: 9600, outputTokens: 33 },
        modelContextWindow: 258400,
      },
    }),
  );
  push(feed(state, 'turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed', durationMs: 4200 } }));

  return events;
}

describe('the ordering contract', () => {
  it('emits session.started first and run.end last, exactly once each', () => {
    const events = runSimpleTurn(makeState());

    expect(events[0]?.type).toBe('session.started');
    expect(events.at(-1)?.type).toBe('run.end');
    expect(events.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.end')).toHaveLength(1);
  });

  it('produces the full expected event sequence for a real turn', () => {
    const events = runSimpleTurn(makeState());

    expect(events.map((e) => e.type)).toEqual([
      'session.started',
      'text.delta',
      'text.delta',
      'text.complete',
      'usage',
      'run.end',
    ]);
  });

  it('numbers seq densely from zero', () => {
    const events = runSimpleTurn(makeState());
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('stamps every event with the run id', () => {
    const events = runSimpleTurn(makeState());
    expect(events.every((e) => e.runId === RUN_ID)).toBe(true);
  });

  it('emits nothing at all once the run has ended', () => {
    const state = makeState();
    runSimpleTurn(state);

    expect(feed(state, 'item/agentMessage/delta', { itemId: 'it-9', delta: 'late' })).toEqual([]);
    expect(feed(state, 'turn/completed', { turn: { id: 'tu-2', status: 'completed' } })).toEqual([]);
  });

  it('ignores a second thread/started rather than emitting a second session.started', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/work' } });
    const again = feed(state, 'thread/started', { thread: { id: 'th-2', cwd: '/other' } });

    expect(again).toEqual([]);
    expect(state.sessionId).toBe('th-1');
  });
});

describe('session.started', () => {
  it('carries the thread id, cwd and CLI version', () => {
    const state = makeState();
    const [event] = feed(state, 'thread/started', {
      thread: { id: 'th-1', cwd: '/work/repo', cliVersion: '0.142.3' },
    });

    expect(event).toMatchObject({
      type: 'session.started',
      sessionId: 'th-1',
      providerId: 'codex',
      cwd: '/work/repo',
      providerVersion: '0.142.3',
    });
  });

  it('echoes resume and fork state from the run input', () => {
    const state = makeState({ resumedFrom: 'th-old', forked: true });
    const [event] = feed(state, 'thread/started', { thread: { id: 'th-new', cwd: '/work' } });

    expect(event).toMatchObject({ resumedFrom: 'th-old', forked: true });
  });

  it('drops a thread with no id rather than inventing one', () => {
    const state = makeState();
    expect(feed(state, 'thread/started', { thread: { cwd: '/work' } })).toEqual([]);
    expect(state.sessionStarted).toBe(false);
  });
});

describe('text', () => {
  it('emits deltas that concatenate to the completed block', () => {
    const events = runSimpleTurn(makeState());
    const deltas = events.filter((e) => e.type === 'text.delta');
    const complete = events.find((e) => e.type === 'text.complete');

    const joined = deltas.map((e) => (e as { text: string }).text).join('');
    expect(joined).toBe('PONG');
    expect(complete).toMatchObject({ text: 'PONG', role: 'assistant', blockIndex: 0 });
  });

  it('omits blockIndex on a completion that never streamed', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });
    const [event] = feed(state, 'item/completed', {
      item: { type: 'agentMessage', id: 'it-1', text: 'whole' },
    });

    expect(event).toMatchObject({ type: 'text.complete', text: 'whole' });
    expect(event).not.toHaveProperty('blockIndex');
  });

  it('ignores an empty delta', () => {
    const state = makeState();
    expect(feed(state, 'item/agentMessage/delta', { itemId: 'it-1', delta: '' })).toEqual([]);
  });

  it('ignores a delta with no item id', () => {
    const state = makeState();
    expect(feed(state, 'item/agentMessage/delta', { delta: 'orphan' })).toEqual([]);
  });

  it('does not echo the user message back into the transcript', () => {
    const state = makeState();
    const started = feed(state, 'item/started', { item: { type: 'userMessage', id: 'it-0' } });
    const completed = feed(state, 'item/completed', { item: { type: 'userMessage', id: 'it-0' } });

    expect(started).toEqual([]);
    expect(completed).toEqual([]);
  });
});

describe('thinking', () => {
  it('maps both reasoning delta channels', () => {
    const state = makeState();
    const text = feed(state, 'item/reasoning/textDelta', { itemId: 'r-1', delta: 'considering' });
    const summary = feed(state, 'item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'plan' });

    expect(text[0]).toMatchObject({ type: 'thinking.delta', text: 'considering', messageId: 'r-1' });
    expect(summary[0]).toMatchObject({ type: 'thinking.delta', text: 'plan' });
  });

  it('emits nothing when a reasoning item completes', () => {
    const state = makeState();
    // Re-emitting the item's content here would duplicate the whole block,
    // which already arrived as deltas.
    expect(
      feed(state, 'item/completed', {
        item: { type: 'reasoning', id: 'r-1', content: ['considering'] },
      }),
    ).toEqual([]);
  });
});

describe('tool calls', () => {
  const commandItem = {
    type: 'commandExecution',
    id: 'cmd-1',
    command: 'echo one',
    cwd: '/work',
  };

  it('brackets a shell command with tool.start and tool.end', () => {
    const state = makeState();
    const [start] = feed(state, 'item/started', { item: commandItem });
    const [end] = feed(state, 'item/completed', {
      item: { ...commandItem, status: 'completed', exitCode: 0, aggregatedOutput: 'one\n', durationMs: 12 },
    });

    expect(start).toMatchObject({
      type: 'tool.start',
      toolCallId: 'cmd-1',
      name: 'Shell',
      input: { command: 'echo one', cwd: '/work' },
      title: 'echo one',
    });
    expect(end).toMatchObject({
      type: 'tool.end',
      toolCallId: 'cmd-1',
      name: 'Shell',
      status: 'ok',
      resultText: 'one\n',
      durationMs: 12,
    });
  });

  it('reports a non-zero exit as a failed tool, not a failed run', () => {
    const state = makeState();
    feed(state, 'item/started', { item: commandItem });
    const [end] = feed(state, 'item/completed', {
      item: { ...commandItem, status: 'failed', exitCode: 2, aggregatedOutput: 'nope' },
    });

    expect(end).toMatchObject({ type: 'tool.end', status: 'error' });
    expect((end as { error?: { message: string } }).error?.message).toContain('code 2');
    // The run itself is untouched: the model is expected to read the output and
    // try something else.
    expect(state.ended).toBe(false);
    expect(state.lastError).toBeUndefined();
  });

  it('reports a refused command as denied, not as ok', () => {
    // Caught by the end-to-end smoke test: `declined` carries no exit code, so
    // before this was handled it fell through to `ok` and a command the user
    // had just refused rendered as one that ran and succeeded.
    const state = makeState();
    feed(state, 'item/started', { item: commandItem });
    const [end] = feed(state, 'item/completed', {
      item: { ...commandItem, status: 'declined' },
    });

    expect(end).toMatchObject({ type: 'tool.end', status: 'denied' });
    expect(end).not.toHaveProperty('error');
  });

  it('reports a refused file change as denied, not as an error', () => {
    const state = makeState();
    feed(state, 'item/started', { item: { type: 'fileChange', id: 'fc-1', changes: [] } });
    const [end] = feed(state, 'item/completed', {
      item: { type: 'fileChange', id: 'fc-1', status: 'declined' },
    });

    // A denial and a failure are different things: one is the user's decision,
    // the other is the tool breaking.
    expect(end).toMatchObject({ type: 'tool.end', status: 'denied' });
  });

  it('still reports a genuinely failed file change as an error', () => {
    const state = makeState();
    feed(state, 'item/started', { item: { type: 'fileChange', id: 'fc-2', changes: [] } });
    const [end] = feed(state, 'item/completed', {
      item: { type: 'fileChange', id: 'fc-2', status: 'failed' },
    });

    expect(end).toMatchObject({ status: 'error' });
  });

  it('names a file change by its paths', () => {
    const state = makeState();
    const [start] = feed(state, 'item/started', {
      item: { type: 'fileChange', id: 'fc-1', changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
    });

    expect(start).toMatchObject({ name: 'ApplyPatch', title: 'Edit 2 files' });
  });

  it('names an MCP call server.tool', () => {
    const state = makeState();
    const [start] = feed(state, 'item/started', {
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'railway', tool: 'deploy', arguments: { id: 7 } },
    });

    expect(start).toMatchObject({ name: 'railway.deploy', input: { id: 7 } });
  });

  it('surfaces an MCP error as a failed tool', () => {
    const state = makeState();
    feed(state, 'item/started', { item: { type: 'mcpToolCall', id: 'm-1', server: 's', tool: 't' } });
    const [end] = feed(state, 'item/completed', {
      item: { type: 'mcpToolCall', id: 'm-1', server: 's', tool: 't', error: { message: 'boom' } },
    });

    expect(end).toMatchObject({ status: 'error' });
    expect((end as { error?: { message: string } }).error?.message).toBe('boom');
  });

  it('ignores a duplicate item/started for an id already open', () => {
    const state = makeState();
    feed(state, 'item/started', { item: commandItem });
    expect(feed(state, 'item/started', { item: commandItem })).toEqual([]);
    expect(state.openToolCalls.size).toBe(1);
  });

  it('emits exactly one tool.end even if item/completed arrives twice', () => {
    const state = makeState();
    feed(state, 'item/started', { item: commandItem });
    const first = feed(state, 'item/completed', { item: { ...commandItem, exitCode: 0 } });
    const second = feed(state, 'item/completed', { item: { ...commandItem, exitCode: 0 } });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('drops an item type it does not model, without throwing', () => {
    const state = makeState();
    expect(feed(state, 'item/started', { item: { type: 'imageGeneration', id: 'ig-1' } })).toEqual([]);
    expect(feed(state, 'item/completed', { item: { type: 'imageGeneration', id: 'ig-1' } })).toEqual([]);
  });
});

describe('flushCodexToolCalls', () => {
  it('cancels every open call so no spinner is left running', () => {
    const state = makeState();
    feed(state, 'item/started', { item: { type: 'commandExecution', id: 'c-1', command: 'sleep 60' } });
    feed(state, 'item/started', { item: { type: 'webSearch', id: 'w-1', query: 'artemis' } });

    const flushed = flushCodexToolCalls(state);

    expect(flushed).toHaveLength(2);
    expect(flushed.every((e) => e.type === 'tool.end')).toBe(true);
    expect(flushed.every((e) => (e as { status: string }).status === 'cancelled')).toBe(true);
    expect(state.openToolCalls.size).toBe(0);
  });

  it('does not re-close a call that already ended', () => {
    const state = makeState();
    feed(state, 'item/started', { item: { type: 'commandExecution', id: 'c-1', command: 'ls' } });
    feed(state, 'item/completed', { item: { type: 'commandExecution', id: 'c-1', command: 'ls', exitCode: 0 } });

    expect(flushCodexToolCalls(state)).toEqual([]);
  });

  it('is what closes open calls when a turn is interrupted', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });
    feed(state, 'item/started', { item: { type: 'commandExecution', id: 'c-1', command: 'sleep 60' } });

    const events = feed(state, 'turn/completed', {
      turn: { id: 'tu-1', status: 'interrupted' },
    });

    // The cancellation must come before run.end, or the UI sees a terminal
    // event with a tool still spinning.
    expect(events.map((e) => e.type)).toEqual(['tool.end', 'run.end']);
    expect(events[0]).toMatchObject({ status: 'cancelled' });
    expect(events[1]).toMatchObject({ reason: 'interrupted' });
  });
});

describe('usage', () => {
  it('reports each notification as a delta, not a cumulative total', () => {
    const state = makeState();
    const [event] = feed(state, 'thread/tokenUsage/updated', {
      tokenUsage: {
        total: { totalTokens: 27236, inputTokens: 27053, cachedInputTokens: 14080, outputTokens: 183 },
        last: { totalTokens: 13673, inputTokens: 13610, cachedInputTokens: 4480, outputTokens: 63 },
        modelContextWindow: 258400,
      },
    });

    // `total` is thread-scoped and would include turns this run never ran.
    expect(event).toMatchObject({
      type: 'usage',
      usage: {
        scope: 'delta',
        tokens: { inputTokens: 13610, outputTokens: 63, cacheReadInputTokens: 4480 },
        contextTokens: 13673,
        contextWindow: 258400,
      },
    });
  });

  it('sums deltas into the final total on run.end', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });

    // The three requests observed in a real two-command turn.
    for (const last of [
      { totalTokens: 13563, inputTokens: 13443, cachedInputTokens: 9600, outputTokens: 120 },
      { totalTokens: 13673, inputTokens: 13610, cachedInputTokens: 4480, outputTokens: 63 },
      { totalTokens: 13724, inputTokens: 13719, cachedInputTokens: 12672, outputTokens: 5 },
    ]) {
      feed(state, 'thread/tokenUsage/updated', { tokenUsage: { last, modelContextWindow: 258400 } });
    }

    const [end] = feed(state, 'turn/completed', { turn: { id: 'tu-1', status: 'completed' } });

    expect(end).toMatchObject({
      type: 'run.end',
      usage: {
        scope: 'final',
        tokens: {
          inputTokens: 13443 + 13610 + 13719,
          outputTokens: 120 + 63 + 5,
          cacheReadInputTokens: 9600 + 4480 + 12672,
        },
      },
    });
  });

  it('omits usage from run.end when the provider never reported any', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });
    const [end] = feed(state, 'turn/completed', { turn: { id: 'tu-1', status: 'completed' } });

    expect(end).not.toHaveProperty('usage');
  });

  it('ignores a usage notification with no `last` breakdown', () => {
    const state = makeState();
    expect(feed(state, 'thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 1 } } })).toEqual([]);
  });
});

describe('run.end', () => {
  it('reports a completed turn as completed, with the session id', () => {
    const events = runSimpleTurn(makeState());
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      reason: 'completed',
      sessionId: 'th-1',
      durationMs: 4200,
    });
  });

  it('classifies a failed turn from its HTTP status', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });

    const [end] = feed(state, 'turn/completed', {
      turn: {
        id: 'tu-1',
        status: 'failed',
        error: { message: 'rate limited', codexErrorInfo: { httpStatusCode: 429 } },
      },
    });

    expect(end).toMatchObject({
      type: 'run.end',
      reason: 'error',
      error: { code: 'rate_limit', message: 'rate limited', httpStatus: 429, retryable: true },
    });
  });

  it('holds an error notification until the turn ends', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });

    // An `error` notification is the *reason* a turn fails, not a terminal
    // event of its own.
    expect(feed(state, 'error', { message: 'context length exceeded' })).toEqual([]);
    expect(state.lastError?.message).toBe('context length exceeded');

    const [end] = feed(state, 'turn/completed', { turn: { id: 'tu-1', status: 'failed' } });
    expect(end).toMatchObject({ reason: 'error', error: { message: 'context length exceeded' } });
  });

  it('lets Artemis’s own intent outrank the transport’s report', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });
    state.interruptRequested = true;

    // The server raced the interrupt and reported success; the user still
    // pressed Stop.
    const [end] = feed(state, 'turn/completed', { turn: { id: 'tu-1', status: 'completed' } });
    expect(end).toMatchObject({ reason: 'interrupted' });
  });

  it('ranks dispose above interrupt', () => {
    const state = makeState();
    state.interruptRequested = true;
    state.disposeRequested = true;

    const [end] = finalizeCodexRun(state, 'completed');
    expect(end).toMatchObject({ reason: 'disposed' });
  });

  it('reports a denial that interrupted the run as permission_denied', () => {
    const state = makeState();
    state.permissionDenyInterrupted = true;

    const [end] = finalizeCodexRun(state, 'completed');
    expect(end).toMatchObject({ reason: 'permission_denied' });
  });

  it('is idempotent — a second finalize emits nothing', () => {
    const state = makeState();
    expect(finalizeCodexRun(state, 'completed')).toHaveLength(1);
    expect(finalizeCodexRun(state, 'disposed')).toEqual([]);
  });
});

describe('turn/started', () => {
  it('records the turn id, which turn/steer cannot work without', () => {
    const state = makeState();
    const events = feed(state, 'turn/started', { turn: { id: 'tu-42', status: 'inProgress' } });

    expect(events).toEqual([]);
    expect(state.turnId).toBe('tu-42');
  });
});

describe('robustness', () => {
  it('drops every notification it does not model, silently', () => {
    const state = makeState();
    for (const method of [
      'mcpServer/startupStatus/updated',
      'hook/started',
      'hook/completed',
      'remoteControl/status/changed',
      'thread/status/changed',
      'turn/diff/updated',
      'turn/plan/updated',
      'item/commandExecution/outputDelta',
      'a/method/from/a/newer/cli',
    ]) {
      expect(feed(state, method, { anything: true })).toEqual([]);
    }
    expect(state.seq).toBe(0);
  });

  it('survives payloads of entirely the wrong shape', () => {
    const state = makeState();
    for (const params of [null, undefined, 'a string', 42, [1, 2, 3], {}]) {
      expect(() => feed(state, 'item/started', params)).not.toThrow();
      expect(() => feed(state, 'thread/started', params)).not.toThrow();
      expect(() => feed(state, 'turn/completed', params)).not.toThrow();
      expect(() => feed(state, 'thread/tokenUsage/updated', params)).not.toThrow();
    }
  });

  it('survives an item with no id or no type', () => {
    const state = makeState();
    expect(feed(state, 'item/started', { item: { type: 'commandExecution' } })).toEqual([]);
    expect(feed(state, 'item/started', { item: { id: 'x' } })).toEqual([]);
  });
});

describe('nextCodexEventEnvelope', () => {
  it('shares the sequence with the mapper, so out-of-band events stay dense', () => {
    const state = makeState();
    feed(state, 'thread/started', { thread: { id: 'th-1', cwd: '/w' } });

    // This is what a permission.request uses: it arrives as a JSON-RPC request
    // rather than a notification, but must still take its turn in `seq`.
    const envelope = nextCodexEventEnvelope(state);
    expect(envelope.seq).toBe(1);

    const [delta] = feed(state, 'item/agentMessage/delta', { itemId: 'i', delta: 'x' });
    expect(delta?.seq).toBe(2);
  });
});

describe('replayCodexItem', () => {
  it('replays a user message as a completed user block', () => {
    const state = makeState();
    const [event] = replayCodexItem(
      { type: 'userMessage', id: 'u-1', content: [{ type: 'text', text: 'hello' }] } as never,
      state,
    );

    expect(event).toMatchObject({ type: 'text.complete', role: 'user', text: 'hello', replay: true });
  });

  it('replays an agent message as a completed assistant block', () => {
    const state = makeState();
    const [event] = replayCodexItem({ type: 'agentMessage', id: 'a-1', text: 'hi' } as never, state);

    expect(event).toMatchObject({ type: 'text.complete', role: 'assistant', text: 'hi', replay: true });
  });

  it('replays a tool call as a start/end pair so it renders like a live one', () => {
    const state = makeState();
    const events = replayCodexItem(
      { type: 'commandExecution', id: 'c-1', command: 'ls', exitCode: 0, aggregatedOutput: 'a\nb' } as never,
      state,
    );

    expect(events.map((e) => e.type)).toEqual(['tool.start', 'tool.end']);
    expect(events[1]).toMatchObject({ status: 'ok', resultText: 'a\nb' });
  });

  it('drops an item with nothing to render', () => {
    const state = makeState();
    expect(replayCodexItem({ type: 'userMessage', id: 'u-1', content: [] } as never, state)).toEqual([]);
    expect(replayCodexItem({ type: 'contextCompaction', id: 'x-1' } as never, state)).toEqual([]);
  });
});
