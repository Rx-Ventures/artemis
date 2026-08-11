/**
 * Tests for the Claude adapter's plumbing.
 *
 * The Agent SDK is mocked, so nothing is spawned and no credential is used —
 * but every path under test is the real adapter: the streaming input pump, the
 * permission deferreds, the teardown ordering, and the option construction that
 * decides what the provider actually inherits.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, PermissionRequestEvent, RunEndEvent } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
  onListSessions: undefined as ((options: unknown) => Promise<unknown>) | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: (options: unknown) => {
    if (sdkMock.onListSessions === undefined) {
      throw new Error('test did not install a listSessions hook');
    }
    return sdkMock.onListSessions(options);
  },
}));

const { buildClaudeOptions, createClaudeAdapter, mapSystemPrompt } = await import('../claude.js');
const { AsyncQueue } = await import('../stream.js');
const { AdapterError, toAgentError } = await import('../types.js');
type ResolvedRunInput = import('../types.js').ResolvedRunInput;

/* -------------------------------------------------------------------------- */
/* Fake Query                                                                 */
/* -------------------------------------------------------------------------- */

class FakeQuery {
  readonly messages = new AsyncQueue<SDKMessage>();
  closed = false;
  interruptCalls = 0;
  interruptImpl: () => Promise<{ still_queued: string[] }> = () =>
    Promise.resolve({ still_queued: [] });

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]();
  }

  interrupt(): Promise<{ still_queued: string[] }> {
    this.interruptCalls += 1;
    return this.interruptImpl();
  }

  close(): void {
    this.closed = true;
    this.messages.close();
  }
}

interface Harness {
  readonly fake: FakeQuery;
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Record<string, unknown>;
}

/** Install a query hook and capture what the adapter passed to it. */
function installQuery(): { harness: () => Harness } {
  let captured: Harness | undefined;
  sdkMock.onQuery = (params) => {
    const fake = new FakeQuery();
    captured = {
      fake,
      prompt: params.prompt as AsyncIterable<SDKUserMessage>,
      options: (params.options ?? {}) as Record<string, unknown>,
    };
    return fake;
  };
  return {
    harness: () => {
      if (captured === undefined) throw new Error('query() was never called');
      return captured;
    },
  };
}

const BASE_INPUT: ResolvedRunInput = {
  runId: 'run-1',
  providerId: 'claude',
  profileId: 'prof-1',
  cwd: '/Users/dev/project',
  prompt: 'refactor the parser',
  env: { ANTHROPIC_API_KEY: 'sk-ant-profile', CLAUDE_CONFIG_DIR: '/app/profiles/work' },
};

const INIT_MESSAGE = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  cwd: '/Users/dev/project',
  model: 'claude-opus-4',
  tools: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.1.226',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  skills: [],
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage;

const RESULT_MESSAGE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 100,
  duration_api_ms: 90,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
  modelUsage: {},
  permission_denials: [],
  uuid: 'uuid-result',
  session_id: 'sess-abc',
} as unknown as SDKMessage;

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * A working directory that exists on the machine running the tests.
 *
 * `BASE_INPUT.cwd` is `/Users/dev/project`, which is fine everywhere the cwd is
 * only ever passed through to the (mocked) SDK — but the adapter now *stats*
 * the directory when a run fails to launch, in order to tell "the binary is
 * missing" apart from "the folder is not there". Tests about the former need a
 * folder that is really there.
 */
const REAL_CWD = process.cwd();

/** A directory that certainly does not exist. */
const MISSING_CWD = '/artemis-tests/no-such-directory/at-all';

/* -------------------------------------------------------------------------- */
/* Run lifecycle                                                              */
/* -------------------------------------------------------------------------- */

