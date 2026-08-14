/**
 * Tests for the JSON-RPC codec the Codex adapter is built on.
 *
 * The subprocess half is mostly not covered here — it is four event handlers
 * around `spawn`. Everything with logic in it lives in `JsonRpcConnection` and
 * `LineSplitter`, both of which are driven by hand below. The one spawn-level
 * test is the line-cap overflow, because "the connection fails" is a property
 * of the wiring rather than of either object alone.
 */

import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@rx-artemis/protocol';

import {
  JSON_RPC_CODES,
  JsonRpcConnection,
  JsonRpcError,
  LineSplitter,
  MAX_UNTERMINATED_LINE_LENGTH,
  isJsonRpcError,
  spawnJsonRpcSubprocess,
} from '../jsonrpc.js';

/** A connection plus the frames it wrote, for asserting on both directions. */
function harness(options?: Partial<Parameters<typeof createConnection>[0]>) {
  return createConnection({ ...options });
}

function createConnection(options: {
  onRequest?: (request: { method: string; params: JsonValue | undefined }) => Promise<JsonValue>;
  onNotification?: (method: string, params: JsonValue | undefined) => void;
  onDiagnostic?: (message: string, detail?: unknown) => void;
}) {
  const sent: Record<string, unknown>[] = [];
  const connection = new JsonRpcConnection({
    send: (line) => {
      sent.push(JSON.parse(line) as Record<string, unknown>);
    },
    ...options,
  });
  return { connection, sent };
}

describe('JsonRpcConnection: outbound requests', () => {
  it('mints dense ids and resolves the matching response', async () => {
    const { connection, sent } = harness();

    const first = connection.request('model/list');
    const second = connection.request('thread/list', { limit: 3 });

    expect(sent).toEqual([
      { id: 0, method: 'model/list' },
      { id: 1, method: 'thread/list', params: { limit: 3 } },
    ]);

    // Answered out of order on purpose: correlation must be by id, not arrival.
    connection.handleLine(JSON.stringify({ id: 1, result: { data: [] } }));
    connection.handleLine(JSON.stringify({ id: 0, result: { data: ['gpt-5.5'] } }));

    await expect(first).resolves.toEqual({ data: ['gpt-5.5'] });
    await expect(second).resolves.toEqual({ data: [] });
    expect(connection.pendingCount).toBe(0);
  });

  it('omits the jsonrpc field, matching the app-server dialect', () => {
    const { connection, sent } = harness();
    void connection.request('initialize');
    expect(sent[0]).not.toHaveProperty('jsonrpc');
  });

  it('omits params entirely when none are given', () => {
    const { connection, sent } = harness();
    void connection.request('account/read');
    expect(Object.hasOwn(sent[0]!, 'params')).toBe(false);
  });

  it('rejects with a JsonRpcError carrying the code and method', async () => {
    const { connection } = harness();
    const pending = connection.request('turn/start');

    connection.handleLine(
      JSON.stringify({
        id: 0,
        error: { code: JSON_RPC_CODES.INVALID_REQUEST, message: 'missing field `type`' },
      }),
    );

    await expect(pending).rejects.toBeInstanceOf(JsonRpcError);
    await expect(pending).rejects.toMatchObject({
      code: JSON_RPC_CODES.INVALID_REQUEST,
      method: 'turn/start',
    });
    await expect(pending).rejects.toThrow(/turn\/start failed: missing field/);
  });

  it('resolves null for a response that carries result: null', async () => {
    const { connection } = harness();
    const pending = connection.request('thread/unsubscribe');
    connection.handleLine(JSON.stringify({ id: 0, result: null }));
    await expect(pending).resolves.toBeNull();
  });

  it('resolves null rather than hanging when a response has neither result nor error', async () => {
    const { connection } = harness();
    const pending = connection.request('config/read');
    connection.handleLine(JSON.stringify({ id: 0 }));
    await expect(pending).resolves.toBeNull();
  });
});

