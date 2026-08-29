import { describe, expect, it } from 'vitest';

import {
  createSseDecoder,
  parseRemoteResourcePath,
  remoteRunPath,
  remoteTerminalPath,
  REMOTE_RUNS_PATH,
  REMOTE_TERMINALS_PATH,
  sseMessage,
  SSE_HEARTBEAT,
} from './remote.js';

describe('remote resource paths', () => {
  it('builds and parses a run action path', () => {
    const path = remoteRunPath('run-1', 'respond-permission');
    expect(path).toBe('/api/v0/runs/run-1/respond-permission');
    expect(parseRemoteResourcePath(path, REMOTE_RUNS_PATH)).toEqual({
      id: 'run-1',
      action: 'respond-permission',
    });
  });

  it('round-trips an id that needs encoding', () => {
    const path = remoteRunPath('run/one', 'events');
    const parsed = parseRemoteResourcePath(path, REMOTE_RUNS_PATH);
    expect(parsed).toEqual({ id: 'run/one', action: 'events' });
  });

  it('parses a bare id with no action', () => {
    expect(parseRemoteResourcePath('/api/v0/runs/abc', REMOTE_RUNS_PATH)).toEqual({
      id: 'abc',
      action: undefined,
    });
  });

  it('refuses nested actions and empty ids', () => {
    expect(parseRemoteResourcePath('/api/v0/runs//send', REMOTE_RUNS_PATH)).toBeUndefined();
    expect(parseRemoteResourcePath('/api/v0/runs/a/b/c', REMOTE_RUNS_PATH)).toBeUndefined();
    expect(parseRemoteResourcePath('/api/v0/runs', REMOTE_RUNS_PATH)).toBeUndefined();
  });

  it('leaves a malformed escape as the id it literally was', () => {
    expect(parseRemoteResourcePath('/api/v0/runs/%zz/send', REMOTE_RUNS_PATH)).toEqual({
      id: '%zz',
      action: 'send',
    });
  });

  it('builds terminal paths under the terminals base', () => {
    expect(remoteTerminalPath('term-1', 'write')).toBe('/api/v0/terminals/term-1/write');
    expect(parseRemoteResourcePath('/api/v0/terminals/term-1/replay', REMOTE_TERMINALS_PATH)).toEqual(
      { id: 'term-1', action: 'replay' },
    );
  });
});

describe('sseMessage', () => {
  it('frames id, event and data with a terminating blank line', () => {
    expect(sseMessage({ id: '7', event: 'x', data: '{"a":1}' })).toBe(
      'id: 7\nevent: x\ndata: {"a":1}\n\n',
    );
  });

  it('splits multi-line data into one data: line each', () => {
    expect(sseMessage({ data: 'a\nb' })).toBe('data: a\ndata: b\n\n');
  });
});

describe('createSseDecoder', () => {
  it('decodes a whole message', () => {
    const decoder = createSseDecoder();
    expect(decoder.feed('id: 3\nevent: hello\ndata: {"seq":3}\n\n')).toEqual([
      { id: '3', event: 'hello', data: '{"seq":3}' },
    ]);
  });

  it('survives chunk boundaries anywhere, including mid-line', () => {
    const decoder = createSseDecoder();
    const frame = sseMessage({ id: '9', event: 'e', data: 'payload' });
    const messages = [
      ...decoder.feed(frame.slice(0, 4)),
      ...decoder.feed(frame.slice(4, 11)),
      ...decoder.feed(frame.slice(11)),
    ];
    expect(messages).toEqual([{ id: '9', event: 'e', data: 'payload' }]);
  });

  it('joins multiple data lines with newlines', () => {
    const decoder = createSseDecoder();
    expect(decoder.feed('data: a\ndata: b\n\n')).toEqual([{ data: 'a\nb' }]);
  });

  it('discards comments, so the heartbeat is silent', () => {
    const decoder = createSseDecoder();
    expect(decoder.feed(SSE_HEARTBEAT)).toEqual([]);
    expect(decoder.feed(':another comment\n\n')).toEqual([]);
  });

  it('tolerates CRLF line endings', () => {
    const decoder = createSseDecoder();
    expect(decoder.feed('id: 1\r\ndata: x\r\n\r\n')).toEqual([{ id: '1', data: 'x' }]);
  });

  it('decodes several messages from one chunk', () => {
    const decoder = createSseDecoder();
    const chunk = sseMessage({ id: '1', data: 'a' }) + sseMessage({ id: '2', data: 'b' });
    expect(decoder.feed(chunk)).toEqual([
      { id: '1', data: 'a' },
      { id: '2', data: 'b' },
    ]);
  });

  it('never emits a message that has not seen its blank line', () => {
    const decoder = createSseDecoder();
    expect(decoder.feed('id: 4\ndata: partial\n')).toEqual([]);
  });
});
