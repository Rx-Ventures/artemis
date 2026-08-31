/**
 * Doppler, and the three ways it differs from the manager the abstraction was
 * first written against.
 *
 * This file exists as much to check the *seam* as to check Doppler: if
 * `SecretManagerProvider` had quietly become "OpenBao's interface", these
 * tests would not compile. What they pin is the handful of Doppler details
 * that a reasonable implementation gets wrong on the first attempt —
 * `value.computed` rather than `value.raw`, `workplace` being an object, and
 * a scoped token refusing a request that names a project it already knows.
 */

import { describe, expect, it } from 'vitest';

import { createDopplerProvider, DOPPLER_API_BASE } from '../doppler.js';
import { SecretManagerError, type SecretHttpRequest, type SecretHttpResponse } from '../types.js';
import type { DopplerSecretRef, SecretConnection } from '@rx-artemis/protocol';

const TOKEN = 'dp.st.dev.fake0000token0000value0000forthistest';

const CONNECTION: SecretConnection = {
  id: 'conn-2',
  label: 'Team Doppler',
  provider: 'doppler',
  address: DOPPLER_API_BASE,
  authMethod: 'token',
};

const REF: DopplerSecretRef = { provider: 'doppler', connectionId: 'conn-2', name: 'GIT_TOKEN' };

function cannedTransport(
  answer: (request: SecretHttpRequest) => { status: number; body: unknown; headers?: Record<string, string> },
): { send: (request: SecretHttpRequest) => Promise<SecretHttpResponse>; seen: SecretHttpRequest[] } {
  const seen: SecretHttpRequest[] = [];
  return {
    seen,
    send: async (request) => {
      seen.push(request);
      const canned = answer(request);
      return {
        status: canned.status,
        headers: canned.headers ?? {},
        body: typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body),
      };
    },
  };
}

describe('verify', () => {
  it('reads the workplace out of the object it is, not as a string', async () => {
    // Read as a string this renders "[object Object]" in the one field whose
    // job is to say whose account the user just proved authority over.
    const transport = cannedTransport(() => ({
      status: 200,
      body: {
        type: 'service_token',
        slug: 'artemis-desktop',
        name: 'artemis-desktop',
        workplace: { id: 'wp_123', name: 'Example Co', billing_email: 'ops@example.com' },
      },
    }));
    const provider = createDopplerProvider(transport.send);

    const result = await provider.verify(CONNECTION, { token: TOKEN });
    expect(result.ok).toBe(true);
    expect(result.identity).toContain('Example Co');
    expect(result.identity).not.toContain('[object Object]');
    expect(result.detail).toContain('Example Co');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(transport.seen[0]?.url).toBe(`${DOPPLER_API_BASE}/v3/me`);
  });

  it('sends the token as a bearer, which is not the header OpenBao uses', async () => {
    const transport = cannedTransport(() => ({ status: 200, body: { workplace: { name: 'X' } } }));
    const provider = createDopplerProvider(transport.send);

    await provider.verify(CONNECTION, { token: TOKEN });
    expect(transport.seen[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('quotes Doppler’s own messages[] rather than paraphrasing them', async () => {
    const transport = cannedTransport(() => ({
      status: 401,
      body: { messages: ['Invalid Auth Token'], success: false },
    }));
    const provider = createDopplerProvider(transport.send);

    const result = await provider.verify(CONNECTION, { token: TOKEN });
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('bad-credentials');
    expect(result.detail).toContain('Invalid Auth Token');
  });

  it('honours retry-after on 429 and says the token itself may be fine', async () => {
    const transport = cannedTransport(() => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: { messages: ['Too many requests'], success: false },
    }));
    const provider = createDopplerProvider(transport.send);

    const result = await provider.verify(CONNECTION, { token: TOKEN });
    expect(result.degraded).toBe('rate-limited');
    expect(result.detail).toContain('30');
    // Rate limiting says nothing about the credential, and reporting it as a
    // bad token would send the user to mint one they do not need.
    expect(result.detail).toContain('may be fine');
  });
});

describe('resolve', () => {
  it('reads value.computed, not value.raw', async () => {
    // `raw` may be a reference to another secret. A client that hands `${…}`
    // to a subprocess produces an authentication failure for a token that is
    // perfectly good.
    const transport = cannedTransport(() => ({
      status: 200,
      body: { name: 'GIT_TOKEN', value: { raw: '${SHARED_TOKEN}', computed: 'the-real-value' } },
    }));
    const provider = createDopplerProvider(transport.send);

    expect((await provider.resolve(CONNECTION, { token: TOKEN }, REF)).value).toBe('the-real-value');
  });

  it('sends project and config only when the reference carries them', async () => {
    const transport = cannedTransport(() => ({
      status: 200,
      body: { value: { computed: 'v' } },
    }));
    const provider = createDopplerProvider(transport.send);

    await provider.resolve(CONNECTION, { token: TOKEN }, REF);
    const bare = new URL(transport.seen[0]?.url ?? '');
    // A service token already names its project and config, and Doppler
    // rejects a request that names another — so "just in case" turns a working
    // reference into a 401.
    expect(bare.searchParams.get('project')).toBeNull();
    expect(bare.searchParams.get('config')).toBeNull();
    expect(bare.searchParams.get('name')).toBe('GIT_TOKEN');

    await provider.resolve(CONNECTION, { token: TOKEN }, { ...REF, project: 'app', config: 'dev' });
    const scoped = new URL(transport.seen[1]?.url ?? '');
    expect(scoped.searchParams.get('project')).toBe('app');
    expect(scoped.searchParams.get('config')).toBe('dev');
  });

  it('reports a missing secret as absent, with Doppler’s wording', async () => {
    const transport = cannedTransport(() => ({
      status: 404,
      body: { messages: ['Could not find requested secret'], success: false },
    }));
    const provider = createDopplerProvider(transport.send);

    const error = (await provider
      .resolve(CONNECTION, { token: TOKEN }, REF)
      .catch((e: unknown) => e)) as SecretManagerError;
    expect(error.problem).toBe('absent');
    expect(error.message).toContain('Could not find requested secret');
    expect(error.retryable).toBe(false);
  });

  it('refuses an OpenBao reference rather than half-reading it', async () => {
    const provider = createDopplerProvider(async () => {
      throw new Error('should never be called');
    });
    await expect(
      provider.resolve(CONNECTION, { token: TOKEN }, {
        provider: 'openbao',
        connectionId: 'conn-2',
        mount: 'secret',
        path: 'p',
        key: 'k',
      }),
    ).rejects.toMatchObject({ problem: 'protocol' });
  });
});

describe('the seam', () => {
  it('declares no login, no renewal and nothing to forget, because Doppler has none of them', () => {
    // All three optional methods on `SecretManagerProvider` are optional
    // *because of this provider*. A caller must ask whether the method is
    // there rather than which provider it is holding.
    const provider = createDopplerProvider(async () => ({ status: 200, headers: {}, body: '{}' }));
    expect(provider.login).toBeUndefined();
    expect(provider.renew).toBeUndefined();
    // `forget` evicts what a provider cached about a connection. Doppler
    // caches nothing — there is no KV version to detect — so there is nothing
    // to drop when an address moves.
    expect(provider.forget).toBeUndefined();
    expect(provider.authMethods).toEqual(['token']);
  });

  it('describes its own reference fields, so the pane never needs a switch', () => {
    const provider = createDopplerProvider(async () => ({ status: 200, headers: {}, body: '{}' }));
    expect(provider.describe().refFields.map((field) => field.id)).toEqual(['name', 'project', 'config']);
  });
});
