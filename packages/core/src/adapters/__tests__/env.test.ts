/**
 * Tests for provider environment composition.
 *
 * The interesting cases here are all security cases: a run must never inherit a
 * credential the profile did not choose, and — since the choice of credential
 * is also the choice of *who pays* — the profile's auth mode must survive
 * contact with whatever the user happens to have exported in their shell.
 */

import { describe, expect, it } from 'vitest';

import { CLAUDE_ENV_SCRUB_KEYS, composeProviderEnv, readEnv } from '../env.js';

const HOST = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/dev',
  ANTHROPIC_API_KEY: 'sk-ant-personal-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-from-the-users-shell',
  CLAUDE_CONFIG_DIR: '/Users/dev/.claude',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_REGION: 'us-east-1',
} as const;

describe('composeProviderEnv', () => {
  it('inherits the host environment so the provider can find its tools', () => {
    const env = composeProviderEnv({}, { hostEnv: HOST, scrubKeys: CLAUDE_ENV_SCRUB_KEYS });
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/Users/dev');
  });

  it('scrubs inherited credentials so a profile cannot be contaminated', () => {
    const env = composeProviderEnv({}, { hostEnv: HOST, scrubKeys: CLAUDE_ENV_SCRUB_KEYS });
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
    expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });

  it('strips an inherited subscription token from an api-key profile, so the shell cannot change who is billed', () => {
    const env = composeProviderEnv(
      { ANTHROPIC_API_KEY: 'sk-ant-profile-key' },
      { hostEnv: HOST, scrubKeys: CLAUDE_ENV_SCRUB_KEYS },
    );
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-profile-key');
    expect(CLAUDE_ENV_SCRUB_KEYS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('strips an inherited API key from a subscription profile — the API key would otherwise win', () => {
    // The asymmetric case, and the reason this list has to cover *both*
    // credential variables rather than only the one Libra used to support:
    // ANTHROPIC_API_KEY takes precedence over CLAUDE_CODE_OAUTH_TOKEN, so an
    // ambient key would silently turn a subscription run into metered spend.
    const env = composeProviderEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-profile-token' },
      { hostEnv: HOST, scrubKeys: CLAUDE_ENV_SCRUB_KEYS },
    );
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-profile-token');
    expect(CLAUDE_ENV_SCRUB_KEYS).toContain('ANTHROPIC_API_KEY');
  });

  it('lets a profile set the credential variable the scrub list removes', () => {
    // Scrubbing applies to the inherited base only. If it applied to the
    // profile bundle as well, subscription mode could never emit its own token.
    const env = composeProviderEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-profile-token' },
      { hostEnv: {}, scrubKeys: CLAUDE_ENV_SCRUB_KEYS },
    );
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-profile-token');
  });

  it('leaves the cloud credential chain alone, which bedrock and vertex rely on', () => {
    const env = composeProviderEnv({}, { hostEnv: HOST, scrubKeys: CLAUDE_ENV_SCRUB_KEYS });
    expect(env['AWS_REGION']).toBe('us-east-1');
  });

  it('lets the profile win over anything inherited', () => {
    const env = composeProviderEnv(
      { PATH: '/opt/libra/bin', CLAUDE_CONFIG_DIR: '/app/profiles/work' },
      { hostEnv: HOST, scrubKeys: CLAUDE_ENV_SCRUB_KEYS },
    );
    expect(env['PATH']).toBe('/opt/libra/bin');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/app/profiles/work');
  });

  it('treats an undefined bundle value as an explicit unset', () => {
    const env = composeProviderEnv({ HOME: undefined }, { hostEnv: HOST });
    expect('HOME' in env).toBe(false);
  });

  it('produces a hermetic environment when inheritance is off', () => {
    const env = composeProviderEnv(
      { ANTHROPIC_API_KEY: 'sk-ant-profile-key' },
      { hostEnv: HOST, inheritHostEnv: false, scrubKeys: CLAUDE_ENV_SCRUB_KEYS },
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-profile-key' });
  });

  it('supports scrubbing a whole family by pattern', () => {
    const env = composeProviderEnv({}, { hostEnv: HOST, scrubPattern: /^AWS_/ });
    expect(env['AWS_REGION']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin:/bin');
  });

  it('returns a detached copy, so no caller can mutate process.env through it', () => {
    const host: Record<string, string> = { PATH: '/bin' };
    const env = composeProviderEnv({}, { hostEnv: host });
    env['PATH'] = '/hacked';
    expect(host['PATH']).toBe('/bin');
  });
});

describe('readEnv', () => {
  it('reads a value from the bundle', () => {
    expect(readEnv({ CLAUDE_CONFIG_DIR: '/app/work' }, 'CLAUDE_CONFIG_DIR')).toBe('/app/work');
  });

  it('treats missing and empty as absent, so callers do not point at ""', () => {
    expect(readEnv({}, 'CLAUDE_CONFIG_DIR')).toBeUndefined();
    expect(readEnv({ CLAUDE_CONFIG_DIR: '' }, 'CLAUDE_CONFIG_DIR')).toBeUndefined();
    expect(readEnv({ CLAUDE_CONFIG_DIR: undefined }, 'CLAUDE_CONFIG_DIR')).toBeUndefined();
  });
});
