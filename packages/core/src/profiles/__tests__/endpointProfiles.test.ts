/**
 * A profile that is an address, and the one secret Artemis keeps.
 * ============================================================================
 *
 * `profile.ts` explains why Artemis stopped storing credentials, and this
 * feature puts one back — deliberately, and only this one. What is pinned here
 * is every rule that makes that safe, plus the two failures that made a local
 * profile unusable in the first place:
 *
 *  - The address could be written and never read back, because it lived in
 *    `publicEnv`, which the renderer is not allowed to see.
 *  - Nothing could carry a key at all, because every name that would hold one
 *    is stripped from `publicEnv` by design.
 *
 * The rules the key lives under are the interesting assertions: it never
 * appears in `profiles.json`, it never appears in a `ProfileMetadata`, it is
 * dropped for providers that sign in to an account instead, and it leaves when
 * its profile does.
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_API_KEY_ENV, LOCAL_BASE_URL_ENV } from '@rx-artemis/protocol';
import type { ProfileId } from '@rx-artemis/protocol';

import { MemoryProfileSecrets } from '../secrets.js';
import { ProfileStore } from '../store.js';
import { resolveEnv } from '../env.js';

const CREDENTIALS = {
  configDirVar: 'ARTEMIS_LOCAL_PROFILE_DIR',
  credentialEnvKeys: [LOCAL_BASE_URL_ENV, LOCAL_API_KEY_ENV],
  signIn: {
    executable: 'true',
    loginArgs: [],
    statusArgs: [],
    logoutArgs: [],
    howTo: '',
    parseStatus: () => ({ loggedIn: true }),
  },
} as never;

let dir: string;
let secrets: MemoryProfileSecrets;
let store: ProfileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artemis-endpoint-'));
  secrets = new MemoryProfileSecrets();
  store = new ProfileStore({ userDataDir: dir, secrets });
});

const localDraft = (over: Record<string, unknown> = {}) => ({
  label: 'Local',
  providerId: 'llamacpp' as const,
  configDir: join(dir, 'local'),
  ...over,
});

const rawFile = async (): Promise<string> => readFile(store.filePath, 'utf8');

describe('the address', () => {
  it('comes back on the metadata the renderer receives', async () => {
    // The whole reason it is a field. In `publicEnv` it was write-only: typed
    // once, never displayed, impossible to confirm or correct.
    const profile = await store.create(localDraft({ baseUrl: 'http://192.168.1.40:9090' }));

    const metadata = await store.describe(profile.id);

    expect(metadata.baseUrl).toBe('http://192.168.1.40:9090');
  });

  it('is stored in one spelling', async () => {
    const profile = await store.create(localDraft({ baseUrl: '  http://box.local:8080/  ' }));
    expect(profile.baseUrl).toBe('http://box.local:8080');
  });

  it('refuses an address that cannot work', async () => {
    // Unlike the colour and the plan, which are dropped when unusable: those
    // decide how a menu looks and this decides whether the profile can reach
    // its server. A profile saved without it would fail later, elsewhere.
    await expect(store.create(localDraft({ baseUrl: '127.0.0.1:8080' }))).rejects.toThrow(
      /http:\/\//,
    );
  });

  it('goes back to the default when a patch sends the empty string', async () => {
    const profile = await store.create(localDraft({ baseUrl: 'http://box.local:8080' }));

    const cleared = await store.update(profile.id, { baseUrl: '' });

    expect(cleared.baseUrl).toBeUndefined();
  });

  it('is left alone by a patch that does not mention it', async () => {
    const profile = await store.create(localDraft({ baseUrl: 'http://box.local:8080' }));

    const renamed = await store.update(profile.id, { label: 'Renamed' });

    expect(renamed.baseUrl).toBe('http://box.local:8080');
  });

  it('adopts an address an older build left in publicEnv', async () => {
    /*
     * Before this field existed the address lived in `publicEnv` as
     * `ARTEMIS_LOCAL_BASE_URL`, and that is where every profile written by an
     * older build still keeps it. Those profiles keep working — and start
     * working better, since the value is now visible and probed against.
     */
    const profile = await store.create(
      localDraft({ publicEnv: { [LOCAL_BASE_URL_ENV]: 'http://legacy.local:8080' } }),
    );

    const reopened = new ProfileStore({ userDataDir: dir, secrets });
    const [migrated] = await reopened.list();

    expect(migrated?.baseUrl).toBe('http://legacy.local:8080');
    expect((await reopened.describe(profile.id)).baseUrl).toBe('http://legacy.local:8080');
  });
});

