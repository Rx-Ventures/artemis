/**
 * @vitest-environment jsdom
 *
 * The remote bridge, against a scripted server.
 *
 * What the mock bridge proves for the interface — implementable without
 * Electron — this suite proves for the wire: every observation call maps onto
 * the routes and back into the renderer's own shapes, the token travels in
 * the Authorization header and never in a URL, the event stream reconnects
 * carrying its resume cursor, and everything that cannot cross the wire
 * answers with a sentence rather than a hang or a silent no-op.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, ServerProfile } from '@rx-artemis/protocol';
import {
  NO_CAPABILITIES,
  parseRemoteResourcePath,
  REMOTE_STREAM_HELLO,
  REMOTE_TERMINALS_PATH,
  remoteTerminalPath,
  sseMessage,
} from '@rx-artemis/protocol';

import { createRemoteBridge } from './remoteBridge';
import type { RemoteBridgeConfig } from './remoteConfig';

const CONFIG: RemoteBridgeConfig = {
  origin: 'http://kronos:6472',
  token: 'tok-abcdefghijklmnop',
  label: 'Kronos',
  active: true,
};

const PROFILES: readonly ServerProfile[] = [
  {
    id: 'prof-a' as ServerProfile['id'],
    slug: 'work-max',
    label: 'Work Max',
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: { ...NO_CAPABILITIES, interactivePermissions: true },
    models: [
      {
        route: 'work-max/opus',
        id: 'opus',
        label: 'Opus 5',
        note: 'The big one.',
        profileId: 'prof-a' as ServerProfile['id'],
        profileSlug: 'work-max',
        profileLabel: 'Work Max',
        providerId: 'claude',
        thinkingLevels: [{ id: 'high', label: 'High', note: 'Deep.' }],
        adaptiveThinking: false,
        fastMode: true,
        ultracode: false,
      },
    ],
  },
];

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A body stream the test scripts: push frames, then end (or hold open). */
function scriptedBody(frames: readonly string[], holdOpen = false): {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
} {
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index < frames.length) {
          const value = new TextEncoder().encode(frames[index]);
          index += 1;
          return { done: false, value };
        }
        if (holdOpen) return new Promise(() => undefined); // never settles
        return { done: true };
      },
    }),
  };
}

function jsonResponse(status: number, body: unknown): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => body,
  };
}

let requests: RecordedRequest[];
/** Per-path scripted replies; the events path yields streams in order. */
let replies: Map<string, unknown[]>;
/** Ends each test's stream pumps, so they cannot eat a later test's script. */
let lifetime: AbortController;

function bridgeUnderTest(local: Parameters<typeof createRemoteBridge>[1] = null) {
  return createRemoteBridge(CONFIG, local, { signal: lifetime.signal });
}

