/**
 * The one property this module exists for: **the token appears in exactly one
 * value, and that value is never a config value.**
 *
 * Everything else here — the origin scoping, the username default, the reset
 * at index 0 — is a means to it. So the tests are written as statements about
 * the whole environment block rather than about individual keys: a future edit
 * that adds a fourth config entry carrying the token would pass a
 * key-by-key test and fail these.
 *
 * The scoping tests use two different hosts on purpose. A helper configured
 * globally would satisfy "the token reaches git" and would also offer a team's
 * memory-bank token to every other remote a spawn happened to touch.
 */

import { describe, expect, it } from 'vitest';

import {
  credentialOrigin,
  DEFAULT_GIT_USERNAME,
  GIT_TOKEN_ENV,
  gitCredentialEnv,
  gitCredentialsEnv,
  gitCredentialUsernameProblem,
  gitRemoteProblem,
} from './gitCredentialEnv';

const TOKEN = 'forgejo-9f3c1a77b2e04d6a8c5f0e1b7d4a9268';

describe('credentialOrigin', () => {
  it('keeps scheme and host, and drops everything after them', () => {
    expect(credentialOrigin('https://git.example.com/team/bank.git')).toBe('https://git.example.com');
    expect(credentialOrigin('https://git.example.com:3000/team/bank.git')).toBe(
      'https://git.example.com:3000',
    );
  });

  it('refuses anything a token must not be sent over', () => {
    // http would put the token on the wire in clear.
    expect(credentialOrigin('http://git.example.com/team/bank.git')).toBeNull();
    // ssh authenticates with a key; there is nowhere for a token to go.
    expect(credentialOrigin('git@git.example.com:team/bank.git')).toBeNull();
    expect(credentialOrigin('ssh://git@git.example.com/team/bank.git')).toBeNull();
    // Already carrying credentials: refused rather than quietly rewritten.
    expect(credentialOrigin('https://someone:hunter2@git.example.com/team/bank.git')).toBeNull();
    expect(credentialOrigin('not a url at all')).toBeNull();
  });
});

describe('gitRemoteProblem', () => {
  it('passes every transport git actually speaks', () => {
    expect(gitRemoteProblem('https://git.example.com/team/bank.git')).toBeNull();
    expect(gitRemoteProblem('http://git.internal/team/bank.git')).toBeNull();
    expect(gitRemoteProblem('git@github.com:Rx-Ventures/cerebro.git')).toBeNull();
    expect(gitRemoteProblem('ssh://git@git.example.com:2222/team/bank.git')).toBeNull();
  });

  it('refuses a URL carrying credentials, and says where they go instead', () => {
    // The rule `baseUrlProblem` applies to a server address, for the same
    // reason: this string is written into .git/config on clone.
    expect(gitRemoteProblem('https://user:token@git.example.com/team/bank.git')).toMatch(
      /access-token field/,
    );
    expect(gitRemoteProblem('https://token@git.example.com/team/bank.git')).toMatch(/access-token field/);
    // Over ssh a bare user is a login name, not a secret — but a password is.
    expect(gitRemoteProblem('ssh://git:hunter2@git.example.com/team/bank.git')).toMatch(
      /access-token field/,
    );
  });

  it('refuses an empty remote', () => {
    expect(gitRemoteProblem('   ')).toMatch(/required/);
  });
});

describe('gitCredentialUsernameProblem', () => {
  it('accepts the shapes a git host actually issues', () => {
    for (const name of [DEFAULT_GIT_USERNAME, 'seth', 'seth.torrence', 'deploy+bank', 'a@b.co', 'gitlab-ci_token']) {
      expect(gitCredentialUsernameProblem(name)).toBeNull();
    }
  });

  it('refuses anything that could be a token, or could change a shell body', () => {
    for (const name of ['', 'has space', 'semi;colon', '$(whoami)', '"quoted"', 'back`tick`']) {
      expect(gitCredentialUsernameProblem(name)).not.toBeNull();
    }
  });
});

