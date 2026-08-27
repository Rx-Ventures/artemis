/**
 * The registry, and the promises it makes about a resolved value.
 *
 * Three properties are worth a test here, and only one of them is about
 * storage:
 *
 *  1. **The plain file holds no credential.** `secret-managers.json` is
 *     readable, hand-editable, and a user is invited to check it. If a token
 *     ever appeared in it the argument in `core/secrets/credentials.ts` would
 *     be false.
 *  2. **A resolved value is scrubbed for exactly as long as it is live.**
 *     Between `resolve` and `dispose` the literal is removed from anything
 *     that goes through `scrubSecrets` — including code with no idea a secret
 *     is in flight — and after `dispose` it is not, because a value Artemis
 *     keeps scrubbing is a value Artemis still knows.
 *  3. **The certificate preview writes nothing.** It is the one unverified
 *     socket in the feature, and that is acceptable only because no request
 *     rides on it.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EphemeralSecretManagerCredentials,
  SecretManagerError,
  type SecretManagerProvider,
  type SecretProviderDescriptor,
} from '@rx-artemis/core';
import type { SecretConnection, SecretProviderId } from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* A fake TLS server, for the certificate preview                             */
/* -------------------------------------------------------------------------- */

/** Everything written to the preview socket. Must stay empty. */
const socketWrites: unknown[] = [];
let handshakeFails = false;

class FakeTlsSocket extends EventEmitter {
  destroyed = false;
  setTimeout(): void {}
  write(chunk: unknown): boolean {
    socketWrites.push(chunk);
    return true;
  }
  end(chunk?: unknown): void {
    if (chunk !== undefined) socketWrites.push(chunk);
  }
  destroy(): void {
    this.destroyed = true;
  }
  getPeerCertificate(): unknown {
    const issuer = {
      subject: { CN: 'Example Internal CA', O: 'Example' },
      issuer: { CN: 'Example Internal CA', O: 'Example' },
      fingerprint256: 'AA:BB',
      valid_to: 'Aug 27 12:00:00 2030 GMT',
      raw: Buffer.from('issuer-der-bytes'),
    };
    return {
      subject: { CN: 'vault.example.com' },
      issuer: { CN: 'Example Internal CA', O: 'Example' },
      fingerprint256: '9F:3C:1A:77',
      subjectaltname: 'DNS:vault.example.com, IP Address:100.75.234.21',
      valid_to: 'Aug 27 12:00:00 2027 GMT',
      raw: Buffer.from('leaf-der-bytes'),
      issuerCertificate: { ...issuer, issuerCertificate: issuer },
    };
  }
}

vi.mock('node:tls', () => ({
  connect: (_options: unknown, onSecure: () => void) => {
    const socket = new FakeTlsSocket();
    queueMicrotask(() => {
      if (handshakeFails) socket.emit('error', new Error('self signed certificate'));
      else onSecure();
    });
    return socket;
  },
}));

const {
  configureSecretManagers,
  deleteSecretConnection,
  fetchServerCertificate,
  listSecretConnections,
  resolveSecretRef,
  saveSecretConnection,
  testSecretRef,
  verifySecretConnection,
} = await import('./secretManagers.js');
const { liveSecretCount, scrubSecrets } = await import('./redact.js');

/* -------------------------------------------------------------------------- */
/* A fake provider                                                            */
/* -------------------------------------------------------------------------- */

const SECRET_VALUE = 'forgejo-9f3c1a77b2e04d6a8c5f0e1b7d4a9268';

const DESCRIPTOR: SecretProviderDescriptor = {
  id: 'openbao',
  label: 'OpenBao',
  note: 'test',
  authMethods: ['userpass', 'token'],
  configFields: [],
  refFields: [],
};

let loginCalls: { username: string; password: string }[] = [];
let resolveShouldFail: SecretManagerError | null = null;
let forgotten: string[] = [];

function fakeProvider(id: SecretProviderId): SecretManagerProvider {
  return {
    id,
    label: id,
    note: 'test',
    authMethods: id === 'openbao' ? ['userpass', 'token'] : ['token'],
    configFields: [],
    refFields: [],
    describe: () => ({ ...DESCRIPTOR, id, label: id }),
    verify: async (_config, credential) => ({
      ok: true,
      detail: 'fine',
      identity: `identity-for-${credential.token.slice(0, 4)}`,
      policies: ['bao-admin', 'default'],
    }),
    resolve: async () => {
      if (resolveShouldFail !== null) throw resolveShouldFail;
      return { value: SECRET_VALUE, siblingKeys: ['git_token', 'username'], dispose: () => undefined };
    },
    login: async (_config, username, password) => {
      loginCalls.push({ username, password });
      return {
        token: 'minted-token-abcdefghijklmnop',
        expiresAt: Date.now() + 3_600_000,
        renewable: true,
        policies: ['bao-admin'],
        identity: username,
      };
    },
    forget: (connectionId) => forgotten.push(connectionId),
  };
}