describe('JsonRpcConnection: inbound routing', () => {
  it('routes a frame with both id and method to onRequest, not to a pending response', async () => {
    const onRequest = vi.fn(async () => ({ decision: 'accept' }) as unknown as JsonValue);
    const { connection, sent } = harness({ onRequest });

    // An outbound request is in flight with id 0. The server independently
    // sends *its* request, also numbered 0. These must not collide.
    const outbound = connection.request('turn/start');
    connection.handleLine(
      JSON.stringify({
        id: 0,
        method: 'item/commandExecution/requestApproval',
        params: { command: ['rm', '-rf', '/'] },
      }),
    );

    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });

    expect(onRequest).toHaveBeenCalledWith({
      method: 'item/commandExecution/requestApproval',
      params: { command: ['rm', '-rf', '/'] },
    });
    expect(sent[1]).toEqual({ id: 0, result: { decision: 'accept' } });

    // The outbound request is still outstanding — it was never answered.
    expect(connection.pendingCount).toBe(1);
    connection.handleLine(JSON.stringify({ id: 0, result: 'done' }));
    await expect(outbound).resolves.toBe('done');
  });

  it('routes a method with no id to onNotification', () => {
    const onNotification = vi.fn();
    const { connection } = harness({ onNotification });

    connection.handleLine(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'P' } }));

    expect(onNotification).toHaveBeenCalledWith('item/agentMessage/delta', { delta: 'P' });
  });

  it('answers METHOD_NOT_FOUND when no request handler is installed', () => {
    const { connection, sent } = harness();
    connection.handleLine(JSON.stringify({ id: 7, method: 'item/tool/call', params: {} }));

    expect(sent[0]).toMatchObject({
      id: 7,
      error: { code: JSON_RPC_CODES.METHOD_NOT_FOUND },
    });
  });

  it('answers with an error when the request handler rejects', async () => {
    const { connection, sent } = harness({
      onRequest: async () => {
        throw new Error('the user closed the window');
      },
    });

    connection.handleLine(JSON.stringify({ id: 3, method: 'item/fileChange/requestApproval' }));

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      id: 3,
      error: { code: JSON_RPC_CODES.INTERNAL_ERROR, message: 'the user closed the window' },
    });
  });

  it('does not block the line reader on a request handler that parks', async () => {
    let release!: (value: JsonValue) => void;
    const parked = new Promise<JsonValue>((resolve) => {
      release = resolve;
    });
    const onNotification = vi.fn();
    const { connection, sent } = harness({ onRequest: async () => parked, onNotification });

    connection.handleLine(JSON.stringify({ id: 1, method: 'item/permissions/requestApproval' }));
    // This is the point: an unanswered approval must not stall the events the
    // UI needs in order to render the prompt being waited on.
    connection.handleLine(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'x' } }));

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);

    release({ decision: 'decline' });
    await vi.waitFor(() => {
      expect(sent[0]).toEqual({ id: 1, result: { decision: 'decline' } });
    });
  });
});

describe('JsonRpcConnection: malformed input', () => {
  it('drops a non-JSON line without throwing', () => {
    const onDiagnostic = vi.fn();
    const { connection } = harness({ onDiagnostic });

    expect(() => {
      connection.handleLine('WARNING: proceeding, even though we could not create PATH aliases');
    }).not.toThrow();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining('non-JSON'),
      expect.any(String),
    );
  });

  it('drops JSON that is not an object', () => {
    const onDiagnostic = vi.fn();
    const { connection } = harness({ onDiagnostic });
    connection.handleLine('[1,2,3]');
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('not an object'), expect.any(String));
  });

  it('ignores blank lines silently', () => {
    const onDiagnostic = vi.fn();
    const { connection } = harness({ onDiagnostic });
    connection.handleLine('   ');
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('drops a response for an id it never sent', () => {
    const onDiagnostic = vi.fn();
    const { connection } = harness({ onDiagnostic });
    connection.handleLine(JSON.stringify({ id: 99, result: 'stale' }));
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('unknown request id 99'));
  });

  it('survives a notification handler that throws', () => {
    const onDiagnostic = vi.fn();
    const { connection } = harness({
      onNotification: () => {
        throw new Error('renderer bug');
      },
      onDiagnostic,
    });

    expect(() => {
      connection.handleLine(JSON.stringify({ method: 'turn/started' }));
    }).not.toThrow();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('threw'), expect.any(Error));
  });
});

describe('JsonRpcConnection: failure', () => {
  it('rejects everything outstanding with the failure reason', async () => {
    const { connection } = harness();
    const first = connection.request('turn/start');
    const second = connection.request('model/list');

    const reason = new Error('The provider process exited with code 1.');
    connection.fail(reason);

    await expect(first).rejects.toBe(reason);
    await expect(second).rejects.toBe(reason);
    expect(connection.pendingCount).toBe(0);
    expect(connection.closed).toBe(true);
  });

  it('keeps the first reason when failed twice', async () => {
    const { connection } = harness();
    const pending = connection.request('turn/start');

    const real = new Error('segfault');
    connection.fail(real);
    connection.fail(new Error('disposed'));

    await expect(pending).rejects.toBe(real);
  });

  it('rejects new requests after failing, without writing to a dead pipe', async () => {
    const { connection, sent } = harness();
    connection.fail(new Error('gone'));

    await expect(connection.request('model/list')).rejects.toThrow('gone');
    expect(sent).toHaveLength(0);
  });

  it('drops notifications after failing', () => {
    const { connection, sent } = harness();
    connection.fail(new Error('gone'));
    connection.notify('initialized');
    expect(sent).toHaveLength(0);
  });

  it('does not answer a server request that resolves after the transport died', async () => {
    let release!: (value: JsonValue) => void;
    const { connection, sent } = harness({
      onRequest: async () =>
        new Promise<JsonValue>((resolve) => {
          release = resolve;
        }),
    });

    connection.handleLine(JSON.stringify({ id: 1, method: 'item/fileChange/requestApproval' }));
    connection.fail(new Error('process exited'));
    release({ decision: 'accept' });

    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(0);
  });

  it('reports a send that throws as a rejected request rather than an exception', async () => {
    const connection = new JsonRpcConnection({
      send: () => {
        throw new Error('EPIPE');
      },
    });
    await expect(connection.request('model/list')).rejects.toThrow('EPIPE');
    expect(connection.pendingCount).toBe(0);
  });
});

