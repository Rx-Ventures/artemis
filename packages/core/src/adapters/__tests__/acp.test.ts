/**
 * Tests for the shared ACP client and its protocol vocabulary.
 *
 * The subprocess is never spawned here. `connectAcpAgent` takes a `spawn` seam
 * precisely so the parts with judgement in them — version negotiation, the
 * presence-keyed capability reads, the auth-required path, and what happens to
 * an approval request nobody is there to answer — can be driven by hand.
 *
 * The wire shapes below were transcribed from the same generated schema
 * `protocol.ts` was, and the handshake fixture is a verbatim copy of what
 * OpenCode 1.18.18 actually answered when driven live. If a future agent
 * disagrees with these fixtures, the fixtures are what to re-verify.
 */

import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@rx-artemis/protocol';

import { JsonRpcConnection } from '../jsonrpc.js';
import type { JsonRpcSubprocess, SpawnJsonRpcOptions } from '../jsonrpc.js';
import { AcpClient, connectAcpAgent, isAcpAuthRequiredError } from '../acp/client.js';
import {
  ACP_AUTH_REQUIRED_CODE,
  hasSessionCapability,
  isAuthRequiredError,
  isPromptResponse,
  isRequestPermissionRequest,
  isSessionNotification,
  isTerminalToolStatus,
} from '../acp/protocol.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Verbatim from `opencode acp` 1.18.18, driven live on 2026-08-17. */
const OPENCODE_INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { embeddedContext: true, image: true },
    // Presence-keyed, with empty objects rather than booleans. This is the
    // detail that would silently disable fork/list/resume if read for truth.
    sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
  },
  authMethods: [
    {
      description: 'Run `opencode auth login` in the terminal',
      name: 'Login with opencode',
      id: 'opencode-login',
    },
  ],
  agentInfo: { name: 'OpenCode', version: '1.18.18' },
} satisfies JsonValue;

/* -------------------------------------------------------------------------- */
/* Fake transport                                                             */
/* -------------------------------------------------------------------------- */

interface ScriptedAgent {
  /** Results keyed by method. A function receives the request's params. */
  readonly results?: Record<string, JsonValue | ((params: JsonValue | undefined) => JsonValue)>;
  /** Errors keyed by method, which win over results. */
  readonly errors?: Record<string, { code: number; message: string }>;
}

/**
 * A transport that answers from a script instead of from a process.
 *
 * Auto-replies to any request whose method appears in the script and leaves
 * anything else outstanding, which is how "the agent never answered" is tested
 * without a timeout.
 */
function fakeAgent(script: ScriptedAgent = {}) {
  const sent: Record<string, unknown>[] = [];
  let connection: JsonRpcConnection | undefined;
  let alive = true;
  let disposeCalls = 0;

  const transport: JsonRpcSubprocess = {
    get connection(): JsonRpcConnection {
      if (connection === undefined) throw new Error('spawn was never called');
      return connection;
    },
    stderrTail: () => '',
    get alive(): boolean {
      return alive;
    },
    dispose: async () => {
      disposeCalls += 1;
      alive = false;
      connection?.fail(new Error('The agent was disposed.'));
      return Promise.resolve();
    },
  };

  const spawn = (options: SpawnJsonRpcOptions): JsonRpcSubprocess => {
    connection = new JsonRpcConnection({
      send: (line) => {
        const frame = JSON.parse(line) as Record<string, unknown>;
        sent.push(frame);

        const method = frame['method'];
        const id = frame['id'];
        if (typeof method !== 'string' || id === undefined) return;

        const error = script.errors?.[method];
        const result = script.results?.[method];
        // Replying inline would re-enter the connection mid-write, so the
        // answer is queued the way a real pipe would deliver it.
        queueMicrotask(() => {
          if (error !== undefined) {
            connection?.handleLine(JSON.stringify({ jsonrpc: '2.0', id, error }));
          } else if (result !== undefined) {
            const value = typeof result === 'function' ? result(frame['params'] as JsonValue) : result;
            connection?.handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: value }));
          }
        });
      },
      ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      ...(options.jsonRpcVersion === undefined ? {} : { jsonRpcVersion: options.jsonRpcVersion }),
    });
    return transport;
  };

  return {
    spawn,
    sent,
    /** Push an agent→client message in, as a real agent would. */
    deliver: (frame: Record<string, unknown>) => {
      connection?.handleLine(JSON.stringify(frame));
    },
    frames: (method: string) => sent.filter((frame) => frame['method'] === method),
    get disposeCalls(): number {
      return disposeCalls;
    },
  };
}

