import { describe, expect, it } from 'vitest';

import type { ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { createArtemisServer, handleServerRequest } from '../http.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const OTHER_TOKEN = 'other-token-abcdefghijklmnopqrstuvwx';

/** A connection with the run of the place, which is what most tests need. */
const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

/** One restricted to an account that does not exist, so it can see nothing. */
const NARROW = {
  id: 'conn-2',
  label: 'Narrow',
  workspace: { kind: 'ephemeral' as const, perSession: true },
  token: OTHER_TOKEN,
  createdAt: 0,
  allow: [{ profileId: 'nobody' as ServerProfile['id'] }],
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
    capabilities: NO_CAPABILITIES,
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
        ultracode: true,
      },
    ],
  },
];

const catalogue: Catalogue = {
  read: async () => PROFILES,
  invalidate: () => undefined,
};

function request(
  url: string,
  headers: Record<string, string | undefined> = {},
  method = 'GET',
): Parameters<typeof handleServerRequest>[0] {
  return { method, url, headers: { host: '127.0.0.1:6472', ...headers } };
}

const authorized = { authorization: `Bearer ${TOKEN}` };

async function ask(
  url: string,
  headers: Record<string, string | undefined> = authorized,
  method = 'GET',
): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(request(url, headers, method), {
    connections: [CONNECTION, NARROW],
    version: '1.1.1',
    catalogue,
    startedAt: 1_700_000_000_000,
  });
}

