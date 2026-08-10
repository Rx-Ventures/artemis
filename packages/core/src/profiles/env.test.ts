import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Profile, ProviderBackend } from '@libra/protocol';

import {
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CREDENTIALS,
  CLAUDE_OAUTH_TOKEN_ENV,
} from '../adapters/claude.js';
import { managedEnvKeys } from '../adapters/types.js';
import { ProfileError } from './errors.js';
import { InMemorySecretStore } from './secrets.js';
import {
  assertBareDirName,
  maskSecretHint,
  profileConfigDir,
  readMetadata,
  resolveEnv,
  resolveStoreEnv,
  toMetadata,
} from './env.js';

const SECRET_REF = 'profile-test';
const API_KEY = 'sk-ant-api03-0123456789abcdef4f2a';

/**
 * These tests exercise `resolveEnv` through Claude's credential spec, because
 * that is the one Libra ships. The point of the parameter is that the variable
 * names below come *from the adapter* rather than from `resolveEnv` itself.
 */
const ANTHROPIC_API_KEY_ENV = CLAUDE_CREDENTIALS.apiKeyVar;
const MANAGED_ENV_KEYS = managedEnvKeys(CLAUDE_CREDENTIALS);

let userDataDir: string;
let secrets: InMemorySecretStore;

/** Options every `resolveEnv` call in this file shares. */
let ENV_OPTS: { userDataDir: string; credentials: typeof CLAUDE_CREDENTIALS };
let STORE_OPTS: { userDataDir: string; credentials: typeof CLAUDE_CREDENTIALS };

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'libra-env-'));
  secrets = new InMemorySecretStore();
  await secrets.set(SECRET_REF, API_KEY);
  ENV_OPTS = { userDataDir, credentials: CLAUDE_CREDENTIALS };
  STORE_OPTS = { userDataDir, credentials: CLAUDE_CREDENTIALS };
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    label: 'Work',
    providerId: 'claude',
    configDirName: 'work-p1',
    secretRef: SECRET_REF,
    publicEnv: {},
    ...overrides,
  };
}

describe('resolveEnv — backends', () => {
  it('puts the decrypted key in ANTHROPIC_API_KEY for the anthropic backend', async () => {
    const env = await resolveEnv(makeProfile({ backend: 'anthropic' }), secrets, ENV_OPTS);

    expect(env[ANTHROPIC_API_KEY_ENV]).toBe(API_KEY);
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
    expect(env['CLAUDE_CODE_USE_VERTEX']).toBeUndefined();
    expect(env['CLAUDE_CODE_USE_FOUNDRY']).toBeUndefined();
  });

  it('treats an absent backend as anthropic', async () => {
    const env = await resolveEnv(makeProfile(), secrets, ENV_OPTS);
    expect(env[ANTHROPIC_API_KEY_ENV]).toBe(API_KEY);
  });

  const cloudBackends: ReadonlyArray<[ProviderBackend, string]> = [
    ['bedrock', 'CLAUDE_CODE_USE_BEDROCK'],
    ['vertex', 'CLAUDE_CODE_USE_VERTEX'],
    ['foundry', 'CLAUDE_CODE_USE_FOUNDRY'],
  ];

  for (const [backend, flag] of cloudBackends) {
    it(`sets ${flag}=1 and no API key for the ${backend} backend`, async () => {
      const env = await resolveEnv(makeProfile({ backend }), secrets, ENV_OPTS);

      expect(env[flag]).toBe('1');
      // Cloud backends authenticate from the ambient credential chain. A key
      // stored on the profile must not leak into the environment anyway.
      expect(env[ANTHROPIC_API_KEY_ENV]).toBeUndefined();
      for (const [, otherFlag] of cloudBackends) {
        if (otherFlag !== flag) expect(env[otherFlag]).toBeUndefined();
      }
    });
  }

  it('refuses to start an anthropic profile with no stored key', async () => {
    await secrets.delete(SECRET_REF);
    const error = await resolveEnv(makeProfile(), secrets, ENV_OPTS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).code).toBe('auth');
  });

  it('treats a whitespace-only key as no key', async () => {
    await secrets.set(SECRET_REF, '   ');
    await expect(resolveEnv(makeProfile(), secrets, ENV_OPTS)).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it('rejects an unknown backend from a hand-edited profile', async () => {
    const profile = makeProfile({ backend: 'azure' as ProviderBackend });
    const error = await resolveEnv(profile, secrets, ENV_OPTS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).code).toBe('invalid_request');
  });
});

