import { describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  RunHandle,
  RunInput,
  ServerConnection,
  ServerProfile,
} from '@rx-artemis/protocol';
import {
  createSseDecoder,
  NO_CAPABILITIES,
  REMOTE_EVENTS_PATH,
  REMOTE_LIVE_WORK_PATH,
  REMOTE_RUNS_PATH,
  REMOTE_STREAM_CLOSED,
  REMOTE_STREAM_GAP,
  REMOTE_STREAM_HELLO,
  type SseMessage,
} from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { createPushFeed } from '../feed.js';
import { handleServerRequest, isStreamReply, type ServerContext } from '../http.js';
import type { RunSource } from '../completions.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const NARROW_TOKEN = 'narrow-token-abcdefghijklmnopqrstuvw';

const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

/** Allowed one account only, so what it must not see is testable. */
const NARROW = {
  id: 'conn-2',
  label: 'Narrow',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: NARROW_TOKEN,
  createdAt: 0,
  allow: [{ profileId: 'prof-a' as ServerProfile['id'] }],
};

const catalogue: Catalogue = {
  read: async () => [],
  invalidate: () => undefined,
};

function runHandle(runId: string, profileId: string): RunHandle {
  return {
    runId,
    providerId: 'claude',
    profileId,
    cwd: '/w',
    status: 'running',
    capabilities: NO_CAPABILITIES,
    startedAt: 0,
  };
}

function agentEvent(runId: string, seq: number): AgentEvent {
  return { type: 'text.delta', runId, seq, ts: 0, messageId: 'm1', blockIndex: 0, text: 'x' };
}

const RUNS: readonly RunHandle[] = [runHandle('run-a', 'prof-a'), runHandle('run-b', 'prof-b')];

/** An observe-capable source over two runs on two accounts. */
const observableRuns: RunSource = {
  startRun: () => Promise.reject(new Error('not under test')),
  subscribe: () => () => undefined,
  interrupt: async () => undefined,
  respondToPermission: async () => undefined,
  disposeRun: async () => undefined,
  listRuns: async () => RUNS,
  getRun: async (runId) => RUNS.find((run) => run.runId === runId),
  runEvents: async ({ runId, afterSeq }) => {
    const after = afterSeq ?? -1;
    const events = [agentEvent(runId, 5), agentEvent(runId, 6)].filter((e) => e.seq > after);
    const first = events[0];
    return { events, truncated: first !== undefined && first.seq > after + 1 };
  },
};

