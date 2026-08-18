/**
 * Tests for the OpenCode adapter's own decisions.
 *
 * The mapper is tested next door and the transport the door after that; what is
 * left here is the judgement that belongs to neither — which session call a
 * resume makes, how an Artemis permission mode becomes an OpenCode one, how a
 * verdict becomes an opaque option id, and which working directory a listing
 * reports. All of it runs against the injected transport seam, so no binary is
 * spawned.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@rx-artemis/protocol';

import { JsonRpcConnection } from '../jsonrpc.js';
import type { JsonRpcSubprocess, SpawnJsonRpcOptions } from '../jsonrpc.js';
import { OPENCODE_CAPABILITIES, OPENCODE_CREDENTIALS, createOpencodeAdapter } from '../opencode.js';
import { isAdapterError } from '../types.js';

/* -------------------------------------------------------------------------- */
/* Fake agent                                                                 */
/* -------------------------------------------------------------------------- */

const HANDSHAKE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true },
    sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
  },
  authMethods: [{ id: 'opencode-login', name: 'Login', description: 'Run `opencode auth login`' }],
  agentInfo: { name: 'OpenCode', version: '1.18.18' },
};

function fakeAgent(results: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  let connection: JsonRpcConnection | undefined;
  let alive = true;

  const script: Record<string, unknown> = {
    initialize: HANDSHAKE,
    'session/new': { sessionId: 'ses_new' },
    'session/load': {},
    'session/fork': { sessionId: 'ses_fork' },
    'session/set_mode': {},
    'session/set_model': {},
    'session/prompt': { stopReason: 'end_turn' },
    'session/list': { sessions: [] },
    ...results,
  };

  const transport: JsonRpcSubprocess = {
    get connection(): JsonRpcConnection {
      if (connection === undefined) throw new Error('not spawned');
      return connection;
    },
    stderrTail: () => '',
    get alive(): boolean {
      return alive;
    },
    dispose: async () => {
      alive = false;
      connection?.fail(new Error('disposed'));
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
        queueMicrotask(() => {
          const result = script[method];
          if (result === undefined) return;
          // A scripted `{ __error }` answers with a JSON-RPC error instead.
          const asError = (result as { __error?: unknown }).__error;
          connection?.handleLine(
            JSON.stringify(
              asError === undefined
                ? { jsonrpc: '2.0', id, result }
                : { jsonrpc: '2.0', id, error: asError },
            ),
          );
        });
      },
      ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
      ...(options.jsonRpcVersion === undefined ? {} : { jsonRpcVersion: options.jsonRpcVersion }),
    });
    return transport;
  };

  return {
    spawn,
    sent,
    frames: (method: string) => sent.filter((f) => f['method'] === method),
    deliver: (frame: Record<string, unknown>) => {
      connection?.handleLine(JSON.stringify(frame));
    },
    /**
     * Answer a request the script deliberately left hanging.
     *
     * A real turn stays open while an approval is outstanding; a fake that
     * answers `session/prompt` immediately ends the run — and disposes the
     * transport — before the reply to the approval can be written.
     */
    resolve: (method: string, result: unknown) => {
      const frame = sent.find((f) => f['method'] === method);
      if (frame === undefined) throw new Error(`${method} was never sent`);
      connection?.handleLine(JSON.stringify({ jsonrpc: '2.0', id: frame['id'], result }));
    },
  };
}

function adapterWith(agent: ReturnType<typeof fakeAgent>) {
  let tick = 1000;
  return createOpencodeAdapter({ spawn: agent.spawn, now: () => (tick += 10), hostEnv: {} });
}

const RUN = {
  runId: 'run-1',
  providerId: 'opencode' as const,
  profileId: 'p1',
  prompt: 'hello',
  cwd: '/tmp/project',
  env: { XDG_DATA_HOME: '/tmp/profile' },
};

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Declarations                                                               */
/* -------------------------------------------------------------------------- */

