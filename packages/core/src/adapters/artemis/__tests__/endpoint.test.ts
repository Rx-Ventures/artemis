/**
 * One Artemis driving another, over a real socket.
 * ============================================================================
 *
 * Same discipline as the local adapter's endpoint tests: the adapter is driven
 * through a real `node:http` server rather than a stubbed `fetch`, because the
 * thing under test is what goes out on the wire — the path, the bearer token,
 * the request body — and what is made of the SSE that comes back.
 *
 * The behaviours pinned here that the local suite has no equivalent of:
 *
 *  - **The session id is never guessed.** `session.started` carries an id the
 *    server owns or is not emitted at all, and `run.end` never carries one the
 *    server did not confirm. The local adapter's placeholder trick would, with
 *    `resumeSession: true`, poison the pane's resume target on any stream that
 *    died early — see the adapter's class comment.
 *  - **The activity report becomes settled tool rows**, after the text.
 *  - **A vanished stream is an error, not a completion.**
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, RunId } from '@rx-artemis/protocol';
import { LOCAL_API_KEY_ENV, LOCAL_BASE_URL_ENV } from '@rx-artemis/protocol';

import type { ResolvedRunInput } from '../../types.js';
import { createArtemisAdapter } from '../adapter.js';

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Every request a test server received, in order. */
interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A server whose every route is scripted by the test. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void,
): Promise<{ origin: string; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      seen.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      handler(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, seen };
}

/** Frame chunks the way the serving Artemis does. */
function sse(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'work/opus',
    choices: [{ index: 0, delta, finish_reason: (extra['finish_reason'] as string) ?? null }],
    ...extra,
  };
}

/** Start a run against `origin` and collect its whole event stream. */
async function drive(
  origin: string,
  input: Partial<ResolvedRunInput> = {},
): Promise<readonly AgentEvent[]> {
  const adapter = createArtemisAdapter();
  const run = await adapter.createRun({
    runId: 'run-1' as RunId,
    providerId: 'artemis',
    profileId: 'profile-1',
    cwd: process.cwd(),
    prompt: 'hello over the wire',
    model: 'work/opus',
    env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok_123' },
    ...input,
  } as ResolvedRunInput);

  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

/** The default happy stream: an early session chunk, text, a final report. */
function happyStream(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  response.write(sse(chunk({ role: 'assistant' })));
  response.write(sse(chunk({}, { artemis: { sessionId: 'sess-abc' } })));
  response.write(sse(chunk({ content: 'Hel' })));
  response.write(sse(chunk({ content: 'lo.' })));
  response.write(
    sse(
      chunk(
        {},
        {
          finish_reason: 'stop',
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
          artemis: {
            sessionId: 'sess-abc',
            activity: [
              { tool: 'read', summary: 'src/index.ts', at: 1, ok: true },
              { tool: 'bash', summary: 'pnpm test', at: 2, ok: false },
            ],
            endReason: 'completed',
          },
        },
      ),
    ),
  );
  response.write(sse('[DONE]'));
  response.end();
}

describe('a fresh turn', () => {
  it('streams the reply and never guesses a session id', async () => {
    const { origin, seen } = await serve((request, response) => {
      expect(request.url).toBe('/v1/chat/completions');
      happyStream(response);
    });

    const events = await drive(origin);
    const types = events.map((event) => event.type);

    // The id arrived on an early chunk, so `session.started` leads — with the
    // server's id, not a placeholder.
    expect(types[0]).toBe('session.started');
    expect(events[0]).toMatchObject({ sessionId: 'sess-abc', providerId: 'artemis' });

    expect(types).toEqual([
      'session.started',
      'text.delta',
      'text.delta',
      'tool.start',
      'tool.end',
      'tool.start',
      'tool.end',
      'text.complete',
      'run.end',
    ]);

    const end = events.at(-1);
    expect(end).toMatchObject({
      type: 'run.end',
      reason: 'completed',
      sessionId: 'sess-abc',
      usage: { scope: 'final', tokens: { inputTokens: 11, outputTokens: 5 } },
    });

    // The request body is the wire contract: the route as `model`, one user
    // message, streaming on, and no `artemis` extensions on a fresh turn.
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body['model']).toBe('work/opus');
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello over the wire' }]);
    expect(body['stream']).toBe(true);
    expect(body['artemis']).toBeUndefined();
    expect(seen[0]?.authorization).toBe('Bearer tok_123');
  });

  it('renders the activity report as settled tool rows', async () => {
    const { origin } = await serve((_request, response) => happyStream(response));

    const events = await drive(origin);
    const toolEnds = events.filter((event) => event.type === 'tool.end');

    expect(events.filter((event) => event.type === 'tool.start')).toMatchObject([
      { name: 'read', title: 'src/index.ts' },
      { name: 'bash', title: 'pnpm test' },
    ]);
    // `ok: false` is a row that failed; absent/true settle as ok.
    expect(toolEnds).toMatchObject([
      { name: 'read', status: 'ok' },
      { name: 'bash', status: 'error' },
    ]);
  });

  it('accepts the id arriving only on the final chunk, as older servers send it', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'Hi.' })));
      response.write(
        sse(
          chunk(
            {},
            {
              finish_reason: 'stop',
              artemis: { sessionId: 'sess-late', endReason: 'completed' },
            },
          ),
        ),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    const types = events.map((event) => event.type);

    // Late is tolerated — the text streams first, the announcement lands when
    // the server finally says. What is not tolerated is a made-up id.
    expect(types).toEqual(['text.delta', 'session.started', 'text.complete', 'run.end']);
    expect(events.at(-1)).toMatchObject({ sessionId: 'sess-late' });
  });

  it('reports a stream that died mid-turn as an error with no session at all', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'Hal' })));
      // The socket dies before any final chunk. No id was ever confirmed.
      response.destroy();
    });

    const events = await drive(origin);
    const end = events.at(-1);

    expect(end?.type).toBe('run.end');
    expect(end).toMatchObject({ reason: 'error' });
    // The load-bearing assertion: nothing here for the store to promote into
    // a resume target the server has never heard of.
    expect((end as { sessionId?: string }).sessionId).toBeUndefined();
    expect(events.some((event) => event.type === 'session.started')).toBe(false);
  });
});