describe('resolveEnv — auth modes', () => {
  const TOKEN = 'sk-ant-oat01-0123456789abcdefdead';

  /**
   * The billing-correctness guarantee, stated as plainly as it can be.
   *
   * `ANTHROPIC_API_KEY` overrides a subscription token when both are present:
   * the run is billed as metered API usage even though the user chose their
   * plan. So it is not enough for subscription mode to set its own variable —
   * the API key variable must be *absent from the resolved environment*, and
   * that is what this asserts.
   */
  it('BILLING: never sets ANTHROPIC_API_KEY in subscription mode, because an API key overrides the subscription', async () => {
    await secrets.set(SECRET_REF, TOKEN);
    const profile = makeProfile({ backend: 'anthropic', authMode: 'subscription' });

    const env = await resolveEnv(profile, secrets, {
      ...ENV_OPTS,
      // Every plausible way an API key could arrive: the user's shell, and a
      // hand-edited profile. Neither may survive.
      baseEnv: { [ANTHROPIC_API_KEY_ENV]: 'sk-ant-inherited-from-the-shell' },
    });

    expect(env).not.toHaveProperty(ANTHROPIC_API_KEY_ENV);
    expect(Object.values(env)).not.toContain('sk-ant-inherited-from-the-shell');
  });

  it('BILLING: emits NO credential at all in subscription mode, so the CLI login decides', async () => {
    /*
      The credential is created by `claude auth login` run against this
      profile's `CLAUDE_CONFIG_DIR`, and it stays with the CLI. Libra emitting
      any credential variable here would *override* that login — an explicitly
      set value outranks whatever the config directory holds — so a stale token
      would silently beat a good sign-in and could bill the wrong account.

      A stored secret is deliberately present in this test: even then, nothing
      is emitted.
    */
    await secrets.set(SECRET_REF, TOKEN);
    const env = await resolveEnv(makeProfile({ authMode: 'subscription' }), secrets, ENV_OPTS);

    expect(env[CLAUDE_OAUTH_TOKEN_ENV]).toBeUndefined();
    expect(env[ANTHROPIC_API_KEY_ENV]).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();

    // The one thing it must set: which directory holds the login.
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBeDefined();
  });

  it('BILLING: never sets CLAUDE_CODE_OAUTH_TOKEN in api-key mode, so an ambient token cannot bill a subscription', async () => {
    // The mirror image, and the reason the scrub is mode-specific rather than
    // one-directional: a token sitting in the user's shell must not quietly
    // move an api-key profile's usage onto their plan.
    const env = await resolveEnv(makeProfile({ authMode: 'api-key' }), secrets, {
      ...ENV_OPTS,
      baseEnv: { [CLAUDE_OAUTH_TOKEN_ENV]: 'sk-ant-oat01-from-the-shell' },
    });

    expect(env).not.toHaveProperty(CLAUDE_OAUTH_TOKEN_ENV);
    expect(env[ANTHROPIC_API_KEY_ENV]).toBe(API_KEY);
  });

  it('defaults to api-key when the profile names no mode', async () => {
    // Absent must mean the metered, explicit-consent option. A profile written
    // before this axis existed keeps billing exactly the way it always did.
    const env = await resolveEnv(makeProfile(), secrets, ENV_OPTS);

    expect(env[ANTHROPIC_API_KEY_ENV]).toBe(API_KEY);
    expect(env).not.toHaveProperty(CLAUDE_OAUTH_TOKEN_ENV);
  });

  it('refuses subscription mode on a cloud backend, which cannot bill a plan', async () => {
    await secrets.set(SECRET_REF, TOKEN);
    for (const backend of ['bedrock', 'vertex', 'foundry'] as const) {
      const profile = makeProfile({ backend, authMode: 'subscription' });
      const error = await resolveEnv(profile, secrets, ENV_OPTS).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProfileError);
      expect((error as ProfileError).code).toBe('invalid_request');
      // Naming the backends it *is* valid on is the difference between an error
      // a user can act on and one they can only report.
      expect((error as ProfileError).message).toContain('anthropic');
    }
  });

  it('rejects an auth mode the provider does not offer', async () => {
    const profile = makeProfile({ authMode: 'oauth-device' });
    const error = await resolveEnv(profile, secrets, ENV_OPTS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).code).toBe('invalid_request');
    expect((error as ProfileError).message).toContain('api-key, subscription');
  });

  it('resolves a subscription profile with no stored token, because it needs none', async () => {
    /*
      This used to throw. It must not: a subscription profile's credential is
      created by `claude auth login` against its own config directory, so
      "no secret stored" is the normal, correct state rather than a
      misconfiguration. Whether that directory is actually signed in is a
      separate question, answered by `checkAuthStatus`, and it is not
      `resolveEnv`'s to refuse.
    */
    await secrets.delete(SECRET_REF);
    const env = await resolveEnv(makeProfile({ authMode: 'subscription' }), secrets, ENV_OPTS);

    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBeDefined();
    expect(env[CLAUDE_OAUTH_TOKEN_ENV]).toBeUndefined();
    expect(env[ANTHROPIC_API_KEY_ENV]).toBeUndefined();
  });

  it('manages both credential variables, so neither can be smuggled in through publicEnv', async () => {
    expect(MANAGED_ENV_KEYS).toEqual(
      expect.arrayContaining([ANTHROPIC_API_KEY_ENV, CLAUDE_OAUTH_TOKEN_ENV]),
    );

    await secrets.set(SECRET_REF, TOKEN);
    const profile = makeProfile({
      authMode: 'subscription',
      publicEnv: { [ANTHROPIC_API_KEY_ENV]: 'sk-ant-smuggled-0000' },
    });
    const env = await resolveEnv(profile, secrets, ENV_OPTS);

    // Neither survives: the smuggled key is stripped, and subscription mode
    // emits no credential of its own — the CLI's per-profile login supplies it.
    expect(env).not.toHaveProperty(ANTHROPIC_API_KEY_ENV);
    expect(env[CLAUDE_OAUTH_TOKEN_ENV]).toBeUndefined();
  });

  it('reads no credential at all for a cloud backend, whatever the mode says', async () => {
    const env = await resolveEnv(
      makeProfile({ backend: 'bedrock', authMode: 'api-key' }),
      secrets,
      ENV_OPTS,
    );

    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
    expect(env).not.toHaveProperty(ANTHROPIC_API_KEY_ENV);
    expect(env).not.toHaveProperty(CLAUDE_OAUTH_TOKEN_ENV);
  });
});

