/**
 * Connections declared by a deployment rather than by a person.
 *
 * Two properties are under test, and the second replaced an earlier one.
 *
 *  - **The environment never removes a grant, and never touches one it does
 *    not name.** Revocation is `connection revoke`, and a row the variable is
 *    silent about is the file's business alone.
 *  - **A declaration that names a token this server already has *updates* that
 *    grant.** This used to be "skips", which was right for rows the file owns
 *    and wrong for the rows this variable created: widening one meant revoking
 *    the connection and re-declaring it, which rotates the token every client
 *    is configured with. The bookkeeping — id, creation time, last use — is
 *    still the server's and survives.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ServerConnection } from '@rx-artemis/protocol';

import { loadConfig, mergeBootstrapConnections, saveConfig } from './config.js';

/** Tokens are floored at 32 characters, so the fixtures have to be real ones. */
const EXISTING_TOKEN = 'existing-token-aaaaaaaaaaaaaaaaaaaa';
const NEW_TOKEN = 'bootstrap-token-bbbbbbbbbbbbbbbbbbb';

const EXISTING: ServerConnection = {
  id: 'conn-existing',
  label: 'Minted by hand',
  workspace: { kind: 'directory', path: '/work/repo' },
  token: EXISTING_TOKEN,
  createdAt: 1,
};

const declare = (entries: readonly unknown[]): string => JSON.stringify(entries);

