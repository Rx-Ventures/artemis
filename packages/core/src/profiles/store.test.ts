import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProfileDraft } from '@rx-apollo/protocol';

import { CLAUDE_CREDENTIALS } from '../adapters/claude.js';
import { managedEnvKeys } from '../adapters/types.js';
import { ProfileError } from './errors.js';
import { InMemorySecretStore } from './secrets.js';
import { PROFILE_STORE_FILE, ProfileStore } from './store.js';

const API_KEY = 'sk-ant-api03-000111222333444555666777888999aabb4f2a';

let userDataDir: string;
let secrets: InMemorySecretStore;
let store: ProfileStore;
let counter: number;

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'apollo-store-'));
  secrets = new InMemorySecretStore();
  counter = 0;
  store = new ProfileStore({
    userDataDir,
    secrets,
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

const draft = (overrides: Partial<ProfileDraft> = {}): ProfileDraft => ({
  label: 'Work — Anthropic',
  providerId: 'claude',
  // Stated explicitly: the store no longer invents `'anthropic'` when a draft
  // omits the backend, because that is Claude's vocabulary and the store serves
  // every provider. Absent now means "the provider's own default".
  backend: 'anthropic',
  apiKey: API_KEY,
  ...overrides,
});

async function readDocument(): Promise<string> {
  return readFile(path.join(userDataDir, PROFILE_STORE_FILE), 'utf8');
}

describe('ProfileStore — create', () => {
  it('stores a record and puts the credential in the secret store', async () => {
    const profile = await store.create(draft());

    expect(profile).toMatchObject({
      id: 'id1',
      label: 'Work — Anthropic',
      providerId: 'claude',
      backend: 'anthropic',
      secretRef: 'profile-id1',
      publicEnv: {},
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    expect(profile.configDirName).toMatch(/^work-anthropic-id1$/);
    expect(await secrets.get('profile-id1')).toBe(API_KEY);
  });

  it('never writes the credential to disk', async () => {
    await store.create(draft());
    const document = await readDocument();

    expect(document).not.toContain(API_KEY);
    expect(document).not.toContain(API_KEY.slice(-8));
    expect(document).toContain('profile-id1');
  });

  it('writes the document with owner-only permissions', async () => {
    await store.create(draft());
    const info = await stat(path.join(userDataDir, PROFILE_STORE_FILE));

    // Skipped on Windows, where mode bits are not meaningful.
    if (process.platform !== 'win32') {
      expect(info.mode & 0o077).toBe(0);
    }
  });

  it('allows a profile with no credential — the "needs setup" state', async () => {
    const profile = await store.create(draft({ apiKey: undefined }));

    expect(secrets.has(profile.secretRef)).toBe(false);
    expect((await store.describe(profile)).keyHint).toBeNull();
  });

  it('gives each profile its own config directory name', async () => {
    const a = await store.create(draft({ label: 'Work' }));
    const b = await store.create(draft({ label: 'Work' }));

    expect(a.configDirName).not.toBe(b.configDirName);
  });

  it('accepts an explicit config directory name and rejects a duplicate', async () => {
    await store.create(draft({ configDirName: 'chosen-name' }));
    await expect(store.create(draft({ configDirName: 'chosen-name' }))).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('refuses a traversing config directory name', async () => {
    await expect(store.create(draft({ configDirName: '../escape' }))).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('refuses an empty label', async () => {
    await expect(store.create(draft({ label: '   ' }))).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses an unknown provider', async () => {
    await expect(
      store.create(draft({ providerId: 'gemini' as ProfileDraft['providerId'] })),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses credential-shaped publicEnv', async () => {
    for (const key of ['ANTHROPIC_API_KEY', 'MY_TOKEN', 'SOME_SECRET', 'DB_PASSWORD']) {
      await expect(store.create(draft({ publicEnv: { [key]: 'x' } }))).rejects.toBeInstanceOf(
        ProfileError,
      );
    }
  });

  it('refuses publicEnv that would redirect the credential', async () => {
    // These hold no secret and sail past the credential-name heuristic, but
    // `resolveEnv` puts the decrypted key into the same bundle — so accepting
    // one is an exfiltration primitive for anything that can write a profile.
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'HTTPS_PROXY',
      'https_proxy',
      'NODE_EXTRA_CA_CERTS',
      'NODE_OPTIONS',
    ]) {
      await expect(
        store.create(draft({ publicEnv: { [key]: 'https://attacker.example' } })),
      ).rejects.toBeInstanceOf(ProfileError);
      await expect(
        store.create(draft({ publicEnv: { [key]: 'https://attacker.example' } })),
      ).rejects.toThrow(/where the profile's credential is sent/);
    }
  });

  it('still allows model and region settings in publicEnv', async () => {
    const created = await store.create(
      draft({ publicEnv: { ANTHROPIC_MODEL: 'claude-opus-4', AWS_REGION: 'us-west-2' } }),
    );
    expect(created.publicEnv).toEqual({
      ANTHROPIC_MODEL: 'claude-opus-4',
      AWS_REGION: 'us-west-2',
    });
  });

  it('refuses env Apollo manages itself', async () => {
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK']) {
      await expect(store.create(draft({ publicEnv: { [key]: '1' } }))).rejects.toBeInstanceOf(
        ProfileError,
      );
    }
  });

  it('refuses a malformed env name', async () => {
    await expect(store.create(draft({ publicEnv: { 'not-a-var': 'x' } }))).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('stores the auth mode, and leaves it absent when the draft omits one', async () => {
    const subscription = await store.create(draft({ authMode: 'subscription' }));
    expect(subscription.authMode).toBe('subscription');

    // No default invented here, for the same reason as `backend`: which mode is
    // the usual one is the provider's answer, resolved when the env is built.
    const unspecified = await store.create(draft({ label: 'Second' }));
    expect(unspecified.authMode).toBeUndefined();
  });

  it('refuses a malformed auth mode id', async () => {
    for (const bad of ['Subscription', 'sub scription', '1mode', 'a'.repeat(40)]) {
      await expect(store.create(draft({ authMode: bad }))).rejects.toBeInstanceOf(ProfileError);
    }
  });

  it('never writes a subscription token to disk either', async () => {
    const token = 'sk-ant-oat01-0123456789abcdefdead';
    await store.create(draft({ authMode: 'subscription', apiKey: token }));
    const document = await readDocument();

    // The mode is a record; the token is a secret. Only one of them is here.
    expect(document).toContain('subscription');
    expect(document).not.toContain(token);
    expect(document).not.toContain(token.slice(-8));
  });

  it('serialises concurrent creates without losing records', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.create(draft({ label: `Account ${i}` }))),
    );

    expect(await store.list()).toHaveLength(8);
    const reopened = new ProfileStore({ userDataDir, secrets });
    expect(await reopened.list()).toHaveLength(8);
  });
});

describe('ProfileStore — read', () => {
  it('round-trips through the filesystem', async () => {
    const created = await store.create(draft({ publicEnv: { AWS_REGION: 'us-east-1' } }));

    const reopened = new ProfileStore({ userDataDir, secrets });
    expect(await reopened.get(created.id)).toEqual(created);
  });

  it('starts empty when there is no document yet', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('filters by provider', async () => {
    await store.create(draft());
    expect(await store.list('claude')).toHaveLength(1);
    expect(await store.list('codex')).toHaveLength(0);
  });

  it('throws a typed error for a missing profile', async () => {
    await expect(store.require('nope')).rejects.toBeInstanceOf(ProfileError);
    expect(await store.get('nope')).toBeUndefined();
  });

  it('projects metadata with a masked hint and nothing else', async () => {
    await store.create(draft());
    const [metadata] = await store.listMetadata();

    expect(metadata).toEqual({
      id: 'id1',
      label: 'Work — Anthropic',
      providerId: 'claude',
      backend: 'anthropic',
      keyHint: 'sk-ant-...4f2a',
    });
  });

  it('refuses to parse a corrupt document', async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(path.join(userDataDir, PROFILE_STORE_FILE), '{ not json');

    await expect(new ProfileStore({ userDataDir, secrets }).list()).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('loads a profile written before the auth-mode axis existed', async () => {
    // Absent means "the provider's default mode", so an old document keeps
    // billing exactly the way it did before this feature landed.
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
            configDirName: 'legacy-old1',
            secretRef: 'profile-old1',
            publicEnv: {},
          },
        ],
      }),
    );

    const [profile] = await new ProfileStore({ userDataDir, secrets }).list();
    expect(profile?.authMode).toBeUndefined();
  });

  it('refuses a document with a malformed authMode', async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      path.join(userDataDir, PROFILE_STORE_FILE),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: 'bad1',
            label: 'Hand edited',
            providerId: 'claude',
            authMode: 'NOT A MODE',
            configDirName: 'bad-bad1',
            secretRef: 'profile-bad1',
            publicEnv: {},
          },
        ],
      }),
    );

    await expect(new ProfileStore({ userDataDir, secrets }).list()).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('refuses a document from a future schema version', async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      path.join(userDataDir, PROFILE_STORE_FILE),
      JSON.stringify({ version: 99, profiles: [] }),
    );

    await expect(new ProfileStore({ userDataDir, secrets }).list()).rejects.toBeInstanceOf(
      ProfileError,
    );
  });
});