describe('resolveEnv — config directory isolation', () => {
  it('points CLAUDE_CONFIG_DIR at <userData>/profiles/<configDirName> and creates it', async () => {
    const profile = makeProfile({ configDirName: 'work-p1' });
    const env = await resolveEnv(profile, secrets, ENV_OPTS);

    const expected = path.join(userDataDir, 'profiles', 'work-p1');
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(expected);
    expect((await stat(expected)).isDirectory()).toBe(true);
  });

  it('gives two profiles two directories', async () => {
    const a = await resolveEnv(makeProfile({ configDirName: 'a-1' }), secrets, ENV_OPTS);
    const b = await resolveEnv(makeProfile({ configDirName: 'b-2' }), secrets, ENV_OPTS);

    expect(a[CLAUDE_CONFIG_DIR_ENV]).not.toBe(b[CLAUDE_CONFIG_DIR_ENV]);
  });

  it('can skip directory creation', async () => {
    const profile = makeProfile({ configDirName: 'not-created' });
    const env = await resolveEnv(profile, secrets, { ...ENV_OPTS, ensureConfigDir: false });

    await expect(stat(env[CLAUDE_CONFIG_DIR_ENV] as string)).rejects.toThrow();
  });

  it('refuses a traversing configDirName', async () => {
    const profile = makeProfile({ configDirName: '../../etc' });
    await expect(resolveEnv(profile, secrets, ENV_OPTS)).rejects.toBeInstanceOf(ProfileError);
  });

  it('validates bare directory names', () => {
    expect(assertBareDirName('work-1a2b')).toBe('work-1a2b');
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', '../x', '.hidden']) {
      expect(() => assertBareDirName(bad)).toThrow(ProfileError);
    }
  });

  it('builds the config path without touching the filesystem', () => {
    expect(profileConfigDir(userDataDir, makeProfile({ configDirName: 'x-1' }))).toBe(
      path.join(userDataDir, 'profiles', 'x-1'),
    );
  });
});

