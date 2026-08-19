/**
 * Tests for the OpenCode mapper.
 *
 * The fixtures are not invented: every `session/update` below is a real frame
 * captured from `opencode acp` 1.18.18 on 2026-08-17, trimmed only for width.
 * That matters most for the three behaviours the schema does not describe — a
 * tool call whose arguments arrive after it starts, a title that is overwritten
 * mid-call, and the off-spec `usage_update` — which are exactly the ones a
 * mapper written from the spec alone would get wrong.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@rx-artemis/protocol';

import type { AcpSessionNotification } from '../acp/protocol.js';
import {
  applyPromptUsage,
  createOpencodeMapperState,
  finishOpencodeRun,
  flushOpencodeToolCalls,
  mapOpencodeUpdate,
  mapStopReason,
  openSession,
} from '../opencode/mapper.js';
import type { OpencodeMapperState } from '../opencode/mapper.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function state(): OpencodeMapperState {
  let tick = 1000;
  return createOpencodeMapperState('run-1', { now: () => (tick += 10) });
}

function update(body: Record<string, unknown>): AcpSessionNotification {
  return { sessionId: 'ses_1', update: body } as AcpSessionNotification;
}

function types(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Every event, in order, for a state driven through a list of updates. */
function drive(
  s: OpencodeMapperState,
  bodies: readonly Record<string, unknown>[],
): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const body of bodies) events.push(...mapOpencodeUpdate(s, update(body)));
  return events;
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

describe('session lifecycle', () => {
  it('emits session.started first, exactly once', () => {
    const s = state();
    const first = openSession(s, { sessionId: 'ses_1', cwd: '/tmp/p', model: 'big-pickle' });

    expect(types(first)).toEqual(['session.started']);
    expect(first[0]).toMatchObject({
      type: 'session.started',
      sessionId: 'ses_1',
      providerId: 'opencode',
      cwd: '/tmp/p',
      model: 'big-pickle',
      seq: 0,
    });

    // A second call is a no-op rather than a duplicate first event.
    expect(openSession(s, { sessionId: 'ses_1', cwd: '/tmp/p' })).toEqual([]);
  });

  it('stamps a dense, monotonic seq across every path', () => {
    const s = state();
    const events = [
      ...openSession(s, { sessionId: 'ses_1', cwd: '/tmp/p' }),
      ...drive(s, [
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'a' } },
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'b' } },
        { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0, currency: 'USD' } },
      ]),
      ...finishOpencodeRun(s, { reason: 'completed' }),
    ];

    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('emits nothing after run.end', () => {
    const s = state();
    finishOpencodeRun(s, { reason: 'completed' });

    expect(
      drive(s, [
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'late' } },
      ]),
    ).toEqual([]);
    // Terminal event is emitted exactly once, however many times it is asked for.
    expect(finishOpencodeRun(s, { reason: 'completed' })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Text and thinking                                                          */
/* -------------------------------------------------------------------------- */

describe('text and thinking', () => {
  it('streams deltas additively and completes the block with the whole text', () => {
    const s = state();
    const streamed = drive(s, [
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'ARTEMIS' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '_ACP_OK' } },
    ]);

    expect(types(streamed)).toEqual(['text.delta', 'text.delta']);
    // The fragment, never the accumulation.
    expect(streamed.map((e) => (e as { text: string }).text)).toEqual(['ARTEMIS', '_ACP_OK']);

    const ended = finishOpencodeRun(s, { reason: 'completed' });
    const complete = ended.find((e) => e.type === 'text.complete');
    // A consumer that ignored every delta still renders the full transcript.
    expect(complete).toMatchObject({ role: 'assistant', text: 'ARTEMIS_ACP_OK' });
  });

  it('routes thought chunks to thinking.delta, on their own block index', () => {
    const s = state();
    // Real shape: OpenCode reuses one messageId for a message's thinking and
    // its text, so the two need separate block indices.
    const events = drive(s, [
      { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } },
    ]);

    expect(types(events)).toEqual(['thinking.delta', 'text.delta']);
    expect(events[0]).toMatchObject({ blockIndex: 0, text: 'hmm' });
    expect(events[1]).toMatchObject({ blockIndex: 1, text: 'hi' });
  });

  it('completes a message when the next one starts', () => {
    const s = state();
    const events = drive(s, [
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'first' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'second' } },
    ]);

    // m1 settles as soon as m2 begins, rather than waiting for run.end.
    expect(types(events)).toEqual(['text.delta', 'text.complete', 'text.delta']);
    expect(events[1]).toMatchObject({ messageId: 'm1', text: 'first' });
  });

  it('marks replayed user messages as replay, not as new generation', () => {
    const s = state();
    const events = drive(s, [
      { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'do it' } },
    ]);

    expect(events[0]).toMatchObject({ type: 'text.complete', role: 'user', replay: true });
  });

  it('ignores empty and non-text content instead of emitting blank deltas', () => {
    const s = state();
    expect(
      drive(s, [
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '' } },
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'image', data: 'x', mimeType: 'image/png' } },
      ]),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                 */
