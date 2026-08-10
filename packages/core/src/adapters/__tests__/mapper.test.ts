/**
 * Tests for the pure Claude → Libra mapper.
 *
 * Every fixture below is a handwritten SDK message. Nothing is spawned, no
 * network is touched, and the clock is injected — which is the whole reason the
 * mapping lives in its own module rather than inside the adapter class.
 *
 * The casts to `SDKMessage` are deliberate. The SDK's message types carry
 * branded `UUID` template-literal types and a dozen fields that are irrelevant
 * to any given assertion; writing them out in full would make the fixtures
 * unreadable and would test the fixture rather than the mapper. Each fixture
 * carries exactly the fields the code under test reads.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, SessionStartedEvent, TextCompleteEvent, TextDeltaEvent, ThinkingDeltaEvent, ToolEndEvent, ToolStartEvent, RunEndEvent, UsageEvent } from '@libra/protocol';
import type { SDKMessage, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import {
  buildPermissionRequest,
  createClaudeMapperState,
  finalizeRun,
  flattenResultText,
  flushOpenToolCalls,
  mapSdkMessage,
  mapSessionInfo,
  mapStopReason,
  nextEventEnvelope,
  toJsonObject,
  toJsonValue,
  toPermissionResult,
} from '../mapper.js';
import type { ClaudeMapperState } from '../mapper.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** A controllable clock so `ts` and `durationMs` are assertable. */
function makeClock(start = 1_000): { now: () => number; set: (value: number) => void } {
  let value = start;
  return {
    now: () => value,
    set: (next: number) => {
      value = next;
    },
  };
}

function makeState(
  overrides?: Partial<Pick<ClaudeMapperState, 'resumedFrom' | 'forked'>>,
  now: () => number = () => 1_000,
): ClaudeMapperState {
  return createClaudeMapperState('run-1', {
    now,
    resumedFrom: overrides?.resumedFrom,
    forked: overrides?.forked,
  });
}

/** Cast a fixture literal to `SDKMessage`. See the file header for why. */
function sdk(message: unknown): SDKMessage {
  return message as SDKMessage;
}

/** Drive a whole sequence of messages through the mapper. */
function run(state: ClaudeMapperState, messages: readonly unknown[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const message of messages) events.push(...mapSdkMessage(sdk(message), state));
  return events;
}

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  cwd: '/Users/dev/project',
  model: 'claude-opus-4',
  tools: ['Read', 'Bash'],
  slash_commands: ['/help', '/compact'],
  permissionMode: 'default',
  claude_code_version: '2.1.226',
  apiKeySource: 'user',
  mcp_servers: [],
  output_style: 'default',
  skills: [],
  plugins: [],
  uuid: 'uuid-init',
};

function assistantMessage(options: {
  readonly id?: string;
  readonly uuid?: string;
  readonly content: readonly unknown[];
  readonly stopReason?: string | null;
  readonly parentToolUseId?: string | null;
  readonly usage?: unknown;
  readonly error?: string;
}): unknown {
  return {
    type: 'assistant',
    uuid: options.uuid ?? 'uuid-assistant',
    session_id: 'sess-abc',
    parent_tool_use_id: options.parentToolUseId ?? null,
    error: options.error,
    message: {
      id: options.id ?? 'msg_01',
      role: 'assistant',
      model: 'claude-opus-4',
      type: 'message',
      content: options.content,
      stop_reason: options.stopReason ?? null,
      usage: options.usage,
    },
  };
}

function resultMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4_200,
    duration_api_ms: 3_900,
    num_turns: 3,
    result: 'All done.',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0421,
    usage: {
      input_tokens: 120,
      output_tokens: 340,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 45,
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
    },
    modelUsage: {
      'claude-opus-4': {
        inputTokens: 120,
        outputTokens: 340,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 45,
        webSearchRequests: 2,
        costUSD: 0.0421,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    uuid: 'uuid-result',
    session_id: 'sess-abc',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* session.started                                                            */
/* -------------------------------------------------------------------------- */

describe('session.started', () => {
  it('maps the init message and is the first event with seq 0', () => {
    const state = makeState();
    const events = run(state, [INIT]);

    expect(events).toHaveLength(1);
    const event = events[0] as SessionStartedEvent;
    expect(event).toMatchObject({
      type: 'session.started',
      runId: 'run-1',
      seq: 0,
      ts: 1_000,
      sessionId: 'sess-abc',
      providerId: 'claude',
      cwd: '/Users/dev/project',
      model: 'claude-opus-4',
      tools: ['Read', 'Bash'],
      slashCommands: ['/help', '/compact'],
      permissionMode: 'default',
      providerVersion: '2.1.226',
    });
    expect(state.sessionId).toBe('sess-abc');
    expect(state.model).toBe('claude-opus-4');
  });

  it('reports resume/fork provenance only when the run actually resumed', () => {
    const fresh = makeState();
    const freshEvent = run(fresh, [INIT])[0] as SessionStartedEvent;
    expect(freshEvent.resumedFrom).toBeUndefined();
    expect(freshEvent.forked).toBeUndefined();

    const resumed = makeState({ resumedFrom: 'sess-old', forked: true });
    const resumedEvent = run(resumed, [INIT])[0] as SessionStartedEvent;
    expect(resumedEvent.resumedFrom).toBe('sess-old');
    expect(resumedEvent.forked).toBe(true);
  });

  it('drops a second init (reinitialize) rather than emitting session.started twice', () => {
    const state = makeState();
    run(state, [INIT]);
    const second = mapSdkMessage(sdk({ ...INIT, session_id: 'sess-new' }), state);

    expect(second).toEqual([]);
    // State still tracks the newest id, so run.end reports the right session.
    expect(state.sessionId).toBe('sess-new');
  });

  it('drops an unrecognised permissionMode instead of forwarding a bad value', () => {
    const state = makeState();
    const event = run(state, [{ ...INIT, permissionMode: 'yolo' }])[0] as SessionStartedEvent;
    expect(event.permissionMode).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* text                                                                       */
/* -------------------------------------------------------------------------- */

describe('assistant text', () => {
  it('streams deltas that concatenate to the completed block', () => {
    const state = makeState();
    const events = run(state, [
      INIT,
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u1',
        session_id: 'sess-abc',
        event: { type: 'message_start', message: { id: 'msg_01' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u2',
        session_id: 'sess-abc',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, ' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u3',
        session_id: 'sess-abc',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world.' } },
      },
      { type: 'stream_event', parent_tool_use_id: null, uuid: 'u4', session_id: 'sess-abc', event: { type: 'content_block_stop', index: 0 } },
      assistantMessage({
        content: [{ type: 'text', text: 'Hello, world.', citations: null }],
        stopReason: 'end_turn',
      }),
    ]);

    const deltas = events.filter((e): e is TextDeltaEvent => e.type === 'text.delta');
    expect(deltas.map((d) => d.text).join('')).toBe('Hello, world.');
    expect(deltas.every((d) => d.messageId === 'msg_01' && d.blockIndex === 0)).toBe(true);

    const complete = events.find((e): e is TextCompleteEvent => e.type === 'text.complete');
    expect(complete).toMatchObject({
      messageId: 'msg_01',
      role: 'assistant',
      text: 'Hello, world.',
      blockIndex: 0,
      stopReason: 'end_turn',
    });
  });

  it('keeps the completed message on the streamed id when the raw id is missing', () => {
    // The two halves of a streamed turn derive identity independently: the
    // stream anchors on `message_start`'s id, the completed message on
    // `message.id || uuid`. When that fallback fires they disagree, and the
    // renderer — which keys blocks by (messageId, blockIndex) — has no way to
    // tell it is the same block. It inserts a second one, and the user sees
    // the answer twice.
    const state = makeState();
    const events = run(state, [
      INIT,
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u1',
        session_id: 'sess-abc',
        event: { type: 'message_start', message: { id: 'msg_01' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u2',
        session_id: 'sess-abc',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Received.' } },
      },
      assistantMessage({ id: '', content: [{ type: 'text', text: 'Received.', citations: null }] }),
    ]);

    const deltas = events.filter((e): e is TextDeltaEvent => e.type === 'text.delta');
    const complete = events.find((e): e is TextCompleteEvent => e.type === 'text.complete');

    expect(deltas[0]?.messageId).toBe('msg_01');
    // Not 'uuid-assistant': the completed message must land on the block the
    // deltas already built.
    expect(complete?.messageId).toBe('msg_01');
  });

  it('does not lend the streamed id to a later message that was never streamed', () => {
    // The mirror of the bug above. The streamed id is only valid for the turn
    // it opened; if it outlived that turn, an unstreamed message with no id
    // would merge *into* the previous message's blocks and overwrite them.
    const state = makeState();
    const events = run(state, [
      INIT,
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u1',
        session_id: 'sess-abc',
        event: { type: 'message_start', message: { id: 'msg_01' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u2',
        session_id: 'sess-abc',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } },
      },
      assistantMessage({ id: '', content: [{ type: 'text', text: 'first' }] }),
      assistantMessage({ id: '', uuid: 'uuid-second', content: [{ type: 'text', text: 'second' }] }),
    ]);

    const completes = events.filter((e): e is TextCompleteEvent => e.type === 'text.complete');
    expect(completes.map((c) => c.messageId)).toEqual(['msg_01', 'uuid-second']);
  });

  it('drops deltas that arrive before message_start rather than guessing a messageId', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u1',
        session_id: 's',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } },
      },
    ]);
    expect(events).toEqual([]);
  });

  it('attaches the stop reason only to the final block of a multi-block message', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({
        content: [
          { type: 'text', text: 'first', citations: null },
          { type: 'text', text: 'second', citations: null },
        ],
        stopReason: 'tool_use',
      }),
    ]);

    const completes = events.filter((e): e is TextCompleteEvent => e.type === 'text.complete');
    expect(completes).toHaveLength(2);
    expect(completes[0]?.stopReason).toBeUndefined();
    expect(completes[1]?.stopReason).toBe('tool_use');
  });

  it('tags subagent output with the tool call that spawned it', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({
        content: [{ type: 'text', text: 'from the subagent', citations: null }],
        parentToolUseId: 'toolu_task',
      }),
    ]);
    expect((events[0] as TextCompleteEvent).agentId).toBe('toolu_task');
  });
});