describe('declarations', () => {
  it('isolates the account with XDG_DATA_HOME, not the vendor-named variable', () => {
    // OPENCODE_CONFIG_DIR relocates configuration while the credential stays
    // put, so two profiles set up that way would share one account.
    expect(OPENCODE_CREDENTIALS.configDirVar).toBe('XDG_DATA_HOME');
  });

  it('stands in for both XDG roots rather than overriding them', () => {
    // `opencode debug paths` showed every path comes from an XDG root and that
    // OPENCODE_CONFIG_DIR moves none of them. Data carries the credential;
    // config carries the providers and endpoints two profiles were sharing.
    const roots = OPENCODE_CREDENTIALS.xdgRoots ?? [];
    expect(roots.map((r) => r.variable)).toEqual(['XDG_DATA_HOME', 'XDG_CONFIG_HOME']);
    expect(roots.every((r) => r.ownedEntry === 'opencode')).toBe(true);
    // The data root is the profile directory itself, or `auth.json` would move
    // out from under existing profiles and the sign-in command would desync.
    expect(roots[0]?.farmSubpath).toBe('.');
    expect(OPENCODE_CREDENTIALS.credentialEnvKeys).toContain('OPENCODE_CONFIG_DIR');
  });

  it('strips the other providers’ keys, not just OpenCode’s own', () => {
    // OpenCode authenticates to any of them from the environment, and each one
    // outranks the profile's login.
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'AWS_ACCESS_KEY_ID']) {
      expect(OPENCODE_CREDENTIALS.credentialEnvKeys).toContain(key);
    }
    // And the isolation variable itself, which inherited would defeat profiles.
    expect(OPENCODE_CREDENTIALS.credentialEnvKeys).toContain('XDG_DATA_HOME');
  });

  it('offers only the two permission modes that map onto real agent modes', () => {
    expect(OPENCODE_CAPABILITIES.permissionModes).toEqual(['plan', 'default']);
    // The permissive rungs have no equivalent; mapping them onto `build` would
    // silently grant more than the user asked for.
    expect(OPENCODE_CAPABILITIES.permissionModes).not.toContain('bypassPermissions');
  });

  it('reports a status probe from a credential count rather than JSON', () => {
    const parse = OPENCODE_CREDENTIALS.signIn.parseStatus;
    expect(parse?.({ stdout: '2 credentials', stderr: '', exitCode: 0 })).toMatchObject({
      loggedIn: true,
    });
    // Zero credentials is a usable profile, not a broken one: OpenCode serves
    // free models with no credential at all.
    expect(parse?.({ stdout: '0 credentials', stderr: '', exitCode: 0 })).toMatchObject({
      loggedIn: false,
    });
    expect(parse?.({ stdout: '', stderr: 'boom', exitCode: 1 })).toMatchObject({
      loggedIn: false,
      error: 'boom',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Starting a run                                                             */
/* -------------------------------------------------------------------------- */

describe('createRun', () => {
  it('refuses a permission mode the agent has no equivalent for', async () => {
    const adapter = adapterWith(fakeAgent());
    await expect(
      adapter.createRun({ ...RUN, permissionMode: 'bypassPermissions' }),
    ).rejects.toThrow(/does not support/);
  });

  it('refuses a relative working directory', async () => {
    const adapter = adapterWith(fakeAgent());
    await expect(adapter.createRun({ ...RUN, cwd: 'relative/path' })).rejects.toThrow(/absolute/);
  });

  it('sets the mode after the session exists and before the turn starts', async () => {
    const agent = fakeAgent();
    const run = await adapterWith(agent).createRun({ ...RUN, permissionMode: 'plan' });
    await collect(run.events);

    expect(agent.frames('session/set_mode')[0]?.['params']).toMatchObject({ modeId: 'plan' });
    // Order matters: a mode applied after the prompt would govern nothing.
    const order = agent.sent.map((f) => f['method']);
    expect(order.indexOf('session/set_mode')).toBeLessThan(order.indexOf('session/prompt'));
  });

  it('maps Artemis’s default mode onto the agent’s build mode', async () => {
    const agent = fakeAgent();
    const run = await adapterWith(agent).createRun({ ...RUN, permissionMode: 'default' });
    await collect(run.events);

    expect(agent.frames('session/set_mode')[0]?.['params']).toMatchObject({ modeId: 'build' });
  });

  it('loads a session when resuming, and forks one when forking', async () => {
    const resuming = fakeAgent();
    await collect(
      (await adapterWith(resuming).createRun({ ...RUN, resumeSessionId: 'ses_old' })).events,
    );
    expect(resuming.frames('session/load')).toHaveLength(1);
    expect(resuming.frames('session/fork')).toHaveLength(0);

    const forking = fakeAgent();
    await collect(
      (
        await adapterWith(forking).createRun({
          ...RUN,
          resumeSessionId: 'ses_old',
          forkSession: true,
        })
      ).events,
    );
    // Forking leaves the original conversation exactly as it was.
    expect(forking.frames('session/fork')).toHaveLength(1);
    expect(forking.frames('session/load')).toHaveLength(0);
  });

  it('reports a missing login as an auth error carrying the command to fix it', async () => {
    const agent = fakeAgent({
      'session/new': { __error: { code: -32000, message: 'Authentication required' } },
    });

    // Not "the provider crashed": this is the profile screen's question,
    // answered over the transport, and it must reach the user as "sign in".
    const failure = await adapterWith(agent)
      .createRun(RUN)
      .catch((error: unknown) => error);

    expect(isAdapterError(failure)).toBe(true);
    const agentError = (failure as { agentError: { code: string; message: string } }).agentError;
    expect(agentError.code).toBe('auth');
    expect(agentError.message).toContain('not signed in');
    // The command the profile screen would show, carried on the failure itself.
    expect(agentError.message).toContain('opencode auth login');
  });

  it('emits a well-formed stream: session first, run.end last, dense seq', async () => {
    const agent = fakeAgent();
    const run = await adapterWith(agent).createRun(RUN);

    agent.deliver({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'ses_new',
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } },
      },
    });

    const events = await collect(run.events);
    expect(events[0]?.type).toBe('session.started');
    expect(events.at(-1)?.type).toBe('run.end');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, index) => index));
  });

  it('refuses mid-run input rather than dropping it', async () => {
    const agent = fakeAgent();
    const run = await adapterWith(agent).createRun(RUN);
    // ACP models a turn as one request with no steering channel.
    await expect(run.send('more')).rejects.toThrow(/more input/);
    await collect(run.events);
  });
});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