describe('resolveEnv — merging', () => {
  it('merges publicEnv', async () => {
    const profile = makeProfile({
      backend: 'bedrock',
      publicEnv: { AWS_REGION: 'us-west-2', ANTHROPIC_MODEL: 'claude-opus-4' },
    });
    const env = await resolveEnv(profile, secrets, ENV_OPTS);

    expect(env['AWS_REGION']).toBe('us-west-2');
    expect(env['ANTHROPIC_MODEL']).toBe('claude-opus-4');
  });

  it('inherits baseEnv but never a credential the profile’s mode did not choose', async () => {
    // Default mode is api-key, so the key comes from the profile and the
    // subscription token in the shell is dropped. `resolveEnv — auth modes`
    // covers the mirror image, where the profile is in subscription mode and it
    // is the *inherited API key* that has to go.
    const env = await resolveEnv(makeProfile(), secrets, {
      ...ENV_OPTS,
      baseEnv: {
        PATH: '/usr/bin',
        HOME: '/Users/someone',
        // A stale key in the user's shell must not shadow the selected profile.
        [ANTHROPIC_API_KEY_ENV]: 'sk-ant-inherited-9999',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-from-shell',
        [CLAUDE_CONFIG_DIR_ENV]: '/somewhere/else',
        UNSET: undefined,
      },
    });

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/Users/someone');
    expect(env).not.toHaveProperty('UNSET');
    expect(env[ANTHROPIC_API_KEY_ENV]).toBe(API_KEY);
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(path.join(userDataDir, 'profiles', 'work-p1'));
  });

  it('drops credential-shaped publicEnv from a hand-edited profile', async () => {
    const profile = makeProfile({
      publicEnv: {
        ANTHROPIC_API_KEY: 'sk-ant-smuggled-0000',
        ANTHROPIC_AUTH_TOKEN: 'smuggled',
        MY_TOKEN: 'smuggled',
        CLAUDE_CONFIG_DIR: '/tmp/not-isolated',
        SAFE_VALUE: 'kept',
      },
    });
    const env = await resolveEnv(profile, secrets, ENV_OPTS);

    expect(env[ANTHROPIC_API_KEY_ENV]).toBe(API_KEY);
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['MY_TOKEN']).toBeUndefined();
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(path.join(userDataDir, 'profiles', 'work-p1'));
    expect(env['SAFE_VALUE']).toBe('kept');
  });

  it('drops credential-routing publicEnv from a hand-edited profile', async () => {
    // The dangerous case: none of these hold a secret, so the credential-name
    // heuristic passes them — but the decrypted key is written into this very
    // bundle, so honouring one would send it wherever the profile file said.
    const profile = makeProfile({
      publicEnv: {
        ANTHROPIC_BASE_URL: 'https://attacker.example',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Exfil: 1',
        HTTPS_PROXY: 'http://attacker.example:8080',
        NODE_EXTRA_CA_CERTS: '/tmp/evil.pem',
        NODE_OPTIONS: '--require /tmp/evil.js',
        // Lower-case spellings are honoured by real HTTP stacks, so the check
        // cannot be case-sensitive.
        http_proxy: 'http://attacker.example:8080',
        // Model and region selection stay supported.
        ANTHROPIC_MODEL: 'claude-opus-4',
        AWS_REGION: 'us-west-2',
      },
    });
    const env = await resolveEnv(profile, secrets, ENV_OPTS);

    expect(env[ANTHROPIC_API_KEY_ENV]).toBe(API_KEY);
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBeUndefined();
    expect(env['HTTPS_PROXY']).toBeUndefined();
    expect(env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['http_proxy']).toBeUndefined();
    expect(env['ANTHROPIC_MODEL']).toBe('claude-opus-4');
    expect(env['AWS_REGION']).toBe('us-west-2');
  });

  it('lists every variable it manages', () => {
    expect(MANAGED_ENV_KEYS).toEqual(
      expect.arrayContaining([
        ANTHROPIC_API_KEY_ENV,
        CLAUDE_CONFIG_DIR_ENV,
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
      ]),
    );
  });

  it('does not write the resolved environment anywhere', async () => {
    // Belt and braces: resolveEnv creates a directory and nothing else.
    const marker = path.join(userDataDir, 'canary');
    await writeFile(marker, 'untouched');
    await resolveEnv(makeProfile(), secrets, ENV_OPTS);
    expect((await stat(marker)).isFile()).toBe(true);
  });
});

