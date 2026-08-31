/**
 * The encrypted store, and the four promises its file makes.
 *
 * `core/secrets/credentials.ts` argues that this credential is allowed to
 * exist because it removes others — the manager token is stored so that git
 * tokens do not have to be. That argument is only true if this file behaves,
 * so what is pinned here is behaviour rather than shape:
 *
 *  1. The token on disk is **ciphertext**; the expiry beside it is not, and
 *     that asymmetry is the honest record of what is being protected.
 *  2. A password never reaches this store at all — there is no field for one,
 *     which the type system enforces and this file states in prose.
 *  3. `has` answers without decrypting, because a boolean is the whole of what
 *     the pane asks.
 *  4. An unavailable keyring fails the **write**, loudly. A silent downgrade
 *     from encrypted to not is the one failure mode a boundary must not have.
 *
 * `safeStorage` is faked with a reversible transform rather than a spy that
 * returns a constant: the test has to be able to tell "stored encrypted" from
 * "stored, and the ciphertext happens to be the plaintext", and only a real
 * round trip does that.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Flipped by the test that checks a machine with no keyring. */
let encryptionAvailable = true;

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    // A reversible stand-in for the OS keychain: not encryption, but a
    // transform whose output is visibly not its input, which is exactly the
    // property the assertions below need.
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not decryptable on this machine');
      return text.slice(4);
    },
  },
}));

const { createSecretManagerCredentials } = await import('./secretManagerSecrets.js');

const TOKEN = 'hvs.CAESIJ7fake0000token0000value0000forthistest';
const FILE = 'secret-manager-credentials.json';

let userData = '';
let store: ReturnType<typeof createSecretManagerCredentials>;

beforeEach(async () => {
  encryptionAvailable = true;
  userData = await mkdtemp(join(tmpdir(), 'artemis-mgr-creds-'));
  store = createSecretManagerCredentials(userData);
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('SecretManagerCredentials on safeStorage', () => {
  it('reads back what it stored', async () => {
    await store.write('conn-1', { token: TOKEN, expiresAt: 1_800_000_000_000 });
    expect(await store.read('conn-1')).toEqual({ token: TOKEN, expiresAt: 1_800_000_000_000 });
  });

  it('writes the token as ciphertext and the expiry in clear', async () => {
    await store.write('conn-1', { token: TOKEN, expiresAt: 1_800_000_000_000 });
    const onDisk = await readFile(join(userData, FILE), 'utf8');

    // The whole point of the file. A reader can see which of the two values
    // this store treats as a secret.
    expect(onDisk).not.toContain(TOKEN);
    expect(onDisk).toContain('1800000000000');
  });

  it('answers null for a connection that has none', async () => {
    expect(await store.read('conn-1')).toBeNull();
    expect(await store.has('conn-1')).toBe(false);
  });

  it('answers has() without producing the token', async () => {
    await store.write('conn-1', { token: TOKEN });
    expect(await store.has('conn-1')).toBe(true);
    // Not written as `read(id) !== null`, because computing a boolean by
    // putting a secret in memory is exposure bought for nothing.
    expect(await store.has('conn-2')).toBe(false);
  });

  it('replaces rather than accumulates, so a rotated token is the only one', async () => {
    await store.write('conn-1', { token: TOKEN, expiresAt: 1 });
    await store.write('conn-1', { token: 'minted-later-token-value' });
    expect(await store.read('conn-1')).toEqual({ token: 'minted-later-token-value' });
    // The old expiry does not survive the replacement — a stale one would be
    // read as the new token's, and a connection would be reported expired
    // moments after being renewed.
    expect(await readFile(join(userData, FILE), 'utf8')).not.toContain('"expiresAt": 1');
  });

  it('keeps connections apart', async () => {
    await store.write('conn-1', { token: TOKEN });
    await store.write('conn-2', { token: 'the-other-one' });
    expect((await store.read('conn-2'))?.token).toBe('the-other-one');
    expect((await store.read('conn-1'))?.token).toBe(TOKEN);
  });

  it('takes the file away with the last credential', async () => {
    await store.write('conn-1', { token: TOKEN });
    await store.clear('conn-1');
    // An Artemis holding no manager credentials has no credential file, which
    // is a thing a user can check for themselves.
    await expect(readFile(join(userData, FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clears idempotently, because forgetting must not depend on order', async () => {
    await store.clear('conn-1');
    await store.write('conn-1', { token: TOKEN });
    await store.clear('conn-1');
    await store.clear('conn-1');
    expect(await store.read('conn-1')).toBeNull();
  });

  it('fails the write loudly when there is nowhere secure to put it', async () => {
    encryptionAvailable = false;
    // Never a silent downgrade to plaintext. A connection that cannot be
    // stored must not be reported as stored.
    await expect(store.write('conn-1', { token: TOKEN })).rejects.toThrow(/no secure storage/);
    await expect(readFile(join(userData, FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a credential it cannot decrypt as absent, rather than throwing', async () => {
    // A file copied from another machine, or a keychain entry since removed.
    // Absent is what it now is; the pane asks for the password again.
    await writeFile(join(userData, FILE), JSON.stringify({ 'conn-1': { token: 'bm90LWVuYw==' } }));
    expect(await store.read('conn-1')).toBeNull();
  });

  it('treats a corrupt file as empty rather than refusing to start', async () => {
    await writeFile(join(userData, FILE), 'not json at all');
    expect(await store.read('conn-1')).toBeNull();
    expect(await store.has('conn-1')).toBe(false);
  });

  it('reports a stored credential as absent when this session cannot decrypt at all', async () => {
    await store.write('conn-1', { token: TOKEN });
    encryptionAvailable = false;
    expect(await store.read('conn-1')).toBeNull();
  });
});