describe('bootstrapping connections from the environment', () => {
  it('adds one a deployment declared, with an id and a creation time of its own', () => {
    const merged = mergeBootstrapConnections(
      [EXISTING],
      declare([
        {
          label: 'laptop',
          token: NEW_TOKEN,
          workspace: { kind: 'directory', path: '/work/my-repo' },
        },
      ]),
    );

    expect(merged.added).toHaveLength(1);
    expect(merged.added[0]).toMatchObject({
      label: 'laptop',
      token: NEW_TOKEN,
      workspace: { kind: 'directory', path: '/work/my-repo' },
    });
    // Bookkeeping the declaration has no business carrying, supplied here.
    expect(merged.added[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(merged.added[0]?.createdAt).toBeGreaterThan(0);
    // And the row that was already there is untouched and still first.
    expect(merged.connections[0]).toBe(EXISTING);
    expect(merged.connections).toHaveLength(2);
  });

  it('adds nothing for a token it already has, so a redeploy converges', () => {
    // Identity is the token: the same grant declared with a different label is
    // the same grant, and adding it twice would leave one nobody could revoke.
    const merged = mergeBootstrapConnections(
      [EXISTING],
      declare([
        {
          label: 'Minted by hand',
          token: EXISTING_TOKEN,
          workspace: { kind: 'directory', path: '/work/repo' },
        },
      ]),
    );

    expect(merged.added).toEqual([]);
    expect(merged.updated).toEqual([]);
    // Byte-identical, and the same object: an unchanged redeploy must not
    // rewrite server.json or tell the operator that something happened.
    expect(merged.connections[0]).toBe(EXISTING);
  });

  it('updates the grant on a token it already has, keeping the bookkeeping', () => {
    /*
     * The case that used to be unreachable. An operator who edits the variable
     * and redeploys has said what the grant is; the alternative — ignoring it —
     * left them revoking the connection and re-declaring it, which rotates the
     * token every client is already configured with.
     */
    const merged = mergeBootstrapConnections(
      [{ ...EXISTING, lastUsedAt: 42 }],
      declare([
        {
          label: 'renamed',
          token: EXISTING_TOKEN,
          workspace: { kind: 'ephemeral' },
          manageProfiles: true,
        },
      ]),
    );

    expect(merged.added).toEqual([]);
    expect(merged.updated).toHaveLength(1);
    expect(merged.connections).toHaveLength(1);
    expect(merged.connections[0]).toEqual({
      // The operator's declaration, in full.
      label: 'renamed',
      workspace: { kind: 'ephemeral', perSession: true },
      manageProfiles: true,
      token: EXISTING_TOKEN,
      // This server's own bookkeeping, preserved: the id is the handle
      // `connection revoke` takes, and the timestamps are facts about this
      // server rather than claims the environment gets to make.
      id: 'conn-existing',
      createdAt: 1,
      lastUsedAt: 42,
    });
  });

  it('leaves a stored connection the variable does not name completely alone', () => {
    const other: ServerConnection = {
      id: 'conn-other',
      label: 'Not mentioned',
      workspace: { kind: 'none' },
      token: 'other-token-dddddddddddddddddddddd',
      createdAt: 2,
    };
    const merged = mergeBootstrapConnections(
      [EXISTING, other],
      declare([{ label: 'x', token: NEW_TOKEN, workspace: { kind: 'ephemeral' } }]),
    );

    expect(merged.connections[0]).toBe(EXISTING);
    expect(merged.connections[1]).toBe(other);
    expect(merged.connections).toHaveLength(3);
  });

  it('takes the administration grant only when it is literally true', () => {
    // Every other value a JSON blob can hold has to land as "no". This one
    // lets a token add accounts to the server and drive their logins, which
    // is the authority here that is bounded by nothing else.
    const merged = mergeBootstrapConnections(
      [],
      declare([
        { label: 'a', token: NEW_TOKEN, workspace: { kind: 'none' }, manageProfiles: true },
        {
          label: 'b',
          token: 'stringy-token-eeeeeeeeeeeeeeeeeeee',
          workspace: { kind: 'none' },
          manageProfiles: 'true',
        },
        {
          label: 'c',
          token: 'numeric-token-ffffffffffffffffffff',
          workspace: { kind: 'none' },
          manageProfiles: 1,
        },
      ]),
    );

    expect(merged.added.map((connection) => connection.manageProfiles)).toEqual([
      true,
      undefined,
      undefined,
    ]);
  });

  it('drops a malformed entry exactly as a corrupt stored one would be', () => {
    // A short token is the case that matters: it is the only thing standing
    // between this port and a guess, and half-accepting one would invent a
    // grant the operator did not make.
    const merged = mergeBootstrapConnections(
      [EXISTING],
      declare([
        { label: 'too short', token: 'nope', workspace: { kind: 'ephemeral' } },
        { label: 'no workspace', token: NEW_TOKEN },
        'not even an object',
        {
          label: 'the good one',
          token: 'third-token-cccccccccccccccccccccc',
          workspace: { kind: 'none' },
        },
      ]),
    );

    expect(merged.added.map((connection) => connection.label)).toEqual(['the good one']);
    expect(merged.ignored).toBe(3);
  });

  it('adds nothing at all when the variable is not readable', () => {
    // Reported rather than silently shrugged at: a deployment whose token did
    // nothing is the exact failure this feature exists to prevent.
    const merged = mergeBootstrapConnections([EXISTING], '{ not json');
    expect(merged.connections).toEqual([EXISTING]);
    expect(merged.added).toEqual([]);
    expect(merged.ignored).toBe(1);
  });

  it('refuses to be the second copy of a token it just added', () => {
    const merged = mergeBootstrapConnections(
      [],
      declare([
        { label: 'first', token: NEW_TOKEN, workspace: { kind: 'ephemeral' } },
        { label: 'second', token: NEW_TOKEN, workspace: { kind: 'ephemeral' } },
      ]),
    );
    expect(merged.added.map((connection) => connection.label)).toEqual(['first']);
  });

  it('normalises a workspace the same way a stored one is', () => {
    const merged = mergeBootstrapConnections(
      [],
      declare([
        { label: 'scratch', token: NEW_TOKEN, workspace: { kind: 'ephemeral', perSession: false } },
      ]),
    );
    expect(merged.added[0]?.workspace).toMatchObject({ kind: 'ephemeral', perSession: false });
  });
});

describe('reading connections back off disk', () => {
  it('round-trips the administration grant, and only when it was written', async () => {
    // The file is shared with the desktop app's Server tab, which has never
    // heard of this field. A connection without it has to come back without
    // it — absent and false are one state, and storing the default would make
    // a file written by this build differ from one written by the last.
    const dir = await mkdtemp(path.join(tmpdir(), 'artemis-config-'));
    try {
      await saveConfig(dir, {
        port: 6472,
        autoStart: false,
        connections: [
          { ...EXISTING, manageProfiles: true },
          { ...EXISTING, id: 'conn-plain', token: NEW_TOKEN },
        ],
      });

      const loaded = await loadConfig(dir);
      expect(loaded.connections[0]?.manageProfiles).toBe(true);
      expect(loaded.connections[1]).not.toHaveProperty('manageProfiles');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A token minted with a deadline still has one after a restart.
 *
 * The reader used to parse label, workspace, token, createdAt and allow and
 * stop there — so a connection the desktop app minted to expire on Friday came
 * back off disk with no expiry at all, and the server honoured it forever. That
 * is the one field where dropping the value *widens* the grant, which is why it
 * is also the one field whose unreadable form takes the whole row with it.
 */
describe('a connection that was given an expiry', () => {
  it('keeps it across a save and a load', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'artemis-config-'));
    try {
      await saveConfig(dir, {
        port: 6472,
        autoStart: false,
        connections: [{ ...EXISTING, expiresAt: 4_000, lastUsedAt: 3_000 }],
      });

      const loaded = await loadConfig(dir);
      expect(loaded.connections[0]?.expiresAt).toBe(4_000);
      // Carried for the same reason: this file is shared with the desktop app,
      // and rewriting it without this field erases the column that says whether
      // a token is safe to delete.
      expect(loaded.connections[0]?.lastUsedAt).toBe(3_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is absent, not null, on a connection that never had one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'artemis-config-'));
    try {
      await saveConfig(dir, { port: 6472, autoStart: false, connections: [EXISTING] });
      const loaded = await loadConfig(dir);
      expect(loaded.connections[0]).not.toHaveProperty('expiresAt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops the whole row when the expiry is there but unreadable', () => {
    // Fails closed. Loading it without the deadline would turn a token that
    // stops working on Friday into one that never stops, silently.
    for (const bad of ['4000', null, Number.NaN, {}]) {
      const merged = mergeBootstrapConnections(
        [],
        declare([
          {
            label: 'laptop',
            token: NEW_TOKEN,
            workspace: { kind: 'directory', path: '/work/my-repo' },
            expiresAt: bad,
          },
        ]),
      );
      expect(merged.added).toEqual([]);
      expect(merged.ignored).toBe(1);
    }
  });

  it('lets a declaration set and clear the expiry on a token it already owns', () => {
    // Expiry is part of the grant, so it is re-declared with it — including by
    // omission, which is why the merge reports the row as updated.
    const dated = mergeBootstrapConnections(
      [EXISTING],
      declare([{ ...EXISTING, expiresAt: 9_000 }]),
    );
    expect(dated.updated[0]).toMatchObject({ id: 'conn-existing', expiresAt: 9_000 });

    const cleared = mergeBootstrapConnections(
      [{ ...EXISTING, expiresAt: 9_000 }],
      declare([EXISTING]),
    );
    expect(cleared.updated[0]).not.toHaveProperty('expiresAt');
  });

  it('never takes a last-use claim from the environment', () => {
    // `createdAt` and `lastUsedAt` are this server's own observations; a
    // declaration carrying either is making a claim about the past.
    const merged = mergeBootstrapConnections(
      [],
      declare([
        {
          label: 'laptop',
          token: NEW_TOKEN,
          workspace: { kind: 'directory', path: '/work/my-repo' },
          lastUsedAt: 1_999_999,
        },
      ]),
    );
    expect(merged.added[0]).not.toHaveProperty('lastUsedAt');
  });
});