let userData = '';
let credentials: EphemeralSecretManagerCredentials;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'artemis-secrets-'));
  credentials = new EphemeralSecretManagerCredentials();
  loginCalls = [];
  forgotten = [];
  resolveShouldFail = null;
  handshakeFails = false;
  socketWrites.length = 0;
  configureSecretManagers(userData, credentials, {
    openbao: fakeProvider('openbao'),
    doppler: fakeProvider('doppler'),
  });
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

const OPENBAO_SAVE = {
  label: 'Work vault',
  provider: 'openbao' as const,
  address: 'https://vault.example.com:8200',
  authMethod: 'userpass' as const,
  username: 'demo',
  credential: { password: 'hunter2-and-then-some' },
};

describe('the connection registry', () => {
  it('round-trips a connection through the file', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    expect(saved.verify.ok).toBe(true);

    // Read back through a fresh configure, which is what a restart is.
    configureSecretManagers(userData, credentials, {
      openbao: fakeProvider('openbao'),
      doppler: fakeProvider('doppler'),
    });
    const listed = await listSecretConnections();
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]?.connection).toMatchObject({
      id: saved.id,
      label: 'Work vault',
      provider: 'openbao',
      address: 'https://vault.example.com:8200',
      authMethod: 'userpass',
      username: 'demo',
    });
    // The verification survives too, which is what lets a row say "expired
    // last Tuesday" instead of saying nothing until someone presses Verify.
    expect(listed.connections[0]?.lastVerify?.result.policies).toEqual(['bao-admin', 'default']);
  });

  it('writes no credential into the plain file — that is the whole split', async () => {
    await saveSecretConnection(OPENBAO_SAVE);
    const onDisk = await readFile(join(userData, 'secret-managers.json'), 'utf8');
    expect(onDisk).not.toContain('hunter2-and-then-some');
    expect(onDisk).not.toContain('minted-token');
    // …and it does hold the things a person is invited to check.
    expect(onDisk).toContain('vault.example.com');
  });

  it('spends a userpass password on a login and stores only the minted token', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    expect(loginCalls).toEqual([{ username: 'demo', password: 'hunter2-and-then-some' }]);
    const stored = await credentials.read(saved.id);
    expect(stored?.token).toBe('minted-token-abcdefghijklmnop');
    expect(stored?.expiresAt).toBeGreaterThan(Date.now());
    // The password itself is nowhere: not in the store, not in the registry.
    expect(JSON.stringify(stored)).not.toContain('hunter2');
  });

  it('keeps the stored credential when a save carries none', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    // A user fixing a label must not have to retype a password, and a save
    // that silently emptied the credential would be a connection that works
    // today and stops overnight.
    await saveSecretConnection({ ...OPENBAO_SAVE, id: saved.id, label: 'Work vault v2', credential: undefined });
    expect(loginCalls).toHaveLength(1);
    expect((await credentials.read(saved.id))?.token).toBe('minted-token-abcdefghijklmnop');
  });

  it('drops anything cached about a connection whose address may have moved', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    await saveSecretConnection({ ...OPENBAO_SAVE, id: saved.id, address: 'https://elsewhere:8200' });
    expect(forgotten).toContain(saved.id);
  });

  it('deletes the credential with the connection', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    expect(await credentials.has(saved.id)).toBe(true);

    const after = await deleteSecretConnection({ id: saved.id });
    expect(after.connections).toHaveLength(0);
    // A credential left behind for a connection nobody can see is a secret
    // this machine holds and cannot name.
    expect(await credentials.has(saved.id)).toBe(false);
  });

  it('reports a connection with no credential rather than pretending it works', async () => {
    const saved = await saveSecretConnection({ ...OPENBAO_SAVE, credential: undefined });
    expect(saved.verify.ok).toBe(false);
    expect(saved.verify.problem).toBe('bad-credentials');

    const verified = await verifySecretConnection({ id: saved.id });
    expect(verified.verify.ok).toBe(false);
  });

  it('reports an expired token as expired, without a round trip', async () => {
    const saved = await saveSecretConnection({ ...OPENBAO_SAVE, credential: { token: 'stale-token-value' } });
    await credentials.write(saved.id, { token: 'stale-token-value', expiresAt: Date.now() - 1000 });

    const verified = await verifySecretConnection({ id: saved.id });
    expect(verified.verify.problem).toBe('expired');
    expect(verified.verify.detail).toContain('password again');
  });

  it('never returns the credential in the listing, only whether there is one', async () => {
    await saveSecretConnection(OPENBAO_SAVE);
    const listed = await listSecretConnections();
    expect(listed.connections[0]?.hasCredential).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('minted-token');
  });
});