/* -------------------------------------------------------------------------- */
/* thinking                                                                   */
/* -------------------------------------------------------------------------- */

describe('thinking', () => {
  it('emits the whole block as one delta when it was not streamed', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({
        content: [{ type: 'thinking', thinking: 'Let me consider…', signature: 'sig' }],
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'thinking.delta',
      messageId: 'msg_01',
      blockIndex: 0,
      text: 'Let me consider…',
    });
  });

  it('does not re-send thinking that already went out as deltas', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u1',
        session_id: 's',
        event: { type: 'message_start', message: { id: 'msg_01' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u2',
        session_id: 's',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm…' } },
      },
      assistantMessage({ content: [{ type: 'thinking', thinking: 'Hmm…', signature: 'sig' }] }),
    ]);

    const thinking = events.filter((e): e is ThinkingDeltaEvent => e.type === 'thinking.delta');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.text).toBe('Hmm…');
  });

  it('marks redacted thinking with empty text', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({ content: [{ type: 'redacted_thinking', data: 'ENCRYPTED' }] }),
    ]);

    expect(events[0]).toMatchObject({ type: 'thinking.delta', text: '', redacted: true });
  });

  it('drops signature deltas, which carry no renderable content', () => {
    const state = makeState();
    const events = run(state, [
      { type: 'stream_event', parent_tool_use_id: null, uuid: 'u1', session_id: 's', event: { type: 'message_start', message: { id: 'm' } } },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: 'u2',
        session_id: 's',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
      },
    ]);
    expect(events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* tools                                                                      */
/* -------------------------------------------------------------------------- */

describe('tool calls', () => {
  it('pairs tool.start with tool.end and measures duration from the injected clock', () => {
    const clock = makeClock(1_000);
    const state = makeState(undefined, clock.now);

    const started = run(state, [
      assistantMessage({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } }],
      }),
    ]);

    const start = started[0] as ToolStartEvent;
    expect(start).toMatchObject({
      type: 'tool.start',
      toolCallId: 'toolu_1',
      name: 'Read',
      input: { file_path: '/tmp/a.txt' },
      messageId: 'msg_01',
    });
    expect(state.openToolCalls.has('toolu_1')).toBe(true);

    clock.set(1_750);
    const ended = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'uuid-tr',
        session_id: 'sess-abc',
        tool_use_result: { file: { numLines: 3 } },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'line one\nline two' }],
            },
          ],
        },
      },
    ]);

    expect(ended).toHaveLength(1);
    const end = ended[0] as ToolEndEvent;
    expect(end).toMatchObject({
      type: 'tool.end',
      toolCallId: 'toolu_1',
      name: 'Read',
      status: 'ok',
      resultText: 'line one\nline two',
      durationMs: 750,
    });
    // `tool_use_result` is preferred over the raw blocks when it unambiguously
    // belongs to this call.
    expect(end.result).toEqual({ file: { numLines: 3 } });
    expect(state.openToolCalls.size).toBe(0);
  });

  it('does not attribute tool_use_result when a message closes several calls', () => {
    const state = makeState();
    run(state, [
      assistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
        ],
      }),
    ]);

    const events = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
        tool_use_result: { ambiguous: true },
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'b' },
          ],
        },
      },
    ]);

    expect(events).toHaveLength(2);
    expect((events[0] as ToolEndEvent).result).toBe('a');
    expect((events[1] as ToolEndEvent).result).toBe('b');
  });

  it('reports a failed tool result as an error with a message', () => {
    const state = makeState();
    run(state, [
      assistantMessage({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }),
    ]);
    const events = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'command not found' },
          ],
        },
      },
    ]);

    expect(events[0]).toMatchObject({
      type: 'tool.end',
      status: 'error',
      error: { code: 'unknown', message: 'command not found' },
    });
  });

  it('maps a permission_denied system message onto tool.end', () => {
    const state = makeState();
    run(state, [
      assistantMessage({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }),
    ]);

    const events = run(state, [
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        decision_reason_type: 'user_reject',
        message: 'The user declined this tool call.',
        uuid: 'u',
        session_id: 's',
      },
    ]);

    expect(events[0]).toMatchObject({
      type: 'tool.end',
      toolCallId: 'toolu_1',
      name: 'Bash',
      status: 'denied',
      error: { code: 'permission_denied', providerCode: 'user_reject' },
    });
    expect(state.openToolCalls.size).toBe(0);
  });

  it('does not re-close a denied call when its tool_result arrives', () => {
    // The CLI closes a denied call with `permission_denied` and *also* feeds a
    // `tool_result` for the same id back to the model. Emitting for both would
    // put two terminal events against one `tool.start`, and the second — which
    // knows nothing about the denial — would relabel it a nameless `unknown`
    // error, losing the reason the call actually failed.
    const state = makeState();
    run(state, [
      assistantMessage({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }),
    ]);
    run(state, [
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        decision_reason_type: 'rule',
        message: 'Denied by a deny rule.',
        uuid: 'u',
        session_id: 's',
      },
    ]);

    const echoed = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'u2',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'denied' },
          ],
        },
      },
    ]);

    expect(echoed.filter((event) => event.type === 'tool.end')).toHaveLength(0);
  });

  it('maps a server-side tool result embedded in assistant content', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'libra' } },
        ],
      }),
      assistantMessage({
        uuid: 'uuid-2',
        id: 'msg_02',
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [{ type: 'text', text: 'a result' }],
          },
        ],
      }),
    ]);

    expect(events[0]).toMatchObject({ type: 'tool.start', name: 'web_search' });
    expect(events[1]).toMatchObject({
      type: 'tool.end',
      toolCallId: 'srvtoolu_1',
      status: 'ok',
      resultText: 'a result',
    });
  });

  it('treats a *_error server tool result as a failure', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_9',
            content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
          },
        ],
      }),
    ]);
    expect(events[0]).toMatchObject({ type: 'tool.end', status: 'error' });
  });
});

