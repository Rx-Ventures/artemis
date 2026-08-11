/**
 * Reading the CLI's authentication status, and writing the command that changes
 * it.
 *
 * Two things in `signIn.ts` are worth pinning; the rest is subprocess plumbing.
 *
 *  - **The parser** decides whether a profile is shown as ready to run. Reading
 *    "signed in" from a malformed answer would let a run start against a
 *    directory that has no credential.
 *  - **The command** is pasted into a terminal by a human. It is the only
 *    instruction they get, so a quoting mistake is not a cosmetic defect — it
 *    is a command that silently signs in the wrong directory, or fails with a
 *    shell error the user has no way to connect back to Apollo.
 */

import { describe, expect, it } from 'vitest';

import { CLAUDE_CREDENTIALS } from '../claude.js';
import { parseAuthStatus, signInCommand } from '../signIn.js';

/** The real shape, captured from `claude auth status --json` on a signed-in dir. */
const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'someone@example.com',
  orgId: 'c8174372-993e-4bad-a3a4-b9fdc548b5e7',
  orgName: "someone@example.com's Organization",
  subscriptionType: 'max',
});

/** And from a config directory that has never been signed in. */
const SIGNED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'firstParty',
});

describe('parseAuthStatus', () => {
  it('reads a signed-in subscription directory', () => {
    expect(parseAuthStatus(SIGNED_IN)).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'someone@example.com',
      orgName: "someone@example.com's Organization",
      subscriptionType: 'max',
    });
  });

  it('reads a signed-out directory without inventing an error', () => {
    // Signed out is a normal state, not a failure. An `error` here would make
    // the UI report a problem where there is only an empty directory.
    const status = parseAuthStatus(SIGNED_OUT);
    expect(status.loggedIn).toBe(false);
    expect(status.authMethod).toBe('none');
    expect(status.error).toBeUndefined();
  });

  it('ignores notices printed before the JSON', () => {
    // The CLI prefixes update notices and warnings often enough that parsing
    // the whole of stdout would fail on a perfectly good status.
    const status = parseAuthStatus(`Update available: 2.1.226\n\n${SIGNED_IN}`);
    expect(status.loggedIn).toBe(true);
    expect(status.subscriptionType).toBe('max');
  });

  it('treats a missing loggedIn field as signed OUT', () => {
    // The safe direction. Defaulting to signed-in would let a run start
    // against a directory holding no credential.
    expect(parseAuthStatus('{"authMethod":"claude.ai"}').loggedIn).toBe(false);
  });

  it('treats a truthy-but-not-true loggedIn as signed out', () => {
    expect(parseAuthStatus('{"loggedIn":"yes"}').loggedIn).toBe(false);
    expect(parseAuthStatus('{"loggedIn":1}').loggedIn).toBe(false);
  });

  it('reports an error for output that is not JSON at all', () => {
    // Distinct from signed-out: something is wrong with the CLI, and the UI
    // should say so rather than showing an ordinary "sign in" prompt.
    const status = parseAuthStatus('command not found: claude');
    expect(status.loggedIn).toBe(false);
    expect(status.error).toBeDefined();
  });

  it('reports an error for JSON that is not an object', () => {
    expect(parseAuthStatus('[1,2,3]').error).toBeDefined();
    expect(parseAuthStatus('"nope"').error).toBeDefined();
  });

  it('omits empty strings rather than surfacing blank fields', () => {
    const status = parseAuthStatus('{"loggedIn":true,"email":"","subscriptionType":"pro"}');
    expect(status.email).toBeUndefined();
    expect(status.subscriptionType).toBe('pro');
  });

  it('never throws, whatever it is handed', () => {
    expect(() => parseAuthStatus('')).not.toThrow();
    expect(() => parseAuthStatus('{')).not.toThrow();
    expect(() => parseAuthStatus('{"loggedIn":true')).not.toThrow();
  });
});

describe('signInCommand', () => {
  const command = (configDir: string): string =>
    signInCommand({ credentials: CLAUDE_CREDENTIALS, configDir });

  it('sets the config directory inline rather than exporting it', () => {
    // Inline, so it scopes to this one command. An `export` would silently
    // re-point every later `claude` invocation in that shell — a user signing a
    // second profile in would end up looking at the first one's account.
    expect(command('/Users/me/.claude')).toBe(
      "CLAUDE_CONFIG_DIR=/Users/me/.claude claude auth login",
    );
  });

  it('quotes a path containing spaces, which macOS produces by default', () => {
    // `~/Library/Application Support/…` is where Apollo's own suggestions live,
    // so this is the common case rather than an edge one. Unquoted, the shell
    // splits it and `claude` is run with a truncated directory.
    expect(command('/Users/me/Library/Application Support/Apollo/profiles/work')).toBe(
      "CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/Apollo/profiles/work' claude auth login",
    );
  });

  it('quotes characters a shell would otherwise interpret', () => {
    for (const dir of ['/tmp/a$b', '/tmp/a`b', '/tmp/a"b', '/tmp/a\\b', '/tmp/a;rm -rf b']) {
      const line = command(dir);
      // Single quotes: nothing inside them is expanded or executed.
      expect(line).toContain(`'${dir}'`);
    }
  });

  it('escapes an embedded single quote rather than ending the quoting early', () => {
    // The one character single-quoting cannot contain. Getting this wrong
    // terminates the string mid-path and hands the rest to the shell as code.
    expect(command("/Users/me/o'brien/.claude")).toBe(
      String.raw`CLAUDE_CONFIG_DIR='/Users/me/o'\''brien/.claude' claude auth login`,
    );
  });

  it('names the executable and argv the adapter declared, not a hard-coded string', () => {
    const line = signInCommand({
      credentials: {
        configDirVar: 'OTHER_CONFIG_DIR',
        credentialEnvKeys: [],
        signIn: {
          executable: 'other',
          loginArgs: ['login', '--browser'],
          statusArgs: [],
          logoutArgs: [],
          howTo: '',
        },
      },
      configDir: '/tmp/other',
    });

    expect(line).toBe('OTHER_CONFIG_DIR=/tmp/other other login --browser');
  });
});
