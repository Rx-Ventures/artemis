import { describe, expect, it } from 'vitest';

import type { AgentEvent, RunHandle, ServerProfile } from '@rx-artemis/protocol';
import {
  createSseDecoder,
  NO_CAPABILITIES,
  REMOTE_EVENTS_PATH,
  REMOTE_LIVE_WORK_PATH,
  REMOTE_RUNS_PATH,
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

  it('reports the host ledger when there is one', async () => {
    const reply = await ask(REMOTE_LIVE_WORK_PATH, {
      runs: {
        ...observableRuns,
        liveWork: async () => ({ sessionIds: ['s1'], working: ['s1'], delegated: [] }),
      },
    });
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect((reply.body as { working: string[] }).working).toEqual(['s1']);
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