describe('resolveEnv — provider vocabulary', () => {
  /** What a Codex-style adapter would declare: OpenAI's names, not Anthropic's. */
  const CODEX_CREDENTIALS = {
    apiKeyVar: 'OPENAI_API_KEY',
    configDirVar: 'CODEX_HOME',
    extraManagedEnvKeys: ['OPENAI_ORG_ID'],
    // No auth-mode axis at all: one credential, one variable. The point is that
    // the axis is a per-provider declaration, not a fact about every provider.
    authModes: [],
    backends: [
      {
        id: 'openai',
        label: 'OpenAI API',
        note: 'Uses OPENAI_API_KEY.',
        requiresApiKey: true,
        envFlag: null,
      },
      {
        id: 'azure',
        label: 'Azure OpenAI',
        note: 'Uses ambient Azure credentials.',
        requiresApiKey: false,
        envFlag: 'CODEX_USE_AZURE',
      },
    ],
  };

  it('writes the credential into the provider’s own variable', async () => {
    // The defect this parameter exists to prevent: the credential used to be
    // written to ANTHROPIC_API_KEY for every provider, because resolveEnv never
    // read providerId at all.
    const profile = makeProfile({ providerId: 'codex', backend: 'openai' });
    const env = await resolveEnv(profile, secrets, {
      userDataDir,
      credentials: CODEX_CREDENTIALS,
    });

    expect(env['OPENAI_API_KEY']).toBe(API_KEY);
    expect(env['CODEX_HOME']).toBe(path.join(userDataDir, 'profiles', 'work-p1'));
    expect(env[ANTHROPIC_API_KEY_ENV]).toBeUndefined();
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBeUndefined();
  });

  it('uses the provider’s own backend flag', async () => {
    const profile = makeProfile({ providerId: 'codex', backend: 'azure' });
    const env = await resolveEnv(profile, secrets, {
      userDataDir,
      credentials: CODEX_CREDENTIALS,
    });

    expect(env['CODEX_USE_AZURE']).toBe('1');
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
  });

  it('falls back to the provider’s first backend when none is stored', async () => {
    const profile = makeProfile({ providerId: 'codex' });
    const env = await resolveEnv(profile, secrets, {
      userDataDir,
      credentials: CODEX_CREDENTIALS,
    });

    expect(env['OPENAI_API_KEY']).toBe(API_KEY);
  });

  it('rejects a backend the provider does not offer, naming the ones it does', async () => {
    // A Claude backend on a Codex profile is exactly the mismatch the old
    // global backend union made not just possible but mandatory.
    const profile = makeProfile({ providerId: 'codex', backend: 'bedrock' });
    const error = await resolveEnv(profile, secrets, {
      userDataDir,
      credentials: CODEX_CREDENTIALS,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).code).toBe('invalid_request');
    expect((error as ProfileError).message).toContain('openai, azure');
  });

  it('strips the provider’s own managed keys from the inherited environment', async () => {
    const env = await resolveEnv(makeProfile({ providerId: 'codex' }), secrets, {
      userDataDir,
      credentials: CODEX_CREDENTIALS,
      baseEnv: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-inherited-from-the-shell',
        OPENAI_ORG_ID: 'org-from-the-shell',
        CODEX_USE_AZURE: '1',
        CODEX_HOME: '/somewhere/else',
      },
    });

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['OPENAI_API_KEY']).toBe(API_KEY);
    expect(env['OPENAI_ORG_ID']).toBeUndefined();
    expect(env['CODEX_USE_AZURE']).toBeUndefined();
    expect(env['CODEX_HOME']).toBe(path.join(userDataDir, 'profiles', 'work-p1'));
  });

  it('rejects an auth mode on a provider that declares none, rather than ignoring it', async () => {
    const profile = makeProfile({ providerId: 'codex', authMode: 'subscription' });
    const error = await resolveEnv(profile, secrets, {
      userDataDir,
      credentials: CODEX_CREDENTIALS,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).code).toBe('invalid_request');
  });

  it('does not write Claude’s credential variables for another provider’s modes', async () => {
    const env = await resolveEnv(makeProfile({ providerId: 'codex' }), secrets, {
      userDataDir,
      credentials: CODEX_CREDENTIALS,
    });

    expect(env).not.toHaveProperty(CLAUDE_OAUTH_TOKEN_ENV);
    expect(env).not.toHaveProperty(ANTHROPIC_API_KEY_ENV);
  });
});