describe('ProfileStore — update', () => {
  it('changes label, backend and publicEnv', async () => {
    const created = await store.create(draft());
    const updated = await store.update(created.id, {
      label: 'Renamed',
      backend: 'bedrock',
      publicEnv: { AWS_REGION: 'eu-west-1' },
    });

    expect(updated).toMatchObject({
      id: created.id,
      label: 'Renamed',
      backend: 'bedrock',
      publicEnv: { AWS_REGION: 'eu-west-1' },
      configDirName: created.configDirName,
      secretRef: created.secretRef,
    });
  });

  it('leaves the credential alone when apiKey is omitted', async () => {
    const created = await store.create(draft());
    await store.update(created.id, { label: 'Renamed' });

    expect(await secrets.get(created.secretRef)).toBe(API_KEY);
  });

  it('replaces the credential when apiKey is a string', async () => {
    const created = await store.create(draft());
    await store.update(created.id, { apiKey: 'sk-ant-api03-replacement-value-9999' });

    expect(await secrets.get(created.secretRef)).toBe('sk-ant-api03-replacement-value-9999');
    expect(await readDocument()).not.toContain('replacement');
  });

  it('removes the credential when apiKey is null', async () => {
    const created = await store.create(draft());
    await store.update(created.id, { apiKey: null });

    expect(await secrets.get(created.secretRef)).toBeNull();
    expect((await store.describe(created.id)).keyHint).toBeNull();
  });

  it('rejects an empty apiKey rather than silently deleting it', async () => {
    const created = await store.create(draft());
    await expect(store.update(created.id, { apiKey: '   ' })).rejects.toBeInstanceOf(ProfileError);
    expect(await secrets.get(created.secretRef)).toBe(API_KEY);
  });

  it('switches the auth mode and leaves it alone when the patch omits it', async () => {
    const created = await store.create(draft({ authMode: 'api-key' }));

    const switched = await store.update(created.id, {
      authMode: 'subscription',
      apiKey: 'sk-ant-oat01-0123456789abcdefdead',
    });
    expect(switched.authMode).toBe('subscription');

    const renamed = await store.update(created.id, { label: 'Renamed' });
    expect(renamed.authMode).toBe('subscription');
  });

  it('rejects a malformed auth mode on update', async () => {
    const created = await store.create(draft());
    await expect(store.update(created.id, { authMode: 'NOT A MODE' })).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('rejects an unknown id', async () => {
    await expect(store.update('nope', { label: 'x' })).rejects.toBeInstanceOf(ProfileError);
  });
});

describe('ProfileStore — delete', () => {
  it('removes the record and the credential, keeping history by default', async () => {
    const created = await store.create(draft());
    const configDir = store.configDirFor(created);
    await mkdir(configDir, { recursive: true });

    const result = await store.delete(created.id);

    expect(result).toEqual({ id: created.id, configDirDeleted: false });
    expect(await store.list()).toEqual([]);
    expect(await secrets.get(created.secretRef)).toBeNull();
    expect((await stat(configDir)).isDirectory()).toBe(true);
  });

  it('removes the config directory on request', async () => {
    const created = await store.create(draft());
    const configDir = store.configDirFor(created);
    await mkdir(path.join(configDir, 'projects'), { recursive: true });

    const result = await store.delete(created.id, { deleteConfigDir: true });

    expect(result.configDirDeleted).toBe(true);
    await expect(stat(configDir)).rejects.toThrow();
  });

  it('reports configDirDeleted false when there was no directory', async () => {
    const created = await store.create(draft());
    const result = await store.delete(created.id, { deleteConfigDir: true });

    expect(result.configDirDeleted).toBe(false);
  });

  it('rejects an unknown id', async () => {
    await expect(store.delete('nope')).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses to delete outside the profiles root', async () => {
    const created = await store.create(draft());
    const outside = path.join(userDataDir, 'sibling');
    await mkdir(outside, { recursive: true });

    // Simulate a hand-edited record pointing at an escape path.
    const doc = JSON.parse(await readDocument()) as {
      version: number;
      profiles: Array<Record<string, unknown>>;
    };
    const first = doc.profiles[0];
    if (first) first['configDirName'] = '../sibling';
    await writeFile(path.join(userDataDir, PROFILE_STORE_FILE), JSON.stringify(doc));

    const reopened = new ProfileStore({ userDataDir, secrets });
    await expect(
      reopened.delete(created.id, { deleteConfigDir: true }),
    ).rejects.toBeInstanceOf(ProfileError);
    expect((await stat(outside)).isDirectory()).toBe(true);
  });
});
