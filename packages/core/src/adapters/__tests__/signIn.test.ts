/**
 * Parsing the CLI's authentication status.
 *
 * The parser is the part worth pinning: everything else in `signIn.ts` is
 * subprocess plumbing, but this decides whether a profile is shown as ready to
 * run. Reading "signed in" from a malformed answer would let a run start
 * against a directory that has no credential.
 */

import { describe, expect, it } from 'vitest';
import { parseAuthStatus } from '../signIn.js';

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
