/**
 * OpenBao's four traps, pinned.
 * ============================================================================
 *
 * The provider is written against a live OpenBao v2.6.2 and its file header
 * names four behaviours that are load-bearing and non-obvious. Each of them is
 * a test here, because each of them is the kind of thing a later refactor
 * "simplifies" and only finds out about in production:
 *
 *  1. A login failure arrives as **400**, which is not a malformed request.
 *  2. `lookup-self` hands back the plaintext token in `data.id`.
 *  3. **403** is denied-*or*-absent and must never render as "not found".
 *  4. `sys/health` answers **429** for a standby node, which is usable.
 *
 * Everything runs against a canned transport rather than a server: the
 * interesting inputs are exact status/body pairs from a real vault, and a
 * fixture is the only way to have all of them, including the ones that need a
 * sealed cluster.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBaoProvider, readTokenInfo, shouldRenewToken, describeHealth } from '../openbao.js';
import { SecretManagerError, type SecretHttpRequest, type SecretHttpResponse } from '../types.js';
import type { OpenBaoSecretRef, SecretConnection } from '@rx-artemis/protocol';

/** The token that must never appear in anything this module returns. */
const TOKEN = 'hvs.CAESIJ7fake0000token0000value0000forthistest';

const CONNECTION: SecretConnection = {
  id: 'conn-1',
  label: 'Work vault',
  provider: 'openbao',
  address: 'https://vault.example.com:8200',
  authMethod: 'userpass',
  username: 'demo',
};

const REF: OpenBaoSecretRef = {
  provider: 'openbao',
  connectionId: 'conn-1',
  mount: 'secret',
  path: 'claude/artemis',
  key: 'git_token',
  kvVersion: 2,
};

type Canned = { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> };

/**
 * A transport that answers from a table of URL fragments.
 *
 * Matched on a substring rather than on an exact URL so a test can say "the
 * KV read" without restating the escaping rules the provider is responsible
 * for — and `seen` keeps the whole request list, which is how the detection
 * ladder's *shape* (which URLs, in which order) is asserted at all.
 */
function cannedTransport(table: readonly (readonly [string, Canned])[]): {
  send: (request: SecretHttpRequest) => Promise<SecretHttpResponse>;
  seen: SecretHttpRequest[];
} {
  const seen: SecretHttpRequest[] = [];
  return {
    seen,
    send: async (request) => {
      seen.push(request);
      const match = table.find(([fragment]) => request.url.includes(fragment));
      if (match === undefined) throw new Error(`no fixture for ${request.url}`);
      const [, canned] = match;
      return {
        status: canned.status,
        headers: canned.headers ?? {},
        body: typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body),
      };
    },
  };
}

const HEALTHY = { status: 200, body: { initialized: true, sealed: false, standby: false, version: '2.6.2' } };