describe('a resumed turn', () => {
  it('announces the known session first and asks the server to continue it', async () => {
    const { origin, seen } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'Continuing.' })));
      response.write(
        sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId: 'sess-abc', endReason: 'completed' } })),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin, { resumeSessionId: 'sess-abc' });

    expect(events[0]).toMatchObject({
      type: 'session.started',
      sessionId: 'sess-abc',
      resumedFrom: 'sess-abc',
    });

    const body = seen[0]?.body as { artemis?: { sessionId?: string } };
    expect(body.artemis?.sessionId).toBe('sess-abc');
  });

  it('carries fast mode and ultracode through as extensions', async () => {
    const { origin, seen } = await serve((_request, response) => happyStream(response));

    await drive(origin, { fastMode: true, ultracode: false });

    const body = seen[0]?.body as { artemis?: Record<string, unknown> };
    expect(body.artemis).toEqual({ fastMode: true, ultracode: false });
  });
});

describe('refusals and losses', () => {
  it('reports a 401 as a token problem, not an absent server', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'No connection matches this token.', type: 'auth' } }),
      );
    });

    const events = await drive(origin);
    const end = events.at(-1) as { type: string; reason?: string; error?: { code?: string; message?: string } };

    expect(end.type).toBe('run.end');
    expect(end.reason).toBe('error');
    expect(end.error?.code).toBe('auth');
    expect(end.error?.message).toContain('connection token');
  });

  it('surfaces the server’s own message for an unknown route', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'No model route “gone/away”.', type: 'invalid_request_error' } }),
      );
    });

    const events = await drive(origin);
    const end = events.at(-1) as { error?: { code?: string; message?: string } };

    expect(end.error?.code).toBe('model_unavailable');
    expect(end.error?.message).toContain('gone/away');
  });

  it('ends interrupted when asked to stop mid-stream', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'thinking…' })));
      // …and then nothing, forever. The client's interrupt is the only exit.
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      runId: 'run-2' as RunId,
      providerId: 'artemis',
      profileId: 'profile-1',
      cwd: process.cwd(),
      prompt: 'hang please',
      model: 'work/opus',
      env: { [LOCAL_BASE_URL_ENV]: origin },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text.delta') void run.interrupt();
    }

    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'interrupted' });
  });
});