/* -------------------------------------------------------------------------- */
/* user messages                                                              */
/* -------------------------------------------------------------------------- */

describe('user messages', () => {
  it('does not echo the prompt Libra itself sent', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
        message: { role: 'user', content: 'what Libra just sent' },
      },
    ]);
    expect(events).toEqual([]);
  });

  it('surfaces replayed history', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
        isReplay: true,
        message: { role: 'user', content: 'an earlier turn' },
      },
    ]);

    expect(events[0]).toMatchObject({
      type: 'text.complete',
      role: 'user',
      text: 'an earlier turn',
      replay: true,
    });
  });

  it('surfaces provider-synthesised turns', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
        isSynthetic: true,
        message: { role: 'user', content: [{ type: 'text', text: 'auto-continue' }] },
      },
    ]);

    expect(events[0]).toMatchObject({ type: 'text.complete', role: 'user', synthetic: true });
  });

  it('drops image and document attachments', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
        isReplay: true,
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'see attached' },
          ],
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect((events[0] as TextCompleteEvent).text).toBe('see attached');
  });
});

/* -------------------------------------------------------------------------- */
/* result / run.end                                                           */
/* -------------------------------------------------------------------------- */

describe('run.end', () => {
  it('emits final usage then run.end, and nothing after', () => {
    const state = makeState();
    const events = run(state, [INIT, resultMessage()]);

    const usage = events.find((e): e is UsageEvent => e.type === 'usage');
    expect(usage?.usage).toMatchObject({
      scope: 'final',
      costUsd: 0.0421,
      contextWindow: 200_000,
      tokens: {
        inputTokens: 120,
        outputTokens: 340,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 45,
        webSearchRequests: 2,
      },
    });
    expect(usage?.usage.byModel?.[0]).toMatchObject({ model: 'claude-opus-4', costUsd: 0.0421 });
    // Run totals are not context occupancy, so it is deliberately absent.
    expect(usage?.usage.contextTokens).toBeUndefined();

    const last = events[events.length - 1] as RunEndEvent;
    expect(last).toMatchObject({
      type: 'run.end',
      reason: 'completed',
      sessionId: 'sess-abc',
      durationMs: 4_200,
      numTurns: 3,
      result: 'All done.',
    });
    expect(state.ended).toBe(true);

    // Anything arriving after the terminal event is discarded.
    expect(mapSdkMessage(sdk(assistantMessage({ content: [{ type: 'text', text: 'late' }] })), state)).toEqual([]);
    expect(mapSdkMessage(sdk(resultMessage()), state)).toEqual([]);
  });

  it('keeps seq dense and monotonic from zero across the whole run', () => {
    const state = makeState();
    const events = run(state, [
      INIT,
      assistantMessage({
        content: [
          { type: 'text', text: 'hi', citations: null },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
        ],
      }),
      resultMessage(),
    ]);

    expect(events.map((e) => e.seq)).toEqual(events.map((_, index) => index));
  });

  it('cancels every open tool call before the terminal event', () => {
    const clock = makeClock(2_000);
    const state = makeState(undefined, clock.now);
    run(state, [
      INIT,
      assistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
        ],
      }),
    ]);

    state.interruptRequested = true;
    clock.set(2_500);
    const events = run(state, [
      resultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['aborted'], terminal_reason: 'aborted_tools' }),
    ]);

    const cancelled = events.filter((e): e is ToolEndEvent => e.type === 'tool.end');
    expect(cancelled.map((e) => e.toolCallId)).toEqual(['toolu_1', 'toolu_2']);
    expect(cancelled.every((e) => e.status === 'cancelled' && e.durationMs === 500)).toBe(true);

    const end = events[events.length - 1] as RunEndEvent;
    expect(end.type).toBe('run.end');
    expect(end.reason).toBe('interrupted');
    // A tool.end must never appear after run.end.
    expect(events.findIndex((e) => e.type === 'run.end')).toBe(events.length - 1);
  });

  it.each([
    ['error_max_turns', 'max_turns'],
    ['error_max_budget_usd', 'budget_exceeded'],
    ['error_during_execution', 'error'],
    ['error_max_structured_output_retries', 'error'],
  ])('maps result subtype %s onto reason %s', (subtype, reason) => {
    const state = makeState();
    const events = run(state, [
      resultMessage({ subtype, is_error: true, errors: ['boom'], result: undefined }),
    ]);
    const end = events[events.length - 1] as RunEndEvent;
    expect(end.reason).toBe(reason);
  });

  it('carries the provider errors onto a failing run.end', () => {
    const state = makeState();
    const events = run(state, [
      resultMessage({
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['upstream exploded', ''],
        terminal_reason: 'api_error',
      }),
    ]);

    const end = events[events.length - 1] as RunEndEvent;
    expect(end.error).toMatchObject({
      code: 'provider_unavailable',
      message: 'upstream exploded',
      providerCode: 'api_error',
    });
  });

  it('classifies the failure from the assistant error when the provider reported one', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({ content: [], error: 'rate_limit' }),
      resultMessage({ subtype: 'error_during_execution', is_error: true, errors: [] }),
    ]);

    const end = events[events.length - 1] as RunEndEvent;
    expect(end.error?.code).toBe('rate_limit');
  });

  it('lets Libra’s own intent outrank the transport’s story', () => {
    const disposed = makeState();
    disposed.disposeRequested = true;
    const disposedEnd = run(disposed, [resultMessage()]).at(-1) as RunEndEvent;
    expect(disposedEnd.reason).toBe('disposed');

    const denied = makeState();
    denied.permissionDenyInterrupted = true;
    const deniedEnd = run(denied, [resultMessage()]).at(-1) as RunEndEvent;
    expect(deniedEnd.reason).toBe('permission_denied');
  });

  it('honours terminal_reason for limits reported as a success result', () => {
    const state = makeState();
    const end = run(state, [resultMessage({ terminal_reason: 'budget_exhausted' })]).at(-1) as RunEndEvent;
    expect(end.reason).toBe('budget_exceeded');
  });
});

