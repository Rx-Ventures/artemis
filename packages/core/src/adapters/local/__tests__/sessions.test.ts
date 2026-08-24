/**
 * A local model that remembers the last thing it was told.
 * ============================================================================
 *
 * The defect these pin is not subtle and was invisible from inside the app: an
 * inference server is a pure function of the array it is sent, this adapter
 * sent `[system?, latest user message]`, and so every turn began a fresh
 * conversation with a model the user believed was following one. Asked "what
 * did I just ask you?", it guessed — plausibly, which is what made it hard to
 * notice.
 *
 * So the assertion that matters is about the *request body*: what came back is
 * the model's business, and what went out is Artemis's. These drive the adapter
 * against a real local server, for the reason `endpoint.test.ts` gives — a
 * stubbed `fetch` would be asserting that the test's idea of the request
 * matches the test's idea of the request.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent, ProfileId, RunId, SessionId } from '@rx-artemis/protocol';

import { createLocalAdapter, LLAMA_CPP, BASE_URL_ENV } from '../adapter.js';
import { LOCAL_PROFILE_DIR_ENV } from '../sessionStore.js';
import type { ResolvedRunInput, Run } from '../../types.js';

const PROFILE = 'profile-1' as ProfileId;

const servers: Server[] = [];
let profileDir: string;
let cwd: string;

/** A message as it appears in a recorded request body. */
interface WireMessage {
  readonly role: string;
  readonly content: string;
  readonly tool_call_id?: string;
}

/**
 * A server that answers completions with a scripted reply, recording what it
 * was sent. One reply per request, then a plain acknowledgement.
 */
async function serveCompletions(
  ...replies: string[]
): Promise<{ origin: string; bodies: { messages: WireMessage[] }[] }> {
  const bodies: { messages: WireMessage[] }[] = [];
  let answered = 0;

  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: WireMessage[] });
      const text = replies[answered++] ?? 'ok';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, bodies };
}

function input(origin: string, overrides: Partial<ResolvedRunInput> = {}): ResolvedRunInput {
  return {
    providerId: 'llamacpp',
    profileId: PROFILE,
    cwd,
    prompt: 'hello',
    runId: `run-${String(Math.random()).slice(2)}` as RunId,
    env: { [BASE_URL_ENV]: origin, [LOCAL_PROFILE_DIR_ENV]: profileDir },
    // Nothing this adapter would offer a tool for, so a turn is one completion.
    permissionMode: 'plan',
    ...overrides,
  } as ResolvedRunInput;
}

/** Run one turn to its end, returning everything it emitted. */
async function drain(run: Run): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

beforeEach(async () => {
  profileDir = await realpath(await mkdtemp(path.join(tmpdir(), 'artemis-local-sessions-')));
  cwd = profileDir;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await rm(profileDir, { recursive: true, force: true });
});

describe('what goes out on the wire', () => {
  it('sends only the new message when the conversation is new', async () => {
    const { origin, bodies } = await serveCompletions('hi there');
    const adapter = createLocalAdapter(LLAMA_CPP);

    await drain(await adapter.createRun(input(origin)));

    expect(bodies[0]?.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('replays the whole conversation when the run resumes one', async () => {
    // The reported defect, stated as a request: turn two must carry turn one.
    const { origin, bodies } = await serveCompletions('the sky is blue', 'you asked about the sky');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const first = await adapter.createRun(input(origin, { prompt: 'why is the sky blue?' }));
    await drain(first);

    await drain(
      await adapter.createRun(
        input(origin, {
          prompt: 'what did I just ask you?',
          resumeSessionId: first.sessionId as SessionId,
        }),
      ),
    );

    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: 'why is the sky blue?' },
      { role: 'assistant', content: 'the sky is blue' },
      { role: 'user', content: 'what did I just ask you?' },
    ]);
  });

  it('keeps the system prompt first and the new message last', async () => {
    // Order is not cosmetic: a system message the server sees after the
    // conversation is not a system prompt, and a question buried mid-array
    // gets answered as history.
    const { origin, bodies } = await serveCompletions('one', 'two');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const system = { kind: 'append' as const, text: 'Be terse.' };
    const first = await adapter.createRun(input(origin, { systemPrompt: system }));
    await drain(first);

    await drain(
      await adapter.createRun(
        input(origin, {
          prompt: 'again',
          systemPrompt: system,
          resumeSessionId: first.sessionId as SessionId,
        }),
      ),
    );

    expect(bodies[1]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(bodies[1]?.messages.at(-1)).toEqual({ role: 'user', content: 'again' });
  });
});

describe('the session a turn belongs to', () => {
  it('reports an id of its own, and repeats it when resumed', async () => {
    const { origin } = await serveCompletions('hi', 'hi again');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const first = await adapter.createRun(input(origin));
    const opened = (await drain(first))[0] as { type: string; sessionId: SessionId };

    expect(opened.type).toBe('session.started');
    expect(opened.sessionId).toBe(first.sessionId);
    // The run id used to stand in here, which made every turn a new
    // conversation as far as anything downstream could tell.
    expect(opened.sessionId).not.toBe(first.runId);

    const second = await adapter.createRun(
      input(origin, { resumeSessionId: first.sessionId as SessionId }),
    );
    const resumed = (await drain(second))[0] as { sessionId: SessionId; resumedFrom?: SessionId };

    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.resumedFrom).toBe(first.sessionId);
  });
});

