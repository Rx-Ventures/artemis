import { describe, expect, it } from 'vitest';

import type { ServerProfile, ServerSignInStatus } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { RemoteAccessEvent } from '../../sessions/lifecycleLog.js';
import type { Catalogue } from '../catalogue.js';
import { createArtemisServer, handleServerRequest } from '../http.js';
import {
  DuplicateProfileLabelError,
  SignInBusyError,
  SignInNotWaitingError,
  SignInUnavailableError,
  type ProfileAdmin,
  type SignInDirector,
} from '../signin.js';

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
      // A capability line rather than a filter, so it is always present and
      // always a boolean — a client reading it decides whether to draw a whole
      // surface, and "the field was missing" must not be a third answer.
      manageProfiles: false,
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

/* -------------------------------------------------------------------------- */
/* Accounts: adding one, and signing it in                                    */
/* -------------------------------------------------------------------------- */

/**
 * The administrative surface, from the router's side.
 *
 * The state machine itself is exercised against a real subprocess in
 * `signin.test.ts`; what is pinned here is everything the *router* decides —
 * who may see these routes at all, which verb reaches which action, how each
 * refusal is spelled, and what lands in the attribution record. The director is
 * a fake for that reason: a test about authorisation should not be waiting on a
 * process to print a URL.
 */
