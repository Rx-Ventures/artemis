/**
 * Running a turn over HTTP.
 *
 * The run source is a fake, and it has to be: a real one spawns a provider CLI
 * against a real account and bills it. What the fake reproduces faithfully is
 * the *shape* of a run — a handle first, then an event stream, then exactly one
 * `run.end` — because every property worth testing here is about how this code
 * reacts to that sequence, including the awkward orderings.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, RunHandle, ServerModel } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { promptFromMessages, runTurn, type RunSource } from '../completions.js';

const MODEL: ServerModel = {
  route: 'work-max/opus',
  id: 'opus',
  label: 'Opus',
  note: '.',
  profileId: 'prof-a' as ServerModel['profileId'],
  profileSlug: 'work-max',
  profileLabel: 'Work Max',
  providerId: 'claude',
  thinkingLevels: [{ id: 'high', label: 'High', note: '.' }],
  adaptiveThinking: false,
  fastMode: true,
  ultracode: true,
};

/** A run source that replays a scripted event sequence. */
function fakeRuns(
  script: readonly Partial<AgentEvent>[],
  overrides: Partial<RunSource> = {},
): RunSource & {
  readonly started: { input: unknown }[];
  readonly denied: string[];
  readonly interrupted: string[];
  readonly disposed: string[];
} {
  const listeners = new Set<(event: AgentEvent) => void>();
  const started: { input: unknown }[] = [];
  const denied: string[] = [];
  const interrupted: string[] = [];
  const disposed: string[] = [];

  const source: RunSource = {
    startRun: async (input) => {
      started.push({ input });
      const handle = {
        runId: 'run-1',
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'working',
        capabilities: NO_CAPABILITIES,
      } as unknown as RunHandle;

      // Emitted after the handle resolves, on a later tick — which is what a
      // real adapter does, and what the queue in `runTurn` has to survive.
      queueMicrotask(() => {
        for (const partial of script) {
          const event = { runId: 'run-1', seq: 0, ...partial } as AgentEvent;
          for (const listener of listeners) listener(event);
        }
      });
      return handle;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interrupt: async (runId) => {
      interrupted.push(String(runId));
    },
    respondToPermission: async (_runId, requestId) => {
      denied.push(requestId);
    },
    disposeRun: async (runId) => {
      disposed.push(String(runId));
    },
    ...overrides,
  };

  return Object.assign(source, { started, denied, interrupted, disposed });
}

const turn = (overrides: Record<string, unknown> = {}) =>
  ({
    model: MODEL,
    cwd: '/w',
    request: { model: 'work-max/opus', messages: [{ role: 'user', content: 'hi' }] },
    extensions: {},
    ignored: [],
    ...overrides,
  }) as Parameters<typeof runTurn>[1];

async function drain(source: RunSource, input = turn()) {
  const events = [];
  for await (const event of runTurn(source, input)) events.push(event);
  return events;
}

describe('a turn', () => {
  it('streams text, then ends with a result', async () => {
    const source = fakeRuns([
      { type: 'text.delta', text: 'Hel' },
      { type: 'text.delta', text: 'lo' },
      { type: 'run.end', reason: 'completed' },
    ]);

    const events = await drain(source);
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual(
      ['Hel', 'lo'],
    );
    const done = events.at(-1) as { kind: 'done'; result: { text: string } };
    expect(done.kind).toBe('done');
    expect(done.result.text).toBe('Hello');
  });

  it('does not double the reply when a provider sends deltas and a complete block', async () => {
    // The bug this prevents: providers that stream emit both, and appending
    // each would return every answer twice.
    const source = fakeRuns([
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.complete', role: 'assistant', text: 'Hello' },
      { type: 'run.end', reason: 'completed' },
    ]);

    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('Hello');
  });

  it('uses a complete block when nothing streamed', async () => {
    // A provider with `partialMessages: false` sends only this.
    const source = fakeRuns([
      { type: 'text.complete', role: 'assistant', text: 'Whole answer' },
      { type: 'run.end', reason: 'completed' },
    ]);

    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('Whole answer');
  });

  it('falls back to the provider’s own summary when it sent no text at all', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed', result: 'Summary.' }]);
    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('Summary.');
  });

  it('never puts thinking into the answer', async () => {
    // A caller reading `content` must not receive the model's private
    // reasoning as though it were the reply.
    const source = fakeRuns([
      { type: 'thinking.delta', text: 'Let me consider…' },
      { type: 'text.delta', text: 'Done.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('Done.');
  });

  it('reports what the agent did, without reporting what it found', async () => {
    const source = fakeRuns([
      {
        type: 'tool.start',
        name: 'Read',
        toolCallId: 't1',
        input: { file_path: '/w/src/index.ts' },
      },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as {
      result: { activity: readonly { tool: string; summary?: string }[] };
    };
    expect(done.result.activity[0]).toMatchObject({
      tool: 'read',
      summary: '/w/src/index.ts',
    });
  });

  it('carries the session id, so a caller can continue the conversation', async () => {
    const source = fakeRuns([
      { type: 'session.started', sessionId: 'sess-9' },
      { type: 'run.end', reason: 'completed', sessionId: 'sess-9' },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as { result: { sessionId?: string } };
    expect(done.result.sessionId).toBe('sess-9');
  });

  it('maps usage into OpenAI’s three numbers', async () => {
    const source = fakeRuns([
      {
        type: 'run.end',
        reason: 'completed',
        usage: { scope: 'final', tokens: { inputTokens: 100, outputTokens: 40 } },
      },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as { result: { usage?: Record<string, number> } };
    expect(done.result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
    });
  });

  it('always disposes the run, so a reply never leaks a process', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    await drain(source);
    expect(source.disposed).toEqual(['run-1']);
  });

  it('reports a failure to start rather than hanging', async () => {
    const source = fakeRuns([], {
      startRun: async () => {
        throw new Error('no such profile');
      },
    });

    const done = (await drain(source)).at(-1) as { result: { error?: string } };
    expect(done.result.error).toBe('no such profile');
  });
});

describe('permission requests, with nobody to answer them', () => {
  it('denies automatically instead of parking forever', async () => {
    // Over HTTP there is no human. A request that waited would hang until the
    // client timed out, with no explanation on either side.
    const source = fakeRuns([
      { type: 'permission.request', requestId: 'perm-1', request: {} },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    await drain(source);
    expect(source.denied).toEqual(['perm-1']);
  });

  it('explains the denial as a constraint the model can work around', async () => {
    let message = '';
    const source = fakeRuns(
      [
        { type: 'permission.request', requestId: 'perm-1', request: {} },
        { type: 'run.end', reason: 'permission_denied' },
      ] as Partial<AgentEvent>[],
      {
        respondToPermission: async (_runId, _requestId, decision) => {
          message = decision.message ?? '';
        },
      },
    );

    const done = (await drain(source)).at(-1) as { result: { error?: string } };
    expect(message).toMatch(/no one is present to approve/i);
    expect(done.result.error).toMatch(/permission/i);
  });
});

describe('a client that goes away', () => {
  it('interrupts the run rather than paying for output nobody reads', async () => {
    const aborted = { aborted: true };
    // A run that never ends on its own: only the interrupt path can finish it.
    const source = fakeRuns([{ type: 'text.delta', text: 'working…' }]);

    const events = runTurn(source, turn({ signal: aborted }));
    const first = await events.next();
    expect(first.value).toMatchObject({ kind: 'text' });

    // Let the loop notice the abort, then close the generator as the socket
    // layer does when the response ends.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await events.return(undefined as never);

    expect(source.interrupted).toEqual(['run-1']);
  });
});

describe('what gets sent to the provider', () => {
  it('passes the thinking level, fast mode and ultracode through', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    await drain(
      source,
      turn({ extensions: { thinking: 'high', fastMode: true, ultracode: false } }),
    );

    expect(source.started[0]?.input).toMatchObject({
      model: 'opus',
      effort: 'high',
      fastMode: true,
      ultracode: false,
      cwd: '/w',
    });
  });

  it('resumes a session when one was named', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    await drain(source, turn({ extensions: { sessionId: 'sess-3' } }));
    expect(source.started[0]?.input).toMatchObject({ resumeSessionId: 'sess-3' });
  });
});

describe('promptFromMessages', () => {
  it('treats the trailing user message as the turn', () => {
    expect(
      promptFromMessages(
        [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
        { resuming: false },
      ),
    ).toContain('second');
  });

  it('does not replay history into a session that already holds it', () => {
    // The double-counting this prevents: a stateless client re-sends the whole
    // array every call, and a resumed session already has it.
    const prompt = promptFromMessages(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      { resuming: true },
    );
    expect(prompt).toBe('second');
  });

  it('carries history when there is no session to resume', () => {
    const prompt = promptFromMessages(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      { resuming: false },
    );
    expect(prompt).toContain('first');
    expect(prompt).toContain('reply');
  });

  it('keeps system messages every time, because they are instructions not history', () => {
    for (const resuming of [true, false]) {
      expect(
        promptFromMessages(
          [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'hi' },
          ],
          { resuming },
        ),
      ).toContain('Be terse.');
    }
  });

  it('reads content given as parts, and names an image it cannot forward', () => {
    const prompt = promptFromMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
      { resuming: false },
    );
    expect(prompt).toContain('what is this');
    // Named rather than dropped: the model should know something was meant to
    // be there.
    expect(prompt).toContain('image omitted');
  });
});

/* -------------------------------------------------------------------------- */
/* Over a real socket                                                          */
/* -------------------------------------------------------------------------- */

describe('POST /v1/chat/completions', () => {
  const TOKEN = 'completions-token-0123456789abcdef';
  const CONNECTION = {
    id: 'conn-1',
    label: 'Test',
    workspace: { kind: 'ephemeral' as const, perSession: true },
    token: TOKEN,
    createdAt: 0,
  };
  const CATALOGUE = {
    read: async () => [
      {
        id: 'prof-a' as ServerModel['profileId'],
        slug: 'work-max',
        label: 'Work Max',
        provider: { id: 'claude' as const, label: 'Claude', kind: 'hosted' as const },
        available: true,
        disabled: false,
        live: true,
        capabilities: NO_CAPABILITIES,
        models: [MODEL],
      },
    ],
    invalidate: () => undefined,
  };

  async function serve(source: RunSource) {
    const { createArtemisServer } = await import('../http.js');
    const { createWorkspaceResolver } = await import('../workspaces.js');
    const server = createArtemisServer({
      port: 0,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue: CATALOGUE,
      runs: source,
      workspaces: createWorkspaceResolver(),
    });
    const port = await server.listen();
    return { server, url: `http://127.0.0.1:${port}/v1/chat/completions` };
  }

  const post = (url: string, body: unknown, token = TOKEN) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers in the shape an OpenAI client parses', async () => {
    const source = fakeRuns([
      { type: 'text.delta', text: 'Hello there' },
      {
        type: 'run.end',
        reason: 'completed',
        sessionId: 'sess-1',
        usage: { scope: 'final', tokens: { inputTokens: 10, outputTokens: 3 } },
      },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, never>;
      expect(body).toMatchObject({
        object: 'chat.completion',
        model: 'work-max/opus',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello there' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        artemis: { sessionId: 'sess-1', endReason: 'completed' },
      });
    } finally {
      await server.close();
    }
  });

  it('streams as Server-Sent Events, ending with the sentinel', async () => {
    const source = fakeRuns([
      { type: 'text.delta', text: 'one ' },
      { type: 'text.delta', text: 'two' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const text = await response.text();
      const chunks = text
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));

      // The order OpenAI clients depend on: role first, then content, then a
      // finish_reason, then [DONE].
      expect(JSON.parse(chunks[0]!).choices[0].delta).toEqual({ role: 'assistant' });
      const content = chunks
        .slice(1, -2)
        .map((chunk) => JSON.parse(chunk).choices[0].delta.content ?? '')
        .join('');
      expect(content).toBe('one two');
      expect(JSON.parse(chunks.at(-2)!).choices[0].finish_reason).toBe('stop');
      expect(chunks.at(-1)).toBe('[DONE]');
    } finally {
      await server.close();
    }
  });

  it('rejects a parameter it would otherwise have to ignore', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toMatch(/temperature/);
      // And nothing was started: every refusal happens before the user's plan
      // is spent.
      expect(source.started).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('proceeds when the caller opts into leniency', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed', result: 'ok' }]);
    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        artemis: { ignoreUnsupported: true },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { artemis: { ignored: readonly string[] } };
      // Accepted, not applied, and *said so* — which is the whole bargain.
      expect(body.artemis.ignored).toContain('temperature');
    } finally {
      await server.close();
    }
  });

  it('refuses a route this connection may not use, as though it did not exist', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { createArtemisServer } = await import('../http.js');
    const { createWorkspaceResolver } = await import('../workspaces.js');
    const server = createArtemisServer({
      port: 0,
      connections: () => [
        { ...CONNECTION, allow: [{ profileId: 'someone-else' as ServerModel['profileId'] }] },
      ],
      version: '1.1.1',
      catalogue: CATALOGUE,
      runs: source,
      workspaces: createWorkspaceResolver(),
    });
    const port = await server.listen();

    try {
      const response = await post(`http://127.0.0.1:${port}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(404);
      expect(source.started).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('refuses a catalogue-only connection with a reason, not a crash', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { createArtemisServer } = await import('../http.js');
    const { createWorkspaceResolver } = await import('../workspaces.js');
    const server = createArtemisServer({
      port: 0,
      connections: () => [{ ...CONNECTION, workspace: { kind: 'none' as const } }],
      version: '1.1.1',
      catalogue: CATALOGUE,
      runs: source,
      workspaces: createWorkspaceResolver(),
    });
    const port = await server.listen();

    try {
      const response = await post(`http://127.0.0.1:${port}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).toMatch(/catalogue-only/i);
    } finally {
      await server.close();
    }
  });

  it('rejects a body that is not a conversation', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { server, url } = await serve(source);
    try {
      expect((await post(url, { model: 'work-max/opus' })).status).toBe(400);
      expect((await post(url, { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('still needs a token', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      }, 'wrong');
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe('a resumed conversation', () => {
  it('reports the session it ran in, even when the provider does not repeat it', async () => {
    /*
     * A new session announces itself with `session.started`; a resumed one does
     * not, and providers do not always repeat the id on `run.end`. Without this,
     * the second turn's response carried no `sessionId` and a client following
     * the documented pattern lost the thread after one exchange.
     */
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const done = (await drain(source, turn({ extensions: { sessionId: 'sess-existing' } }))).at(
      -1,
    ) as { result: { sessionId?: string } };

    expect(done.result.sessionId).toBe('sess-existing');
  });

  it('prefers an id the run reports over the one it was given', async () => {
    // A provider that forks rather than resumes answers in a different session,
    // and the caller must be told which one to continue.
    const source = fakeRuns([
      { type: 'run.end', reason: 'completed', sessionId: 'sess-forked' },
    ] as Partial<AgentEvent>[]);
    const done = (await drain(source, turn({ extensions: { sessionId: 'sess-existing' } }))).at(
      -1,
    ) as { result: { sessionId?: string } };

    expect(done.result.sessionId).toBe('sess-forked');
  });
});
