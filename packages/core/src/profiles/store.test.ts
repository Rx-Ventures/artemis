/**
 * Tests for profile persistence.
 *
 * Two things here are worth more than the rest put together, and both are about
 * destruction rather than storage:
 *
 *  - **The v1 migration.** A profile's config directory holds a real login and
 *    real transcripts. A schema change that made those unreachable would look,
 *    to the user, exactly like Apollo having deleted them.
 *  - **The delete gate.** `configDir` is a path the *user* chose, and the most
 *    useful thing to put there is their own `~/.claude`. `rm -r` against that
 *    because a switch was left on is the worst thing this file could do.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProfileDraft } from '@rx-apollo/protocol';

import { CLAUDE_CREDENTIALS } from '../adapters/claude.js';
import { managedEnvKeys } from '../adapters/types.js';
import { ProfileError } from './errors.js';
import { profilesRoot } from './env.js';
import { PROFILE_STORE_FILE, ProfileStore } from './store.js';

let userDataDir: string;
let store: ProfileStore;
let counter: number;

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'apollo-store-'));
  counter = 0;
  store = new ProfileStore({
    userDataDir,
    // The store is provider-agnostic and takes this list rather than owning
    // one; the app builds it by unioning every registered adapter's spec.
    managedEnvKeys: managedEnvKeys(CLAUDE_CREDENTIALS),
    now: () => 1_700_000_000_000,
    newId: () => `id${++counter}`,
  });
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/** A directory inside Apollo's own root — the kind it created and may delete. */
const owned = (name: string): string => path.join(profilesRoot(userDataDir), name);

const draft = (overrides: Partial<ProfileDraft> = {}): ProfileDraft => ({
  label: 'Work',
  providerId: 'claude',
  configDir: owned('work'),
  ...overrides,
});