describe('what a run refuses up front', () => {
  const adapter = createArtemisAdapter();
  const base = {
    runId: 'run-3' as RunId,
    providerId: 'artemis',
    profileId: 'profile-1',
    cwd: process.cwd(),
    prompt: 'x',
    model: 'work/opus',
    env: {},
  };

  it('a run with no model route', async () => {
    await expect(
      adapter.createRun({ ...base, model: undefined } as unknown as ResolvedRunInput),
    ).rejects.toMatchObject({ agentError: { code: 'invalid_request' } });
  });

  it('a permission mode, which the server would silently not honour', async () => {
    await expect(
      adapter.createRun({ ...base, permissionMode: 'default' } as unknown as ResolvedRunInput),
    ).rejects.toMatchObject({ agentError: { code: 'invalid_request' } });
  });

  it('fork and rewind, which the wire cannot carry yet', async () => {
    await expect(
      adapter.createRun({
        ...base,
        resumeSessionId: 'sess-abc',
        forkSession: true,
      } as unknown as ResolvedRunInput),
    ).rejects.toMatchObject({ agentError: { code: 'invalid_request' } });
  });

  it('a message mid-turn, plainly rather than by queueing it', async () => {
    const { origin } = await serve((_request, response) => happyStream(response));
    const run = await adapter.createRun({
      ...base,
      env: { [LOCAL_BASE_URL_ENV]: origin },
    } as ResolvedRunInput);
    await expect(run.send('more')).rejects.toMatchObject({
      agentError: { code: 'invalid_request' },
    });
    for await (const event of run.events) void event; // drain to completion
  });
});

describe('the probe and the catalogue', () => {
  it('probes the connection endpoint at the profile’s address, with the token', async () => {
    const { origin, seen } = await serve((request, response) => {
      expect(request.url).toBe('/api/v0/connection');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'conn-1',
          label: 'laptop',
          workspace: { kind: 'directory', path: '/srv/work' },
          canRunTurns: true,
        }),
      );
    });

    const adapter = createArtemisAdapter();
    const availability = await adapter.checkAvailability?.({
      env: { [LOCAL_BASE_URL_ENV]: `${origin}/`, [LOCAL_API_KEY_ENV]: 'tok_123' },
    });

    expect(availability?.available).toBe(true);
    expect(seen[0]?.url).toBe('/api/v0/connection');
    expect(seen[0]?.authorization).toBe('Bearer tok_123');
  });

  it('reports a refusal as a token problem and an absence as an address one', async () => {
    const refused = await serve((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'no', type: 'auth' } }));
    });

    const adapter = createArtemisAdapter();

    const refusal = await adapter.checkAvailability?.({
      env: { [LOCAL_BASE_URL_ENV]: refused.origin },
    });
    expect(refusal?.available).toBe(false);
    expect(refusal?.unavailableReason).toContain('connection token');

    const absence = await adapter.checkAvailability?.({
      env: { [LOCAL_BASE_URL_ENV]: 'http://127.0.0.1:9' },
    });
    expect(absence?.available).toBe(false);
    expect(absence?.unavailableReason).toContain('http://127.0.0.1:9');
  });

  it('lists the routes the connection may run, live', async () => {
    const { origin, seen } = await serve((request, response) => {
      expect(request.url).toBe('/api/v0/models');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'artemis.models',
          models: [
            {
              route: 'work/opus',
              id: 'opus',
              label: 'Opus 5',
              note: 'The safe default.',
              profileId: 'p1',
              profileSlug: 'work',
              profileLabel: 'Work',
              providerId: 'claude',
              thinkingLevels: [],
              adaptiveThinking: true,
              fastMode: true,
              ultracode: false,
              tier: 2,
            },
          ],
        }),
      );
    });

    const adapter = createArtemisAdapter();
    const catalogue = await adapter.listModels?.({
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok_123' },
      cwd: process.cwd(),
    });

    expect(catalogue?.live).toBe(true);
    expect(catalogue?.models[0]).toMatchObject({
      id: 'work/opus',
      label: 'Opus 5',
      note: 'Work — The safe default.',
      tier: 2,
      supportsFastMode: true,
      supportsUltracode: false,
      adaptiveThinking: true,
    });
    expect(seen[0]?.authorization).toBe('Bearer tok_123');
  });

  it('answers not-confirmed rather than throwing when the server is away', async () => {
    const adapter = createArtemisAdapter();
    const catalogue = await adapter.listModels?.({
      env: { [LOCAL_BASE_URL_ENV]: 'http://127.0.0.1:9' },
      cwd: process.cwd(),
    });
    expect(catalogue).toEqual({ models: [], live: false });
  });
});