describe('the account surface', () => {
  /** A connection the operator granted account administration. */
  const ADMIN_TOKEN = 'admin-token-abcdefghijklmnopqrstuvwx';
  const ADMIN = { ...CONNECTION, id: 'conn-admin', token: ADMIN_TOKEN, manageProfiles: true };
  const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };

  const SIGN_IN: ServerSignInStatus = {
    object: 'artemis.signin',
    profileId: 'prof-a' as ServerProfile['id'],
    state: 'awaiting_code',
    verificationUrl: 'https://claude.ai/oauth/authorize?code=true',
    startedAt: 1_000,
    expiresAt: 601_000,
  };

  /** A scripted director: every call answers, or throws what the router maps. */
  function fakeSignIns(overrides: Partial<SignInDirector> = {}): SignInDirector {
    return {
      start: () => SIGN_IN,
      status: () => SIGN_IN,
      submitCode: () => ({ ...SIGN_IN, state: 'completing' }),
      cancel: () => ({ ...SIGN_IN, state: 'cancelled' }),
      close: () => undefined,
      ...overrides,
    };
  }

  function fakeAdmin(overrides: Partial<ProfileAdmin> = {}): ProfileAdmin {
    return {
      create: async ({ label, providerId }) => ({
        id: 'prof-new' as ServerProfile['id'],
        label,
        providerId,
        configDir: `/data/profiles/${label}`,
        credentials: {} as never,
      }),
      find: async (id) =>
        id === 'prof-a'
          ? {
              id: 'prof-a' as ServerProfile['id'],
              label: 'Work Max',
              providerId: 'claude',
              configDir: '/data/profiles/work',
              credentials: {} as never,
            }
          : undefined,
      ...overrides,
    };
  }

  async function admin(
    url: string,
    method = 'GET',
    body?: unknown,
    seams:
      | {
          profileAdmin?: ProfileAdmin;
          signIns?: SignInDirector;
          onRemoteAccess?: (event: RemoteAccessEvent) => void;
        }
      | 'none' = {},
    headers: Record<string, string | undefined> = asAdmin,
  ): ReturnType<typeof handleServerRequest> {
    return handleServerRequest(
      { ...request(url, headers, method), ...(body === undefined ? {} : { body }) },
      {
        connections: [CONNECTION, ADMIN],
        version: '1.1.1',
        catalogue,
        startedAt: 0,
        ...(seams === 'none'
          ? {}
          : {
              profileAdmin: seams.profileAdmin ?? fakeAdmin(),
              signIns: seams.signIns ?? fakeSignIns(),
              ...(seams.onRemoteAccess === undefined
                ? {}
                : { onRemoteAccess: seams.onRemoteAccess }),
            }),
      },
    );
  }

  it('tells a connection without the grant that these routes do not exist', async () => {
    /*
     * 404 and not 403, and the difference is the whole authorisation model
     * here. A 403 would tell any token that this deployment *has* an
     * administrative surface — and therefore that some other token can add
     * accounts to it — which is the most useful thing an attacker could learn
     * from a refusal.
     */
    const routes: readonly (readonly [string, string])[] = [
      ['/api/v0/profiles', 'POST'],
      ['/api/v0/profiles/prof-a/signin', 'POST'],
      ['/api/v0/profiles/prof-a/signin', 'GET'],
      ['/api/v0/profiles/prof-a/signin', 'DELETE'],
      ['/api/v0/profiles/prof-a/signin/code', 'POST'],
    ];
    for (const [path, method] of routes) {
      const reply = await admin(path, method, { label: 'x', code: 'x' }, {}, authorized);
      expect(reply.status).toBe(404);
      expect(JSON.stringify((reply as { body: unknown }).body)).not.toMatch(/grant|permission/i);
    }
  });

  it('keeps the surface out of the index for a connection without the grant', async () => {
    // The index is behind auth, but so is every route it lists. Naming these
    // ones to a token that gets a 404 from them would hand back the one fact
    // the 404 exists to withhold.
    const seen = JSON.stringify((await admin('/', 'GET', undefined, {}, authorized)).body);
    expect(seen).not.toContain('signin');
    const asAdministrator = JSON.stringify((await admin('/', 'GET')).body);
    expect(asAdministrator).toContain('/api/v0/profiles/{id}/signin');
  });

  it('still serves the catalogue to a connection without the grant', async () => {
    // `GET /api/v0/profiles` is the ordinary read every client makes. Routing
    // it through the administrative gate would hide the whole catalogue from
    // every token that is not an administrator.
    expect((await admin('/api/v0/profiles', 'GET', undefined, {}, authorized)).status).toBe(200);
  });

  it('answers 501 to an administrator on a build that cannot add accounts', async () => {
    // And only to an administrator: the 501 is itself a fact about this
    // installation, so an unprivileged token still gets the 404.
    expect((await admin('/api/v0/profiles', 'POST', { label: 'x' }, 'none')).status).toBe(501);
    expect(
      (await admin('/api/v0/profiles', 'POST', { label: 'x' }, 'none', authorized)).status,
    ).toBe(404);
  });

  it('creates an account and reports where its credential will live', async () => {
    const reply = await admin('/api/v0/profiles', 'POST', { label: 'work' });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      object: 'artemis.profile',
      id: 'prof-new',
      label: 'work',
      providerId: 'claude',
      configDir: '/data/profiles/work',
    });
  });

  it('defaults the provider rather than making a caller name the only one', async () => {
    const reply = await admin('/api/v0/profiles', 'POST', { label: ' spaced ' });
    // And trims, so a label pasted with a stray space is not a different
    // account from the one the user meant.
    expect(reply.body).toMatchObject({ label: 'spaced', providerId: 'claude' });
  });

  it('refuses a duplicate label with a sentence naming it', async () => {
    const reply = await admin('/api/v0/profiles', 'POST', { label: 'work' }, {
      profileAdmin: fakeAdmin({
        create: async ({ label }) => {
          throw new DuplicateProfileLabelError(label);
        },
      }),
    });
    expect(reply.status).toBe(409);
    expect(JSON.stringify((reply as { body: unknown }).body)).toContain('work');
  });

  it('refuses a body with nothing usable in it', async () => {
    expect((await admin('/api/v0/profiles', 'POST', undefined)).status).toBe(400);
    expect((await admin('/api/v0/profiles', 'POST', { label: '  ' })).status).toBe(400);
    expect((await admin('/api/v0/profiles', 'POST', { label: 'x', provider: 7 })).status).toBe(400);
  });

  it('starts a sign-in and hands back the verification URL', async () => {
    const reply = await admin('/api/v0/profiles/prof-a/signin', 'POST');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      object: 'artemis.signin',
      state: 'awaiting_code',
      verificationUrl: 'https://claude.ai/oauth/authorize?code=true',
    });
  });

  it('drives one sign-in at a time', async () => {
    // Each one is a subprocess parked on a human. A surface that let a caller
    // start them without bound is one that lets a caller park processes
    // without bound.
    const reply = await admin('/api/v0/profiles/prof-a/signin', 'POST', undefined, {
      signIns: fakeSignIns({
        start: () => {
          throw new SignInBusyError('Personal');
        },
      }),
    });
    expect(reply.status).toBe(409);
    expect(JSON.stringify((reply as { body: unknown }).body)).toContain('Personal');
  });

  it('says plainly when the provider CLI is not installed on the server', async () => {
    const reply = await admin('/api/v0/profiles/prof-a/signin', 'POST', undefined, {
      signIns: fakeSignIns({
        start: () => {
          throw new SignInUnavailableError('The claude CLI is not installed on this server.');
        },
      }),
    });
    expect(reply.status).toBe(409);
    expect(JSON.stringify((reply as { body: unknown }).body)).toContain('not installed');
  });

  it('refuses to sign in an account that is not there', async () => {
    expect((await admin('/api/v0/profiles/nobody/signin', 'POST')).status).toBe(404);
  });

  it('reads a flow, and reports plainly when there is none', async () => {
    expect((await admin('/api/v0/profiles/prof-a/signin', 'GET')).status).toBe(200);
    const none = await admin('/api/v0/profiles/prof-a/signin', 'GET', undefined, {
      signIns: fakeSignIns({ status: () => undefined }),
    });
    expect(none.status).toBe(404);
  });

  it('carries the code to the subprocess and never quotes it back', async () => {
    const reply = await admin('/api/v0/profiles/prof-a/signin/code', 'POST', { code: 'S3CR3T' });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ state: 'completing' });
    // The one secret in flight on this whole surface.
    expect(JSON.stringify((reply as { body: unknown }).body)).not.toContain('S3CR3T');
  });

  it('refuses a code that is not one', async () => {
    expect((await admin('/api/v0/profiles/prof-a/signin/code', 'POST', {})).status).toBe(400);
    expect((await admin('/api/v0/profiles/prof-a/signin/code', 'POST', { code: '' })).status).toBe(
      400,
    );
    // A line break would be read by the CLI as the end of one answer and the
    // start of another, so a pasted value carrying one is not the code it was
    // shown.
    expect(
      (await admin('/api/v0/profiles/prof-a/signin/code', 'POST', { code: 'a\nb' })).status,
    ).toBe(400);
  });

  it('refuses a code when nothing is waiting for one', async () => {
    const reply = await admin('/api/v0/profiles/prof-a/signin/code', 'POST', { code: 'x' }, {
      signIns: fakeSignIns({
        submitCode: () => {
          throw new SignInNotWaitingError('done');
        },
      }),
    });
    expect(reply.status).toBe(409);
  });

  it('cancels a flow, and says so when there was nothing to cancel', async () => {
    expect((await admin('/api/v0/profiles/prof-a/signin', 'DELETE')).body).toMatchObject({
      state: 'cancelled',
    });
    const none = await admin('/api/v0/profiles/prof-a/signin', 'DELETE', undefined, {
      signIns: fakeSignIns({ cancel: () => undefined }),
    });
    expect(none.status).toBe(404);
  });

  it('refuses a verb no action on this surface has', async () => {
    expect((await admin('/api/v0/profiles/prof-a/signin', 'PUT')).status).toBe(405);
    expect((await admin('/api/v0/profiles/prof-a/signin/code', 'GET')).status).toBe(405);
  });

  it('404s a sub-path that is not one of the two actions', async () => {
    // Enumerated, so an unknown one is refused before an id is even decoded.
    expect((await admin('/api/v0/profiles/prof-a/nonsense', 'POST')).status).toBe(404);
    expect((await admin('/api/v0/profiles/prof-a', 'POST')).status).toBe(404);
  });

  it('reports the grant to the connection that has it', async () => {
    expect((await admin('/api/v0/connection', 'GET')).body).toMatchObject({
      manageProfiles: true,
    });
  });

  it('lets a browser preflight the DELETE it is about to send', async () => {
    const reply = await ask('/api/v0/profiles/prof-a/signin', {}, 'OPTIONS');
    expect(reply.headers['access-control-allow-methods']).toContain('DELETE');
  });

  /* ------------------------------------------------------------------------ */
  /* Attribution                                                              */
  /* ------------------------------------------------------------------------ */

  it('records every act against the connection that asked, and no read', async () => {
    const seen: RemoteAccessEvent[] = [];
    const onRemoteAccess = (event: RemoteAccessEvent): void => void seen.push(event);

    await admin('/api/v0/profiles', 'POST', { label: 'work' }, { onRemoteAccess });
    await admin('/api/v0/profiles/prof-a/signin', 'POST', undefined, { onRemoteAccess });
    await admin('/api/v0/profiles/prof-a/signin/code', 'POST', { code: 'S3CR3T' }, {
      onRemoteAccess,
    });
    await admin('/api/v0/profiles/prof-a/signin', 'DELETE', undefined, { onRemoteAccess });
    // A read. Polling a sign-in is how a client draws a frame, and a line per
    // poll would bury the lines that matter.
    await admin('/api/v0/profiles/prof-a/signin', 'GET', undefined, { onRemoteAccess });

    expect(seen.map((event) => event.kind)).toEqual([
      'remote.profile.created',
      'remote.signin.started',
      'remote.signin.completed',
      'remote.signin.cancelled',
    ]);
    expect(new Set(seen.map((event) => event.connectionId))).toEqual(new Set(['conn-admin']));
    expect(seen.map((event) => event.profileId)).toEqual([
      'prof-new',
      'prof-a',
      'prof-a',
      'prof-a',
    ]);
  });

  it('never puts a code or a verification URL on the record', async () => {
    const seen: RemoteAccessEvent[] = [];
    const onRemoteAccess = (event: RemoteAccessEvent): void => void seen.push(event);
    await admin('/api/v0/profiles/prof-a/signin', 'POST', undefined, { onRemoteAccess });
    await admin('/api/v0/profiles/prof-a/signin/code', 'POST', { code: 'S3CR3T' }, {
      onRemoteAccess,
    });
    const written = JSON.stringify(seen);
    expect(written).not.toContain('S3CR3T');
    expect(written).not.toContain('claude.ai');
  });

  it('writes no line for an account or a flow that is not there', async () => {
    /*
     * The ids on these lines come off the URL, and the record is written before
     * the verb runs. Without this check a caller could put an arbitrary string
     * into the log by asking about an account that never existed.
     */
    const seen: RemoteAccessEvent[] = [];
    const onRemoteAccess = (event: RemoteAccessEvent): void => void seen.push(event);
    const none = { signIns: fakeSignIns({ status: () => undefined }), onRemoteAccess };

    await admin('/api/v0/profiles/nobody/signin', 'POST', undefined, { onRemoteAccess });
    await admin('/api/v0/profiles/<script>/signin/code', 'POST', { code: 'x' }, none);
    await admin('/api/v0/profiles/<script>/signin', 'DELETE', undefined, none);

    expect(seen).toEqual([]);
  });

  it('records nothing at all for a connection without the grant', async () => {
    const seen: RemoteAccessEvent[] = [];
    await admin(
      '/api/v0/profiles',
      'POST',
      { label: 'work' },
      { onRemoteAccess: (event) => void seen.push(event) },
      authorized,
    );
    expect(seen).toEqual([]);
  });
});