async function readDocument(): Promise<string> {
  return readFile(path.join(userDataDir, PROFILE_STORE_FILE), 'utf8');
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

describe('ProfileStore — create', () => {
  it('stores a record', async () => {
    const profile = await store.create(draft());

    expect(profile).toMatchObject({
      id: 'id1',
      label: 'Work',
      providerId: 'claude',
      configDir: owned('work'),
      publicEnv: {},
    });
  });

  it('has no credential to write anywhere', async () => {
    await store.create(draft());
    const raw = await readDocument();

    // Not a masked hint, not a `secretRef`, not a key. There is no secret in
    // this model, so there is nothing in this file worth stealing.
    expect(raw).not.toContain('secretRef');
    expect(raw).not.toContain('keyHint');
    expect(raw).not.toContain('sk-ant-');
  });

  it('writes the document with owner-only permissions', async () => {
    await store.create(draft());
    const stats = await stat(path.join(userDataDir, PROFILE_STORE_FILE));

    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('creates the profile signed out, which is the ordinary first state', async () => {
    // Signing in happens afterwards, in the user's own terminal. The store has
    // no opinion about it and nothing to refuse.
    await expect(store.create(draft())).resolves.toBeDefined();
  });

  it('lets two profiles share a config directory, which makes them one account', async () => {
    // Occasionally what someone means. `suggestConfigDir` is what stops it
    // happening by accident; the store does not forbid it on purpose.
    await store.create(draft({ label: 'A' }));
    await expect(store.create(draft({ label: 'B' }))).resolves.toBeDefined();
  });

  it('refuses a relative config directory', async () => {
    await expect(store.create(draft({ configDir: 'profiles/work' }))).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('refuses a traversing config directory', async () => {
    await expect(store.create(draft({ configDir: '/tmp/../../etc' }))).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('refuses an empty label', async () => {
    await expect(store.create(draft({ label: '   ' }))).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses an unknown provider', async () => {
    await expect(
      store.create(draft({ providerId: 'nope' as ProfileDraft['providerId'] })),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses credential-shaped publicEnv', async () => {
    // Written to a plaintext file, so this is a hard error rather than a
    // warning — and a credential set here would override the login anyway.
    await expect(
      store.create(draft({ publicEnv: { ANTHROPIC_AUTH_TOKEN: 'x' } })),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses publicEnv that would redirect the credential', async () => {
    // Holds no secret, passes the name heuristic, and yet aims the credential
    // the CLI holds at a host of the writer's choosing.
    for (const key of ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'NODE_OPTIONS', 'https_proxy']) {
      await expect(store.create(draft({ publicEnv: { [key]: 'x' } }))).rejects.toBeInstanceOf(
        ProfileError,
      );
    }
  });

  it('still allows model and region settings in publicEnv', async () => {
    const profile = await store.create(
      draft({ publicEnv: { ANTHROPIC_MODEL: 'claude-sonnet-5', AWS_REGION: 'us-east-1' } }),
    );

    expect(profile.publicEnv).toEqual({
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      AWS_REGION: 'us-east-1',
    });
  });

  it('refuses env Apollo manages itself', async () => {
    await expect(
      store.create(draft({ publicEnv: { CLAUDE_CONFIG_DIR: '/elsewhere' } })),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses a malformed env name', async () => {
    await expect(
      store.create(draft({ publicEnv: { 'not a name': 'x' } })),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it('serialises concurrent creates without losing records', async () => {
    await Promise.all([
      store.create(draft({ label: 'A', configDir: owned('a') })),
      store.create(draft({ label: 'B', configDir: owned('b') })),
      store.create(draft({ label: 'C', configDir: owned('c') })),
    ]);

    expect(await store.list()).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

describe('ProfileStore — read', () => {
  it('round-trips through the filesystem', async () => {
    await store.create(draft());
    const fresh = new ProfileStore({ userDataDir });

    expect(await fresh.list()).toHaveLength(1);
  });

  it('starts empty when there is no document yet', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('filters by provider', async () => {
    await store.create(draft());
    expect(await store.list('codex')).toEqual([]);
    expect(await store.list('claude')).toHaveLength(1);
  });

  it('throws a typed error for a missing profile', async () => {
    await expect(store.require('nope')).rejects.toBeInstanceOf(ProfileError);
  });

  it('projects metadata with the config directory and nothing else', async () => {
    const profile = await store.create(draft({ publicEnv: { AWS_REGION: 'us-east-1' } }));
    const metadata = await store.describe(profile.id);

    expect(metadata).toEqual({
      id: 'id1',
      label: 'Work',
      providerId: 'claude',
      configDir: owned('work'),
    });
  });

  it('suggests a directory no existing profile uses', async () => {
    await store.create(draft({ label: 'Work' }));

    expect(await store.suggestConfigDir('Work')).toBe(owned('work-2'));
  });

  it('refuses to parse a corrupt document', async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(path.join(userDataDir, PROFILE_STORE_FILE), '{ not json');

    await expect(new ProfileStore({ userDataDir }).list()).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses a document from a future schema version', async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      path.join(userDataDir, PROFILE_STORE_FILE),
      JSON.stringify({ version: 99, profiles: [] }),
    );

    await expect(new ProfileStore({ userDataDir }).list()).rejects.toBeInstanceOf(ProfileError);
  });
});

/* -------------------------------------------------------------------------- */
/* v1 migration                                                               */
/* -------------------------------------------------------------------------- */

describe('ProfileStore — reading a version 1 document', () => {
  async function writeLegacy(): Promise<void> {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      path.join(userDataDir, PROFILE_STORE_FILE),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: 'old1',
            label: 'Legacy',
            providerId: 'claude',
            backend: 'anthropic',
            authMode: 'subscription',
            configDirName: 'legacy-old1',
            secretRef: 'profile-old1',
            publicEnv: { AWS_REGION: 'us-east-1' },
          },
        ],
      }),
    );
  }

  it('resolves the old bare name against the same root version 1 used', async () => {
    await writeLegacy();
    const [profile] = await new ProfileStore({ userDataDir }).list();

    // The directory this points at already exists and holds the user's login
    // and transcripts. Getting this join wrong would present as Apollo having
    // lost their account.
    expect(profile?.configDir).toBe(owned('legacy-old1'));
  });

  it('keeps the label and publicEnv, and drops the fields that no longer mean anything', async () => {
    await writeLegacy();
    const [profile] = await new ProfileStore({ userDataDir }).list();

    expect(profile).toMatchObject({ id: 'old1', label: 'Legacy', providerId: 'claude' });
    expect(profile?.publicEnv).toEqual({ AWS_REGION: 'us-east-1' });
    expect(profile).not.toHaveProperty('secretRef');
    expect(profile).not.toHaveProperty('authMode');
    expect(profile).not.toHaveProperty('backend');
  });

  it('rewrites the document at the current version once it is touched', async () => {
    await writeLegacy();
    const migrated = new ProfileStore({ userDataDir, now: () => 1, newId: () => 'id9' });
    await migrated.update('old1', { label: 'Renamed' });

    const raw = JSON.parse(await readDocument()) as { version: number };
    expect(raw.version).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Update                                                                     */
/* -------------------------------------------------------------------------- */

describe('ProfileStore — update', () => {
  it('changes label, config directory and publicEnv', async () => {
    const created = await store.create(draft());
    const updated = await store.update(created.id, {
      label: 'Renamed',
      configDir: owned('renamed'),
      publicEnv: { AWS_REGION: 'eu-west-1' },
    });

    expect(updated).toMatchObject({
      label: 'Renamed',
      configDir: owned('renamed'),
      publicEnv: { AWS_REGION: 'eu-west-1' },
    });
  });

  it('leaves fields the patch omits alone', async () => {
    const created = await store.create(draft({ publicEnv: { AWS_REGION: 'us-east-1' } }));
    const updated = await store.update(created.id, { label: 'Renamed' });

    expect(updated.configDir).toBe(owned('work'));
    expect(updated.publicEnv).toEqual({ AWS_REGION: 'us-east-1' });
  });

  it('refuses a malformed config directory on update', async () => {
    const created = await store.create(draft());

    await expect(store.update(created.id, { configDir: 'relative' })).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('rejects an unknown id', async () => {
    await expect(store.update('nope', { label: 'x' })).rejects.toBeInstanceOf(ProfileError);
  });
});

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

describe('ProfileStore — delete', () => {
  it('removes the record and keeps history by default', async () => {
    const created = await store.create(draft());
    await mkdir(created.configDir, { recursive: true });

    const result = await store.delete(created.id);

    expect(result).toEqual({ id: created.id, configDirDeleted: false });
    expect(await store.list()).toEqual([]);
    await expect(stat(created.configDir)).resolves.toBeDefined();
  });

  it('removes a directory Apollo created, on request', async () => {
    const created = await store.create(draft());
    await mkdir(created.configDir, { recursive: true });

    const result = await store.delete(created.id, { deleteConfigDir: true });

    expect(result.configDirDeleted).toBe(true);
    await expect(stat(created.configDir)).rejects.toThrow();
  });

  it('REFUSES to delete a directory the user chose, however it is asked', async () => {
    // The one that matters. A profile pointed at `~/.claude` names the user's
    // real Claude installation — their login, every project transcript, and the
    // credential every other profile pointing there depends on. A switch in a
    // dialog is not authority to `rm -r` it.
    const outside = path.join(userDataDir, 'not-apollos', '.claude');
    await mkdir(outside, { recursive: true });
    const created = await store.create(draft({ configDir: outside }));

    const result = await store.delete(created.id, { deleteConfigDir: true });

    // The profile goes; the directory stays; the caller is told which happened
    // rather than left to assume the deletion took.
    expect(result.configDirDeleted).toBe(false);
    expect(await store.list()).toEqual([]);
    await expect(stat(outside)).resolves.toBeDefined();
  });

  it('refuses to delete the profiles root itself', async () => {
    // Equality with the root counts as outside: deleting it would take every
    // profile's history at once.
    const created = await store.create(draft({ configDir: profilesRoot(userDataDir) }));
    await mkdir(created.configDir, { recursive: true });

    const result = await store.delete(created.id, { deleteConfigDir: true });

    expect(result.configDirDeleted).toBe(false);
    await expect(stat(profilesRoot(userDataDir))).resolves.toBeDefined();
  });

  it('reports configDirDeleted false when there was no directory', async () => {
    const created = await store.create(draft());

    expect(await store.delete(created.id, { deleteConfigDir: true })).toEqual({
      id: created.id,
      configDirDeleted: false,
    });
  });

  it('rejects an unknown id', async () => {
    await expect(store.delete('nope')).rejects.toBeInstanceOf(ProfileError);
  });
});