describe('userpass login', () => {
  it('reads 400 as bad credentials, not as a malformed request', async () => {
    // The trap: OpenBao answers a wrong username or password with 400, and a
    // client that maps 400 to "protocol error" sends the user to check their
    // address instead of their password.
    const transport = cannedTransport([
      ['auth/userpass/login', { status: 400, body: { errors: ['invalid username or password'] } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    await expect(provider.login?.(CONNECTION, 'demo', 'wrong')).rejects.toMatchObject({
      problem: 'bad-credentials',
    });
  });

  it('escapes the username, because it is a path segment', async () => {
    const transport = cannedTransport([['auth/userpass/login', { status: 200, body: { auth: { client_token: TOKEN, lease_duration: 3600, token_policies: ['default'], renewable: true } } }]]);
    const provider = createOpenBaoProvider(transport.send);

    await provider.login?.(CONNECTION, 'a/b', 'password');

    // An account name with a slash would otherwise address a different auth
    // method entirely.
    expect(transport.seen[0]?.url).toContain('/auth/userpass/login/a%2Fb');
  });

  it('turns the lease into an expiry, and reports the policies', async () => {
    const transport = cannedTransport([
      [
        'auth/userpass/login',
        {
          status: 200,
          body: {
            auth: {
              client_token: TOKEN,
              lease_duration: 2764800,
              token_policies: ['bao-admin', 'default'],
              renewable: true,
              metadata: { username: 'demo' },
            },
          },
        },
      ],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const minted = await provider.login?.(CONNECTION, 'demo', 'password');
    expect(minted?.policies).toEqual(['bao-admin', 'default']);
    expect(minted?.identity).toBe('demo');
    expect(minted?.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('token lookup', () => {
  /** A real `lookup-self` body, with `data.id` where OpenBao actually puts it. */
  const LOOKUP = {
    data: {
      id: TOKEN,
      accessor: 'hmac-sha256:abcdef',
      policies: ['bao-admin', 'default'],
      ttl: 2761000,
      creation_ttl: 2764800,
      expire_time: '2026-09-28T09:14:03.123456789Z',
      display_name: 'userpass-demo',
      meta: { username: 'demo' },
    },
  };

  it('rebuilds the answer without the token in it', () => {
    // The single most important assertion in this file. `data.id` IS the
    // credential, and a result carrying it would publish the token into every
    // log line that ever prints a verify result.
    const info = readTokenInfo(LOOKUP);
    expect(JSON.stringify(info)).not.toContain(TOKEN);
    expect(info).toEqual({
      policies: ['bao-admin', 'default'],
      ttl: 2761000,
      creationTtl: 2764800,
      expireTime: '2026-09-28T09:14:03.123456789Z',
      displayName: 'userpass-demo',
    });
  });

  it('carries the identity, policies and expiry into a verify result — and not the token', async () => {
    const transport = cannedTransport([
      ['sys/health', HEALTHY],
      ['auth/token/lookup-self', { status: 200, body: LOOKUP }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const result = await provider.verify(CONNECTION, { token: TOKEN });
    expect(result.ok).toBe(true);
    expect(result.identity).toBe('userpass-demo');
    expect(result.policies).toEqual(['bao-admin', 'default']);
    expect(result.expiresAt).toBe('2026-09-28T09:14:03.123456789Z');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('reports a refused token as expired rather than as a denied path', async () => {
    const transport = cannedTransport([
      ['sys/health', HEALTHY],
      ['auth/token/lookup-self', { status: 403, body: { errors: ['permission denied'] } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    await expect(provider.verify(CONNECTION, { token: TOKEN })).rejects.toMatchObject({
      problem: 'expired',
    });
  });
});

describe('reading a secret', () => {
  it('unwraps KV v2’s double nesting', async () => {
    const transport = cannedTransport([
      [
        '/secret/data/claude/artemis',
        {
          status: 200,
          body: {
            data: {
              data: { git_token: 'the-value', username: 'x-access-token' },
              metadata: { version: 3, deletion_time: '', destroyed: false },
            },
          },
        },
      ],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const resolved = await provider.resolve(CONNECTION, { token: TOKEN }, REF);
    expect(resolved.value).toBe('the-value');
    expect(resolved.siblingKeys).toEqual(['git_token', 'username']);
  });

  it('reads KV v1’s flat body', async () => {
    const transport = cannedTransport([
      ['/secret/claude/artemis', { status: 200, body: { data: { git_token: 'the-value' } } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const resolved = await provider.resolve(CONNECTION, { token: TOKEN }, { ...REF, kvVersion: 1 });
    expect(resolved.value).toBe('the-value');
    // The v1 URL has no `/data/` segment, which is the entire difference
    // between the two engines on the read path.
    expect(transport.seen[0]?.url).not.toContain('/data/');
  });

  it('says a version was deleted rather than saying the path is empty', async () => {
    const transport = cannedTransport([
      [
        '/secret/data/',
        {
          status: 200,
          body: { data: { data: null, metadata: { deletion_time: '2026-08-20T10:00:00Z', destroyed: false } } },
        },
      ],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const error = await provider.resolve(CONNECTION, { token: TOKEN }, REF).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretManagerError);
    expect((error as SecretManagerError).problem).toBe('deleted-version');
    expect((error as SecretManagerError).message).toContain('2026-08-20T10:00:00Z');
  });

  it('lists the key NAMES when the key is missing, and no values', async () => {
    const transport = cannedTransport([
      [
        '/secret/data/',
        { status: 200, body: { data: { data: { git_token: 'secret-value', username: 'bot' }, metadata: {} } } },
      ],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const error = (await provider
      .resolve(CONNECTION, { token: TOKEN }, { ...REF, key: 'git-token' })
      .catch((e: unknown) => e)) as SecretManagerError;

    expect(error.problem).toBe('missing-key');
    expect(error.keysAtPath).toEqual(['git_token', 'username']);
    // The names are the diagnostic; the values are not, and must not ride
    // along on the error that carries them.
    expect(error.message).not.toContain('secret-value');
  });

  it('never renders 403 as "not found", and names the mount as well as the path', async () => {
    const transport = cannedTransport([
      ['/secret/data/', { status: 403, body: { errors: ['1 error occurred:\n\t* permission denied\n\n'] } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const error = (await provider.resolve(CONNECTION, { token: TOKEN }, REF).catch((e: unknown) => e)) as SecretManagerError;
    expect(error.problem).toBe('denied');
    expect(error.message.toLowerCase()).not.toContain('not found');
    expect(error.message).toContain('denied, or absent');
    expect(error.message).toContain('mount');
    // Terminal: a policy decision does not change by being asked again.
    expect(error.retryable).toBe(false);
  });

  it('treats a 404 with an empty errors array as proof of access', async () => {
    // The good diagnostic: the token could have read it, and there is nothing
    // there. Reporting this as "denied" throws away the only case where
    // OpenBao tells you which of the two it is.
    const transport = cannedTransport([['/secret/data/', { status: 404, body: { errors: [] } }]]);
    const provider = createOpenBaoProvider(transport.send);

    const error = (await provider.resolve(CONNECTION, { token: TOKEN }, REF).catch((e: unknown) => e)) as SecretManagerError;
    expect(error.problem).toBe('absent');
    expect(error.message).toContain('readable and empty');
  });

  it('says sealed, and says retrying will not help', async () => {
    const transport = cannedTransport([['/secret/data/', { status: 503, body: { errors: ['Vault is sealed'] } }]]);
    const provider = createOpenBaoProvider(transport.send);

    const error = (await provider.resolve(CONNECTION, { token: TOKEN }, REF).catch((e: unknown) => e)) as SecretManagerError;
    expect(error.problem).toBe('sealed');
    expect(error.retryable).toBe(false);
  });
});

describe('sys/health', () => {
  it('reads 429 as a standby node, which is usable', () => {
    // The trap: 429 is "too many requests" everywhere else on the web.
    const health = describeHealth({
      status: 429,
      headers: {},
      body: JSON.stringify({ initialized: true, sealed: false, standby: true, version: '2.6.2' }),
    });
    expect(health.standby).toBe(true);
    expect(health.sealed).toBe(false);
    expect(health.detail).toContain('not rate limiting');
  });

  it('reads 503 as sealed', () => {
    const health = describeHealth({
      status: 503,
      headers: {},
      body: JSON.stringify({ initialized: true, sealed: true, standby: false }),
    });
    expect(health.sealed).toBe(true);
  });

  it('reads 501 as uninitialised', () => {
    const health = describeHealth({
      status: 501,
      headers: {},
      body: JSON.stringify({ initialized: false, sealed: true, standby: false }),
    });
    expect(health.initialized).toBe(false);
  });

  it('marks a verify against a standby node as degraded rather than failed', async () => {
    const transport = cannedTransport([
      ['sys/health', { status: 429, body: { initialized: true, sealed: false, standby: true, version: '2.6.2' } }],
      [
        'auth/token/lookup-self',
        { status: 200, body: { data: { id: TOKEN, policies: ['default'], ttl: 100, creation_ttl: 200, expire_time: null, display_name: 'x' } } },
      ],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const result = await provider.verify(CONNECTION, { token: TOKEN });
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe('standby');
  });

  it('answers sealed as a result rather than an exception, so the pane can draw a row', async () => {
    const transport = cannedTransport([
      ['sys/health', { status: 503, body: { initialized: true, sealed: true, standby: false } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const result = await provider.verify(CONNECTION, { token: TOKEN });
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('sealed');
  });
});

describe('the kvVersion "auto" ladder', () => {
  const AUTO: OpenBaoSecretRef = { ...REF, kvVersion: 'auto' };

  it('takes the mount catalogue’s answer when it can read it', async () => {
    const transport = cannedTransport([
      ['sys/internal/ui/mounts/secret', { status: 200, body: { data: { type: 'kv', options: { version: '2' } } } }],
      ['/secret/data/', { status: 200, body: { data: { data: { git_token: 'v' }, metadata: {} } } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    expect((await provider.resolve(CONNECTION, { token: TOKEN }, AUTO)).value).toBe('v');
  });

  it('reads a missing options.version as v1', async () => {
    const transport = cannedTransport([
      ['sys/internal/ui/mounts/secret', { status: 200, body: { data: { type: 'kv', options: {} } } }],
      ['/secret/claude/artemis', { status: 200, body: { data: { git_token: 'v1-value' } } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    expect((await provider.resolve(CONNECTION, { token: TOKEN }, AUTO)).value).toBe('v1-value');
  });

  it('probes the v2 path when the catalogue is denied, and accepts a 404 as proof of v2', async () => {
    // A 404 on `/data/<path>` means the endpoint exists and the secret does
    // not — which is exactly the evidence needed, and the reason this rung
    // does not require a successful read.
    let dataReads = 0;
    const provider = createOpenBaoProvider(async (request) => {
      if (request.url.includes('sys/internal/ui/mounts')) {
        return { status: 403, headers: {}, body: JSON.stringify({ errors: ['permission denied'] }) };
      }
      if (request.url.includes('/secret/data/')) {
        dataReads += 1;
        return dataReads === 1
          ? { status: 404, headers: {}, body: JSON.stringify({ errors: [] }) }
          : { status: 200, headers: {}, body: JSON.stringify({ data: { data: { git_token: 'v' }, metadata: {} } }) };
      }
      throw new Error(`unexpected ${request.url}`);
    });

    expect((await provider.resolve(CONNECTION, { token: TOKEN }, AUTO)).value).toBe('v');
  });

  it('stops when both engines answer 403, rather than guessing', async () => {
    // The rung that matters most. Guessing here produces a 403 from the wrong
    // URL, which the user reads as "my secret is missing" and acts on by
    // rewriting a path that was correct.
    const transport = cannedTransport([
      ['sys/internal/ui/mounts/', { status: 403, body: { errors: ['permission denied'] } }],
      ['/secret/data/', { status: 403, body: { errors: ['permission denied'] } }],
      ['/secret/claude/artemis', { status: 403, body: { errors: ['permission denied'] } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const error = (await provider.resolve(CONNECTION, { token: TOKEN }, AUTO).catch((e: unknown) => e)) as SecretManagerError;
    expect(error.problem).toBe('undetermined');
    expect(error.message).toContain('guessing');
  });

  it('caches the detected version per connection and mount', async () => {
    const transport = cannedTransport([
      ['sys/internal/ui/mounts/secret', { status: 200, body: { data: { options: { version: '2' } } } }],
      ['/secret/data/', { status: 200, body: { data: { data: { git_token: 'v' }, metadata: {} } } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    await provider.resolve(CONNECTION, { token: TOKEN }, AUTO);
    await provider.resolve(CONNECTION, { token: TOKEN }, AUTO);

    const catalogueCalls = transport.seen.filter((request) => request.url.includes('sys/internal/ui/mounts'));
    expect(catalogueCalls).toHaveLength(1);

    // …and forgetting the connection drops it, because an address that has
    // been repointed must not inherit the last server's answers.
    provider.forget?.('conn-1');
    await provider.resolve(CONNECTION, { token: TOKEN }, AUTO);
    expect(transport.seen.filter((request) => request.url.includes('sys/internal/ui/mounts'))).toHaveLength(2);
  });

  it('does not ask at all when the version is stated', async () => {
    const transport = cannedTransport([
      ['/secret/data/', { status: 200, body: { data: { data: { git_token: 'v' }, metadata: {} } } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    await provider.resolve(CONNECTION, { token: TOKEN }, REF);
    expect(transport.seen.every((request) => !request.url.includes('sys/internal'))).toBe(true);
  });
});

describe('renewal', () => {
  it('renews below a quarter of the token’s life and not above it', () => {
    expect(shouldRenewToken({ ttl: 100, creationTtl: 1000 })).toBe(true);
    expect(shouldRenewToken({ ttl: 250, creationTtl: 1000 })).toBe(false);
    expect(shouldRenewToken({ ttl: 249, creationTtl: 1000 })).toBe(true);
    // A token with no expiry has nothing to extend, and asking would produce
    // an error about a perfectly healthy credential.
    expect(shouldRenewToken({ ttl: 0, creationTtl: 0 })).toBe(false);
    expect(shouldRenewToken({ ttl: 10, creationTtl: 0 })).toBe(false);
  });

  it('reads the granted lease back rather than assuming the increment', async () => {
    const transport = cannedTransport([
      [
        'auth/token/lookup-self',
        { status: 200, body: { data: { id: TOKEN, policies: [], ttl: 100, creation_ttl: 1000, expire_time: null, display_name: 'x' } } },
      ],
      ['auth/token/renew-self', { status: 200, body: { auth: { client_token: TOKEN, lease_duration: 600, renewable: true } } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    const outcome = await provider.renew?.(CONNECTION, { token: TOKEN });
    expect(outcome?.renewed).toBe(true);
    // 600, the granted lease — not whatever a client might have asked for.
    expect(outcome?.detail).toContain('600');
    expect(outcome?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('degrades silently when renewal is refused', async () => {
    const transport = cannedTransport([
      [
        'auth/token/lookup-self',
        { status: 200, body: { data: { id: TOKEN, policies: [], ttl: 10, creation_ttl: 1000, expire_time: null, display_name: 'x' } } },
      ],
      ['auth/token/renew-self', { status: 400, body: { errors: ['lease is not renewable'] } }],
    ]);
    const provider = createOpenBaoProvider(transport.send);

    // Never throws. A manager that will not extend a token has not broken it.
    const outcome = await provider.renew?.(CONNECTION, { token: TOKEN });
    expect(outcome?.renewed).toBe(false);
    expect(outcome?.detail).toContain('signing in again');
  });
});

describe('transport contract', () => {
  it('sends the token in OpenBao’s own header and passes the pinned certificate through', async () => {
    const transport = cannedTransport([['sys/health', HEALTHY], ['lookup-self', { status: 200, body: { data: { id: TOKEN, policies: [], ttl: 1, creation_ttl: 1, expire_time: null, display_name: 'x' } } }]]);
    const provider = createOpenBaoProvider(transport.send);

    await provider.verify({ ...CONNECTION, caPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n' }, { token: TOKEN });

    const authenticated = transport.seen.find((request) => request.url.includes('lookup-self'));
    expect(authenticated?.headers['X-Vault-Token']).toBe(TOKEN);
    expect(authenticated?.caPem).toContain('BEGIN CERTIFICATE');
    // The health probe is unauthenticated on purpose: it has to answer for a
    // manager whose token is the thing under suspicion.
    const health = transport.seen.find((request) => request.url.includes('sys/health'));
    expect(health?.headers['X-Vault-Token']).toBeUndefined();
  });
});