describe('run lifecycle', () => {
  it('streams mapped events and terminates on run.end', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    expect(events[0]?.type).toBe('session.started');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed', sessionId: 'sess-abc' });
    expect(run.status).toBe('ended');
    expect(run.sessionId).toBe('sess-abc');
  });

  it('buffers events produced before anyone subscribes', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    // Let the pump run to completion with no consumer attached at all.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = await drain(run.events);
    expect(events.map((e) => e.type)).toEqual(['session.started', 'usage', 'run.end']);
  });

  it('is consumable exactly once', async () => {
    installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    run.events[Symbol.asyncIterator]();
    expect(() => run.events[Symbol.asyncIterator]()).toThrow(/only be consumed once/);
    await run.dispose();
  });

  it('reports a transport failure as run.end rather than rejecting the stream', async () => {
    const { harness } = installQuery();
    // A cwd that really exists, so the launch-failure diagnosis below confirms
    // the directory is fine and leaves the provider's own classification alone.
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    harness().fake.messages.fail(new Error('spawn claude ENOENT'));

    const events = await drain(run.events);
    const end = events.at(-1) as RunEndEvent;
    expect(end).toMatchObject({ type: 'run.end', reason: 'error' });
    expect(end.error?.code).toBe('provider_not_found');
  });

  it('ends the run when query() itself cannot start', async () => {
    sdkMock.onQuery = () => {
      throw new Error('spawn claude ENOENT');
    };
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    const events = await drain(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'run.end', reason: 'error' });
  });

  it('walks through starting → running → ended', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    expect(run.status).toBe('starting');

    const { fake } = harness();
    const iterator = run.events[Symbol.asyncIterator]();
    fake.messages.push(INIT_MESSAGE);
    await iterator.next();
    expect(run.status).toBe('running');

    fake.messages.push(RESULT_MESSAGE);
    await iterator.next();
    await iterator.next();
    expect(run.status).toBe('ended');
  });
});

/* -------------------------------------------------------------------------- */
/* Streaming input                                                            */
/* -------------------------------------------------------------------------- */

