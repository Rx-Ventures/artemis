/**
 * Reading an OpenAI-compatible stream.
 *
 * Verified shapes: the chunk fixtures follow the format LM Studio emitted on
 * 2026-08-18. Ollama and `llama-server` implement the same wire format, which
 * is the reason this file is shared — but only the first was driven.
 */

import { describe, expect, it } from 'vitest';

import { readChunk, readEventLine, splitEvents, ToolCallAccumulator } from '../stream.js';

describe('readChunk', () => {
  it('reads visible text', () => {
    expect(readChunk({ choices: [{ delta: { content: 'AR' } }] })).toEqual({ text: 'AR' });
  });

  it.each([['reasoning_content'], ['reasoning']])('reads thinking under %s', (field) => {
    // The servers disagree on the name and neither spelling is in the OpenAI
    // spec. A model whose thinking vanished would look like one that stalled.
    expect(readChunk({ choices: [{ delta: { [field]: 'weighing it up' } }] })).toEqual({
      thinking: 'weighing it up',
    });
  });

  it('reads a finish reason', () => {
    expect(readChunk({ choices: [{ finish_reason: 'stop' }] })).toEqual({ finishReason: 'stop' });
  });

  it('reads usage, which most servers send only on the last chunk', () => {
    expect(readChunk({ usage: { prompt_tokens: 7210, completion_tokens: 45 } })).toEqual({
      usage: { promptTokens: 7210, completionTokens: 45 },
    });
  });

  it('treats a chunk with an error as a failure, not a delta', () => {
    // A chunk carrying both is the server saying the generation failed.
    const delta = readChunk({
      error: { message: 'model not loaded' },
      choices: [{ delta: { content: 'partial' } }],
    });

    expect(delta).toEqual({ error: 'model not loaded' });
  });

  it('names the failure even when the server gives no message', () => {
    expect(readChunk({ error: {} })?.error).toBe('The server reported an error.');
  });

  it('accepts a non-streaming message body, so one parser serves both', () => {
    expect(readChunk({ choices: [{ message: { content: 'whole reply' } }] })).toEqual({
      text: 'whole reply',
    });
  });

  it.each([
    ['a role-only opening delta', { choices: [{ delta: { role: 'assistant' } }] }],
    ['an empty chunk', {}],
    ['a keep-alive', { choices: [] }],
    ['not an object', 'nope'],
    ['null', null],
  ])('emits nothing for %s', (_label, chunk) => {
    expect(readChunk(chunk)).toBeUndefined();
  });
});

describe('splitEvents', () => {
  it('keeps an incomplete trailing line for the next read', () => {
    // A chunk boundary lands mid-line often enough that treating each network
    // read as whole lines drops text at random.
    const { lines, rest } = splitEvents('data: {"a":1}\ndata: {"b"');

    expect(lines).toEqual(['data: {"a":1}']);
    expect(rest).toBe('data: {"b"');
  });

  it('leaves nothing behind when the buffer ends on a newline', () => {
    const { lines, rest } = splitEvents('data: one\ndata: two\n');

    expect(lines).toEqual(['data: one', 'data: two']);
    expect(rest).toBe('');
  });
});

describe('readEventLine', () => {
  it('reads a data line', () => {
    expect(readEventLine('data: {"choices":[{"delta":{"content":"hi"}}]}')).toEqual({ text: 'hi' });
  });

  it('recognises the terminator every implementation sends', () => {
    expect(readEventLine('data: [DONE]')).toBe('done');
  });

  it.each([
    ['a comment', ': keep-alive'],
    ['a blank line', ''],
    ['a non-data field', 'event: message'],
  ])('ignores %s, which is part of the format', (_label, line) => {
    expect(readEventLine(line)).toBeNull();
  });

  it('SURVIVAL: a malformed chunk does not kill a reply arriving fine', () => {
    // The failure that matters is not one bad chunk; it is one bad chunk taking
    // the whole reply with it.
    expect(readEventLine('data: {not json')).toBeNull();
    expect(readEventLine('data: {"choices":[{"delta":{"content":"still here"}}]}')).toEqual({
      text: 'still here',
    });
  });
});

describe('tool calls', () => {
  it('reads a call that arrives whole', () => {
    const delta = readChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
            ],
          },
        },
      ],
    });

    expect(delta?.toolCalls).toEqual([
      { index: 0, id: 'call_a', name: 'read_file', argumentsFragment: '{"path":"a.ts"}' },
    ]);
  });

  it('defaults a missing index to zero, for servers that send one at a time', () => {
    const delta = readChunk({
      choices: [{ delta: { tool_calls: [{ function: { name: 'ls' } }] } }],
    });

    expect(delta?.toolCalls?.[0]?.index).toBe(0);
  });
});

describe('ToolCallAccumulator', () => {
  it('STREAMING: assembles arguments arriving a fragment at a time', () => {
    // The actual wire behaviour: the name lands once, then the JSON arrives in
    // slices that are not individually parseable.
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, id: 'call_a', name: 'read_file' }]);
    acc.add([{ index: 0, argumentsFragment: '{"pa' }]);
    acc.add([{ index: 0, argumentsFragment: 'th":"src/a.ts"}' }]);

    expect(acc.take()).toEqual([
      { id: 'call_a', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' },
    ]);
  });

  it('keeps two parallel calls apart by index', () => {
    const acc = new ToolCallAccumulator();
    acc.add([
      { index: 0, id: 'a', name: 'read_file', argumentsFragment: '{"path":"one"}' },
      { index: 1, id: 'b', name: 'grep', argumentsFragment: '{"pattern":"x"}' },
    ]);

    expect(acc.take().map((c) => c.name)).toEqual(['read_file', 'grep']);
  });

  it('returns them in the order the server indexed them', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 2, name: 'third' }, { index: 0, name: 'first' }, { index: 1, name: 'second' }]);

    expect(acc.take().map((c) => c.name)).toEqual(['first', 'second', 'third']);
  });

  it('substitutes an id for a server that omits one', () => {
    // The protocol needs an id to match the result back to the call.
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, name: 'ls' }]);

    expect(acc.take()[0]?.id).toBe('call_0');
  });

  it('defaults empty arguments to an object, not an empty string', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, id: 'a', name: 'ls' }]);

    // `JSON.parse('')` throws; `{}` is what a no-argument call means.
    expect(acc.take()[0]?.argumentsJson).toBe('{}');
  });

  it('drops a fragment that never received a name', () => {
    // Executing something unnamed is not a recoverable state.
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, argumentsFragment: '{"path":"a"}' }]);

    expect(acc.take()).toEqual([]);
  });

  it('empties itself once taken, so a second turn starts clean', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, id: 'a', name: 'ls' }]);
    acc.take();

    expect(acc.size).toBe(0);
    expect(acc.take()).toEqual([]);
  });
});