describe('isJsonRpcError', () => {
  it('recognises its own errors and rejects look-alikes', () => {
    expect(isJsonRpcError(new JsonRpcError('m', { code: -1, message: 'x' }))).toBe(true);
    expect(isJsonRpcError({ name: 'JsonRpcError', code: -32601 })).toBe(true);
    expect(isJsonRpcError(new Error('nope'))).toBe(false);
    expect(isJsonRpcError(null)).toBe(false);
  });
});

describe('LineSplitter', () => {
  it('emits one frame per newline', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a frame split across chunks', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));

    splitter.push('{"method":"item/agentMes');
    expect(lines).toEqual([]);
    expect(splitter.buffered).toBeGreaterThan(0);

    splitter.push('sage/delta"}\n');
    expect(lines).toEqual(['{"method":"item/agentMessage/delta"}']);
    expect(splitter.buffered).toBe(0);
  });

  it('handles several frames and a partial one in a single chunk', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);

    splitter.push('3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('strips a trailing carriage return', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('{"a":1}\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('skips empty lines', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('\n\n{"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('flushes a final frame that never got its newline', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('{"partial":true}');
    splitter.flush();
    expect(lines).toEqual(['{"partial":true}']);
  });

  it('flushes nothing when the buffer is empty', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('{"a":1}\n');
    splitter.flush();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('overflows on a single line that exceeds the cap, and goes inert', () => {
    // Without the cap a peer that never emits a newline grows the buffer by
    // however much it writes, for as long as it writes — an unbounded leak
    // that only a misbehaving process can trigger and only an OOM reports.
    const lines: string[] = [];
    let overflowed: number | undefined;
    const splitter = new LineSplitter((line) => lines.push(line), {
      maxBuffered: 64,
      onOverflow: (buffered) => {
        overflowed = buffered;
      },
    });

    splitter.push('x'.repeat(100));

    expect(overflowed).toBe(100);
    // The oversized fragment is discarded, not delivered: a truncated frame
    // would only parse as garbage.
    expect(lines).toEqual([]);
    expect(splitter.buffered).toBe(0);

    // A stream that overflowed once has nothing trustworthy left to say.
    splitter.push('{"late":true}\n');
    splitter.flush();
    expect(lines).toEqual([]);
  });

  it('overflows only once, however much more arrives', () => {
    const overflows: number[] = [];
    const splitter = new LineSplitter(() => undefined, {
      maxBuffered: 8,
      onOverflow: (buffered) => {
        overflows.push(buffered);
      },
    });
    splitter.push('x'.repeat(16));
    splitter.push('y'.repeat(16));
    expect(overflows).toEqual([16]);
  });

  it('does not count completed frames against the cap', () => {
    // The cap bounds what is *held back* waiting for a newline. Any number of
    // well-framed messages must pass through a small cap untouched.
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line), {
      maxBuffered: 16,
      onOverflow: () => {
        throw new Error('a framed stream must never overflow');
      },
    });
    for (let i = 0; i < 100; i += 1) splitter.push('{"n":12345678}\n');
    expect(lines).toHaveLength(100);
  });
});

describe('spawnJsonRpcSubprocess — unframed output', () => {
  it('fails the connection with a clear error when a peer exceeds the line cap', async () => {
    // A real subprocess writing just past the 8 MiB default without ever
    // sending a newline. The connection must fail — settling every pending
    // request with a reason that names the problem — rather than buffering
    // until the host runs out of memory.
    const child = spawnJsonRpcSubprocess({
      executable: process.execPath,
      args: [
        '-e',
        `process.stdout.write('x'.repeat(${String(MAX_UNTERMINATED_LINE_LENGTH + 1024)})); setInterval(() => {}, 1000);`,
      ],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
    });

    try {
      await expect(child.connection.request('model/list')).rejects.toThrow(/without a newline/);
    } finally {
      await child.dispose();
    }
  }, 20_000);
});