function install(fetchImpl?: typeof fetch): void {
  requests = [];
  replies = new Map();
  vi.stubGlobal(
    'fetch',
    fetchImpl ??
      (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const path = new URL(url).pathname;
        requests.push({
          url,
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        const queue = replies.get(path);
        const reply = queue?.shift();
        if (reply === undefined) {
          // The default stream: a hello, held open. Everything else 404s.
          if (path === '/api/v0/events') {
            return {
              ok: true,
              status: 200,
              body: scriptedBody(
                [sseMessage({ event: REMOTE_STREAM_HELLO, data: '{"seq":0,"version":"t"}' })],
                true,
              ),
            } as unknown as Response;
          }
          return jsonResponse(404, {
            error: { message: 'No route.', type: 'invalid_request_error' },
          }) as Response;
        }
        return reply as Response;
      }),
  );
}

beforeEach(() => {
  lifetime = new AbortController();
  install();
});

afterEach(() => {
  lifetime.abort();
  vi.unstubAllGlobals();
});

/** Wait until a predicate holds, bounded. */
async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('transport', () => {
  it('sends the token as a bearer header, never in the URL', async () => {
    replies.set('/api/v0/profiles', [jsonResponse(200, { profiles: PROFILES })]);
    const bridge = bridgeUnderTest();
    await bridge.profiles.list({});
    const call = requests.find((request) => request.url.includes('/profiles'));
    expect(call?.headers['authorization']).toBe(`Bearer ${CONFIG.token}`);
    for (const request of requests) expect(request.url).not.toContain(CONFIG.token);
  });

  it('turns a server refusal into the server’s own sentence', async () => {
    replies.set('/api/v0/profiles', [
      jsonResponse(401, {
        error: { message: 'Send a connection token.', type: 'authentication_error' },
      }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.profiles.list({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('auth');
      expect(result.error.message).toContain('connection token');
    }
  });

  it('turns an unreachable machine into a retryable transport failure', async () => {
    install(async () => Promise.reject(new Error('ECONNREFUSED')));
    const bridge = bridgeUnderTest();
    const result = await bridge.runs.list({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('transport');
      expect(result.error.retryable).toBe(true);
    }
  });
});

describe('observation', () => {
  it('maps the catalogue into profile metadata and provider descriptors', async () => {
    replies.set('/api/v0/profiles', [jsonResponse(200, { profiles: PROFILES })]);
    const bridge = bridgeUnderTest();

    const profiles = await bridge.profiles.list({});
    expect(profiles.ok).toBe(true);
    if (profiles.ok) {
      expect(profiles.value.profiles).toEqual([
        { id: 'prof-a', label: 'Work Max', providerId: 'claude', configDir: '' },
      ]);
    }

    const providers = await bridge.providers.list({});
    expect(providers.ok).toBe(true);
    if (providers.ok) {
      expect(providers.value.providers).toHaveLength(1);
      const descriptor = providers.value.providers[0];
      expect(descriptor?.id).toBe('claude');
      expect(descriptor?.capabilities.interactivePermissions).toBe(true);
      expect(descriptor?.effortLevels).toEqual([{ id: 'high', label: 'High', note: 'Deep.' }]);
    }

    const models = await bridge.providers.models({ providerId: 'claude', profileId: 'prof-a' });
    expect(models.ok).toBe(true);
    if (models.ok) {
      expect(models.value.live).toBe(true);
      expect(models.value.models[0]).toMatchObject({
        id: 'opus',
        supportsFastMode: true,
        effortLevels: ['high'],
      });
    }
  });

  it('lists runs and filters by cwd client-side', async () => {
    const runs = [
      { runId: 'r1', cwd: '/w', profileId: 'prof-a' },
      { runId: 'r2', cwd: '/elsewhere', profileId: 'prof-a' },
    ];
    replies.set('/api/v0/runs', [
      jsonResponse(200, { object: 'artemis.runs', runs }),
      jsonResponse(200, { object: 'artemis.runs', runs }),
    ]);
    const bridge = bridgeUnderTest();
    const all = await bridge.runs.list({});
    if (!all.ok) throw new Error(all.error.message);
    expect(all.value.runs).toHaveLength(2);
    const scoped = await bridge.runs.list({ cwd: '/w' });
    if (!scoped.ok) throw new Error(scoped.error.message);
    expect(scoped.value.runs.map((run) => run.runId)).toEqual(['r1']);
  });

  it('replays run events with the resume point in the query', async () => {
    replies.set('/api/v0/runs/r1/events', [
      jsonResponse(200, { object: 'artemis.run.events', runId: 'r1', events: [], truncated: true }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.runs.events({ runId: 'r1', afterSeq: 41 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.truncated).toBe(true);
    const request = requests.find((entry) => entry.url.includes('/runs/r1/events'));
    expect(request?.url).toContain('after=41');
  });

  it('degrades liveWork to safe empty sets on a server without the route', async () => {
    const bridge = bridgeUnderTest();
    const result = await bridge.runs.liveWork({});
    expect(result).toEqual({
      ok: true,
      value: { sessionIds: [], working: [], delegated: [] },
    });
  });
});

describe('the event stream', () => {
  const frame = (seq: number, event: AgentEvent): string =>
    sseMessage({ id: String(seq), event: 'artemis:push:agent-event', data: JSON.stringify(event) });

  const textDelta = (seq: number): AgentEvent => ({
    type: 'text.delta',
    runId: 'r1',
    seq,
    ts: 0,
    messageId: 'm',
    blockIndex: 0,
    text: 'x',
  });

  it('fans agent events out to subscribers', async () => {
    replies.set('/api/v0/events', [
      {
        ok: true,
        status: 200,
        body: scriptedBody(
          [
            sseMessage({ event: REMOTE_STREAM_HELLO, data: '{"seq":0,"version":"t"}' }),
            frame(1, textDelta(0)),
          ],
          true,
        ),
      },
    ]);
    const bridge = bridgeUnderTest();
    const seen: AgentEvent[] = [];
    bridge.runs.onEvent((event) => seen.push(event));
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ type: 'text.delta', runId: 'r1' });
  });

  it('reconnects carrying the last applied seq as Last-Event-ID', async () => {
    replies.set('/api/v0/events', [
      {
        ok: true,
        status: 200,
        // Two events, then the stream closes — a proxy timeout in miniature.
        body: scriptedBody([
          sseMessage({ event: REMOTE_STREAM_HELLO, data: '{"seq":0,"version":"t"}' }),
          frame(1, textDelta(0)) + frame(2, textDelta(1)),
        ]),
      },
      // The reconnect: held open so the loop parks.
      {
        ok: true,
        status: 200,
        body: scriptedBody(
          [sseMessage({ event: REMOTE_STREAM_HELLO, data: '{"seq":2,"version":"t"}' })],
          true,
        ),
      },
    ]);
    const bridge = bridgeUnderTest();
    const seen: AgentEvent[] = [];
    bridge.runs.onEvent((event) => seen.push(event));

    await until(
      () => requests.filter((request) => request.url.endsWith('/api/v0/events')).length >= 2,
    );
    const streams = requests.filter((request) => request.url.endsWith('/api/v0/events'));
    expect(streams[0]?.headers['last-event-id']).toBeUndefined();
    expect(streams[1]?.headers['last-event-id']).toBe('2');
    expect(seen).toHaveLength(2);
  });
});

describe('control verbs on the wire', () => {
  it('answers a permission request with the decision in the body', async () => {
    replies.set('/api/v0/runs/r1/respond-permission', [
      jsonResponse(200, { object: 'artemis.run.permission', runId: 'r1', requestId: 'p1' }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.runs.respondToPermission({
      runId: 'r1',
      requestId: 'p1',
      decision: { behavior: 'allow' },
    });
    expect(result.ok).toBe(true);
    const request = requests.find((entry) => entry.url.includes('respond-permission'));
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({ requestId: 'p1', decision: { behavior: 'allow' } });
  });

  it('starts a run by shipping the whole RunInput', async () => {
    replies.set('/api/v0/connection', [
      jsonResponse(200, {
        id: 'c1',
        label: 'Kronos',
        workspace: { kind: 'directory', path: '/w' },
        canRunTurns: true,
      }),
    ]);
    replies.set('/api/v0/runs', [
      jsonResponse(200, {
        object: 'artemis.run',
        run: { runId: 'r9', providerId: 'claude', profileId: 'prof-a' },
      }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.runs.start({
      input: {
        providerId: 'claude',
        profileId: 'prof-a',
        cwd: '/w',
        prompt: 'hello',
        permissionMode: 'default',
      },
    });
    expect(result.ok).toBe(true);
    const request = requests.find(
      (entry) => entry.method === 'POST' && entry.url.endsWith('/api/v0/runs'),
    );
    expect(request?.body).toMatchObject({
      input: { prompt: 'hello', permissionMode: 'default', cwd: '/w' },
    });
  });

  /*
   * The cwd rule on the wire: a pane's directory is sent only when it already
   * belongs to the serving machine — the pin, or inside it. Everything else
   * names a path on the wrong computer (a Windows pane's C:\…, a Mac pane's
   * leftover /Users/…) and earns either a 400 or a 403 from a server that
   * never had that directory; omitting it roots the run at the pin instead.
   */
  it('sends a cwd that lives inside the pin', async () => {
    replies.set('/api/v0/connection', [
      jsonResponse(200, {
        id: 'c1',
        label: 'Kronos',
        workspace: { kind: 'directory', path: '/srv/repo' },
        canRunTurns: true,
      }),
    ]);
    replies.set('/api/v0/runs', [
      jsonResponse(200, {
        object: 'artemis.run',
        run: { runId: 'r9', providerId: 'claude', profileId: 'prof-a' },
      }),
    ]);
    const bridge = bridgeUnderTest();
    await bridge.runs.start({
      input: { providerId: 'claude', profileId: 'prof-a', cwd: '/srv/repo/app', prompt: 'hi' },
    });
    const request = requests.find(
      (entry) => entry.method === 'POST' && entry.url.endsWith('/api/v0/runs'),
    );
    expect((request?.body as { input: { cwd?: string } }).input.cwd).toBe('/srv/repo/app');
  });

  it.each([
    ['a Windows pane directory', 'C:\\Users\\d\\app'],
    ['a Mac pane directory outside the pin', '/Users/d/app'],
    ['a sibling sharing the pin’s prefix', '/srv/repo-other'],
  ])('leaves %s off the wire and lets the pin root the run', async (_label, cwd) => {
    replies.set('/api/v0/connection', [
      jsonResponse(200, {
        id: 'c1',
        label: 'Kronos',
        workspace: { kind: 'directory', path: '/srv/repo' },
        canRunTurns: true,
      }),
    ]);
    replies.set('/api/v0/runs', [
      jsonResponse(200, {
        object: 'artemis.run',
        run: { runId: 'r9', providerId: 'claude', profileId: 'prof-a' },
      }),
    ]);
    const bridge = bridgeUnderTest();
    await bridge.runs.start({
      input: { providerId: 'claude', profileId: 'prof-a', cwd, prompt: 'hi' },
    });
    const request = requests.find(
      (entry) => entry.method === 'POST' && entry.url.endsWith('/api/v0/runs'),
    );
    expect('cwd' in (request?.body as { input: object }).input).toBe(false);
  });
});

describe('what cannot cross the wire', () => {
  it('refuses the browser dock with the reason on it', async () => {
    const bridge = bridgeUnderTest();
    const result = await bridge.browser.open({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('does not cross the remote wire');
    // The reload path stays quiet rather than erroring the whole boot.
    expect(await bridge.browser.list({})).toEqual({ ok: true, value: { browsers: [] } });
  });

  it('refuses file reads and previews with the reason on them', async () => {
    const bridge = bridgeUnderTest();
    const read = await bridge.files.read({ path: '/etc/hosts' });
    expect(read.ok).toBe(false);
    const preview = await bridge.preview.open({ path: '/x.html' });
    expect(preview.ok).toBe(false);
    // And the link-scout answers "none reachable", so paths render as text.
    expect(await bridge.files.check({ paths: ['/a'] })).toEqual({
      ok: true,
      value: { reachable: [] },
    });
  });

  it('offers the workspace pin as the one pickable directory', async () => {
    replies.set('/api/v0/connection', [
      jsonResponse(200, {
        id: 'c1',
        label: 'Kronos',
        workspace: { kind: 'directory', path: '/srv/repo' },
        canRunTurns: true,
      }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.workspace.pickDirectory({});
    expect(result).toEqual({ ok: true, value: { path: '/srv/repo' } });
  });

  it('keeps local machinery local by delegating to the injected bridge', () => {
    const localWindow = {} as never;
    const localBridge = {
      version: '2.0.0',
      platform: 'darwin',
      window: localWindow,
      updates: {},
      menu: {},
      prefsFile: {},
      remote: {},
    } as never;
    const bridge = bridgeUnderTest(localBridge);
    expect(bridge.version).toBe('2.0.0+remote');
    expect(bridge.window).toBe(localWindow);
  });
});

/*
 * The serving machine's history, in this window's sidebar.
 *
 * Scoping is the server's job and is tested there; what has to hold here is
 * the mapping — that a wire row becomes a sidebar row without gaining a field
 * nobody measured — and that the two list calls differ only in their filter.
 */
describe('sessions', () => {
  const SESSIONS = [
    {
      id: 'sess-1',
      title: 'The dock rebuild',
      firstPrompt: 'Rebuild the dock',
      updatedAt: 3_000,
      profileSlug: 'work-max',
      profileId: 'prof-a',
      providerId: 'claude',
      cwd: '/srv/repo',
      origin: 'bridge' as const,
    },
    {
      id: 'sess-2',
      title: 'A codex thing',
      updatedAt: 9_000,
      profileSlug: 'personal',
      profileId: 'prof-b',
      providerId: 'codex',
      cwd: '/srv/other',
    },
  ];

  it('lists the serving machine’s conversations, newest first', async () => {
    replies.set('/api/v0/sessions', [
      jsonResponse(200, { object: 'artemis.sessions', sessions: SESSIONS }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.listAll({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions.map((session) => session.id)).toEqual(['sess-2', 'sess-1']);
    expect(result.value.hasMore).toBe(false);
  });

  it('carries the ids a sidebar row is keyed and resumed on', async () => {
    replies.set('/api/v0/sessions', [
      jsonResponse(200, { object: 'artemis.sessions', sessions: SESSIONS }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.listAll({});
    if (!result.ok) throw new Error('expected a listing');
    expect(result.value.sessions[1]).toEqual({
      id: 'sess-1',
      providerId: 'claude',
      profileId: 'prof-a',
      cwd: '/srv/repo',
      title: 'The dock rebuild',
      firstPrompt: 'Rebuild the dock',
      updatedAt: 3_000,
    });
  });

  it('invents nothing the wire did not carry', async () => {
    replies.set('/api/v0/sessions', [
      jsonResponse(200, { object: 'artemis.sessions', sessions: SESSIONS }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.listAll({});
    if (!result.ok) throw new Error('expected a listing');
    const row = result.value.sessions[0] as Record<string, unknown>;
    for (const invented of ['titleIsCustom', 'messageCount', 'sizeBytes', 'gitBranch', 'model']) {
      expect(row).not.toHaveProperty(invented);
    }
  });

  it('narrows the scoped list to one provider, profile and directory', async () => {
    replies.set('/api/v0/sessions', [
      jsonResponse(200, { object: 'artemis.sessions', sessions: SESSIONS }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.list({
      providerId: 'claude' as never,
      profileId: 'prof-a' as never,
      cwd: '/srv/repo',
    });
    if (!result.ok) throw new Error('expected a listing');
    expect(result.value.sessions.map((session) => session.id)).toEqual(['sess-1']);
  });

  it('replays a transcript, restamped with the caller’s run id', async () => {
    const stored: AgentEvent = {
      type: 'text.delta',
      runId: 'server-replay:sess-1',
      seq: 1,
      ts: 0,
      messageId: 'm1',
      blockIndex: 0,
      text: 'hi',
    };
    replies.set('/api/v0/sessions/sess-1/messages', [
      jsonResponse(200, {
        object: 'artemis.session.messages',
        events: [stored],
        hasMore: false,
      }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.messages({
      profileId: 'prof-a' as never,
      sessionId: 'sess-1' as never,
      runId: 'run-local' as never,
    });
    if (!result.ok) throw new Error('expected a replay');
    expect(result.value.events[0]?.runId).toBe('run-local');
    // The id travels in the path, encoded once; the token never does.
    const call = requests.find((request) => request.url.includes('/sessions/'));
    expect(call?.url).not.toContain(CONFIG.token);
  });

  it('shows an empty sidebar rather than an error when the server keeps no history', async () => {
    replies.set('/api/v0/sessions', [
      jsonResponse(501, {
        error: { message: 'This Artemis keeps no session history.', type: 'invalid_request_error' },
      }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.listAll({});
    expect(result).toEqual({ ok: true, value: { sessions: [], hasMore: false } });
  });

  /*
   * `profileId`/`providerId` arrived on the wire with remote sessions, so a
   * newer client can meet a server that sends neither. Both obvious handlings
   * are wrong: casting `undefined` into a branded id puts a lie in the row, and
   * filtering rows that lack it empties the sidebar against a server that is
   * working perfectly.
   */
  it('degrades honestly against a server too old to send the ids', async () => {
    const old = [
      {
        id: 'sess-old',
        title: 'Before the ids existed',
        updatedAt: 5_000,
        profileSlug: 'work-max',
        cwd: '/srv/repo',
      },
    ];
    replies.set('/api/v0/sessions', [
      jsonResponse(200, { object: 'artemis.sessions', sessions: old }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.listAll({});
    if (!result.ok) throw new Error('expected a listing');

    expect(result.value.sessions).toHaveLength(1);
    const row = result.value.sessions[0];
    // Marked unknown rather than attributed to an account it may not belong to.
    expect(row?.profileIsUnknown).toBe(true);
    expect(row?.profileId).toBe('');
    expect(row?.title).toBe('Before the ids existed');
  });

  it('still finds an unattributed row by the directory it does carry', async () => {
    replies.set('/api/v0/sessions', [
      jsonResponse(200, {
        object: 'artemis.sessions',
        sessions: [
          { id: 'sess-old', title: 'Old', updatedAt: 1, profileSlug: 'x', cwd: '/srv/repo' },
        ],
      }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.sessions.list({
      providerId: 'claude' as never,
      profileId: 'prof-a' as never,
      cwd: '/srv/repo',
    });
    if (!result.ok) throw new Error('expected a listing');
    expect(result.value.sessions.map((session) => session.id)).toEqual(['sess-old']);
  });

  it('still refuses what stays on the serving machine', async () => {
    const bridge = bridgeUnderTest();
    for (const result of await Promise.all([
      bridge.sessions.rename({ profileId: 'p' as never, sessionId: 's' as never, title: 'x' }),
      bridge.sessions.subagentMessages({
        profileId: 'p' as never,
        sessionId: 's' as never,
        agentId: 'a',
        runId: 'r' as never,
      }),
    ])) {
      expect(result.ok).toBe(false);
    }
  });
});

/*
 * The terminal wire, from the client side.
 *
 * The dock's terminal surface is the one part of this bridge whose request
 * shapes were written against routes that did not exist yet, and matched by
 * hand afterwards. Field names are the whole contract here — `data`,
 * `cols`/`rows`, `cwd`, and the `artemis:push:terminal-event` channel — and a
 * rename on either side is silent: the server would answer 400 and the dock
 * would show a shell that never echoes. These pin the vocabulary, and they
 * build every path through the *shared* `remoteTerminalPath` helper, so a
 * change to the route grammar has to break here rather than in production.
 */
describe('terminals', () => {
  const INFO = {
    id: 'term-1',
    shell: '/bin/zsh',
    cwd: '/srv/repo',
    startedAt: 1_000,
    exited: false,
  };

  it('opens a shell with the size the pane measured', async () => {
    replies.set(REMOTE_TERMINALS_PATH, [
      jsonResponse(200, { object: 'artemis.terminal', terminal: INFO }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.terminal.start({ cwd: '/srv/repo', cols: 120, rows: 40 });
    expect(result).toEqual({ ok: true, value: { terminal: INFO } });

    const call = requests.find((request) => request.url.endsWith(REMOTE_TERMINALS_PATH));
    expect(call?.method).toBe('POST');
    // The three fields the route reads, and no argv or environment: the serving
    // side picks the program. See `core/server/terminals.ts`.
    expect(call?.body).toEqual({ cwd: '/srv/repo', cols: 120, rows: 40 });
  });

  it('writes keystrokes to the path the shared helper builds', async () => {
    replies.set(remoteTerminalPath('term-1', 'write'), [
      jsonResponse(200, { object: 'artemis.terminal', terminal: INFO }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.terminal.write({ id: 'term-1' as never, data: 'ls -la\n' });
    expect(result).toEqual({ ok: true, value: { id: 'term-1' } });

    const call = requests.find((request) => request.url.includes('/write'));
    expect(new URL(call?.url ?? '').pathname).toBe(remoteTerminalPath('term-1', 'write'));
    expect(call?.body).toEqual({ data: 'ls -la\n' });
  });

  it('resizes with cols and rows, the names the route reads', async () => {
    replies.set(remoteTerminalPath('term-1', 'resize'), [
      jsonResponse(200, { object: 'artemis.terminal', terminal: INFO }),
    ]);
    const bridge = bridgeUnderTest();
    await bridge.terminal.resize({ id: 'term-1' as never, cols: 100, rows: 30 });
    const call = requests.find((request) => request.url.includes('/resize'));
    expect(call?.body).toEqual({ cols: 100, rows: 30 });
  });

  it('closes through the one route that ends a shell', async () => {
    replies.set(remoteTerminalPath('term-1', 'close'), [
      jsonResponse(200, { object: 'artemis.terminal', terminal: { ...INFO, exited: true } }),
    ]);
    const bridge = bridgeUnderTest();
    await bridge.terminal.close({ id: 'term-1' as never });
    const call = requests.find((request) => request.url.includes('/close'));
    expect(call?.method).toBe('POST');
  });

  it('replays the retained tail with its truncation flag', async () => {
    replies.set(remoteTerminalPath('term-1', 'replay'), [
      jsonResponse(200, {
        object: 'artemis.terminal.replay',
        id: 'term-1',
        data: 'last screenful',
        truncated: true,
      }),
    ]);
    const bridge = bridgeUnderTest();
    const result = await bridge.terminal.replay({ id: 'term-1' as never });
    expect(result).toEqual({
      ok: true,
      value: { id: 'term-1', data: 'last screenful', truncated: true },
    });
    const call = requests.find((request) => request.url.includes('/replay'));
    expect(call?.method).toBe('GET');
  });

  it('percent-encodes an awkward id exactly as the server decodes it', async () => {
    const id = 'term/one two';
    replies.set(remoteTerminalPath(id, 'write'), [
      jsonResponse(200, { object: 'artemis.terminal', terminal: INFO }),
    ]);
    const bridge = bridgeUnderTest();
    await bridge.terminal.write({ id: id as never, data: 'x' });
    const call = requests.find((request) => request.url.includes('/write'));
    // The round trip the two sides have to agree on: the client's builder and
    // the server's parser are the same module.
    const path = new URL(call?.url ?? '').pathname;
    expect(parseRemoteResourcePath(path, REMOTE_TERMINALS_PATH)).toEqual({
      id,
      action: 'write',
    });
  });

  it('lists no shells rather than erroring when the server serves none', async () => {
    replies.set(REMOTE_TERMINALS_PATH, [
      jsonResponse(501, {
        error: { message: 'This Artemis does not serve shells.', type: 'invalid_request_error' },
      }),
    ]);
    const bridge = bridgeUnderTest();
    // The reload path asks for this; a 501 must not break it.
    expect(await bridge.terminal.list({})).toEqual({ ok: true, value: { terminals: [] } });
  });

  it('delivers PTY bytes off the event stream to terminal listeners', async () => {
    const event = { type: 'data', id: 'term-1', data: 'hello from the other machine' };
    replies.set('/api/v0/events', [
      {
        ok: true,
        status: 200,
        body: scriptedBody(
          [
            sseMessage({ event: REMOTE_STREAM_HELLO, data: '{"seq":0,"version":"t"}' }),
            sseMessage({
              id: '1',
              event: 'artemis:push:terminal-event',
              data: JSON.stringify(event),
            }),
          ],
          true,
        ),
      } as unknown as Response,
    ]);

    const seen: unknown[] = [];
    const bridge = bridgeUnderTest();
    bridge.terminal.onEvent((received) => seen.push(received));
    await until(() => seen.length > 0);
    expect(seen[0]).toEqual(event);
  });
});