describe('resolveStoreEnv', () => {
  it('locates history for a profile with no key at all', async () => {
    // The state the protocol models as `keyHint: null`. Reading history must
    // not require a credential the profile has not been given yet.
    const empty = new InMemorySecretStore();
    const profile = makeProfile({ configDirName: 'keyless-1', secretRef: 'nothing-here' });

    const env = await resolveStoreEnv(profile, STORE_OPTS);
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(path.join(userDataDir, 'profiles', 'keyless-1'));

    // The same profile is still refused on the run path, where a key is real.
    await expect(resolveEnv(profile, empty, ENV_OPTS)).rejects.toBeInstanceOf(ProfileError);
  });

  it('carries no credential and creates nothing', async () => {
    const profile = makeProfile({ configDirName: 'read-only-1' });
    const env = await resolveStoreEnv(profile, STORE_OPTS);

    expect(Object.keys(env)).toEqual([CLAUDE_CONFIG_DIR_ENV]);
    expect(Object.values(env)).not.toContain(API_KEY);
    await expect(stat(env[CLAUDE_CONFIG_DIR_ENV] as string)).rejects.toThrow();
  });

  it('still refuses a traversing configDirName', async () => {
    await expect(
      resolveStoreEnv(makeProfile({ configDirName: '../../etc' }), STORE_OPTS),
    ).rejects.toBeInstanceOf(ProfileError);
  });
});