describe('gitCredentialEnv', () => {
  const env = gitCredentialEnv({ origin: 'https://git.example.com', token: TOKEN });

  it('resets the helper chain before configuring its own', () => {
    // Index 0 is the reset, and it has to be index 0: git applies these in
    // order and an empty `credential.helper` clears everything before it.
    // Without it Git Credential Manager answers first with its own identity.
    expect(env['GIT_CONFIG_COUNT']).toBe('2');
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.helper');
    expect(env['GIT_CONFIG_VALUE_0']).toBe('');
  });

  it('scopes the helper to one origin', () => {
    expect(env['GIT_CONFIG_KEY_1']).toBe('credential.https://git.example.com.helper');
  });

  it('names the variable in the helper body and never the token', () => {
    expect(env['GIT_CONFIG_VALUE_1']).toContain(`$${GIT_TOKEN_ENV}`);
    expect(env['GIT_CONFIG_VALUE_1']).not.toContain(TOKEN);
  });

  it('defaults the username to a non-secret literal', () => {
    // git echoes the username into its own error strings, which the pane
    // shows. A token in this slot is a token on screen.
    expect(env['GIT_CONFIG_VALUE_1']).toContain(`echo username=${DEFAULT_GIT_USERNAME}`);
  });

  it('honours a username the host requires', () => {
    const gitlab = gitCredentialEnv({
      origin: 'https://gitlab.com',
      token: TOKEN,
      username: 'bank-deploy',
    });
    expect(gitlab['GIT_CONFIG_VALUE_1']).toContain('echo username=bank-deploy');
    expect(gitlab['GIT_CONFIG_VALUE_1']).not.toContain(TOKEN);
  });

  it('puts the token in ARTEMIS_GIT_TOKEN and in nothing else', () => {
    // The whole point of the module, asserted over the whole block rather than
    // key by key.
    const carrying = Object.entries(env).filter(([, value]) => value.includes(TOKEN));
    expect(carrying).toEqual([[GIT_TOKEN_ENV, TOKEN]]);
  });

  it('refuses a username that could be a token in the wrong field', () => {
    expect(() =>
      gitCredentialEnv({ origin: 'https://git.example.com', token: TOKEN, username: 'a b' }),
    ).toThrow(/username cannot be used/);
  });
});

describe('gitCredentialsEnv', () => {
  it('is empty for no credentials, so a spawn is untouched', () => {
    expect(gitCredentialsEnv([])).toEqual({});
    // A blank token is the same as none: nothing is configured for it.
    expect(gitCredentialsEnv([{ origin: 'https://git.example.com', token: '' }])).toEqual({});
  });

  it('configures every origin, each with its own token variable', () => {
    const other = 'gh-11AABBCC0deadbeefdeadbeef';
    const env = gitCredentialsEnv([
      { origin: 'https://git.example.com', token: TOKEN },
      { origin: 'https://github.com', token: other, username: 'x-access-token' },
    ]);

    expect(env['GIT_CONFIG_COUNT']).toBe('3');
    expect(env['GIT_CONFIG_KEY_1']).toBe('credential.https://git.example.com.helper');
    expect(env['GIT_CONFIG_KEY_2']).toBe('credential.https://github.com.helper');
    expect(env[`${GIT_TOKEN_ENV}_0`]).toBe(TOKEN);
    expect(env[`${GIT_TOKEN_ENV}_1`]).toBe(other);

    // Still exactly one value per token, and no config value carries either.
    for (const [name, value] of Object.entries(env)) {
      if (value.includes(TOKEN) || value.includes(other)) {
        expect(name.startsWith(GIT_TOKEN_ENV)).toBe(true);
      }
    }
  });

  it('keeps the first credential when two banks share an origin', () => {
    // git scopes a helper by host and cannot be told to try a second token for
    // the same one. The first wins, deterministically, rather than the block
    // being ambiguous about which it configured.
    const env = gitCredentialsEnv([
      { origin: 'https://git.example.com', token: TOKEN, username: 'first' },
      { origin: 'https://git.example.com', token: 'second-token', username: 'second' },
    ]);
    expect(env['GIT_CONFIG_COUNT']).toBe('2');
    expect(env['GIT_CONFIG_VALUE_1']).toContain('echo username=first');
    expect(env[GIT_TOKEN_ENV]).toBe(TOKEN);
  });
});