function baseOptions(agent: ReturnType<typeof fakeAgent>, overrides: Partial<Parameters<typeof connectAcpAgent>[0]> = {}) {
  return {
    executable: 'opencode',
    args: ['acp'],
    cwd: '/tmp/project',
    env: {},
    onUpdate: () => {},
    spawn: agent.spawn,
    ...overrides,
  };
}

/** Let the microtask-queued scripted replies land. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/* -------------------------------------------------------------------------- */
/* Protocol guards                                                            */
/* -------------------------------------------------------------------------- */

describe('hasSessionCapability', () => {
  it('reads presence, not truthiness, because the values are empty objects', () => {
    const capabilities = { sessionCapabilities: { fork: {}, list: {}, resume: {} } };

    expect(hasSessionCapability(capabilities, 'fork')).toBe(true);
    expect(hasSessionCapability(capabilities, 'list')).toBe(true);
    expect(hasSessionCapability(capabilities, 'delete')).toBe(false);
  });

  it('treats an explicit false as absent, and missing capabilities as absent', () => {
    expect(hasSessionCapability({ sessionCapabilities: { fork: false } }, 'fork')).toBe(false);
    expect(hasSessionCapability({}, 'fork')).toBe(false);
    expect(hasSessionCapability(undefined, 'fork')).toBe(false);
  });
});

describe('isAuthRequiredError', () => {
  it('needs the code and a message that mentions auth', () => {
    expect(
      isAuthRequiredError({ code: ACP_AUTH_REQUIRED_CODE, message: 'Authentication required' }),
    ).toBe(true);
  });

  it('refuses to read an unrelated server error as a missing login', () => {
    // -32000 is JSON-RPC's implementation-defined server error, which agents
    // reuse. Reporting this as "signed out" would send the user to run a login
    // that fixes nothing.
    expect(
      isAuthRequiredError({ code: ACP_AUTH_REQUIRED_CODE, message: 'Disk full' }),
    ).toBe(false);
    expect(isAuthRequiredError({ code: -32603, message: 'auth failed' })).toBe(false);
    expect(isAuthRequiredError(undefined)).toBe(false);
  });
});