describe('finalizeRun', () => {
  it('is idempotent, so racing teardown paths cannot emit two terminal events', () => {
    const state = makeState();
    const first = finalizeRun(state, 'disposed');
    const second = finalizeRun(state, 'error', { error: { code: 'unknown', message: 'x' } });

    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe('run.end');
    expect(second).toEqual([]);
  });

  it('flushes open tool calls before the terminal event', () => {
    const state = makeState();
    run(state, [
      assistantMessage({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }),
    ]);

    const events = finalizeRun(state, 'disposed');
    expect(events.map((e) => e.type)).toEqual(['tool.end', 'run.end']);
    expect((events[0] as ToolEndEvent).status).toBe('cancelled');
  });

  it('flushOpenToolCalls is a no-op when nothing is open', () => {
    expect(flushOpenToolCalls(makeState())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* usage deltas                                                               */
/* -------------------------------------------------------------------------- */

describe('per-message usage', () => {
  it('emits a delta-scope snapshot with a live context estimate', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({
        content: [{ type: 'text', text: 'hi', citations: null }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          server_tool_use: null,
        },
      }),
    ]);

    const usage = events.find((e): e is UsageEvent => e.type === 'usage');
    expect(usage?.usage).toMatchObject({
      scope: 'delta',
      contextTokens: 130,
      tokens: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100 },
    });
  });

  it('emits nothing when the message carries no usage', () => {
    const state = makeState();
    const events = run(state, [
      assistantMessage({ content: [{ type: 'text', text: 'hi', citations: null }] }),
    ]);
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* deliberate drops                                                           */
/* -------------------------------------------------------------------------- */

describe('deliberately dropped messages', () => {
  const dropped: readonly [string, unknown][] = [
    ['tool_progress', { type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 3, uuid: 'u', session_id: 's' }],
    ['tool_use_summary', { type: 'tool_use_summary', summary: 'read some files', preceding_tool_use_ids: [], uuid: 'u', session_id: 's' }],
    ['rate_limit_event', { type: 'rate_limit_event', rate_limit_info: {}, uuid: 'u', session_id: 's' }],
    ['conversation_reset', { type: 'conversation_reset', new_conversation_id: 'c', uuid: 'u', session_id: 's' }],
    ['prompt_suggestion', { type: 'prompt_suggestion', suggestion: 'try this', uuid: 'u', session_id: 's' }],
    ['auth_status', { type: 'auth_status', isAuthenticating: false, output: [], uuid: 'u', session_id: 's' }],
    ['system/status', { type: 'system', subtype: 'status', status: 'compacting', uuid: 'u', session_id: 's' }],
    ['system/compact_boundary', { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100 }, uuid: 'u', session_id: 's' }],
    ['system/api_retry', { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 529, error: 'overloaded', uuid: 'u', session_id: 's' }],
    ['system/hook_started', { type: 'system', subtype: 'hook_started', hook_id: 'h', hook_name: 'n', hook_event: 'e', uuid: 'u', session_id: 's' }],
    ['system/task_started', { type: 'system', subtype: 'task_started', task_id: 't', description: 'd', uuid: 'u', session_id: 's' }],
    ['system/thinking_tokens', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 10, estimated_tokens_delta: 2, uuid: 'u', session_id: 's' }],
    ['system/notification', { type: 'system', subtype: 'notification', key: 'k', text: 't', priority: 'low', uuid: 'u', session_id: 's' }],
    ['system/informational', { type: 'system', subtype: 'informational', content: 'fyi', level: 'info', uuid: 'u', session_id: 's' }],
    ['system/commands_changed', { type: 'system', subtype: 'commands_changed', commands: [], uuid: 'u', session_id: 's' }],
    ['system/session_state_changed', { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'u', session_id: 's' }],
    ['system/memory_recall', { type: 'system', subtype: 'memory_recall', mode: 'select', memories: [], uuid: 'u', session_id: 's' }],
  ];

  it.each(dropped)('drops %s without emitting an event', (_name, message) => {
    expect(mapSdkMessage(sdk(message), makeState())).toEqual([]);
  });

  it('drops an unknown future message type instead of throwing', () => {
    expect(mapSdkMessage(sdk({ type: 'something_new_in_2027', uuid: 'u' }), makeState())).toEqual([]);
    expect(mapSdkMessage(sdk({ type: 'system', subtype: 'brand_new', uuid: 'u' }), makeState())).toEqual([]);
  });
});

describe('messages that do map to text', () => {
  it('surfaces a model refusal as synthetic assistant text', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        original_model: 'claude-opus-4',
        request_id: null,
        content: 'I cannot help with that.',
        uuid: 'uuid-refusal',
        session_id: 's',
      },
    ]);

    expect(events[0]).toMatchObject({
      type: 'text.complete',
      role: 'assistant',
      text: 'I cannot help with that.',
      synthetic: true,
      stopReason: 'refusal',
    });
  });

  it('surfaces local slash-command output on the user side', () => {
    const state = makeState();
    const events = run(state, [
      {
        type: 'system',
        subtype: 'local_command_output',
        content: 'On branch main',
        uuid: 'uuid-cmd',
        session_id: 's',
      },
    ]);

    expect(events[0]).toMatchObject({ type: 'text.complete', role: 'user', synthetic: true });
  });
});