describe('streaming input', () => {
  it('seeds the prompt iterable with the initial message', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);

    const iterator = harness().prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'refactor the parser' },
      parent_tool_use_id: null,
    });
    await run.dispose();
  });

  it('send() pushes into the live prompt iterable', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = harness().prompt[Symbol.asyncIterator]();
    await iterator.next();

    const result = await run.send('actually, use a lexer');
    // The text reaches the CLI immediately, but whether it steers the running
    // turn or becomes a queued turn this run will never execute is the
    // provider's decision. `false` is the only answer that is true either way.
    expect(result.deliveredImmediately).toBe(false);

    const second = await iterator.next();
    expect(second.value).toMatchObject({ message: { content: 'actually, use a lexer' } });
    await run.dispose();
  });

  it('refuses to send once teardown has closed the prompt queue', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = harness().prompt[Symbol.asyncIterator]();
    await iterator.next();

    // Do not await: dispose() closes the prompt queue immediately but only
    // marks the run ended after its grace waits. A send landing in that window
    // used to be pushed into a closed queue — a silent no-op — and still
    // reported success.
    const disposing = run.dispose();
    await expect(run.send('one more thing')).rejects.toThrow(/shutting down/);
    await disposing;
  });

  it('refuses to send into an ended run', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await expect(run.send('too late')).rejects.toThrow(AdapterError);
    await expect(run.send('too late')).rejects.toThrow(/already ended/);
  });

  it('closes the prompt iterable on dispose so the provider stops waiting for input', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = harness().prompt[Symbol.asyncIterator]();
    await iterator.next();

    await run.dispose();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

describe('permissions', () => {
  /** Call the adapter's canUseTool exactly as the SDK would. */
  function callCanUseTool(
    options: Record<string, unknown>,
    signal: AbortSignal,
    overrides: Record<string, unknown> = {},
  ): Promise<unknown> {
    const canUseTool = options['canUseTool'] as (
      toolName: string,
      input: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) => Promise<unknown>;
    return canUseTool(
      'Bash',
      { command: 'git status' },
      {
        signal,
        toolUseID: 'toolu_1',
        requestId: 'req_1',
        title: 'Claude wants to run git status',
        ...overrides,
      },
    );
  }

  it('emits permission.request and blocks until the answer arrives', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();
    harness().fake.messages.push(INIT_MESSAGE);
    await iterator.next();
    expect(run.status).toBe('running');

    const controller = new AbortController();
    const pending = callCanUseTool(harness().options, controller.signal);

    const event = (await iterator.next()).value as PermissionRequestEvent;
    expect(event.type).toBe('permission.request');
    expect(event.request).toMatchObject({
      toolName: 'Bash',
      toolCallId: 'toolu_1',
      title: 'Claude wants to run git status',
      input: { command: 'git status' },
    });
    expect(run.status).toBe('awaiting_permission');

    await run.respondToPermission(event.requestId, { behavior: 'allow', scope: 'session' });

    await expect(pending).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'toolu_1',
      decisionClassification: 'user_temporary',
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }], destination: 'session' },
      ],
    });
    expect(run.status).toBe('running');
    await run.dispose();
  });

  it('forwards a denial with the SDK-required message', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    const pending = callCanUseTool(harness().options, new AbortController().signal);
    const event = (await iterator.next()).value as PermissionRequestEvent;
    await run.respondToPermission(event.requestId, { behavior: 'deny' });

    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      message: 'The user declined this tool call.',
      decisionClassification: 'user_reject',
    });
    await run.dispose();
  });

  it('rejects an unknown or double answer instead of silently succeeding', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    await expect(run.respondToPermission('nope', { behavior: 'allow' })).rejects.toThrow(
      /No outstanding permission request/,
    );

    const pending = callCanUseTool(harness().options, new AbortController().signal);
    const event = (await iterator.next()).value as PermissionRequestEvent;
    await run.respondToPermission(event.requestId, { behavior: 'allow' });
    await expect(run.respondToPermission(event.requestId, { behavior: 'allow' })).rejects.toThrow(
      AdapterError,
    );
    await pending;
    await run.dispose();
  });

  it('denies — never returns null — when the run is torn down mid-prompt', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    const pending = callCanUseTool(harness().options, new AbortController().signal);
    await iterator.next();

    await run.dispose();

    const result = await pending;
    // Returning null would leave the tool blocked forever: no control response
    // is written and permission prompts have no park deadline.
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ behavior: 'deny' });
  });

  it('denies immediately when the provider withdraws the request', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    const controller = new AbortController();
    const pending = callCanUseTool(harness().options, controller.signal);
    await iterator.next();
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      message: 'The provider withdrew this tool call.',
    });
    await run.dispose();
  });

  it('denies without ever emitting a prompt once the run has ended', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake, options } = harness();
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await expect(callCanUseTool(options, new AbortController().signal)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('ends the run as permission_denied when a denial interrupts it', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake, options } = harness();
    const iterator = run.events[Symbol.asyncIterator]();

    const pending = callCanUseTool(options, new AbortController().signal);
    const event = (await iterator.next()).value as PermissionRequestEvent;
    await run.respondToPermission(event.requestId, { behavior: 'deny', interrupt: true });
    await pending;

    fake.messages.push({
      ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['stopped'],
    } as unknown as SDKMessage);

    let end: AgentEvent | undefined;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      end = next.value;
    }
    expect(end).toMatchObject({ type: 'run.end', reason: 'permission_denied' });
  });
});

/* -------------------------------------------------------------------------- */
/* Interrupt and dispose                                                      */
/* -------------------------------------------------------------------------- */

describe('interrupt', () => {
  it('reports what the provider still has queued', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();
    fake.interruptImpl = () => Promise.resolve({ still_queued: ['msg-2', 'msg-3'] });

    await expect(run.interrupt()).resolves.toEqual({ stillQueued: ['msg-2', 'msg-3'] });
    expect(fake.interruptCalls).toBe(1);
    await run.dispose();
  });

  it('reports reason "interrupted" even though the provider says it errored', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    await run.interrupt();
    fake.messages.push({
      ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['aborted'],
      terminal_reason: 'aborted_streaming',
    } as unknown as SDKMessage);

    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'interrupted' });
  });

  it('is a no-op on a run that already ended', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await expect(run.interrupt()).resolves.toEqual({ stillQueued: [] });
    expect(harness().fake.interruptCalls).toBe(0);
  });

  it('falls back to a hard teardown when the control channel never answers', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();
    fake.interruptImpl = () => Promise.reject(new Error('control channel closed'));

    await expect(run.interrupt()).resolves.toEqual({ stillQueued: [] });
    await run.dispose();
    const events = await drain(run.events);
    expect(events.at(-1)?.type).toBe('run.end');
  });
});