function ask(
  url: string,
  overrides: Partial<ServerContext> = {},
  headers: Record<string, string | undefined> = {},
  method = 'GET',
): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    {
      method,
      url,
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}`, ...headers },
    },
    {
      connections: [CONNECTION, NARROW],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
      runs: observableRuns,
      ...overrides,
    },
  );
}

const asNarrow = { authorization: `Bearer ${NARROW_TOKEN}` };

describe('GET /api/v0/runs', () => {
  it('lists live runs', async () => {
    const reply = await ask(REMOTE_RUNS_PATH);
    expect(reply.status).toBe(200);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.body).toMatchObject({ object: 'artemis.runs' });
    expect((reply.body as { runs: RunHandle[] }).runs.map((run) => run.runId)).toEqual([
      'run-a',
      'run-b',
    ]);
  });

  it('narrows the list to the accounts a connection may see', async () => {
    const reply = await ask(REMOTE_RUNS_PATH, {}, asNarrow);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect((reply.body as { runs: RunHandle[] }).runs.map((run) => run.runId)).toEqual(['run-a']);
  });

  it('answers 501 when the host exposes no runs', async () => {
    const { listRuns: _omit, ...rest } = observableRuns;
    const reply = await ask(REMOTE_RUNS_PATH, { runs: rest as RunSource });
    expect(reply.status).toBe(501);
  });

  it('still authenticates', async () => {
    const reply = await ask(REMOTE_RUNS_PATH, {}, { authorization: undefined });
    expect(reply.status).toBe(401);
  });
});

describe('GET /api/v0/runs/{id}/events', () => {
  it('replays a run, with the honest truncation flag', async () => {
    const reply = await ask('/api/v0/runs/run-a/events?after=4');
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.status).toBe(200);
    const body = reply.body as { events: AgentEvent[]; truncated: boolean };
    expect(body.events.map((event) => event.seq)).toEqual([5, 6]);
    expect(body.truncated).toBe(false);
  });

  it('reports truncation when the buffer starts past the ask', async () => {
    const reply = await ask('/api/v0/runs/run-a/events?after=1');
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect((reply.body as { truncated: boolean }).truncated).toBe(true);
  });

  it('gives one 404 for an unknown run and a run outside the allowance', async () => {
    const absent = await ask('/api/v0/runs/run-x/events');
    expect(absent.status).toBe(404);
    // `run-b` exists and bills `prof-b`, which the narrow token cannot see —
    // the refusal must be indistinguishable from "no such run".
    const invisible = await ask('/api/v0/runs/run-b/events', {}, asNarrow);
    expect(invisible.status).toBe(404);
    if (isStreamReply(absent) || isStreamReply(invisible)) throw new Error('expected bodies');
    expect(invisible.body).toEqual(absent.body);
  });

  it('refuses a resume point that is not a number', async () => {
    const reply = await ask('/api/v0/runs/run-a/events?after=abc');
    expect(reply.status).toBe(400);
  });
});

describe('GET /api/v0/runs/live-work', () => {
  it('degrades to empty sets on a host with no background-work ledger', async () => {
    const reply = await ask(REMOTE_LIVE_WORK_PATH);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.body).toEqual({
      object: 'artemis.live-work',
      sessionIds: [],
      working: [],
      delegated: [],
    });
  });

  /*
   * A ledger that owns `s1` and nothing else, so "may this connection see this
   * session" has a true answer and a false one.
   */
  function ledgerOwning(...sessionIds: readonly string[]): ServerContext['ledger'] {
    return {
      load: async () => undefined,
      record: () => undefined,
      has: (id) => sessionIds.includes(id),
      isProgramSession: () => false,
      get: () => undefined,
      listFor: () => [],
      mayAccess: (_scope, id) => sessionIds.includes(id),
      size: () => sessionIds.length,
      flush: async () => undefined,
    } as ServerContext['ledger'];
  }

  const busy = {
    ...observableRuns,
    liveWork: async () => ({
      sessionIds: ['s1', 's2'],
      working: ['s1', 's2'],
      delegated: [
        { sessionId: 's1', tasks: [{ id: 't1', description: 'mine' }] },
        { sessionId: 's2', tasks: [{ id: 't2', description: 'somebody else’s' }] },
      ],
    }),
  } as RunSource;

  it('reports the sessions this connection may see', async () => {
    const reply = await ask(REMOTE_LIVE_WORK_PATH, {
      runs: busy,
      ledger: ledgerOwning('s1', 's2'),
    });
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect((reply.body as { working: string[] }).working).toEqual(['s1', 's2']);
  });

  /*
   * The leak this route had. A session id carries no account, so the allowance
   * cannot filter it and the first version of the route filtered by nothing —
   * handing every token every live session id on the machine, plus every
   * delegated task's provider-authored description.
   */
  it('hides sessions outside the connection’s ledger scope', async () => {
    const reply = await ask(REMOTE_LIVE_WORK_PATH, {
      runs: busy,
      ledger: ledgerOwning('s1'),
    });
    if (isStreamReply(reply)) throw new Error('expected a body');
    const body = reply.body as {
      sessionIds: string[];
      working: string[];
      delegated: { sessionId: string }[];
    };
    expect(body.sessionIds).toEqual(['s1']);
    expect(body.working).toEqual(['s1']);
    expect(body.delegated.map((entry) => entry.sessionId)).toEqual(['s1']);
    // And the task text of the conversation it may not see is nowhere in the
    // reply — that is the part that is provider content, not just an id.
    expect(JSON.stringify(body)).not.toContain('somebody');
  });

  it('answers empty rather than everything when it cannot scope', async () => {
    // No ledger means no authority to filter by. Under-complete is safe here —
    // the response is "keep these", never "the rest are finished".
    const reply = await ask(REMOTE_LIVE_WORK_PATH, { runs: busy });
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.body).toEqual({
      object: 'artemis.live-work',
      sessionIds: [],
      working: [],
      delegated: [],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Control                                                                    */
/* -------------------------------------------------------------------------- */

describe('the control routes', () => {
  /** A source that records every control call it receives. */
  function controllable(): {
    source: RunSource;
    calls: { started: RunInput[]; decisions: unknown[]; sent: string[]; interrupted: string[] };
  } {
    const calls = {
      started: [] as RunInput[],
      decisions: [] as unknown[],
      sent: [] as string[],
      interrupted: [] as string[],
    };
    const source: RunSource = {
      ...observableRuns,
      startUserRun: async (input) => {
        calls.started.push(input);
        return runHandle('run-new', String(input.profileId));
      },
      send: async (_runId, text) => {
        calls.sent.push(text);
        return { deliveredImmediately: true };
      },
      interruptRun: async (runId) => {
        calls.interrupted.push(runId);
        return { stillQueued: ['q1'] };
      },
      respondToPermission: async (_runId, _requestId, decision) => {
        calls.decisions.push(decision);
      },
      stopTask: async () => undefined,
    };
    return { source, calls };
  }

  it('starts a run with the user’s own settings, inside the pin', async () => {
    const { source, calls } = controllable();
    const input = {
      providerId: 'claude',
      profileId: 'prof-a',
      cwd: '/w/sub',
      prompt: 'do the thing',
      permissionMode: 'default',
      effort: 'high',
    };
    const reply = await ask(REMOTE_RUNS_PATH, { runs: source }, {}, 'POST');
    // No body: refused before anything is spent.
    expect(reply.status).toBe(400);

    const started = await handleServerRequest(
      {
        method: 'POST',
        url: REMOTE_RUNS_PATH,
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: { input },
      },
      { connections: [CONNECTION, NARROW], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(started.status).toBe(200);
    // The settings travelled whole — permission mode and effort included —
    // and the cwd stayed the caller's because it sits inside the pin.
    expect(calls.started[0]).toMatchObject({
      prompt: 'do the thing',
      permissionMode: 'default',
      effort: 'high',
      cwd: '/w/sub',
    });
  });

  it('refuses a working directory outside the connection’s pin', async () => {
    const { source, calls } = controllable();
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: REMOTE_RUNS_PATH,
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: {
          input: { providerId: 'claude', profileId: 'prof-a', cwd: '/etc', prompt: 'x' },
        },
      },
      { connections: [CONNECTION], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(reply.status).toBe(403);
    expect(calls.started).toHaveLength(0);
  });

  it('refuses an account outside the allowance as unknown, before spending', async () => {
    const { source, calls } = controllable();
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: REMOTE_RUNS_PATH,
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${NARROW_TOKEN}` },
        body: {
          input: { providerId: 'claude', profileId: 'prof-b', cwd: '/w', prompt: 'x' },
        },
      },
      { connections: [CONNECTION, NARROW], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(reply.status).toBe(404);
    expect(calls.started).toHaveLength(0);
  });

  it('carries a remote permission answer — allow included — to the seam', async () => {
    const { source, calls } = controllable();
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: '/api/v0/runs/run-a/respond-permission',
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: { requestId: 'perm-1', decision: { behavior: 'allow' } },
      },
      { connections: [CONNECTION], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(reply.status).toBe(200);
    expect(calls.decisions).toEqual([{ behavior: 'allow' }]);
  });

  it('refuses a decision that is neither allow nor deny', async () => {
    const { source, calls } = controllable();
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: '/api/v0/runs/run-a/respond-permission',
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: { requestId: 'perm-1', decision: { behavior: 'shrug' } },
      },
      { connections: [CONNECTION], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(reply.status).toBe(400);
    expect(calls.decisions).toHaveLength(0);
  });

  it('keeps another account’s runs unsteerable and unprobeable', async () => {
    const { source, calls } = controllable();
    // `run-b` exists and bills prof-b; the narrow token gets the same 404 an
    // absent run would.
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: '/api/v0/runs/run-b/interrupt',
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${NARROW_TOKEN}` },
        body: {},
      },
      { connections: [CONNECTION, NARROW], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(reply.status).toBe(404);
    expect(calls.interrupted).toHaveLength(0);
  });

  it('interrupts with the stillQueued detail', async () => {
    const { source } = controllable();
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: '/api/v0/runs/run-a/interrupt',
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: {},
      },
      { connections: [CONNECTION], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(reply.status).toBe(200);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.body).toMatchObject({ stillQueued: ['q1'] });
  });

  it('steers mid-run over the wire', async () => {
    const { source, calls } = controllable();
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: '/api/v0/runs/run-a/send',
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: { text: 'also check the tests' },
      },
      { connections: [CONNECTION], version: '1', catalogue, startedAt: 0, runs: source },
    );
    expect(reply.status).toBe(200);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.body).toMatchObject({ deliveredImmediately: true });
    expect(calls.sent).toEqual(['also check the tests']);
  });

  it('answers 501 on control verbs the host does not expose', async () => {
    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: '/api/v0/runs/run-a/send',
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: { text: 'x' },
      },
      // `observableRuns` has the observation surface and no control verbs.
      { connections: [CONNECTION], version: '1', catalogue, startedAt: 0, runs: observableRuns },
    );
    expect(reply.status).toBe(501);
  });

  it('tracks a started run in the guard, and untracks on dispose', async () => {
    const { source } = controllable();
    const guard = {
      attach: vi.fn(),
      detach: vi.fn(),
      trackRun: vi.fn(),
      untrackRun: vi.fn(),
      dispose: vi.fn(),
    };
    const context = {
      connections: [CONNECTION],
      version: '1',
      catalogue,
      startedAt: 0,
      runs: source,
      guard,
    };
    await handleServerRequest(
      {
        method: 'POST',
        url: REMOTE_RUNS_PATH,
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: { input: { providerId: 'claude', profileId: 'prof-a', cwd: '/w', prompt: 'x' } },
      },
      context,
    );
    expect(guard.trackRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-new', connectionId: 'conn-1', workspaceKey: 'dir:/w' }),
    );

    await handleServerRequest(
      {
        method: 'POST',
        url: '/api/v0/runs/run-a/dispose',
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: {},
      },
      context,
    );
    expect(guard.untrackRun).toHaveBeenCalledWith('run-a');
  });
});

/* -------------------------------------------------------------------------- */
/* The event stream                                                           */
/* -------------------------------------------------------------------------- */

/** Pull frames one at a time, so a test can interleave publishes. */
function reader(stream: AsyncIterable<string>): {
  next(): Promise<string>;
  close(): Promise<void>;
} {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      if (result.done === true) throw new Error('the stream ended early');
      return result.value;
    },
    async close() {
      await iterator.return?.(undefined);
    },
  };
}

function decode(frame: string): SseMessage[] {
  return createSseDecoder().feed(frame);
}

/** Pull frames until one carries `event`, or give up rather than hang forever. */
async function waitForEvent(
  stream: { next(): Promise<string> },
  event: string,
  attempts = 40,
): Promise<SseMessage> {
  for (let i = 0; i < attempts; i += 1) {
    for (const message of decode(await stream.next())) {
      if (message.event === event) return message;
    }
  }
  throw new Error(`never saw ${event}`);
}

async function openStream(
  overrides: Partial<ServerContext> = {},
  headers: Record<string, string | undefined> = {},
  url: string = REMOTE_EVENTS_PATH,
): Promise<{ next(): Promise<string>; close(): Promise<void> }> {
  const reply = await ask(url, { remoteStream: { heartbeatMs: 60_000 }, ...overrides }, headers);
  if (!isStreamReply(reply)) {
    throw new Error(`expected a stream, got ${String(reply.status)}: ${JSON.stringify(reply.body)}`);
  }
  expect(reply.headers['content-type']).toContain('text/event-stream');
  // A stream a proxy buffers is not a stream: both dialects must be present.
  expect(reply.headers['cache-control']).toContain('no-transform');
  expect(reply.headers['x-accel-buffering']).toBe('no');
  return reader(reply.stream);
}

/*
 * A stream is not a request, and the auth gate is a request-time check.
 *
 * `deleteConnection` promises revocation takes effect on the next request with
 * no restart, and expiry is checked per request — but a stream opened before
 * either happens is one long-lived request that never re-asks. Left that way it
 * keeps delivering transcripts and PTY bytes to a credential the user has
 * already withdrawn, and holds the guard's attachment so the runs behind it are
 * never interrupted.
 */
describe('a stream whose credential stops being valid', () => {
  const live = (): ServerConnection[] => [
    { ...CONNECTION, expiresAt: Date.now() + 60_000 },
    NARROW as ServerConnection,
  ];

  it('ends itself when the token expires while it is open', async () => {
    const feed = createPushFeed();
    let connections = live();
    const stream = await openStream({
      feed,
      remoteStream: { heartbeatMs: 5, recheckMs: 0 },
      connectionsNow: () => connections,
    });
    expect(decode(await stream.next())[0]?.event).toBe(REMOTE_STREAM_HELLO);

    // The expiry passes under the open stream.
    connections = [{ ...CONNECTION, expiresAt: Date.now() - 1 }, NARROW as ServerConnection];

    const closing = await waitForEvent(stream, REMOTE_STREAM_CLOSED);
    expect(JSON.parse(closing.data ?? '')).toMatchObject({ reason: 'expired' });
    await stream.close();
  });

  it('ends itself when the connection is revoked while it is open', async () => {
    const feed = createPushFeed();
    let connections = live();
    const stream = await openStream({
      feed,
      remoteStream: { heartbeatMs: 5, recheckMs: 0 },
      connectionsNow: () => connections,
    });
    expect(decode(await stream.next())[0]?.event).toBe(REMOTE_STREAM_HELLO);

    connections = [NARROW as ServerConnection];

    const closing = await waitForEvent(stream, REMOTE_STREAM_CLOSED);
    expect(JSON.parse(closing.data ?? '')).toMatchObject({ reason: 'revoked' });
    await stream.close();
  });

  it('detaches the guard on the way out, so the runs behind it are stopped', async () => {
    const feed = createPushFeed();
    const attached: string[] = [];
    const detached: string[] = [];
    let connections = live();
    const stream = await openStream({
      feed,
      remoteStream: { heartbeatMs: 5, recheckMs: 0 },
      connectionsNow: () => connections,
      guard: {
        attach: (id) => attached.push(id),
        detach: (id) => detached.push(id),
        trackRun: () => undefined,
        untrackRun: () => undefined,
        dispose: () => undefined,
      },
    });
    expect(decode(await stream.next())[0]?.event).toBe(REMOTE_STREAM_HELLO);
    expect(attached).toEqual(['conn-1']);

    connections = [NARROW as ServerConnection];
    await waitForEvent(stream, REMOTE_STREAM_CLOSED);
    await stream.close();
    expect(detached).toEqual(['conn-1']);
  });

  it('leaves a stream on a healthy connection alone', async () => {
    const feed = createPushFeed();
    const stream = await openStream({
      feed,
      remoteStream: { heartbeatMs: 5, recheckMs: 0 },
      connectionsNow: live,
    });
    expect(decode(await stream.next())[0]?.event).toBe(REMOTE_STREAM_HELLO);
    // Several ticks' worth of heartbeats, none of them a close.
    for (let i = 0; i < 3; i += 1) {
      const frames = decode(await stream.next());
      for (const frame of frames) expect(frame.event).not.toBe(REMOTE_STREAM_CLOSED);
    }
    await stream.close();
  });
});

describe('GET /api/v0/events', () => {
  it('answers 501 with no feed, as a build without one honestly is', async () => {
    const reply = await ask(REMOTE_EVENTS_PATH);
    expect(reply.status).toBe(501);
  });

  it('opens with a hello naming the head, then follows the live feed', async () => {
    const feed = createPushFeed();
    feed.publish('artemis:push:agent-event', agentEvent('run-a', 0), { profileId: 'prof-a' });
    const stream = await openStream({ feed });

    const [hello] = decode(await stream.next());
    expect(hello?.event).toBe(REMOTE_STREAM_HELLO);
    expect(JSON.parse(hello?.data ?? '')).toMatchObject({ seq: 1, version: '1.1.1' });

    feed.publish('artemis:push:agent-event', agentEvent('run-a', 1), { profileId: 'prof-a' });
    const [live] = decode(await stream.next());
    expect(live?.event).toBe('artemis:push:agent-event');
    expect(live?.id).toBe('2');
    expect(JSON.parse(live?.data ?? '')).toMatchObject({ seq: 1, runId: 'run-a' });

    await stream.close();
  });

  it('replays from Last-Event-ID', async () => {
    const feed = createPushFeed();
    for (let i = 1; i <= 4; i += 1) {
      feed.publish('artemis:push:agent-event', agentEvent('run-a', i), { profileId: 'prof-a' });
    }
    const stream = await openStream({ feed }, { 'last-event-id': '2' });

    const [hello] = decode(await stream.next());
    expect(hello?.event).toBe(REMOTE_STREAM_HELLO);
    const [third] = decode(await stream.next());
    expect(third?.id).toBe('3');
    const [fourth] = decode(await stream.next());
    expect(fourth?.id).toBe('4');
    await stream.close();
  });

  it('reports a gap honestly when retention has dropped what was asked for', async () => {
    const feed = createPushFeed({ retention: 2 });
    for (let i = 1; i <= 5; i += 1) {
      feed.publish('artemis:push:agent-event', agentEvent('run-a', i), { profileId: 'prof-a' });
    }
    const stream = await openStream({ feed }, { 'last-event-id': '1' });

    const [hello] = decode(await stream.next());
    expect(hello?.event).toBe(REMOTE_STREAM_HELLO);
    const [gap] = decode(await stream.next());
    expect(gap?.event).toBe(REMOTE_STREAM_GAP);
    expect(JSON.parse(gap?.data ?? '')).toEqual({ afterSeq: 1, firstSeq: 4 });
    const [fourth] = decode(await stream.next());
    expect(fourth?.id).toBe('4');
    await stream.close();
  });

  it('keeps another account\'s events out of a narrowed stream', async () => {
    const feed = createPushFeed();
    const stream = await openStream({ feed }, asNarrow);
    decode(await stream.next()); // hello

    feed.publish('artemis:push:agent-event', agentEvent('run-b', 0), { profileId: 'prof-b' });
    feed.publish('artemis:push:agent-event', agentEvent('run-a', 0), { profileId: 'prof-a' });
    // The first frame to arrive must be the visible one — the invisible event
    // was dropped, not queued.
    const [frame] = decode(await stream.next());
    expect(frame?.id).toBe('2');
    expect(JSON.parse(frame?.data ?? '')).toMatchObject({ runId: 'run-a' });
    await stream.close();
  });

  it('keeps a quiet stream alive with heartbeat comments', async () => {
    const feed = createPushFeed();
    const stream = await openStream({ feed, remoteStream: { heartbeatMs: 5 } });
    decode(await stream.next()); // hello
    const frame = await stream.next();
    expect(frame.startsWith(':')).toBe(true);
    await stream.close();
  });

  it('refuses a resume point that is not a number', async () => {
    const feed = createPushFeed();
    const reply = await ask(REMOTE_EVENTS_PATH, { feed }, { 'last-event-id': 'x' });
    expect(reply.status).toBe(400);
  });

  it('is what "still here" means: attach on open, detach on close', async () => {
    const feed = createPushFeed();
    const guard = {
      attach: vi.fn(),
      detach: vi.fn(),
      trackRun: vi.fn(),
      untrackRun: vi.fn(),
      dispose: vi.fn(),
    };
    const stream = await openStream({ feed, guard });
    await stream.next(); // The hello proves the generator started.
    expect(guard.attach).toHaveBeenCalledWith('conn-1');
    expect(guard.detach).not.toHaveBeenCalled();
    await stream.close();
    expect(guard.detach).toHaveBeenCalledWith('conn-1');
  });

  it('accepts ?after= for a client that cannot set headers', async () => {
    const feed = createPushFeed();
    feed.publish('artemis:push:agent-event', agentEvent('run-a', 1), { profileId: 'prof-a' });
    feed.publish('artemis:push:agent-event', agentEvent('run-a', 2), { profileId: 'prof-a' });
    const stream = await openStream({ feed }, {}, `${REMOTE_EVENTS_PATH}?after=1`);
    decode(await stream.next()); // hello
    const [frame] = decode(await stream.next());
    expect(frame?.id).toBe('2');
    await stream.close();
  });
});
