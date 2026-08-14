/**
 * Tests for turning a profile into an environment.
 *
 * The subject shrank a great deal when Artemis stopped holding credentials —
 * there is no key to place, no auth mode to resolve, no backend flag to set. So
 * what these cover is what is left, and what is left is the part that was
 * always load-bearing:
 *
 *  - one variable is written, and it is the provider's own;
 *  - every variable that could authenticate the provider some *other* way is
 *    removed, on every run, without exception.
 *
 * The second is the whole security story. `ANTHROPIC_API_KEY` outranks the
 * config directory's login, so an inherited one would silently bill a different
 * account than the profile names. Several tests below exist solely to say that
 * out loud.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Profile } from '@rx-artemis/protocol';

import { CLAUDE_CONFIG_DIR_ENV, CLAUDE_CREDENTIALS } from '../adapters/claude.js';
import { managedEnvKeys } from '../adapters/types.js';
import type { ProviderCredentialSpec } from '../adapters/types.js';
import { ProfileError } from './errors.js';
import {
  assertConfigDir,
  isArtemisOwnedConfigDir,
  profileConfigDir,
  profilesRoot,
  resolveEnv,
  resolveStoreEnv,
  suggestConfigDir,
  toMetadata,
} from './env.js';

/**
 * These tests exercise `resolveEnv` through Claude's spec, because that is the
 * one Artemis ships. The point of the parameter is that the variable names below
 * come *from the adapter* rather than from `resolveEnv` itself — the
 * "provider vocabulary" block at the bottom proves it with a different one.
 */
const MANAGED_ENV_KEYS = managedEnvKeys(CLAUDE_CREDENTIALS);

let userDataDir: string;
let configDir: string;
let ENV_OPTS: { credentials: ProviderCredentialSpec };

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'artemis-env-'));
  configDir = path.join(userDataDir, 'profiles', 'work');
  ENV_OPTS = { credentials: CLAUDE_CREDENTIALS };
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    label: 'Work',
    providerId: 'claude',
    configDir,
    publicEnv: {},
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