describe('history, end to end', () => {
  it('lists a conversation, reopens it, and carries it into the next turn', async () => {
    const { origin, bodies } = await serveCompletions('a fine question', 'as I said');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const first = await adapter.createRun(input(origin, { prompt: 'why is the sky blue?' }));
    await drain(first);
    const sessionId = first.sessionId as SessionId;
    const env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };

    const listed = await adapter.listSessions?.({ profileId: PROFILE, cwd, env });
    expect(listed?.sessions).toHaveLength(1);
    expect(listed?.sessions[0]).toMatchObject({
      id: sessionId,
      cwd,
      providerId: 'llamacpp',
      firstPrompt: 'why is the sky blue?',
      messageCount: 2,
    });

    // The same conversation, in the shape the transcript renders.
    const transcript = await adapter.getSessionMessages?.({
      profileId: PROFILE,
      sessionId,
      cwd,
      env,
      runId: 'run-reader' as RunId,
    });
    expect(
      transcript?.events.map((event) => [
        (event as { role?: string }).role,
        (event as { text?: string }).text,
      ]),
    ).toEqual([
      ['user', 'why is the sky blue?'],
      ['assistant', 'a fine question'],
    ]);
    expect(transcript?.events.every((event) => event.runId === 'run-reader')).toBe(true);

    // And the same conversation, in the shape the server is sent.
    await drain(
      await adapter.createRun(input(origin, { prompt: 'again?', resumeSessionId: sessionId })),
    );
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: 'why is the sky blue?' },
      { role: 'assistant', content: 'a fine question' },
      { role: 'user', content: 'again?' },
    ]);
  });

  it('counts the seam between what came before and what this run adds', async () => {
    // `RunRegistry` takes this number in the moment between resolving a run and
    // spawning it, and it cannot be recovered later — one line further on, the
    // run's own message is in the file.
    const { origin } = await serveCompletions('first answer', 'second answer');
    const adapter = createLocalAdapter(LLAMA_CPP);
    const env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };

    const first = await adapter.createRun(input(origin));
    await drain(first);
    const sessionId = first.sessionId as SessionId;

    const boundary = await adapter.countSessionMessages?.({ sessionId, cwd, env });
    expect(boundary).toBe(2);

    await drain(await adapter.createRun(input(origin, { resumeSessionId: sessionId })));

    // The seam still names the same two messages; the turn after it added its
    // own, which is what makes the count worth taking before the run.
    expect(await adapter.countSessionMessages?.({ sessionId, cwd, env })).toBe(4);
    const before = await adapter.getSessionMessages?.({
      profileId: PROFILE,
      sessionId,
      cwd,
      env,
      runId: 'run-reader' as RunId,
      limit: boundary,
    });
    expect(before?.events.map((event) => (event as { text?: string }).text)).toEqual([
      'hello',
      'first answer',
    ]);
    expect(before?.hasMore).toBe(true);
  });

  it('answers zero for a conversation it has never seen', async () => {
    // Honest here rather than a guess: this adapter owns the store, so no file
    // means nothing was ever written.
    const adapter = createLocalAdapter(LLAMA_CPP);

    await expect(
      adapter.countSessionMessages?.({
        sessionId: 'nope' as SessionId,
        cwd,
        env: { [LOCAL_PROFILE_DIR_ENV]: profileDir },
      }),
    ).resolves.toBe(0);
  });
});

describe('the capability flags and the methods behind them', () => {
  it('claims exactly what it implements', () => {
    // The pairing is the contract: the UI hides history on the flag, not on an
    // empty result, so a flag without a method is a pane that throws and a
    // method without a flag is a feature nobody can reach.
    const adapter = createLocalAdapter(LLAMA_CPP);

    expect(adapter.capabilities.listSessions).toBe(true);
    expect(typeof adapter.listSessions).toBe('function');
    expect(typeof adapter.listAllSessions).toBe('function');
    expect(typeof adapter.getSessionMessages).toBe('function');
    expect(adapter.capabilities.renameSession).toBe(true);
    expect(typeof adapter.setSessionTitle).toBe('function');
    expect(adapter.capabilities.deleteSession).toBe(true);
    expect(typeof adapter.deleteSession).toBe('function');
    expect(adapter.capabilities.tagSession).toBe(true);
    expect(typeof adapter.tagSession).toBe('function');

    // Still ours to write, and still false: the store is append-only and has no
    // message identity to point a rewind at.
    expect(adapter.capabilities.resumeSession).toBe(true);
    expect(adapter.capabilities.rewind).toBe(false);
    expect(adapter.capabilities.forkSession).toBe(false);
    // Unchanged by any of this — the composer is still disabled mid-turn.
    expect(adapter.capabilities.midRunSteering).toBe(false);
  });

  it('refuses a fork or a rewind rather than quietly continuing', async () => {
    const { origin } = await serveCompletions('hi');
    const adapter = createLocalAdapter(LLAMA_CPP);

    await expect(
      adapter.createRun(
        input(origin, { resumeSessionId: 'session-x' as SessionId, forkSession: true }),
      ),
    ).rejects.toThrow(/forked or rewound/);
  });

  it('renames and destroys a stored conversation', async () => {
    const { origin } = await serveCompletions('hi');
    const adapter = createLocalAdapter(LLAMA_CPP);
    const env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };

    const run = await adapter.createRun(input(origin));
    await drain(run);
    const sessionId = run.sessionId as SessionId;

    await adapter.setSessionTitle?.({ sessionId, title: 'Sky questions', cwd, env });
    expect((await adapter.listSessions?.({ profileId: PROFILE, cwd, env }))?.sessions[0]).toMatchObject(
      { title: 'Sky questions', titleIsCustom: true },
    );

    expect(await adapter.deleteSession?.({ sessionId, cwd, env })).toBe(true);
    expect((await adapter.listSessions?.({ profileId: PROFILE, cwd, env }))?.sessions).toEqual([]);
  });
});
