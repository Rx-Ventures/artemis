/**
 * The bank credential store's contract, exercised through the test double.
 *
 * The `safeStorage` half lives in `apps/desktop/main/memoryBankSecrets.ts` and
 * cannot be tested here — core may not import Electron, which is the reason
 * this interface exists at all. What *is* testable here is the shape every
 * implementation has to honour, and the two methods whose whole purpose is a
 * promise about what they do not do: `has` and `list` answer without
 * decrypting, which is why they are separate from `read` rather than being
 * written in terms of it.
 *
 * The username is asserted alongside the token throughout. Storing it is the
 * decision that keeps a token out of the username slot — git echoes that field
 * into its own error output, which Artemis shows the user — so a store that
 * lost it would quietly reintroduce the guessing this design removed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { EphemeralMemoryBankSecrets, type MemoryBankSecrets } from '../secrets.js';

const TOKEN = 'forgejo-9f3c1a77b2e04d6a8c5f0e1b7d4a9268';

let secrets: MemoryBankSecrets;

beforeEach(() => {
  secrets = new EphemeralMemoryBankSecrets();
});

describe('MemoryBankSecrets', () => {
  it('reads back what it stored, both halves', async () => {
    await secrets.write('team', { kind: 'token', token: TOKEN, username: 'x-access-token' });
    expect(await secrets.read('team')).toEqual({ kind: 'token', token: TOKEN, username: 'x-access-token' });
  });

  it('answers null for a bank that has none', async () => {
    // The ordinary state: most banks are public, or reached over ssh with a
    // key this store has nothing to do with.
    expect(await secrets.read('team')).toBeNull();
    expect(await secrets.has('team')).toBe(false);
  });

  it('replaces rather than accumulates, so a rotated token is the only one', async () => {
    await secrets.write('team', { kind: 'token', token: TOKEN, username: 'x-access-token' });
    await secrets.write('team', { kind: 'token', token: 'rotated', username: 'bank-deploy' });
    expect(await secrets.read('team')).toEqual({ kind: 'token', token: 'rotated', username: 'bank-deploy' });
    expect(await secrets.list()).toEqual(['team']);
  });

  it('keeps banks apart', async () => {
    await secrets.write('team', { kind: 'token', token: TOKEN, username: 'x-access-token' });
    await secrets.write('client-docs', { kind: 'token', token: 'other', username: 'x-access-token' });
    expect(await secrets.read('client-docs')).toMatchObject({ kind: 'token', token: 'other' });
    expect(await secrets.list()).toEqual(['team', 'client-docs']);
  });

  it('answers has() and list() for stored banks without producing the token', async () => {
    await secrets.write('team', { kind: 'token', token: TOKEN, username: 'x-access-token' });
    expect(await secrets.has('team')).toBe(true);
    expect(await secrets.list()).toEqual(['team']);
    // Neither answer is a credential, which is the whole reason they are not
    // written as `read(slug) !== null`.
    expect(JSON.stringify(await secrets.list())).not.toContain(TOKEN);
  });

  it('stores a reference instead of a token, which is the point of the second variant', async () => {
    // The whole arrangement in one assertion: this bank authenticates to a
    // private remote and nothing secret was written down for it. What came
    // back is an address, and `JSON.stringify` of the store's contents cannot
    // contain a credential because there is not one to contain.
    await secrets.write('team', {
      kind: 'ref',
      username: 'x-access-token',
      ref: {
        provider: 'openbao',
        connectionId: 'conn-1',
        mount: 'secret',
        path: 'claude/artemis',
        key: 'git_token',
      },
    });
    const stored = await secrets.read('team');
    expect(stored).toMatchObject({ kind: 'ref', username: 'x-access-token' });
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(await secrets.has('team')).toBe(true);
  });

  it('replaces a token with a reference, which is how a bank stops holding one', async () => {
    await secrets.write('team', { kind: 'token', token: TOKEN, username: 'x-access-token' });
    await secrets.write('team', {
      kind: 'ref',
      username: 'x-access-token',
      ref: { provider: 'doppler', connectionId: 'conn-2', name: 'GIT_TOKEN' },
    });
    // Replaced, not merged: a record that kept the old token beside the new
    // reference would be a machine still holding the credential it was just
    // told to stop holding.
    expect(JSON.stringify(await secrets.read('team'))).not.toContain(TOKEN);
  });

  it('clears idempotently, because forgetting a bank must not depend on order', async () => {
    await secrets.clear('team');
    await secrets.write('team', { kind: 'token', token: TOKEN, username: 'x-access-token' });
    await secrets.clear('team');
    await secrets.clear('team');
    expect(await secrets.read('team')).toBeNull();
    expect(await secrets.list()).toEqual([]);
  });
});