/* -------------------------------------------------------------------------- */
/* small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

describe('mapStopReason', () => {
  it('passes through the reasons protocol shares with the API', () => {
    expect(mapStopReason('end_turn')).toBe('end_turn');
    expect(mapStopReason('tool_use')).toBe('tool_use');
    expect(mapStopReason('refusal')).toBe('refusal');
  });

  it('folds unknown and out-of-union values rather than casting them', () => {
    expect(mapStopReason('model_context_window_exceeded')).toBe('max_tokens');
    expect(mapStopReason('compaction')).toBe('other');
    expect(mapStopReason('something_new')).toBe('other');
    expect(mapStopReason(null)).toBeUndefined();
    expect(mapStopReason(undefined)).toBeUndefined();
  });
});

describe('toJsonValue', () => {
  it('keeps everything that survives structured clone', () => {
    expect(toJsonValue({ a: 1, b: 'x', c: true, d: null, e: [1, 2] })).toEqual({
      a: 1,
      b: 'x',
      c: true,
      d: null,
      e: [1, 2],
    });
  });

  it('drops or folds everything that does not', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(
      toJsonValue({
        fn: () => undefined,
        sym: Symbol('s'),
        undef: undefined,
        big: 10n,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        date,
      }),
    ).toEqual({ big: '10', nan: null, inf: null, date: '2026-01-02T03:04:05.000Z' });
  });

  it('survives a cycle instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    expect(toJsonValue(cyclic)).toEqual({ name: 'root', self: null });
  });

  it('handles repeated (non-cyclic) references without collapsing them', () => {
    const shared = { value: 1 };
    expect(toJsonValue({ a: shared, b: shared })).toEqual({ a: { value: 1 }, b: { value: 1 } });
  });

  it('toJsonObject narrows non-objects to an empty object', () => {
    expect(toJsonObject('nope')).toEqual({});
    expect(toJsonObject([1, 2])).toEqual({});
    expect(toJsonObject({ ok: true })).toEqual({ ok: true });
  });
});

describe('flattenResultText', () => {
  it('flattens the shapes a tool result actually arrives in', () => {
    expect(flattenResultText('plain')).toBe('plain');
    expect(flattenResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(flattenResultText({ text: 'single' })).toBe('single');
    expect(flattenResultText([{ type: 'image', source: {} }])).toBeUndefined();
    expect(flattenResultText(undefined)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* permissions                                                                */