describe('dispose', () => {
  it('emits run.end even when the provider never sent a result', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(INIT_MESSAGE);

    await run.dispose();
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'disposed' });
  });

  it('is idempotent under concurrent and repeated calls', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);

    await Promise.all([run.dispose(), run.dispose(), run.dispose()]);
    await run.dispose();

    const events = await drain(run.events);
    expect(events.filter((e) => e.type === 'run.end')).toHaveLength(1);
    expect(harness().fake.closed).toBe(true);
  });

  it('cancels open tool calls before the terminal event', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push({
      type: 'assistant',
      uuid: 'uuid-a',
      session_id: 'sess-abc',
      parent_tool_use_id: null,
      message: {
        id: 'msg_01',
        role: 'assistant',
        type: 'message',
        model: 'claude-opus-4',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
      },
    } as unknown as SDKMessage);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await run.dispose();

    const events = await drain(run.events);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['tool.start', 'tool.end', 'run.end']);
    expect(events[1]).toMatchObject({ status: 'cancelled' });
  });

  it('tears the run down when an external abort signal fires', async () => {
    const { harness } = installQuery();
    const controller = new AbortController();
    const run = await createClaudeAdapter().createRun({
      ...BASE_INPUT,
      abortSignal: controller.signal,
    });
    harness().fake.messages.push(INIT_MESSAGE);

    controller.abort();
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'disposed' });
  });

  it('ends immediately when the abort signal was already aborted', async () => {
    installQuery();
    const run = await createClaudeAdapter().createRun({
      ...BASE_INPUT,
      abortSignal: AbortSignal.abort(),
    });
    const events = await drain(run.events);
    expect(events).toEqual([expect.objectContaining({ type: 'run.end', reason: 'disposed' })]);
  });
});

/* -------------------------------------------------------------------------- */
/* Launch failures                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The misleading-error bug, from the adapter's side.
 *
 * `spawn` raises `ENOENT` both for a missing executable and for a missing
 * `cwd`, and the SDK guesses the first — reporting, on macOS, that its native
 * binary "exists but failed to launch" because it "does not match this
 * system's libc". The adapter's job here is to check which it actually was and
 * say so, without discarding what the provider reported.
 */
describe('a run that never launches', () => {
  const endOf = (events: AgentEvent[]): RunEndEvent => events.at(-1) as RunEndEvent;

  const SDK_LIBC_MESSAGE =
    'Claude Code native binary at /opt/claude exists but failed to launch. This usually means ' +
    "the binary does not match this system's libc — e.g. spawning a musl-linked binary on a " +
    'glibc Linux host.';

  it('blames the working directory when that is what is actually wrong', async () => {
    sdkMock.onQuery = () => {
      throw new Error(SDK_LIBC_MESSAGE);
    };

    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    const end = endOf(await drain(run.events));

    expect(end.reason).toBe('error');
    // Re-classified: this is a bad request, not a missing provider.
    expect(end.error?.code).toBe('invalid_request');
    // The headline is the directory, and it names the path.
    expect(end.error?.message).toContain(`That directory does not exist: ${MISSING_CWD}`);
    // …and the provider's own words survive underneath. Wrapped, not swallowed:
    // if the diagnosis is ever wrong, this is the only way anyone finds out.
    expect(end.error?.message).toContain('exists but failed to launch');
  });

  it('does the same for a failure that arrives on the event stream', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    harness().fake.messages.fail(new Error(SDK_LIBC_MESSAGE));

    const end = endOf(await drain(run.events));
    expect(end.error?.code).toBe('invalid_request');
    expect(end.error?.message).toContain(MISSING_CWD);
  });

  it('names the working directory even when the directory is fine', async () => {
    // The genuinely-missing-binary case. Nothing is re-classified, but the cwd
    // is still stated, so the next report of this failure does not have to
    // guess at it.
    sdkMock.onQuery = () => {
      throw new Error(SDK_LIBC_MESSAGE);
    };

    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    const end = endOf(await drain(run.events));

    expect(end.error?.code).toBe('provider_not_found');
    expect(end.error?.message).toContain('exists but failed to launch');
    expect(end.error?.message).toContain(`(working directory: ${REAL_CWD})`);
  });

  it('leaves a failure that is not about launching alone', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    const overloaded = Object.assign(new Error('Overloaded'), { status: 529 });
    harness().fake.messages.fail(overloaded);

    const end = endOf(await drain(run.events));
    // A bad cwd is real here, but it is not what went wrong, and inventing a
    // directory problem for every failure would be its own misdiagnosis.
    expect(end.error?.code).toBe('provider_unavailable');
    expect(end.error?.message).toBe('Overloaded');
  });

  it('still ends the run exactly once, with the stream terminating', async () => {
    sdkMock.onQuery = () => {
      throw new Error('spawn claude ENOENT');
    };

    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    const events = await drain(run.events);

    expect(events.filter((event) => event.type === 'run.end')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(run.status).toBe('ended');
  });
});