describe('resolveEnv — credentials', () => {
  it('emits no credential of any kind — the config directory is the credential', async () => {
    const env = await resolveEnv(makeProfile(), ENV_OPTS);

    for (const key of CLAUDE_CREDENTIALS.credentialEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    // Exactly one variable, and it is the config directory.
    expect(Object.keys(env)).toEqual([CLAUDE_CONFIG_DIR_ENV]);
  });

  it('BILLING: strips an inherited ANTHROPIC_API_KEY, which would outrank the login', async () => {
    const env = await resolveEnv(makeProfile(), {
      ...ENV_OPTS,
      baseEnv: { ANTHROPIC_API_KEY: 'sk-ant-api03-from-the-users-shell', PATH: '/usr/bin' },
    });

    // The entire point. With this present the CLI bills metered API usage to
    // whoever owns the key, no matter which account the profile is signed into
    // — and the user would find out on an invoice.
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('BILLING: strips an inherited CLAUDE_CODE_OAUTH_TOKEN, so a stale token cannot beat a good login', async () => {
    const env = await resolveEnv(makeProfile(), {
      ...ENV_OPTS,
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-stale' },
    });

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('BILLING: strips ANTHROPIC_AUTH_TOKEN, a third path Artemis does not expose', async () => {
    const env = await resolveEnv(makeProfile(), {
      ...ENV_OPTS,
      baseEnv: { ANTHROPIC_AUTH_TOKEN: 'whatever' },
    });

    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
  });

  it('starts a profile that has never been signed in, because signing in is a later step', async () => {
    // No error, no throw. A profile is created before its login exists, and
    // `resolveEnv` is not the place that discovers the difference — the CLI
    // reports it, and `checkAuthStatus` is what asks.
    await expect(resolveEnv(makeProfile(), ENV_OPTS)).resolves.toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Config directory                                                           */
/* -------------------------------------------------------------------------- */

describe('resolveEnv — config directory isolation', () => {
  it('points CLAUDE_CONFIG_DIR at the profile’s directory and creates it', async () => {
    const env = await resolveEnv(makeProfile(), ENV_OPTS);

    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(configDir);
    await expect(stat(configDir)).resolves.toBeDefined();
  });

  it('gives two profiles two directories', async () => {
    const a = await resolveEnv(makeProfile({ configDir: path.join(userDataDir, 'a') }), ENV_OPTS);
    const b = await resolveEnv(makeProfile({ configDir: path.join(userDataDir, 'b') }), ENV_OPTS);

    expect(a[CLAUDE_CONFIG_DIR_ENV]).not.toBe(b[CLAUDE_CONFIG_DIR_ENV]);
  });

  it('lets two profiles share one directory, which makes them one account', async () => {
    // Allowed on purpose: it is occasionally what someone means, and nothing
    // downstream breaks — they simply resolve to the same credential.
    const a = await resolveEnv(makeProfile({ id: 'p1' }), ENV_OPTS);
    const b = await resolveEnv(makeProfile({ id: 'p2' }), ENV_OPTS);

    expect(a[CLAUDE_CONFIG_DIR_ENV]).toBe(b[CLAUDE_CONFIG_DIR_ENV]);
  });

  it('can skip directory creation', async () => {
    const target = path.join(userDataDir, 'not-created');
    await resolveEnv(makeProfile({ configDir: target }), { ...ENV_OPTS, ensureConfigDir: false });

    await expect(stat(target)).rejects.toThrow();
  });

  it('refuses a traversing configDir from a hand-edited profile', async () => {
    await expect(
      resolveEnv(makeProfile({ configDir: '/tmp/../../etc' }), ENV_OPTS),
    ).rejects.toThrow(ProfileError);
  });

  it('refuses a relative configDir', () => {
    expect(() => assertConfigDir('profiles/work')).toThrow(ProfileError);
  });

  it('refuses the filesystem root, the one path that makes a recursive delete fatal', () => {
    expect(() => assertConfigDir('/')).toThrow(ProfileError);
  });

  it('refuses a tilde rather than creating a directory literally named "~"', () => {
    expect(() => assertConfigDir('~/.claude')).toThrow(ProfileError);
  });

  it('accepts and normalizes an ordinary absolute path', () => {
    expect(assertConfigDir('  /Users/me/.claude/  ')).toBe('/Users/me/.claude');
  });

  it('builds the config path without touching the filesystem', () => {
    expect(profileConfigDir(makeProfile())).toBe(configDir);
  });
});

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

describe('isArtemisOwnedConfigDir', () => {
  it('claims a directory Artemis suggested', () => {
    expect(isArtemisOwnedConfigDir(userDataDir, path.join(profilesRoot(userDataDir), 'work'))).toBe(
      true,
    );
  });

  it('disclaims the user’s own ~/.claude', () => {
    // The single check standing between a checkbox in a profile dialog and
    // `rm -r` on the user's real Claude installation.
    expect(isArtemisOwnedConfigDir(userDataDir, '/Users/me/.claude')).toBe(false);
  });

  it('disclaims the profiles root itself', () => {
    // Deleting it would take every profile's history at once.
    expect(isArtemisOwnedConfigDir(userDataDir, profilesRoot(userDataDir))).toBe(false);
  });

  it('is not fooled by a sibling with a shared prefix', () => {
    expect(isArtemisOwnedConfigDir(userDataDir, `${profilesRoot(userDataDir)}-elsewhere`)).toBe(
      false,
    );
  });
});

describe('suggestConfigDir', () => {
  it('names the directory after the label', () => {
    expect(suggestConfigDir(userDataDir, 'Work Account')).toBe(
      path.join(profilesRoot(userDataDir), 'work-account'),
    );
  });

  it('falls back to a generic name for a label with nothing usable in it', () => {
    expect(suggestConfigDir(userDataDir, '—')).toBe(path.join(profilesRoot(userDataDir), 'profile'));
  });

  it('avoids a directory another profile already uses', () => {
    const taken = makeProfile({ configDir: path.join(profilesRoot(userDataDir), 'work') });

    // Two profiles sharing a directory share an account. Allowed when chosen,
    // but never as the result of a slug collision.
    expect(suggestConfigDir(userDataDir, 'Work', [taken])).toBe(
      path.join(profilesRoot(userDataDir), 'work-2'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

describe('resolveEnv — merging', () => {
  it('merges publicEnv', async () => {
    const env = await resolveEnv(
      makeProfile({ publicEnv: { ANTHROPIC_MODEL: 'claude-sonnet-5' } }),
      ENV_OPTS,
    );

    expect(env['ANTHROPIC_MODEL']).toBe('claude-sonnet-5');
  });

  it('inherits baseEnv but never a managed variable', async () => {
    const env = await resolveEnv(makeProfile(), {
      ...ENV_OPTS,
      baseEnv: {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        [CLAUDE_CONFIG_DIR_ENV]: '/somewhere/else',
        undefinedValue: undefined,
      },
    });

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/Users/me');
    expect(env['undefinedValue']).toBeUndefined();
    // An inherited config directory would point the profile at another
    // account's credential, which is the same failure as an inherited key.
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(configDir);
  });

  it('BILLING: drops the provider’s whole namespace from baseEnv, not just the managed keys', async () => {
    // The resolved bundle is layered *over* the adapter's own scrubbed
    // host-environment merge, and the bundle wins. So a baseEnv built from
    // `process.env` — exactly what the docs suggest — would carry the shell's
    // `ANTHROPIC_BASE_URL` (re-routes every request, and the credential with
    // it) and `CLAUDE_CODE_USE_BEDROCK` (re-bills the run onto a backend the
    // profile never chose) straight past the adapter's scrub. Neither is in
    // `managedEnvKeys`, which is why the filter has to reach the namespace.
    const env = await resolveEnv(makeProfile(), {
      ...ENV_OPTS,
      baseEnv: {
        ANTHROPIC_BASE_URL: 'https://proxy.corp.example',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: 'someone-elses-default',
        PATH: '/usr/bin',
        HOME: '/Users/me',
      },
    });

    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
    expect(env['ANTHROPIC_MODEL']).toBeUndefined();
    // The host's own environment is not the provider's and passes untouched.
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/Users/me');
  });

  it('still lets the profile set a provider variable deliberately, via publicEnv', async () => {
    // The namespace drop is about *ambient* variables nobody chose. A model
    // selection written into the profile is a choice, and publicEnv is layered
    // after baseEnv precisely so choices win over accidents.
    const env = await resolveEnv(
      makeProfile({ publicEnv: { ANTHROPIC_MODEL: 'claude-sonnet-5' } }),
      {
        ...ENV_OPTS,
        baseEnv: { ANTHROPIC_MODEL: 'ambient-shell-model' },
      },
    );

    expect(env['ANTHROPIC_MODEL']).toBe('claude-sonnet-5');
  });

  it('drops credential-shaped publicEnv from a hand-edited profile', async () => {
    const env = await resolveEnv(
      makeProfile({ publicEnv: { ANTHROPIC_API_KEY: 'sk-ant-smuggled', MY_TOKEN: 'x' } }),
      ENV_OPTS,
    );

    // The store rejects these on write, but `profiles.json` is a plaintext file
    // a user can edit, so the run path checks again rather than trusting it.
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['MY_TOKEN']).toBeUndefined();
  });

  it('drops credential-routing publicEnv from a hand-edited profile', async () => {
    const env = await resolveEnv(
      makeProfile({
        publicEnv: { ANTHROPIC_BASE_URL: 'https://attacker.example', HTTPS_PROXY: 'http://mitm' },
      }),
      ENV_OPTS,
    );

    // These hold no secret and pass the name heuristic cleanly, and yet each
    // would aim the credential the CLI holds at a host of the writer's
    // choosing.
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(env['HTTPS_PROXY']).toBeUndefined();
  });

  it('lists every variable it manages', () => {
    expect(MANAGED_ENV_KEYS).toContain(CLAUDE_CONFIG_DIR_ENV);
    expect(MANAGED_ENV_KEYS).toContain('ANTHROPIC_API_KEY');
    expect(MANAGED_ENV_KEYS).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(MANAGED_ENV_KEYS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('does not write the resolved environment anywhere', async () => {
    const before = { ...process.env };
    await resolveEnv(makeProfile(), ENV_OPTS);
    expect(process.env).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Provider vocabulary                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A second provider, so these tests fail if `resolveEnv` ever grows a hard-coded
 * Anthropic variable name again. Nothing here shares a string with Claude's spec.
 */
const OTHER_CREDENTIALS: ProviderCredentialSpec = {
  configDirVar: 'OTHER_CONFIG_DIR',
  credentialEnvKeys: ['OTHER_API_KEY', 'OTHER_SESSION_TOKEN'],
  signIn: {
    executable: 'other',
    loginArgs: ['login'],
    statusArgs: ['status', '--json'],
    logoutArgs: ['logout'],
    howTo: 'Run the other CLI’s login.',
  },
};

describe('resolveEnv — provider vocabulary', () => {
  it('writes the provider’s own config-directory variable, not Claude’s', async () => {
    const env = await resolveEnv(makeProfile({ providerId: 'codex' }), {
      credentials: OTHER_CREDENTIALS,
    });

    expect(env['OTHER_CONFIG_DIR']).toBe(configDir);
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBeUndefined();
  });

  it('strips the provider’s own credential variables from the inherited environment', async () => {
    const env = await resolveEnv(makeProfile({ providerId: 'codex' }), {
      credentials: OTHER_CREDENTIALS,
      baseEnv: { OTHER_API_KEY: 'leaked', OTHER_SESSION_TOKEN: 'leaked', PATH: '/usr/bin' },
    });

    expect(env['OTHER_API_KEY']).toBeUndefined();
    expect(env['OTHER_SESSION_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('leaves another provider’s credential variables alone', async () => {
    // `ANTHROPIC_API_KEY` is not this provider's business. Stripping it would
    // be the same over-reach in the other direction — one adapter deciding what
    // another provider's environment may contain.
    const env = await resolveEnv(makeProfile({ providerId: 'codex' }), {
      credentials: OTHER_CREDENTIALS,
      baseEnv: { ANTHROPIC_API_KEY: 'not-mine' },
    });

    expect(env['ANTHROPIC_API_KEY']).toBe('not-mine');
  });

  it('derives the dropped namespaces from the spec, not from Claude', async () => {
    // `OTHER_BASE_URL` is not managed and not credential-shaped, but it lives
    // in the namespace this spec's own variable names declare — so it goes,
    // for the same reason `ANTHROPIC_BASE_URL` goes under Claude's spec. And
    // Claude's namespace means nothing here.
    const env = await resolveEnv(makeProfile({ providerId: 'codex' }), {
      credentials: OTHER_CREDENTIALS,
      baseEnv: {
        OTHER_BASE_URL: 'https://elsewhere.example',
        ANTHROPIC_BASE_URL: 'https://not-this-providers-problem',
        PATH: '/usr/bin',
      },
    });

    expect(env['OTHER_BASE_URL']).toBeUndefined();
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://not-this-providers-problem');
    expect(env['PATH']).toBe('/usr/bin');
  });
});

/* -------------------------------------------------------------------------- */
/* resolveStoreEnv                                                            */
/* -------------------------------------------------------------------------- */

describe('resolveStoreEnv', () => {
  it('locates history for a profile that has never been signed in', async () => {
    // Reading transcripts is not an authenticated operation. A profile with no
    // login can still hold history — from before a sign-out, or from a
    // directory the user pointed at — and the sidebar must show it.
    const env = await resolveStoreEnv(makeProfile(), { credentials: CLAUDE_CREDENTIALS });

    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(configDir);
  });

  it('creates nothing, because this is the read path', async () => {
    const target = path.join(userDataDir, 'read-only');
    await resolveStoreEnv(makeProfile({ configDir: target }), {
      credentials: CLAUDE_CREDENTIALS,
    });

    await expect(stat(target)).rejects.toThrow();
  });

  it('still refuses a traversing configDir', async () => {
    await expect(
      resolveStoreEnv(makeProfile({ configDir: '/tmp/../../etc' }), {
        credentials: CLAUDE_CREDENTIALS,
      }),
    ).rejects.toThrow(ProfileError);
  });
});

/* -------------------------------------------------------------------------- */
/* toMetadata                                                                 */
/* -------------------------------------------------------------------------- */

describe('toMetadata', () => {
  it('exposes only renderer-safe fields', () => {
    const metadata = toMetadata(
      makeProfile({ publicEnv: { AWS_REGION: 'us-east-1' }, createdAt: 1, updatedAt: 2 }),
    );

    expect(metadata).toEqual({
      id: 'p1',
      label: 'Work',
      providerId: 'claude',
      configDir,
    });
    // `publicEnv` is a main-process concern and the renderer has no use for it.
    expect('publicEnv' in metadata).toBe(false);
  });

  it('carries the config directory, which the sign-in screen cannot work without', () => {
    // Reverses the old rule that a filesystem location had no business in the
    // renderer. That rule protected a secret this shape no longer has, and the
    // directory is what the user chose and what the sign-in command names.
    expect(toMetadata(makeProfile()).configDir).toBe(configDir);
  });
});