/* -------------------------------------------------------------------------- */

describe('buildPermissionRequest', () => {
  it('carries the provider’s own prompt copy and the rule it suggests', () => {
    const request = buildPermissionRequest({
      id: 'run-1:perm:1',
      runId: 'run-1',
      toolName: 'Bash',
      input: { command: 'git status' },
      requestedAt: 1_700,
      info: {
        toolUseID: 'toolu_1',
        agentID: 'agent_7',
        title: 'Claude wants to run git status',
        displayName: 'Run command',
        description: 'Runs a shell command in the project.',
        decisionReason: 'not covered by an allow rule',
        blockedPath: '/etc/passwd',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
            destination: 'projectSettings',
          },
          // No protocol equivalent — must not reach the renderer.
          { type: 'setMode', mode: 'acceptEdits', destination: 'cliArg' },
        ],
      },
    });

    expect(request).toMatchObject({
      id: 'run-1:perm:1',
      runId: 'run-1',
      toolName: 'Bash',
      input: { command: 'git status' },
      toolCallId: 'toolu_1',
      agentId: 'agent_7',
      title: 'Claude wants to run git status',
      displayName: 'Run command',
      reason: 'not covered by an allow rule',
      blockedPath: '/etc/passwd',
      requestedAt: 1_700,
    });
    expect(request.suggestions).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
        scope: 'project',
      },
    ]);
  });

  it('omits suggestions entirely when none survive mapping', () => {
    const request = buildPermissionRequest({
      id: 'p',
      runId: 'r',
      toolName: 'Read',
      input: {},
      requestedAt: 0,
      info: { suggestions: [{ type: 'setMode', mode: 'plan', destination: 'cliArg' }] },
    });
    expect(request.suggestions).toBeUndefined();
  });

  it('coerces a non-cloneable tool input rather than letting it reach IPC', () => {
    const request = buildPermissionRequest({
      id: 'p',
      runId: 'r',
      toolName: 'Write',
      input: { cb: () => undefined, size: 10n },
      requestedAt: 0,
    });
    expect(request.input).toEqual({ size: '10' });
  });
});