/* -------------------------------------------------------------------------- */
/* Input validation                                                           */
/* -------------------------------------------------------------------------- */

describe('createRun validation', () => {
  it('rejects a relative working directory', async () => {
    installQuery();
    await expect(
      createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: 'relative/path' }),
    ).rejects.toThrow(/absolute path/);
  });

  it('rejects an unsupported permission mode instead of downgrading it', async () => {
    installQuery();
    const promise = createClaudeAdapter().createRun({
      ...BASE_INPUT,
      permissionMode: 'nonsense' as never,
    });
    await expect(promise).rejects.toThrow(/does not support the permission mode/);
    await promise.catch((error: unknown) => {
      expect(toAgentError(error).code).toBe('invalid_request');
    });
  });

  it('rejects forkSession with nothing to fork from', async () => {
    installQuery();
    await expect(
      createClaudeAdapter().createRun({ ...BASE_INPUT, forkSession: true }),
    ).rejects.toThrow(/requires resumeSessionId/);
  });

  it('accepts every mode the capability descriptor advertises', async () => {
    installQuery();
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const) {
      const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, permissionMode: mode });
      await run.dispose();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Option construction                                                        */
/* -------------------------------------------------------------------------- */

describe('buildClaudeOptions', () => {
  const context = {
    canUseTool: (async () => ({ behavior: 'deny', message: 'x' })) as never,
    abortController: new AbortController(),
    stderr: () => undefined,
    hostEnv: {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-from-the-users-shell',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDE_CONFIG_DIR: '/Users/dev/.claude',
    },
  };

  it('inherits no filesystem settings by default', () => {
    expect(buildClaudeOptions(BASE_INPUT, context).settingSources).toEqual([]);
  });

  it('honours an explicit opt-in', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, settingSources: ['project'] },
      context,
    );
    expect(options.settingSources).toEqual(['project']);
  });

  it('gives the provider the profile’s credentials, not the shell’s', () => {
    const env = buildClaudeOptions(BASE_INPUT, context).env ?? {};
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-profile');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/app/profiles/work');
    // An api-key profile: the subscription token in the shell is not the
    // profile's choice, so it does not travel.
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['CLAUDE_AGENT_SDK_CLIENT_APP']).toBe('artemis');
  });

  it('BILLING: a subscription bundle reaches the SDK with no ANTHROPIC_API_KEY, even one inherited from the shell', () => {
    // End of the chain: `resolveEnv` already refuses to emit an API key in
    // subscription mode, and this is the last place the shell could put one
    // back. `context.hostEnv` deliberately contains one.
    const env =
      buildClaudeOptions(
        {
          ...BASE_INPUT,
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-profile-token',
            CLAUDE_CONFIG_DIR: '/app/profiles/work',
          },
        },
        context,
      ).env ?? {};

    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-profile-token');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/app/profiles/work');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('turns partial messages on unless the caller opts out', () => {
    expect(buildClaudeOptions(BASE_INPUT, context).includePartialMessages).toBe(true);
    expect(
      buildClaudeOptions({ ...BASE_INPUT, includePartialMessages: false }, context)
        .includePartialMessages,
    ).toBe(false);
  });

  it('maps resume and fork', () => {
    const plain = buildClaudeOptions(BASE_INPUT, context);
    expect(plain.resume).toBeUndefined();
    expect(plain.forkSession).toBeUndefined();

    const forked = buildClaudeOptions(
      { ...BASE_INPUT, resumeSessionId: 'sess-old', forkSession: true },
      context,
    );
    expect(forked).toMatchObject({ resume: 'sess-old', forkSession: true });
  });

  it('ties the dangerous bypass flag to the mode the user actually picked', () => {
    expect(buildClaudeOptions(BASE_INPUT, context).allowDangerouslySkipPermissions).toBeUndefined();
    expect(
      buildClaudeOptions({ ...BASE_INPUT, permissionMode: 'acceptEdits' }, context)
        .allowDangerouslySkipPermissions,
    ).toBeUndefined();
    expect(
      buildClaudeOptions({ ...BASE_INPUT, permissionMode: 'bypassPermissions' }, context)
        .allowDangerouslySkipPermissions,
    ).toBe(true);
  });

  it('copies list options so a caller cannot mutate a live run', () => {
    const allowedTools = ['Read'];
    const options = buildClaudeOptions({ ...BASE_INPUT, allowedTools }, context);
    expect(options.tools).toEqual(['Read']);
    expect(options.tools).not.toBe(allowedTools);
  });

  it('maps allowedTools onto the SDK restriction knob, not its auto-approve list', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, allowedTools: ['Read', 'Grep'] },
      context,
    );
    // `Options.allowedTools` auto-approves without prompting and leaves the
    // full default tool set in place — the opposite of what the caller asked
    // for. `Options.tools` is what narrows the available tools.
    expect(options.tools).toEqual(['Read', 'Grep']);
    expect(options.allowedTools).toBeUndefined();
  });

  it('leaves the tool set alone when no allow-list was given', () => {
    const options = buildClaudeOptions(BASE_INPUT, context);
    expect(options.tools).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
  });

  it('sends the claude_code preset when the run named no system prompt', () => {
    // The default path for every Artemis run: `RunInput.systemPrompt` is optional
    // and the renderer never sets it. Passing `undefined` through would ship an
    // empty system prompt and silently lose the whole Claude Code preset.
    expect(buildClaudeOptions(BASE_INPUT, context).systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('passes budgets, turn limits and the run title through', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, maxTurns: 12, maxBudgetUsd: 2.5, title: 'Parser work', model: 'claude-opus-4', fallbackModel: 'claude-sonnet-4' },
      context,
    );
    expect(options).toMatchObject({
      maxTurns: 12,
      maxBudgetUsd: 2.5,
      title: 'Parser work',
      model: 'claude-opus-4',
      fallbackModel: 'claude-sonnet-4',
    });
  });
});

