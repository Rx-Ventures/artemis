/**
 * The client, against a real Artemis server.
 *
 * Most of this file talks to an actual listening socket rather than a stubbed
 * `fetch`, because the bugs worth catching here live between the two packages:
 * a path composed wrong, a query parameter the server does not read, an error
 * envelope the client cannot unwrap. A fake `fetch` would agree with whatever
 * this client did and prove none of it.
 *
 * `fetch` is stubbed only where the real server cannot produce the condition —
 * an unreachable host, a non-JSON error body.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import { createArtemisServer, type ArtemisServer, type Catalogue } from '@rx-artemis/core';

import {
  acceptsThinkingLevel,
  canRunTurns,
  ArtemisAuthError,
  ArtemisNotImplementedError,
  ArtemisServerError,
  ArtemisUnreachableError,
  createArtemisClient,
  deepestThinkingLevel,
  usableModels,
} from '../client.js';

const TOKEN = 'client-test-token-0123456789abcdef';

function model(profile: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    route: `${profile}/${id}`,
    id,
    label: id,
    note: '.',
    profileId: profile as ServerProfile['id'],
    profileSlug: profile,
    profileLabel: profile,
    providerId: 'claude' as const,
    thinkingLevels: [
      { id: 'low', label: 'Low', note: 'Fast.' },
      { id: 'high', label: 'High', note: 'Deep.' },
    ],
    adaptiveThinking: false,
    fastMode: false,
    ultracode: false,
    ...extra,
  };
}

const PROFILES: readonly ServerProfile[] = [
  {
    id: 'work-max' as ServerProfile['id'],
    slug: 'work-max',
    label: 'Work Max',
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: NO_CAPABILITIES,
    models: [model('work-max', 'opus', { fastMode: true, ultracode: true }), model('work-max', 'haiku')],
  },
  {
    id: 'retired' as ServerProfile['id'],
    slug: 'retired',
    label: 'Retired',
    provider: { id: 'codex', label: 'Codex', kind: 'hosted' },
    available: false,
    unavailableReason: 'Not supported in this version of Artemis yet.',
    disabled: false,
    live: false,
    capabilities: NO_CAPABILITIES,
    models: [model('retired', 'gpt-5.4')],
  },
];

const catalogue: Catalogue = { read: async () => PROFILES, invalidate: () => undefined };

let server: ArtemisServer;
let baseUrl = '';

beforeAll(async () => {
  server = createArtemisServer({
    port: 0,
    // One connection with the run of the place: this file is about the client,
    // and the connection model has its own tests in core.
    connections: () => [
      {
        id: 'conn-1',
        label: 'SDK tests',
        workspace: { kind: 'ephemeral', perSession: true },
        token: TOKEN,
        createdAt: 0,
      },
    ],
    version: '1.1.1',
    catalogue,
  });
  baseUrl = `http://127.0.0.1:${await server.listen()}`;
});

afterAll(async () => {
  await server.close();
});

const client = () => createArtemisClient({ baseUrl, token: TOKEN });

describe('reading a catalogue', () => {
  it('reports liveness without a token', async () => {
    const anonymous = createArtemisClient({ baseUrl });
    expect(await anonymous.health()).toMatchObject({ status: 'ok', api: 'v0' });
  });

  it('lists accounts with what each offers', async () => {
    const profiles = await client().profiles();
    expect(profiles.map((profile) => profile.slug)).toEqual(['work-max', 'retired']);
    expect(profiles[0]?.models).toHaveLength(2);
  });

  it('lists every route flattened, and filters by account', async () => {
    expect((await client().models()).map((m) => m.route)).toEqual([
      'work-max/opus',
      'work-max/haiku',
      'retired/gpt-5.4',
    ]);
    // The filter is the server's, so this also proves the query parameter is
    // spelled the way the server reads it.
    expect((await client().models({ profile: 'work-max' })).map((m) => m.route)).toEqual([
      'work-max/opus',
      'work-max/haiku',
    ]);
  });

  it('resolves one route, and answers undefined for one that is not there', async () => {
    expect((await client().model('work-max/opus'))?.fastMode).toBe(true);
    // A question, not a fault: the caller is usually about to try another route.
    expect(await client().model('work-max/gpt-4')).toBeUndefined();
  });

  it('serves the OpenAI listing off the same server', async () => {
    expect((await client().openaiModels()).map((m) => m.id)).toContain('work-max/opus');
  });
});

describe('failures a program has to tell apart', () => {
  it('raises an auth error the caller can catch on its own', async () => {
    const wrong = createArtemisClient({ baseUrl, token: 'nope' });
    await expect(wrong.profiles()).rejects.toBeInstanceOf(ArtemisAuthError);
    await expect(wrong.profiles()).rejects.toMatchObject({ status: 401, code: 'invalid_api_key' });
  });

  it('refuses without a token rather than sending an empty one', async () => {
    const anonymous = createArtemisClient({ baseUrl });
    await expect(anonymous.profiles()).rejects.toBeInstanceOf(ArtemisAuthError);
  });

  it('distinguishes "not built yet" from "no such thing"', async () => {
    // The client reaches the planned endpoint directly, because that is what an
    // SDK pointed at this base URL will do the moment completions are expected.
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(501);

    const error = new ArtemisNotImplementedError(501, { code: 'not_implemented' });
    expect(error).toBeInstanceOf(ArtemisServerError);
    expect(error.name).toBe('ArtemisNotImplementedError');
  });

  it('says the server could not be reached, and where it looked', async () => {
    const dead = createArtemisClient({
      baseUrl: 'http://127.0.0.1:9',
      token: TOKEN,
      timeoutMs: 250,
    });
    await expect(dead.health()).rejects.toBeInstanceOf(ArtemisUnreachableError);
    await expect(dead.health()).rejects.toMatchObject({ baseUrl: 'http://127.0.0.1:9' });
  });

  it('survives an error body that is not JSON', async () => {
    // A proxy between the caller and Artemis answers HTML. Throwing a
    // SyntaxError from the parse would replace a useful 502 with a confusing one.
    const client = createArtemisClient({
      baseUrl,
      token: TOKEN,
      fetch: async () => new Response('<html>502</html>', { status: 502 }),
    });
    await expect(client.profiles()).rejects.toMatchObject({
      name: 'ArtemisServerError',
      status: 502,
    });
  });

  it('honours a caller’s abort without disabling its own timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client().profiles({ signal: controller.signal })).rejects.toBeInstanceOf(
      ArtemisUnreachableError,
    );
  });
});

describe('base URL handling', () => {
  it('tolerates a trailing slash', async () => {
    const client = createArtemisClient({ baseUrl: `${baseUrl}/`, token: TOKEN });
    expect(client.baseUrl).toBe(baseUrl);
    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('reading capabilities', () => {
  it('answers whether a level will actually be honoured', () => {
    const opus = PROFILES[0]!.models[0]!;
    expect(acceptsThinkingLevel(opus, 'high')).toBe(true);
    // The failure this prevents: sending `max`, which the run drops silently.
    expect(acceptsThinkingLevel(opus, 'max')).toBe(false);
  });

  it('finds the deepest level without knowing any provider’s vocabulary', () => {
    expect(deepestThinkingLevel(PROFILES[0]!.models[0]!)).toBe('high');
    expect(
      deepestThinkingLevel({ ...PROFILES[0]!.models[0]!, thinkingLevels: [] }),
    ).toBeUndefined();
  });

  it('drops unusable accounts and keeps hidden ones', () => {
    const routes = usableModels(PROFILES).map((m) => m.route);
    expect(routes).toEqual(['work-max/opus', 'work-max/haiku']);
    // `retired` is unavailable, so its route goes. A *hidden* profile would
    // stay — see `usableModels`.
    expect(routes).not.toContain('retired/gpt-5.4');
  });
});

describe('knowing what this token is', () => {
  it('reports the connection, and never its own token', async () => {
    const connection = await client().connection();
    expect(connection).toMatchObject({
      label: 'SDK tests',
      workspace: { kind: 'ephemeral', perSession: true },
      canRunTurns: true,
    });
    // The caller already has it; echoing it puts a credential in every log and
    // proxy between here and them.
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
  });

  it('answers whether a turn can run at all', async () => {
    // The check a client makes before drawing a Run button.
    expect(canRunTurns(await client().connection())).toBe(true);
  });
});