describe('toPermissionResult', () => {
  it('substitutes a deny message, because the SDK requires one', () => {
    const { result } = toPermissionResult({ behavior: 'deny' });
    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'The user declined this tool call.',
      decisionClassification: 'user_reject',
    });
  });

  it('reports rule updates it cannot deliver with a denial', () => {
    const { result, droppedUpdates } = toPermissionResult({
      behavior: 'deny',
      message: 'no',
      interrupt: true,
      updatedPermissions: [
        { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }], scope: 'user' },
      ],
    });

    expect(result).toMatchObject({ behavior: 'deny', interrupt: true });
    // The SDK's deny branch has no updatedPermissions field at all.
    expect('updatedPermissions' in result).toBe(false);
    expect(droppedUpdates).toHaveLength(1);
  });

  it('persists nothing for a once-only allow', () => {
    const { result } = toPermissionResult({ behavior: 'allow' }, { toolName: 'Bash' });
    expect(result).toMatchObject({ behavior: 'allow', decisionClassification: 'user_temporary' });
    expect((result as { updatedPermissions?: unknown }).updatedPermissions).toBeUndefined();
  });

  it('synthesises the minimal rule for a durable allow', () => {
    const { result } = toPermissionResult(
      { behavior: 'allow', scope: 'project' },
      { toolName: 'Bash', toolUseID: 'toolu_1' },
    );

    expect(result).toMatchObject({
      behavior: 'allow',
      toolUseID: 'toolu_1',
      decisionClassification: 'user_permanent',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash' }],
          destination: 'projectSettings',
        },
      ],
    });
  });

  it('refuses to guess a tool name it was not given', () => {
    const { result } = toPermissionResult({ behavior: 'allow', scope: 'user' });
    expect((result as { updatedPermissions?: unknown }).updatedPermissions).toBeUndefined();
  });

  it('forwards explicit suggestions verbatim and maps every scope', () => {
    const { result } = toPermissionResult({
      behavior: 'allow',
      updatedInput: { command: 'git status --short' },
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }], scope: 'session' },
        { type: 'setMode', mode: 'acceptEdits', scope: 'local' },
        { type: 'addDirectories', directories: ['/tmp'], scope: 'user' },
        // 'once' has no destination and must produce no update at all.
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read' }], scope: 'once' },
      ],
    });

    expect(result).toMatchObject({ updatedInput: { command: 'git status --short' } });
    expect((result as { updatedPermissions?: unknown[] }).updatedPermissions).toEqual([
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: undefined }], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/tmp'], destination: 'userSettings' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* sessions                                                                   */
/* -------------------------------------------------------------------------- */

describe('mapSessionInfo', () => {
  it('renames every field the SDK spells differently', () => {
    const info = {
      sessionId: 'sess-1',
      summary: 'Refactor the parser',
      lastModified: 1_760_000_000_000,
      fileSize: 40_960,
      firstPrompt: 'help me refactor',
      gitBranch: 'main',
      tag: 'wip',
      createdAt: 1_759_000_000_000,
      cwd: '/Users/dev/project',
    } satisfies SDKSessionInfo;

    expect(mapSessionInfo(info, { profileId: 'prof-1', fallbackCwd: '/other' })).toEqual({
      id: 'sess-1',
      providerId: 'claude',
      profileId: 'prof-1',
      cwd: '/Users/dev/project',
      title: 'Refactor the parser',
      titleIsCustom: undefined,
      firstPrompt: 'help me refactor',
      updatedAt: 1_760_000_000_000,
      createdAt: 1_759_000_000_000,
      sizeBytes: 40_960,
      gitBranch: 'main',
      tag: 'wip',
    });
  });

  it('prefers a user-assigned title and says so', () => {
    const summary = mapSessionInfo(
      { sessionId: 's', summary: 'derived', customTitle: 'My title', lastModified: 1 },
      { profileId: 'p', fallbackCwd: '/w' },
    );
    expect(summary.title).toBe('My title');
    expect(summary.titleIsCustom).toBe(true);
  });

  it('falls back through summary, first prompt and a placeholder', () => {
    expect(
      mapSessionInfo({ sessionId: 's', summary: '', firstPrompt: 'do a thing', lastModified: 1 } as SDKSessionInfo, {
        profileId: 'p',
        fallbackCwd: '/w',
      }).title,
    ).toBe('do a thing');

    expect(
      mapSessionInfo({ sessionId: 's', lastModified: 1 } as SDKSessionInfo, {
        profileId: 'p',
        fallbackCwd: '/w',
      }).title,
    ).toBe('(untitled session)');
  });

  it('falls back to the requested cwd, which the SDK marks optional', () => {
    expect(
      mapSessionInfo({ sessionId: 's', summary: 'x', lastModified: 1 } as SDKSessionInfo, {
        profileId: 'p',
        fallbackCwd: '/requested',
      }).cwd,
    ).toBe('/requested');
  });
});

/* -------------------------------------------------------------------------- */
/* sequencing across out-of-band events                                       */
/* -------------------------------------------------------------------------- */

describe('nextEventEnvelope', () => {
  it('shares the sequence with the message-driven events', () => {
    const state = makeState();
    const before = run(state, [INIT]);
    const outOfBand = nextEventEnvelope(state);
    const after = run(state, [resultMessage()]);

    expect(before[0]?.seq).toBe(0);
    expect(outOfBand.seq).toBe(1);
    expect(after.map((e) => e.seq)).toEqual([2, 3]);
  });
});