describe('shape guards', () => {
  it('accepts a well-formed session/update and rejects a malformed one', () => {
    expect(
      isSessionNotification({ sessionId: 'ses_1', update: { sessionUpdate: 'agent_message_chunk' } }),
    ).toBe(true);
    expect(isSessionNotification({ sessionId: 'ses_1' })).toBe(false);
    expect(isSessionNotification({ update: { sessionUpdate: 'plan' } })).toBe(false);
    expect(isSessionNotification(null)).toBe(false);
  });

  it('accepts a permission request only with its three load-bearing fields', () => {
    const request = {
      sessionId: 'ses_1',
      options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
      toolCall: { toolCallId: 'call_1', title: 'Write file' },
    };
    expect(isRequestPermissionRequest(request)).toBe(true);
    expect(isRequestPermissionRequest({ ...request, options: undefined })).toBe(false);
    expect(isRequestPermissionRequest({ ...request, toolCall: undefined })).toBe(false);
  });

  it('recognises a stop reason and terminal tool statuses', () => {
    expect(isPromptResponse({ stopReason: 'end_turn' })).toBe(true);
    expect(isPromptResponse({})).toBe(false);

    expect(isTerminalToolStatus('completed')).toBe(true);
    expect(isTerminalToolStatus('failed')).toBe(true);
    expect(isTerminalToolStatus('in_progress')).toBe(false);
    expect(isTerminalToolStatus(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Handshake                                                                  */
/* -------------------------------------------------------------------------- */

describe('connectAcpAgent: handshake', () => {
  it('initializes with version 1 and every client capability declined', async () => {
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    await connectAcpAgent(baseOptions(agent));

    const [frame] = agent.frames('initialize');
    expect(frame).toBeDefined();
    // Standard JSON-RPC 2.0, unlike the Codex dialect this codec was built for.
    expect(frame?.['jsonrpc']).toBe('2.0');

    const params = frame?.['params'] as Record<string, unknown>;
    expect(params['protocolVersion']).toBe(1);
    // Offering the agent a filesystem or a terminal would be a second, unmediated
    // path to the user's disk, outside the permission flow.
    expect(params['clientCapabilities']).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });

  it('maps the presence-keyed capabilities onto the handshake', async () => {
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    const client = await connectAcpAgent(baseOptions(agent));

    expect(client.handshake.canFork).toBe(true);
    expect(client.handshake.canList).toBe(true);
    expect(client.handshake.canResume).toBe(true);
    expect(client.handshake.canLoadSession).toBe(true);
    expect(client.handshake.acceptsImages).toBe(true);
    expect(client.handshake.agentName).toBe('OpenCode');
    expect(client.handshake.agentVersion).toBe('1.18.18');
  });

  it('publishes the auth methods, including the instruction the profile screen shows', async () => {
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    const client = await connectAcpAgent(baseOptions(agent));

    expect(client.handshake.authMethods).toHaveLength(1);
    expect(client.handshake.authMethods[0]?.description).toContain('opencode auth login');
  });

  it('refuses a version it was not written against, and tears the process down', async () => {
    const agent = fakeAgent({ results: { initialize: { protocolVersion: 99 } } });

    await expect(connectAcpAgent(baseOptions(agent))).rejects.toThrow(/ACP version 99/);
    // Nothing usable came back, so nothing should be left running.
    expect(agent.disposeCalls).toBe(1);
  });

  it('refuses an answer with no version at all', async () => {
    const agent = fakeAgent({ results: { initialize: { agentInfo: { name: 'Nope' } } } });

    await expect(connectAcpAgent(baseOptions(agent))).rejects.toThrow(/protocol version/);
    expect(agent.disposeCalls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Sessions and turns                                                         */
/* -------------------------------------------------------------------------- */

describe('AcpClient: sessions', () => {
  it('creates a session with the run cwd and an explicit empty MCP list', async () => {
    const agent = fakeAgent({
      results: {
        initialize: OPENCODE_INITIALIZE_RESULT,
        'session/new': { sessionId: 'ses_abc' },
      },
    });
    const client = await connectAcpAgent(baseOptions(agent));

    await expect(client.newSession()).resolves.toBe('ses_abc');
    expect(client.sessionId).toBe('ses_abc');

    const params = agent.frames('session/new')[0]?.['params'] as Record<string, unknown>;
    expect(params['cwd']).toBe('/tmp/project');
    // Required by the schema even when empty.
    expect(params['mcpServers']).toEqual([]);
  });

  it('turns auth_required into a typed error carrying the sign-in methods', async () => {
    const agent = fakeAgent({
      results: { initialize: OPENCODE_INITIALIZE_RESULT },
      errors: {
        'session/new': { code: ACP_AUTH_REQUIRED_CODE, message: 'Authentication required' },
      },
    });
    const client = await connectAcpAgent(baseOptions(agent));

    const error = await client.newSession().catch((caught: unknown) => caught);
    expect(isAcpAuthRequiredError(error)).toBe(true);
    // The adapter turns these into the instructions the profile screen shows,
    // rather than an error the user cannot act on.
    expect((error as { authMethods: readonly { id: string }[] }).authMethods[0]?.id).toBe(
      'opencode-login',
    );
  });

  it('refuses to prompt before a session exists', async () => {
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    const client = await connectAcpAgent(baseOptions(agent));

    await expect(client.prompt([{ type: 'text', text: 'hi' }])).rejects.toThrow(/No ACP session/);
  });

  it('returns the stop reason a turn ended with', async () => {
    const agent = fakeAgent({
      results: {
        initialize: OPENCODE_INITIALIZE_RESULT,
        'session/new': { sessionId: 'ses_abc' },
        'session/prompt': { stopReason: 'end_turn' },
      },
    });
    const client = await connectAcpAgent(baseOptions(agent));
    await client.newSession();

    await expect(client.prompt([{ type: 'text', text: 'hello' }])).resolves.toBe('end_turn');
  });

  it('sends session/cancel for the live session, and stays quiet when there is none', async () => {
    const agent = fakeAgent({
      results: {
        initialize: OPENCODE_INITIALIZE_RESULT,
        'session/new': { sessionId: 'ses_abc' },
      },
    });
    const client = await connectAcpAgent(baseOptions(agent));

    // Nothing to cancel yet: a notification here would name a session that
    // does not exist.
    client.cancel();
    expect(agent.frames('session/cancel')).toHaveLength(0);

    await client.newSession();
    client.cancel();
    expect(agent.frames('session/cancel')[0]?.['params']).toEqual({ sessionId: 'ses_abc' });
  });
});

/* -------------------------------------------------------------------------- */
/* Updates and permissions                                                    */
/* -------------------------------------------------------------------------- */

describe('AcpClient: notifications', () => {
  it('forwards session/update verbatim and drops malformed ones', async () => {
    const onUpdate = vi.fn();
    const onDiagnostic = vi.fn();
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    await connectAcpAgent(baseOptions(agent, { onUpdate, onDiagnostic }));

    agent.deliver({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'ses_abc',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      },
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'ses_abc' });

    agent.deliver({ jsonrpc: '2.0', method: 'session/update', params: { nope: true } });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalled();
  });

  it('survives a mapper that throws', async () => {
    const onDiagnostic = vi.fn();
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    await connectAcpAgent(
      baseOptions(agent, {
        onUpdate: () => {
          throw new Error('mapper bug');
        },
        onDiagnostic,
      }),
    );

    expect(() => {
      agent.deliver({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'ses_abc', update: { sessionUpdate: 'plan', entries: [] } },
      });
    }).not.toThrow();
    expect(onDiagnostic).toHaveBeenCalledWith('The session/update handler threw.', expect.anything());
  });
});

describe('AcpClient: permission requests', () => {
  const permissionRequest = {
    jsonrpc: '2.0',
    id: 77,
    method: 'session/request_permission',
    params: {
      sessionId: 'ses_abc',
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
      toolCall: { toolCallId: 'call_1', title: 'Write src/index.ts' },
    },
  };

  it('answers with the option the handler chose', async () => {
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    await connectAcpAgent(
      baseOptions(agent, {
        onPermissionRequest: () =>
          Promise.resolve({ outcome: { outcome: 'selected' as const, optionId: 'allow' } }),
      }),
    );

    agent.deliver(permissionRequest);
    await settle();

    const reply = agent.sent.find((frame) => frame['id'] === 77);
    expect(reply?.['result']).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('cancels rather than denies when no handler is installed', async () => {
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    await connectAcpAgent(baseOptions(agent));

    agent.deliver(permissionRequest);
    await settle();

    // "Nobody was asked" is not the same as "the user said no", and only one of
    // them should teach the agent anything.
    const reply = agent.sent.find((frame) => frame['id'] === 77);
    expect(reply?.['result']).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('cancels when the handler throws, instead of parking the turn forever', async () => {
    const onDiagnostic = vi.fn();
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    await connectAcpAgent(
      baseOptions(agent, {
        onDiagnostic,
        onPermissionRequest: () => Promise.reject(new Error('UI is gone')),
      }),
    );

    agent.deliver(permissionRequest);
    await settle();

    const reply = agent.sent.find((frame) => frame['id'] === 77);
    expect(reply?.['result']).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(onDiagnostic).toHaveBeenCalled();
  });

  it('declines the filesystem and terminal methods it never advertised', async () => {
    const agent = fakeAgent({ results: { initialize: OPENCODE_INITIALIZE_RESULT } });
    await connectAcpAgent(baseOptions(agent));

    agent.deliver({
      jsonrpc: '2.0',
      id: 88,
      method: 'fs/write_text_file',
      params: { path: '/etc/passwd', content: 'nope' },
    });
    await settle();

    const reply = agent.sent.find((frame) => frame['id'] === 88);
    // A misbehaving agent fails fast and visibly instead of parking a turn.
    expect(reply?.['error']).toBeDefined();
    expect(reply?.['result']).toBeUndefined();
  });
});

describe('AcpClient: teardown', () => {
  it('cancels the live turn before killing the process, and is idempotent', async () => {
    const agent = fakeAgent({
      results: {
        initialize: OPENCODE_INITIALIZE_RESULT,
        'session/new': { sessionId: 'ses_abc' },
      },
    });
    const client = await connectAcpAgent(baseOptions(agent));
    await client.newSession();

    await client.dispose();
    await client.dispose();

    // A killed process leaves half-written files behind; a cancelled turn does not.
    expect(agent.frames('session/cancel')).toHaveLength(1);
    expect(client.alive).toBe(false);
  });

  it('is constructible directly for adapters that own their own transport', () => {
    // Guards the export surface the OpenCode adapter builds on.
    expect(AcpClient).toBeTypeOf('function');
  });
});