describe('readMetadata', () => {
  it('degrades to keyHint: null when the secret store cannot answer', async () => {
    // A locked or missing OS keyring must not take out the profile list — the
    // whole list is read through one Promise.all, so one throw would empty the
    // profile selector and hide the editor that fixes it.
    const broken = {
      get: () => Promise.reject(new Error('keyring unavailable')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const metadata = await readMetadata(makeProfile(), broken);

    expect(metadata.keyHint).toBeNull();
    expect(metadata.id).toBe('p1');
  });
});

describe('maskSecretHint', () => {
  it('returns null for absent or empty secrets', () => {
    expect(maskSecretHint(undefined)).toBeNull();
    expect(maskSecretHint(null)).toBeNull();
    expect(maskSecretHint('')).toBeNull();
    expect(maskSecretHint('    ')).toBeNull();
  });

  it('collapses short secrets to a fixed placeholder', () => {
    expect(maskSecretHint('a')).toBe('••••');
    expect(maskSecretHint('abc')).toBe('••••');
    expect(maskSecretHint('12345678')).toBe('••••');
  });

  it('keeps a vendor prefix and the last four characters', () => {
    expect(maskSecretHint('sk-ant-api03-Zx9qqqqqqqqqqqqq4f2a')).toBe('sk-ant-...4f2a');
  });

  it('reveals nothing but the last four when there is no vendor prefix', () => {
    const key = 'ABCDEFGHIJKLMNOPQRST';
    const hint = maskSecretHint(key);

    expect(hint).toBe('••••QRST');
    expect(hint).not.toContain('ABC');
  });

  it('never reveals more than four characters of key material', () => {
    const keys = [
      'sk-ant-api03-supersecretvalue1234',
      'ABCDEFGHIJKLMNOPQRST',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '  padded-with-spaces-1234  ',
    ];
    for (const key of keys) {
      const hint = maskSecretHint(key) ?? '';
      const trimmed = key.trim();
      // Everything the hint shows, minus a vendor label, must be the tail.
      const revealed = hint.replace(/^[A-Za-z]{2,8}-[A-Za-z]{2,8}-/, '').replace(/[.•]/g, '');
      expect(revealed.length).toBeLessThanOrEqual(4);
      if (revealed.length > 0) expect(trimmed.endsWith(revealed)).toBe(true);
    }
  });

  it('does not throw on pathological input', () => {
    expect(() => maskSecretHint('\n\t')).not.toThrow();
    expect(() => maskSecretHint('•'.repeat(500))).not.toThrow();
  });
});

describe('toMetadata', () => {
  it('exposes only renderer-safe fields', () => {
    const profile = makeProfile({
      backend: 'bedrock',
      authMode: 'api-key',
      publicEnv: { AWS_REGION: 'us-east-1' },
      configDirName: 'work-p1',
      secretRef: 'profile-super-secret-ref',
    });
    const metadata = toMetadata(profile, API_KEY);

    expect(Object.keys(metadata).sort()).toEqual([
      'authMode',
      'backend',
      'id',
      'keyHint',
      'label',
      'providerId',
    ]);
    expect(metadata).toMatchObject({
      id: 'p1',
      label: 'Work',
      providerId: 'claude',
      backend: 'bedrock',
      authMode: 'api-key',
      keyHint: 'sk-ant-...4f2a',
    });

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('profile-super-secret-ref');
    expect(serialized).not.toContain('work-p1');
    expect(serialized).not.toContain('AWS_REGION');
  });

  it('reports a null hint for a profile with no credential', () => {
    expect(toMetadata(makeProfile()).keyHint).toBeNull();
    expect(toMetadata(makeProfile(), null).keyHint).toBeNull();
  });

  it('carries the auth mode so the UI can show which billing a profile uses', () => {
    // The mode id is not a secret, and hiding it would leave the user unable to
    // tell an API-billed profile from a subscription one without starting a run.
    expect(toMetadata(makeProfile({ authMode: 'subscription' }), null).authMode).toBe(
      'subscription',
    );
    expect(toMetadata(makeProfile(), null).authMode).toBeUndefined();
  });
});