describe('the key', () => {
  it('is never written to profiles.json', async () => {
    // That file is plain, hand-editable JSON, and the reason a separate
    // encrypted store exists at all.
    await store.create(localDraft({ apiKey: 'hunter2' }));

    const raw = await rawFile();
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('apiKey');
  });

  it('never travels on the metadata — only the fact that it exists', async () => {
    const profile = await store.create(localDraft({ apiKey: 'hunter2' }));

    const metadata = await store.describe(profile.id);

    expect(metadata.hasApiKey).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('hunter2');
  });

  it('reports no key when none is set', async () => {
    const profile = await store.create(localDraft());
    expect((await store.describe(profile.id)).hasApiKey).toBeUndefined();
  });

  it('is left alone by a patch that does not mention it', async () => {
    // The editor cannot show a stored key, so it cannot send one back. An
    // untouched field has to mean "leave it" or every save would wipe the key.
    const profile = await store.create(localDraft({ apiKey: 'hunter2' }));

    await store.update(profile.id, { label: 'Renamed' });

    expect(await store.readApiKey(profile.id)).toBe('hunter2');
  });

  it('is replaced by a patch that sends a new one', async () => {
    const profile = await store.create(localDraft({ apiKey: 'hunter2' }));

    await store.update(profile.id, { apiKey: 'rotated' });

    expect(await store.readApiKey(profile.id)).toBe('rotated');
  });

  it('is cleared by the empty string', async () => {
    const profile = await store.create(localDraft({ apiKey: 'hunter2' }));

    await store.update(profile.id, { apiKey: '' });

    expect(await store.readApiKey(profile.id)).toBeNull();
    expect((await store.describe(profile.id)).hasApiKey).toBeUndefined();
  });

  it('leaves when its profile does', async () => {
    // A key left behind would be filed under an id nothing can reach, and a
    // later profile minted with that id would silently inherit it.
    const profile = await store.create(localDraft({ apiKey: 'hunter2' }));

    await store.delete(profile.id);

    expect(await secrets.has(profile.id)).toBe(false);
  });

  it('is not stored for a provider that signs in to an account', async () => {
    // The old credential store was deleted because Artemis holding a vendor
    // key is how the wrong account gets billed. That stays true.
    const profile = await store.create({
      label: 'Work',
      providerId: 'claude',
      configDir: join(dir, 'work'),
      apiKey: 'sk-ant-nope',
      baseUrl: 'http://attacker.example',
    } as never);

    expect(await store.readApiKey(profile.id)).toBeNull();
    expect(profile.baseUrl).toBeUndefined();
  });

  it('fails loudly when there is nowhere safe to put it', async () => {
    // A key the user believes is saved and is not turns every later request
    // into a 401 the server gets blamed for.
    const noStore = new ProfileStore({ userDataDir: dir, fileName: 'other.json' });

    await expect(noStore.create(localDraft({ apiKey: 'hunter2' }))).rejects.toThrow(
      /secure storage/i,
    );
  });
});

describe('what the run is handed', () => {
  it('carries the address and the key into the environment', async () => {
    const profile = await store.create(
      localDraft({ baseUrl: 'http://box.local:9090', apiKey: 'hunter2' }),
    );

    const env = await resolveEnv(profile, {
      credentials: CREDENTIALS,
      apiKey: (await store.readApiKey(profile.id)) ?? undefined,
    });

    expect(env[LOCAL_BASE_URL_ENV]).toBe('http://box.local:9090');
    expect(env[LOCAL_API_KEY_ENV]).toBe('hunter2');
  });

  it('emits neither variable when the profile sets neither', async () => {
    // An absent address means the flavour's default, which the adapter
    // supplies; emitting an empty string would override it with nothing.
    const profile = await store.create(localDraft());

    const env = await resolveEnv(profile, { credentials: CREDENTIALS });

    expect(env[LOCAL_BASE_URL_ENV]).toBeUndefined();
    expect(env[LOCAL_API_KEY_ENV]).toBeUndefined();
  });

  it('beats an address exported in the user’s shell', async () => {
    /*
     * Both names are in the provider's strip list, so an ambient value is
     * removed before the profile's own is written. Without that, a stray
     * `ARTEMIS_LOCAL_BASE_URL` in someone's shell would send this profile's
     * key to a machine the profile does not name.
     */
    const profile = await store.create(
      localDraft({ baseUrl: 'http://box.local:9090', apiKey: 'hunter2' }),
    );

    const env = await resolveEnv(profile, {
      credentials: CREDENTIALS,
      apiKey: 'hunter2',
      baseEnv: {
        [LOCAL_BASE_URL_ENV]: 'http://attacker.example',
        [LOCAL_API_KEY_ENV]: 'stolen',
      },
    });

    expect(env[LOCAL_BASE_URL_ENV]).toBe('http://box.local:9090');
    expect(env[LOCAL_API_KEY_ENV]).toBe('hunter2');
  });

  it('does not let a hand-edited publicEnv carry a key', async () => {
    // `profiles.json` is editable by hand, and the key's own name matches
    // `isSecretEnvKey` — so this is stripped on the way through, which is the
    // intended outcome rather than an obstacle.
    const profile = await store.create(localDraft());
    const tampered = {
      ...profile,
      publicEnv: { [LOCAL_API_KEY_ENV]: 'stolen' },
    };

    const env = await resolveEnv(tampered, { credentials: CREDENTIALS });

    expect(env[LOCAL_API_KEY_ENV]).toBeUndefined();
  });
});
