/**
 * Replaying stored sessions.
 *
 * The bug these lock down: clicking a session in the sidebar resumed it
 * against an empty transcript. The agent had the whole conversation in
 * context; the user could see none of it.
 */

import { describe, expect, it } from 'vitest';
import type { RunId, SessionId } from '@rx-artemis/protocol';
import { replayStoredMessage, replayStoredSession, type StoredMessage } from '../history.js';

const TS = 1_700_000_000_000;

function ctx() {
  let seq = 0;
  return {
    runId: 'run_1' as RunId,
    sessionId: 'sesn_1' as SessionId,
    ts: TS,
    next: () => seq++,
  };
}

function assistant(content: unknown, uuid = 'msg_1'): StoredMessage {
  return { type: 'assistant', uuid, message: { role: 'assistant', content } };
}

describe('replayStoredMessage', () => {
  it('keys replayed blocks on the provider message id, not the envelope uuid', () => {
    // The live mapper keys blocks on `message.id`. If replay keyed on the
    // envelope `uuid` instead, a turn that was both replayed and live could
    // never merge — the transcript would show it twice.
    const [event] = replayStoredMessage(
      { type: 'assistant', uuid: 'envelope-uuid', message: { id: 'msg_01', content: [{ type: 'text', text: 'hi' }] } },
      ctx(),
    );

    expect(event).toMatchObject({ messageId: 'msg_01' });
  });

  it('falls back to the envelope uuid when a record carries no message id', () => {
    const [event] = replayStoredMessage(
      { type: 'assistant', uuid: 'envelope-uuid', message: { content: [{ type: 'text', text: 'hi' }] } },
      ctx(),
    );

    expect(event).toMatchObject({ messageId: 'envelope-uuid' });
  });

  it('replays assistant text as a completed block, flagged as replay', () => {
    const [event] = replayStoredMessage(assistant([{ type: 'text', text: 'hello' }]), ctx());

    expect(event).toMatchObject({
      type: 'text.complete',
      role: 'assistant',
      text: 'hello',
      // The protocol models this explicitly so the UI need not infer it.
      replay: true,
    });
  });

  it('accepts a bare string as shorthand for one text block', () => {
    // User messages are commonly stored as `content: "..."` rather than blocks.
    const events = replayStoredMessage(
      { type: 'user', uuid: 'm', message: { role: 'user', content: 'do the thing' } },
      ctx(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text.complete', role: 'user', text: 'do the thing' });
  });

  it('drops a stored task notification instead of attributing it to the user', () => {
    // The harness writes background-task notifications into a user slot,
    // marked only by an `origin` the SDK's stored-session read strips before
    // this module sees the record. Replayed as a user row, the whole
    // `<task-notification>…` frame appeared in the transcript as though the
    // person had typed it — one per settled task.
    const events = replayStoredMessage(
      {
        type: 'user',
        uuid: 'm',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>a12e2a10</task-id>\n<status>completed</status>\n<summary>Agent "Audit scripts" finished</summary>\n</task-notification>',
        },
      },
      ctx(),
    );

    expect(events).toEqual([]);
  });

  it('drops the interrupt markers the CLI records when a turn is stopped', () => {
    const c = ctx();
    for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      expect(
        replayStoredMessage(
          { type: 'user', uuid: 'm', message: { role: 'user', content: [{ type: 'text', text }] } },
          c,
        ),
      ).toEqual([]);
    }
  });

  it('keeps assistant text that merely quotes the notification frame', () => {
    // The shape check is scoped to user slots: the model *talking about* a
    // task notification is ordinary assistant text and must replay.
    const [event] = replayStoredMessage(
      assistant([{ type: 'text', text: '<task-notification> is the frame the harness uses.' }]),
      ctx(),
    );

    expect(event).toMatchObject({ type: 'text.complete', role: 'assistant' });
  });

  it('replays a stored thinking block', () => {
    const [event] = replayStoredMessage(
      assistant([{ type: 'thinking', thinking: 'weighing the options', signature: 'sig' }]),
      ctx(),
    );

    expect(event).toMatchObject({ type: 'thinking.delta', text: 'weighing the options' });
  });

  it('skips a thinking block the provider stored without its text', () => {
    // Roughly half the `thinking` blocks in a real stored transcript are an
    // empty string beside a full signature — the provider kept the block and
    // withheld its content. Replaying those filled the transcript with folds
    // that opened onto nothing.
    const events = replayStoredMessage(
      assistant([
        { type: 'thinking', thinking: '', signature: 'a'.repeat(3232) },
        { type: 'text', text: 'the answer' },
      ]),
      ctx(),
    );

    expect(events.some((e) => e.type === 'thinking.delta')).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text.complete', text: 'the answer' });
  });

  it('replays a tool call and its result as a matched pair', () => {
    const events = replayStoredSession(
      [
        assistant([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a.ts' } }]),
        { type: 'user', uuid: 'm2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
      ],
      ctx(),
    );

    expect(events[0]).toMatchObject({ type: 'tool.start', toolCallId: 'tu_1', name: 'Read' });
    expect(events[1]).toMatchObject({ type: 'tool.end', toolCallId: 'tu_1', status: 'ok' });
  });

  it('maps a failed tool result to error status', () => {
    const [event] = replayStoredMessage(
      { type: 'user', uuid: 'm', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true }] } },
      ctx(),
    );

    expect(event).toMatchObject({ status: 'error' });
  });

  it('drops system messages, which were never shown live', () => {
    // Compact boundaries and provider notices. Surfacing them on replay would
    // add noise that was not in the original conversation.
    expect(
      replayStoredMessage({ type: 'system', uuid: 'm', message: { content: 'compacted' } }, ctx()),
    ).toEqual([]);
  });

  it('skips blocks it does not understand instead of failing the replay', () => {
    // A transcript written by a newer provider must still render its
    // recognisable parts. One unknown block must not blank the whole session.
    const events = replayStoredMessage(
      assistant([
        { type: 'text', text: 'before' },
        { type: 'some_future_block', payload: {} },
        { type: 'text', text: 'after' },
      ]),
      ctx(),
    );

    expect(events.map((e) => (e as { text: string }).text)).toEqual(['before', 'after']);
  });

  it('survives malformed messages without throwing', () => {
    const c = ctx();
    expect(replayStoredMessage({ type: 'assistant', uuid: 'm', message: null }, c)).toEqual([]);
    expect(replayStoredMessage({ type: 'assistant', uuid: 'm', message: {} }, c)).toEqual([]);
    expect(
      replayStoredMessage({ type: 'assistant', uuid: 'm', message: { content: 'x' } }, c),
    ).toHaveLength(1);
  });

  it('drops blocks missing the ids the UI needs to pair them', () => {
    // A tool_use with no id can never be matched to its result, so rendering
    // it would leave a call that never completes.
    const c = ctx();
    expect(replayStoredMessage(assistant([{ type: 'tool_use', name: 'Read' }]), c)).toEqual([]);
    expect(replayStoredMessage(assistant([{ type: 'tool_result', content: 'x' }]), c)).toEqual([]);
  });
});

describe('replayStoredSession', () => {
  it('preserves the provider ordering and issues a strictly increasing seq', () => {
    // Re-sorting a transcript would interleave tool calls with the wrong
    // results; the sequence is what the transcript renders in.
    const events = replayStoredSession(
      [assistant([{ type: 'text', text: 'one' }], 'a'), assistant([{ type: 'text', text: 'two' }], 'b')],
      ctx(),
    );

    expect(events.map((e) => (e as { text: string }).text)).toEqual(['one', 'two']);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('groups blocks from one stored message under one messageId', () => {
    const events = replayStoredSession(
      [assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'shared')],
      ctx(),
    );

    expect(events.every((e) => (e as { messageId: string }).messageId === 'shared')).toBe(true);
    expect(events.map((e) => (e as { blockIndex: number }).blockIndex)).toEqual([0, 1]);
  });
});