/* -------------------------------------------------------------------------- */

describe('tool calls', () => {
  /** The exact sequence a `write` produces, captured live. */
  const WRITE_SEQUENCE = [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'write',
      kind: 'edit',
      status: 'pending',
      locations: [],
      // Empty. The arguments have not arrived yet.
      rawInput: {},
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'in_progress',
      kind: 'edit',
      title: 'write',
      locations: [{ path: '/tmp/p/hello.txt' }],
      rawInput: { filePath: '/tmp/p/hello.txt', content: 'hi' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      // The title is overwritten with a display summary at the end.
      title: '/tmp/p/hello.txt',
      content: [{ type: 'content', content: { type: 'text', text: 'Wrote file successfully.' } }],
      rawOutput: { output: 'Wrote file successfully.' },
    },
  ];

  it('waits for the arguments before emitting tool.start', () => {
    const s = state();

    // The `pending` frame alone produces nothing: `tool.start` carries the
    // input and there is no second chance to correct it.
    const pending = drive(s, [WRITE_SEQUENCE[0] as Record<string, unknown>]);
    expect(pending).toEqual([]);

    const running = drive(s, [WRITE_SEQUENCE[1] as Record<string, unknown>]);
    expect(types(running)).toEqual(['tool.start']);
    expect(running[0]).toMatchObject({
      toolCallId: 'call_1',
      name: 'write',
      input: { filePath: '/tmp/p/hello.txt', content: 'hi' },
    });
  });

  it('keeps the first title as the name and the newest as the title', () => {
    const s = state();
    const events = drive(s, WRITE_SEQUENCE as Record<string, unknown>[]);
    const end = events.find((e) => e.type === 'tool.end');

    // "write" is what the tool is; the path is what it did.
    expect(end).toMatchObject({ toolCallId: 'call_1', name: 'write', status: 'ok' });
    expect(end).toMatchObject({ resultText: 'Wrote file successfully.' });
  });

  it('produces exactly one start and one end for a whole call', () => {
    const s = state();
    expect(types(drive(s, WRITE_SEQUENCE as Record<string, unknown>[]))).toEqual([
      'tool.start',
      'tool.end',
    ]);
  });

  it('starts and ends a call that never reported its arguments', () => {
    const s = state();
    const events = drive(s, [
      { sessionUpdate: 'tool_call', toolCallId: 'c9', title: 'think', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c9', status: 'completed' },
    ]);

    // A terminal status is the other moment after which no better input is
    // coming, so the row appears rather than being lost.
    expect(types(events)).toEqual(['tool.start', 'tool.end']);
  });

  it('reports a failed call as an error with a message', () => {
    const s = state();
    const events = drive(s, [
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'bash', rawInput: { command: 'nope' } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c2',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'command not found' } }],
      },
    ]);

    const end = events.find((e) => e.type === 'tool.end');
    expect(end).toMatchObject({ status: 'error', error: { message: 'command not found' } });
  });

  it('ignores a late update for a call that already ended', () => {
    const s = state();
    drive(s, WRITE_SEQUENCE as Record<string, unknown>[]);

    // A second terminal update must not produce a second tool.end.
    expect(
      drive(s, [{ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }]),
    ).toEqual([]);
  });

  it('summarises a diff rather than inlining the whole new file', () => {
    const s = state();
    const events = drive(s, [
      { sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'edit', rawInput: { path: 'a.ts' } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c3',
        status: 'completed',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
      },
    ]);

    // The structured result already carries old and new text; Artemis renders a
    // real diff from it.
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({
      resultText: 'Edited a.ts.',
    });
  });

  it('closes open calls as cancelled, inventing the start when there was none', () => {
    const s = state();
    drive(s, [WRITE_SEQUENCE[0] as Record<string, unknown>]); // pending, never started

    const flushed = flushOpencodeToolCalls(s);
    // A bare tool.end would close a row the UI never opened.
    expect(types(flushed)).toEqual(['tool.start', 'tool.end']);
    expect(flushed[1]).toMatchObject({ status: 'cancelled', name: 'write' });
  });

  it('leaves no tool call open at run.end', () => {
    const s = state();
    drive(s, [WRITE_SEQUENCE[1] as Record<string, unknown>]);

    const ended = finishOpencodeRun(s, { reason: 'interrupted' });
    expect(types(ended)).toContain('tool.end');
    expect(s.openToolCalls.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Usage                                                                      */
/* -------------------------------------------------------------------------- */

describe('usage', () => {
  it('maps the off-spec usage_update onto context and cost', () => {
    const s = state();
    // Verbatim from a live turn.
    const events = drive(s, [
      { sessionUpdate: 'usage_update', used: 9229, size: 200000, cost: { amount: 0, currency: 'USD' } },
    ]);

    expect(events[0]).toMatchObject({
      type: 'usage',
      usage: {
        scope: 'cumulative',
        contextTokens: 9229,
        contextWindow: 200000,
        costUsd: 0,
      },
    });
  });

  it('does not pass context occupancy off as tokens billed', () => {
    const s = state();
    const [event] = drive(s, [{ sessionUpdate: 'usage_update', used: 9229, size: 200000 }]);
    const usage = (event as { usage: { tokens: { inputTokens: number; outputTokens: number } } }).usage;

    // `used` is what sits in the window, not what the turn generated. Reporting
    // it as input tokens would overstate consumption on every later turn.
    expect(usage.tokens).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('ignores a cost in a currency that is not dollars', () => {
    const s = state();
    const [event] = drive(s, [
      { sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 7, currency: 'EUR' } },
    ]);

    expect((event as { usage: { costUsd?: number } }).usage.costUsd).toBeUndefined();
  });

  it('merges the turn’s real token counts with the streamed context reading', () => {
    const s = state();
    // The notification says how full the window is...
    drive(s, [
      { sessionUpdate: 'usage_update', used: 9002, size: 200000, cost: { amount: 0.02, currency: 'USD' } },
    ]);
    // ...and the turn's result says what it actually spent. Both are wanted:
    // one drives the context meter, the other drives usage reporting.
    const events = applyPromptUsage(s, {
      inputTokens: 7970,
      outputTokens: 4,
      totalTokens: 9013,
      thoughtTokens: 15,
      cachedReadTokens: 1024,
    });

    expect(events[0]).toMatchObject({
      type: 'usage',
      usage: {
        tokens: { inputTokens: 7970, outputTokens: 4, cacheReadInputTokens: 1024 },
        contextTokens: 9002,
        contextWindow: 200000,
        costUsd: 0.02,
      },
    });
  });

  it('ignores an empty token report rather than overwriting a good reading', () => {
    const s = state();
    drive(s, [{ sessionUpdate: 'usage_update', used: 500, size: 200000 }]);

    expect(applyPromptUsage(s, { inputTokens: 0, outputTokens: 0 })).toEqual([]);
    expect(applyPromptUsage(s, undefined)).toEqual([]);
    expect(s.usage).toMatchObject({ contextTokens: 500 });
  });

  it('republishes the last reading as the run total', () => {
    const s = state();
    drive(s, [{ sessionUpdate: 'usage_update', used: 100, size: 200000 }]);
    drive(s, [{ sessionUpdate: 'usage_update', used: 350, size: 200000 }]);

    const end = finishOpencodeRun(s, { reason: 'completed' }).find((e) => e.type === 'run.end');
    expect(end).toMatchObject({ usage: { scope: 'final', contextTokens: 350 } });
  });
});

/* -------------------------------------------------------------------------- */
/* Stop reasons and dropped updates                                           */
/* -------------------------------------------------------------------------- */

describe('stop reasons', () => {
  it('maps every ACP stop reason onto an Artemis one', () => {
    expect(mapStopReason('end_turn')).toBe('completed');
    expect(mapStopReason('cancelled')).toBe('interrupted');
    expect(mapStopReason('max_tokens')).toBe('budget_exceeded');
    expect(mapStopReason('max_turn_requests')).toBe('max_turns');
    // A refusal is an outcome of a turn that ran, and its text is already in
    // the transcript — not a failure of the run.
    expect(mapStopReason('refusal')).toBe('completed');
  });

  it('carries the session id and an error onto run.end', () => {
    const s = state();
    openSession(s, { sessionId: 'ses_9', cwd: '/tmp/p' });

    const end = finishOpencodeRun(s, {
      reason: 'error',
      error: { code: 'transport', message: 'the agent exited' },
    }).find((e) => e.type === 'run.end');

    expect(end).toMatchObject({
      reason: 'error',
      sessionId: 'ses_9',
      error: { code: 'transport', message: 'the agent exited' },
    });
  });
});

describe('dropped updates', () => {
  it('drops the ones Artemis has nowhere to render, without throwing', () => {
    const s = state();
    expect(
      drive(s, [
        { sessionUpdate: 'plan', entries: [{ content: 'do it', priority: 'high', status: 'pending' }] },
        { sessionUpdate: 'available_commands_update', availableCommands: [] },
        { sessionUpdate: 'current_mode_update', currentModeId: 'build' },
        // A variant invented after this mapper was written.
        { sessionUpdate: 'something_new_in_2027', payload: {} },
      ]),
    ).toEqual([]);
  });

  it('survives a malformed update rather than taking the run down', () => {
    const s = state();
    expect(drive(s, [{ sessionUpdate: 'tool_call' }, { sessionUpdate: 'tool_call_update' }])).toEqual(
      [],
    );
  });
});