describe('permissions', () => {
  const ask = {
    jsonrpc: '2.0',
    id: 91,
    method: 'session/request_permission',
    params: {
      sessionId: 'ses_new',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Deny', kind: 'reject_once' },
      ],
      toolCall: { toolCallId: 'call_1', title: 'write', rawInput: { path: 'a.ts' } },
    },
  };

  it('announces the ask, then answers with the option matching the verdict', async () => {
    // The turn is left hanging so the approval happens *during* it, as it does
    // in a real run.
    const agent = fakeAgent({ 'session/prompt': undefined });
    const run = await adapterWith(agent).createRun(RUN);

    const seen: AgentEvent[] = [];
    const pump = (async () => {
      for await (const event of run.events) {
        seen.push(event);
        if (event.type === 'permission.request') {
          await run.respondToPermission(event.requestId, { behavior: 'allow' });
          agent.resolve('session/prompt', { stopReason: 'end_turn' });
        }
      }
    })();

    agent.deliver(ask);
    await pump;

    const request = seen.find((e) => e.type === 'permission.request');
    expect(request).toMatchObject({ request: { toolName: 'write', input: { path: 'a.ts' } } });
    expect(seen.some((e) => e.type === 'permission.resolved')).toBe(true);

    // "Once" over "always": Artemis owns durable rules in its own vocabulary,
    // and letting the agent persist one would put the two out of step.
    const reply = agent.sent.find((f) => f['id'] === 91);
    expect(reply?.['result']).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
  });

  it('rejects an answer to a request that is not waiting', async () => {
    const agent = fakeAgent();
    const run = await adapterWith(agent).createRun(RUN);
    await expect(run.respondToPermission('nope', { behavior: 'allow' })).rejects.toThrow(
      /waiting for an answer/,
    );
    await collect(run.events);
  });
});

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

describe('listSessions', () => {
  it('keeps only the sessions for the requested directory', async () => {
    const agent = fakeAgent({
      'session/list': {
        sessions: [
          { sessionId: 'a', cwd: '/tmp/project', title: 'Mine', updatedAt: '2026-08-17T08:00:00.000Z' },
          { sessionId: 'b', cwd: '/tmp/elsewhere', title: 'Theirs' },
        ],
      },
    });

    const page = await adapterWith(agent).listSessions?.({
      profileId: 'p1',
      cwd: '/tmp/project',
      env: {},
    });

    expect(page?.sessions.map((s) => s.id)).toEqual(['a']);
    expect(page?.sessions[0]).toMatchObject({ providerId: 'opencode', profileId: 'p1', title: 'Mine' });
  });

  it('reports the caller’s spelling of a directory macOS renamed', async () => {
    const agent = fakeAgent({
      'session/list': {
        sessions: [{ sessionId: 'a', cwd: '/private/tmp/project', title: 'Mine' }],
      },
    });

    const page = await adapterWith(agent).listSessions?.({
      profileId: 'p1',
      cwd: '/tmp/project',
      env: {},
    });

    // Two spellings of one directory would otherwise become two project groups
    // in the sidebar.
    expect(page?.sessions[0]?.cwd).toBe('/tmp/project');
  });

  it('pages without losing the total', async () => {
    const agent = fakeAgent({
      'session/list': {
        sessions: [
          { sessionId: 'a', cwd: '/tmp/project' },
          { sessionId: 'b', cwd: '/tmp/project' },
          { sessionId: 'c', cwd: '/tmp/project' },
        ],
      },
    });

    const page = await adapterWith(agent).listSessions?.({
      profileId: 'p1',
      cwd: '/tmp/project',
      env: {},
      limit: 2,
    });

    expect(page?.sessions).toHaveLength(2);
    expect(page?.hasMore).toBe(true);
  });
});