describe('mapSystemPrompt', () => {
  it('treats an absent spec as the provider preset, not as no prompt', () => {
    // Omitting `systemPrompt` does NOT mean "let the CLI use its default". The
    // SDK normalises undefined to the empty string and sends it as an explicit
    // custom prompt, which overrides the preset — so every default run would
    // start with no Claude Code system prompt at all.
    expect(mapSystemPrompt(undefined)).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('keeps the provider preset for default and append', () => {
    expect(mapSystemPrompt({ kind: 'default' })).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(mapSystemPrompt({ kind: 'append', text: 'Use tabs.' })).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Use tabs.',
    });
  });

  it('replaces it wholesale only when asked to', () => {
    expect(mapSystemPrompt({ kind: 'replace', text: 'You are terse.' })).toBe('You are terse.');
  });
});

/* -------------------------------------------------------------------------- */
/* Session listing                                                            */
/* -------------------------------------------------------------------------- */

describe('listSessions', () => {
  it('scopes the listing to the profile’s config directory and restores the environment', async () => {
    const before = process.env['CLAUDE_CONFIG_DIR'];
    let seenConfigDir: string | undefined;
    let seenOptions: Record<string, unknown> | undefined;

    sdkMock.onListSessions = (options) => {
      seenConfigDir = process.env['CLAUDE_CONFIG_DIR'];
      seenOptions = options as Record<string, unknown>;
      return Promise.resolve([
        { sessionId: 's1', summary: 'One', lastModified: 3 },
        { sessionId: 's2', summary: 'Two', lastModified: 2 },
        { sessionId: 's3', summary: 'Three', lastModified: 1 },
      ]);
    };

    const adapter = createClaudeAdapter();
    const page = await adapter.listSessions?.({
      profileId: 'prof-1',
      cwd: '/Users/dev/project',
      env: { CLAUDE_CONFIG_DIR: '/app/profiles/work' },
      limit: 2,
      offset: 0,
    });

    expect(seenConfigDir).toBe('/app/profiles/work');
    // Over-fetch by one so `hasMore` is a fact, not a guess.
    expect(seenOptions).toMatchObject({ dir: '/Users/dev/project', limit: 3, offset: 0 });
    expect(page?.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(page?.hasMore).toBe(true);
    expect(page?.sessions[0]).toMatchObject({ providerId: 'claude', profileId: 'prof-1', cwd: '/Users/dev/project' });
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(before);
  });

  it('restores the environment even when the listing throws', async () => {
    const before = process.env['CLAUDE_CONFIG_DIR'];
    sdkMock.onListSessions = () => Promise.reject(new Error('permission denied'));

    const adapter = createClaudeAdapter();
    await expect(
      adapter.listSessions?.({ profileId: 'p', cwd: '/w', env: { CLAUDE_CONFIG_DIR: '/app/x' } }),
    ).rejects.toThrow(/Could not read Claude session history/);

    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(before);
  });

  it('reports hasMore false when the page was not filled', async () => {
    sdkMock.onListSessions = () =>
      Promise.resolve([{ sessionId: 's1', summary: 'One', lastModified: 1 }]);

    const page = await createClaudeAdapter().listSessions?.({
      profileId: 'p',
      cwd: '/w',
      env: {},
      limit: 10,
    });
    expect(page?.hasMore).toBe(false);
    expect(page?.sessions).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Aggregated session listing                                                 */
/* -------------------------------------------------------------------------- */

describe('listAllSessions', () => {
  /** A profile's config directory, as `resolveStoreEnv` would produce it. */
  const scope = (profileId: string, configDir: string) => ({
    profileId,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });

  it('walks every profile’s config directory and stamps the profile it found each session in', async () => {
    const seen: Array<{ configDir: string | undefined; options: unknown }> = [];

    sdkMock.onListSessions = (options) => {
      const configDir = process.env['CLAUDE_CONFIG_DIR'];
      seen.push({ configDir, options });
      return Promise.resolve(
        configDir === '/app/profiles/work'
          ? [{ sessionId: 'w1', summary: 'Work', lastModified: 2, cwd: '/repos/api' }]
          : [{ sessionId: 'p1', summary: 'Personal', lastModified: 5, cwd: '/repos/blog' }],
      );
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('work', '/app/profiles/work'), scope('home', '/app/profiles/home')],
    });

    // One call per profile, each with the profile's own config directory
    // swapped in, and no `dir` — the SDK enumerates every project itself.
    expect(seen.map((call) => call.configDir)).toEqual([
      '/app/profiles/work',
      '/app/profiles/home',
    ]);
    expect(seen[0]?.options).toEqual({});

    // The profile is not tracked anywhere: it is which directory the session
    // was found in, and that is what lands on the summary.
    expect(result?.sessions).toEqual([
      expect.objectContaining({ id: 'p1', profileId: 'home', cwd: '/repos/blog' }),
      expect.objectContaining({ id: 'w1', profileId: 'work', cwd: '/repos/api' }),
    ]);
    expect(result?.unreadableProfiles).toEqual([]);
  });

  it('takes cwd from the session, not from the encoded project directory name', async () => {
    // The encoding replaces every non-alphanumeric character with `-`, so
    // `/repos/my-app` and `/repos/my/app` share a directory name. Only the
    // session's own record can say which one this was.
    sdkMock.onListSessions = () =>
      Promise.resolve([
        { sessionId: 's1', summary: 'Hyphenated', lastModified: 1, cwd: '/repos/my-app' },
      ]);

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('work', '/app/profiles/work')],
    });

    expect(result?.sessions[0]?.cwd).toBe('/repos/my-app');
  });

  it('drops a session whose working directory cannot be recovered', async () => {
    // Ungroupable and unresumable. A row for it would do nothing, and a guessed
    // path would start an agent somewhere the user never worked.
    sdkMock.onListSessions = () =>
      Promise.resolve([
        { sessionId: 'good', summary: 'Has a cwd', lastModified: 2, cwd: '/repos/api' },
        { sessionId: 'orphan', summary: 'No cwd', lastModified: 1 },
        { sessionId: 'blank', summary: 'Blank cwd', lastModified: 1, cwd: '   ' },
      ]);

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('work', '/app/profiles/work')],
    });

    expect(result?.sessions.map((s) => s.id)).toEqual(['good']);
  });

  it('keeps going when one profile’s store cannot be read', async () => {
    // The property that matters: a profile with a deleted config directory
    // must not blank the whole sidebar.
    sdkMock.onListSessions = () => {
      const configDir = process.env['CLAUDE_CONFIG_DIR'];
      if (configDir === '/app/profiles/broken') {
        return Promise.reject(new Error('EACCES: permission denied'));
      }
      return Promise.resolve([
        { sessionId: 'ok1', summary: 'Fine', lastModified: 1, cwd: '/repos/api' },
      ]);
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [
        scope('broken', '/app/profiles/broken'),
        scope('healthy', '/app/profiles/healthy'),
      ],
    });

    expect(result?.sessions.map((s) => s.id)).toEqual(['ok1']);
    expect(result?.unreadableProfiles).toEqual(['broken']);
  });

  it('restores CLAUDE_CONFIG_DIR even when a profile throws', async () => {
    const before = process.env['CLAUDE_CONFIG_DIR'];
    sdkMock.onListSessions = () => Promise.reject(new Error('boom'));

    await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('a', '/app/profiles/a'), scope('b', '/app/profiles/b')],
    });

    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(before);
  });

  it('sorts newest first across profiles, tie-breaking on id for a stable list', async () => {
    sdkMock.onListSessions = () => {
      const configDir = process.env['CLAUDE_CONFIG_DIR'];
      return Promise.resolve(
        configDir === '/app/profiles/a'
          ? [
              { sessionId: 'a-old', summary: 'x', lastModified: 1, cwd: '/repos/one' },
              { sessionId: 'b-tie', summary: 'x', lastModified: 7, cwd: '/repos/one' },
            ]
          : [
              { sessionId: 'a-tie', summary: 'x', lastModified: 7, cwd: '/repos/two' },
              { sessionId: 'c-new', summary: 'x', lastModified: 9, cwd: '/repos/two' },
            ],
      );
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('a', '/app/profiles/a'), scope('b', '/app/profiles/b')],
    });

    expect(result?.sessions.map((s) => s.id)).toEqual(['c-new', 'a-tie', 'b-tie', 'a-old']);
  });

  it('asks for no page — merging happens above it, so slicing cannot happen here', async () => {
    let seenOptions: unknown;
    sdkMock.onListSessions = (options) => {
      seenOptions = options;
      return Promise.resolve([]);
    };

    await createClaudeAdapter().listAllSessions?.({ profiles: [scope('a', '/app/a')] });

    // A per-profile limit would drop one profile's older sessions in favour of
    // another's newer ones before the two were ever compared.
    expect(seenOptions).toEqual({});
  });

  it('answers an empty profile list without touching the SDK', async () => {
    sdkMock.onListSessions = () => Promise.reject(new Error('should not be called'));

    const result = await createClaudeAdapter().listAllSessions?.({ profiles: [] });
    expect(result).toEqual({ sessions: [], unreadableProfiles: [] });
  });

  it('needs no credential — only the config directory is read out of the env', async () => {
    // `resolveStoreEnv` emits exactly this and no secret, so a profile that has
    // never had a key stored still lists its history.
    let seenApiKey: string | undefined;
    sdkMock.onListSessions = () => {
      seenApiKey = process.env['ANTHROPIC_API_KEY'];
      return Promise.resolve([]);
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [{ profileId: 'keyless', env: { CLAUDE_CONFIG_DIR: '/app/profiles/keyless' } }],
    });

    expect(result?.sessions).toEqual([]);
    expect(result?.unreadableProfiles).toEqual([]);
    // Nothing in this path sets one; whatever the host environment has is
    // untouched by the adapter.
    expect(seenApiKey).toBe(process.env['ANTHROPIC_API_KEY']);
  });
});

describe('checkAvailability', () => {
  it('is available on the platforms the SDK ships a runtime for', async () => {
    const availability = await createClaudeAdapter().checkAvailability?.();
    // The test runner is itself one of the supported platforms.
    expect(availability).toEqual({ available: true });
  });
});