describe('auth', () => {
  it('refuses a request with no token', async () => {
    const reply = await ask('/v1/models', {});
    expect(reply.status).toBe(401);
    expect(reply.rejected).toBe(true);
  });

  it('refuses a wrong token, including one of a different length', async () => {
    expect((await ask('/v1/models', { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await ask('/v1/models', { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
  });

  it('accepts the token under either header', async () => {
    expect((await ask('/v1/models', { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    // Anthropic-shaped clients send this one; refusing it would turn away half
    // the ecosystem over a header name.
    expect((await ask('/v1/models', { 'x-api-key': TOKEN })).status).toBe(200);
  });

  it('lets health through without one, and says nothing about accounts', async () => {
    const reply = await ask('/health', {});
    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).not.toContain('work-max');
  });

  it('never authorises against an empty configured token', async () => {
    const reply = await handleServerRequest(request('/v1/models', { authorization: 'Bearer ' }), {
      connections: [{ ...CONNECTION, token: '' }],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
    });
    expect(reply.status).toBe(401);
  });
});

describe('transport guards', () => {
  it('refuses a request whose Host is not loopback', async () => {
    // DNS rebinding: the socket is loopback-bound, so the connection looks
    // local. The header is the part the attacker cannot forge.
    const reply = await ask('/v1/models', { ...authorized, host: 'evil.example' });
    expect(reply.status).toBe(403);
  });

  it('accepts an IPv6 loopback Host', async () => {
    expect((await ask('/v1/models', { ...authorized, host: '[::1]:6472' })).status).toBe(200);
  });

  it('answers a preflight without a token, because a browser cannot send one', async () => {
    const reply = await ask('/v1/models', {}, 'OPTIONS');
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-origin']).toBe('*');
  });

  it('refuses a write to a route that really is read-only', async () => {
    const reply = await ask('/v1/models', authorized, 'POST');
    expect(reply.status).toBe(405);
  });

  it('says "not built yet" rather than "wrong verb" for a planned endpoint', async () => {
    // 405 would tell a client the endpoint exists and it used the wrong method,
    // which sends its user looking for a GET that will never work.
    const reply = await ask('/v1/responses', authorized, 'POST');
    expect(reply.status).toBe(501);
    expect(JSON.stringify((reply as { body: unknown }).body)).toMatch(/catalogue only/i);
  });

  it('answers 501 for completions when this build cannot run turns', async () => {
    // A context with no `runs` seam — a catalogue-only deployment.
    const reply = await ask('/v1/chat/completions', authorized, 'POST');
    expect(reply.status).toBe(501);
  });

  it('answers 404, not 405, for a path that does not exist at all', async () => {
    const reply = await ask('/v1/nonsense', authorized, 'POST');
    expect(reply.status).toBe(404);
  });

  it('still refuses a planned endpoint to an unauthenticated caller', async () => {
    // The 501 must sit behind the token: which endpoints a build is missing is
    // a fact about this installation, not a public one.
    expect((await ask('/v1/chat/completions', {}, 'POST')).status).toBe(401);
  });

  it('never allows credentials, which is what keeps the open CORS safe', async () => {
    const reply = await ask('/v1/models');
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('routes', () => {
  it('lists every route in OpenAI shape, with seconds since the epoch', async () => {
    const reply = await ask('/v1/models');
    expect(reply.body).toEqual({
      object: 'list',
      data: [
        {
          id: 'work-max/opus',
          object: 'model',
          created: 1_700_000_000,
          owned_by: 'work-max',
        },
      ],
    });
  });

  it('resolves one route, encoded or not', async () => {
    expect((await ask('/v1/models/work-max/opus')).status).toBe(200);
    expect((await ask('/v1/models/work-max%2Fopus')).status).toBe(200);
  });

  it('serves the native catalogue with the facts OpenAI has no room for', async () => {
    const reply = await ask('/api/v0/models');
    const body = reply.body as { models: readonly Record<string, unknown>[] };
    expect(body.models[0]).toMatchObject({
      route: 'work-max/opus',
      fastMode: true,
      ultracode: true,
      thinkingLevels: [{ id: 'high', label: 'High', note: 'Deep.' }],
    });
  });

  it('filters the flat list by account', async () => {
    expect((await ask('/api/v0/models?profile=work-max')).body).toMatchObject({
      models: [{ route: 'work-max/opus' }],
    });
    expect((await ask('/api/v0/models?profile=nobody')).body).toEqual({
      object: 'artemis.models',
      models: [],
    });
  });

  it('treats a trailing slash as the same route', async () => {
    expect((await ask('/v1/models/')).status).toBe(200);
  });

  it('says which model was not found, and where to look', async () => {
    const reply = await ask('/v1/models/work-max/sonnet');
    expect(reply.status).toBe(404);
    expect(JSON.stringify(reply.body)).toContain('/v1/models');
  });

  it('quotes the route the caller meant, not the escaping their client applied', async () => {
    // The client prints this message verbatim, so `work-max%2Fsonnet` reads as
    // part of the name the user got wrong.
    const reply = await ask('/v1/models/work-max%2Fsonnet');
    expect(JSON.stringify(reply.body)).toContain('work-max/sonnet');
    expect(JSON.stringify(reply.body)).not.toContain('%2F');
  });

  it('refuses a bare model id as an address', async () => {
    // `opus` alone names two things when two accounts offer it.
    expect((await ask('/v1/models/opus')).status).toBe(404);
  });

  it('answers the index with paths it really serves', async () => {
    const body = (await ask('/')).body as { endpoints: readonly { path: string }[] };
    expect(body.endpoints.map((entry) => entry.path)).toContain('/api/v0/profiles');
  });
});

describe('a listening server', () => {
  it('binds, answers, and releases the port', async () => {
    const server = createArtemisServer({
      port: 0,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue,
    });

    const port = await server.listen();
    expect(port).toBeGreaterThan(0);

    try {
      const anonymous = await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(anonymous.status).toBe(401);

      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ object: 'list' });

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toMatchObject({ status: 'ok', api: 'v0' });
    } finally {
      await server.close();
    }

    // The port has to be genuinely free afterwards, or quitting and relaunching
    // Artemis would meet EADDRINUSE from its own previous process.
    const second = createArtemisServer({
      port,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue,
    });
    await expect(second.listen()).resolves.toBe(port);
    await second.close();
  });

  it('counts what it answered, and what it refused', async () => {
    const seen: { rejected: boolean }[] = [];
    const server = createArtemisServer({
      port: 0,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue,
      onRequest: (outcome) => seen.push({ rejected: outcome.rejected }),
    });

    const port = await server.listen();
    try {
      await fetch(`http://127.0.0.1:${port}/v1/models`);
      await fetch(`http://127.0.0.1:${port}/health`);
    } finally {
      await server.close();
    }

    expect(seen).toEqual([{ rejected: true }, { rejected: false }]);
  });

  it('reports a port that is already taken rather than resolving', async () => {
    const first = createArtemisServer({ port: 0, token: TOKEN, version: '1.1.1', catalogue });
    const port = await first.listen();
    const second = createArtemisServer({
      port,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue,
    });

    try {
      await expect(second.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await second.close();
      await first.close();
    }
  });
});

describe('a connection is the identity', () => {
  it('answers who the caller is, and never echoes their token back', async () => {
    const reply = await ask('/api/v0/connection');
    expect(reply.body).toEqual({
      id: 'conn-1',
      label: 'Test',
      workspace: { kind: 'directory', path: '/w' },
      canRunTurns: true,
    });
    // The caller already has it; putting it in a body puts it in every log and
    // proxy between here and them.
    expect(JSON.stringify(reply.body)).not.toContain(TOKEN);
  });

  it('reports a scratch connection as able to run turns', async () => {
    const reply = await ask('/api/v0/connection', { authorization: `Bearer ${OTHER_TOKEN}` });
    expect(reply.body).toMatchObject({
      workspace: { kind: 'ephemeral' },
      canRunTurns: true,
    });
  });

  it('says a catalogue-only connection cannot run turns', async () => {
    const reply = await handleServerRequest(request('/api/v0/connection', authorized), {
      connections: [{ ...CONNECTION, workspace: { kind: 'none' } }],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
    });
    expect(reply.body).toMatchObject({ canRunTurns: false });
  });

  it('hides accounts a restricted connection may not use', async () => {
    // Filtered, not merely refused at call time: a token scoped to one account
    // should not be able to enumerate the others.
    const narrow = { authorization: `Bearer ${OTHER_TOKEN}` };
    expect((await ask('/v1/models', narrow)).body).toEqual({ object: 'list', data: [] });
    expect((await ask('/api/v0/profiles', narrow)).body).toEqual({
      object: 'artemis.profiles',
      profiles: [],
    });
    // And the route it cannot see is not resolvable either.
    expect((await ask('/v1/models/work-max/opus', narrow)).status).toBe(404);
  });

  it('attributes an answered request to the connection that asked', async () => {
    // What the host stamps `lastUsedAt` from, without looking at a token.
    expect((await ask('/v1/models')).connectionId).toBe('conn-1');
    expect((await ask('/v1/models', { authorization: `Bearer ${OTHER_TOKEN}` })).connectionId).toBe(
      'conn-2',
    );
  });

  it('stops honouring a token the moment it is removed', async () => {
    // Revocation with no restart is the whole reason `connections` is a
    // function rather than an array captured at construction.
    let connections = [CONNECTION];
    const server = createArtemisServer({
      port: 0,
      connections: () => connections,
      version: '1.1.1',
      catalogue,
    });
    const port = await server.listen();

    try {
      const before = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(before.status).toBe(200);

      connections = [];

      const after = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(after.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe('an allowlisted connection', () => {
  /** Two accounts, two models each, so narrowing has something to hide. */
  const TWO: readonly ServerProfile[] = [
    PROFILES[0]!,
    {
      ...PROFILES[0]!,
      id: 'prof-b' as ServerProfile['id'],
      slug: 'personal',
      label: 'Personal',
      models: [
        { ...PROFILES[0]!.models[0]!, route: 'personal/opus', profileSlug: 'personal' },
        {
          ...PROFILES[0]!.models[0]!,
          route: 'personal/haiku',
          id: 'haiku',
          profileSlug: 'personal',
        },
      ],
    },
  ];

  const wide: Catalogue = { read: async () => TWO, invalidate: () => undefined };

  async function askAs(
    connection: Parameters<typeof handleServerRequest>[1]['connections'][number],
    url: string,
  ): ReturnType<typeof handleServerRequest> {
    return handleServerRequest(
      request(url, { authorization: `Bearer ${connection.token}` }),
      { connections: [connection], version: '1.1.1', catalogue: wide, startedAt: 0 },
    );
  }

  it('hides accounts outside the allowance entirely', async () => {
    const scoped = {
      ...CONNECTION,
      allow: [{ profileId: 'prof-b' as ServerProfile['id'] }],
    };

    const body = (await askAs(scoped, '/v1/models')).body as { data: readonly { id: string }[] };
    expect(body.data.map((m) => m.id)).toEqual(['personal/opus', 'personal/haiku']);
  });

  it('hides models the allowance did not name, on an account it did', async () => {
    // The finer half: the account is reachable, one of its models is not.
    const scoped = {
      ...CONNECTION,
      allow: [{ profileId: 'prof-b' as ServerProfile['id'], modelIds: ['haiku'] }],
    };

    const body = (await askAs(scoped, '/v1/models')).body as { data: readonly { id: string }[] };
    expect(body.data.map((m) => m.id)).toEqual(['personal/haiku']);
    // And the one it may not use is not resolvable either.
    expect((await askAs(scoped, '/v1/models/personal/opus')).status).toBe(404);
  });

  it('drops an account left with no models rather than showing it empty', async () => {
    const scoped = {
      ...CONNECTION,
      allow: [{ profileId: 'prof-b' as ServerProfile['id'], modelIds: ['nonexistent'] }],
    };

    const body = (await askAs(scoped, '/api/v0/profiles')).body as { profiles: readonly unknown[] };
    expect(body.profiles).toEqual([]);
  });

  it('treats an account entry with no model list as the whole account', async () => {
    // Which is what makes a grant follow an account as it gains models.
    const scoped = {
      ...CONNECTION,
      allow: [{ profileId: 'prof-b' as ServerProfile['id'] }],
    };
    expect((await askAs(scoped, '/v1/models/personal/haiku')).status).toBe(200);
  });

  it('treats an empty allowance as unrestricted, never as a lockout', async () => {
    // A narrowing that failed closed would look like a broken token nobody
    // could diagnose.
    const scoped = { ...CONNECTION, allow: [] };
    const body = (await askAs(scoped, '/v1/models')).body as { data: readonly unknown[] };
    expect(body.data).toHaveLength(3);
  });

  it('tells the connection what it may use, without echoing its token', async () => {
    const scoped = {
      ...CONNECTION,
      allow: [{ profileId: 'prof-b' as ServerProfile['id'], modelIds: ['haiku'] }],
    };
    expect((await askAs(scoped, '/api/v0/connection')).body).toMatchObject({
      allow: [{ profileId: 'prof-b', modelIds: ['haiku'] }],
    });
  });
});