describe('resolving a reference', () => {
  const ref = (connectionId: string) =>
    ({
      provider: 'openbao' as const,
      connectionId,
      mount: 'secret',
      path: 'claude/artemis',
      key: 'git_token',
    });

  it('protects the literal value for exactly as long as it is held', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);

    // Before: the value is nothing special to the scrub.
    expect(scrubSecrets(`token=${SECRET_VALUE}`)).toContain(SECRET_VALUE);
    const before = liveSecretCount();

    const resolved = await resolveSecretRef(ref(saved.id));
    expect(resolved.value).toBe(SECRET_VALUE);
    expect(liveSecretCount()).toBe(before + 1);
    // While it is live, code with no idea a secret is in flight is covered.
    expect(scrubSecrets(`git said: ${SECRET_VALUE} is wrong`)).not.toContain(SECRET_VALUE);

    resolved.dispose();
    expect(liveSecretCount()).toBe(before);
    // After: a value Artemis keeps scrubbing is a value Artemis still knows.
    expect(scrubSecrets(`token=${SECRET_VALUE}`)).toContain(SECRET_VALUE);
  });

  it('refuses a reference whose connection is gone, rather than resolving something else', async () => {
    await expect(resolveSecretRef(ref('no-such-connection'))).rejects.toMatchObject({
      problem: 'protocol',
    });
  });

  it('refuses a reference whose provider disagrees with its connection', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    await expect(
      resolveSecretRef({ provider: 'doppler', connectionId: saved.id, name: 'GIT_TOKEN' }),
    ).rejects.toMatchObject({ problem: 'protocol' });
  });
});

describe('testing a reference', () => {
  it('answers with the key names and never with a value', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    const before = liveSecretCount();

    const result = await testSecretRef({
      ref: { provider: 'openbao', connectionId: saved.id, mount: 'secret', path: 'p', key: 'git_token' },
    });

    expect(result.found).toBe(true);
    expect(result.keysAtPath).toEqual(['git_token', 'username']);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    // Resolved and disposed: the test takes the real path and keeps nothing.
    expect(liveSecretCount()).toBe(before);
  });

  it('passes a categorised refusal through as a sentence, with the names it carried', async () => {
    const saved = await saveSecretConnection(OPENBAO_SAVE);
    resolveShouldFail = new SecretManagerError(
      'missing-key',
      'secret/p has no key named “git-token”. It has: git_token, username.',
      ['git_token', 'username'],
    );

    const result = await testSecretRef({
      ref: { provider: 'openbao', connectionId: saved.id, mount: 'secret', path: 'p', key: 'git-token' },
    });
    expect(result.found).toBe(false);
    expect(result.problem).toContain('git_token');
    expect(result.keysAtPath).toEqual(['git_token', 'username']);
  });
});

describe('the certificate preview', () => {
  it('returns the chain in the shape the pane renders, and writes nothing', async () => {
    const certificate = await fetchServerCertificate({ address: 'https://vault.example.com:8200' });

    expect(certificate.fingerprintSha256).toBe('9F:3C:1A:77');
    expect(certificate.subject).toContain('CN=vault.example.com');
    expect(certificate.issuer).toContain('CN=Example Internal CA');
    expect(certificate.san).toEqual(['DNS:vault.example.com', 'IP Address:100.75.234.21']);
    expect(certificate.notAfter).toBe(new Date('Aug 27 12:00:00 2027 GMT').toISOString());
    expect(certificate.pem).toContain('-----BEGIN CERTIFICATE-----');
    // The chain had an issuer, so the issuer is what gets pinned — pinning the
    // leaf would break on the server's next renewal.
    expect(Buffer.from(certificate.pem.split('\n').slice(1, -2).join(''), 'base64').toString()).toBe(
      'issuer-der-bytes',
    );
    expect(certificate.selfSigned).toBe(false);

    // The property that makes an unverified socket acceptable at all.
    expect(socketWrites).toEqual([]);
  });

  it('refuses a plain-http address instead of pretending to fetch one', async () => {
    await expect(fetchServerCertificate({ address: 'http://vault.example.com:8200' })).rejects.toThrow(
      /presents no certificate/,
    );
  });

  it('reports a handshake failure rather than hanging', async () => {
    handshakeFails = true;
    await expect(fetchServerCertificate({ address: 'https://vault.example.com:8200' })).rejects.toThrow(
      /Could not reach/,
    );
  });
});
