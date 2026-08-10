/**
 * Credential shape warnings.
 *
 * These exist because of a real incident: a value that was not an Anthropic
 * credential at all was saved into a subscription profile, and the only signal
 * the user got was `401 invalid bearer token` partway into a run. Nothing
 * between the input field and the provider had an opinion about the shape.
 */

import { describe, expect, it } from 'vitest';
import { credentialShapeWarning } from './profile';

const OAUTH = 'sk-ant-oat01-abcdefghijklmnop';
const API_KEY = 'sk-ant-api03-abcdefghijklmnop';

describe('credentialShapeWarning', () => {
  it('is silent for a subscription token in subscription mode', () => {
    expect(credentialShapeWarning(OAUTH, 'subscription')).toBeNull();
  });

  it('is silent for an API key in api-key mode', () => {
    expect(credentialShapeWarning(API_KEY, 'api-key')).toBeNull();
  });

  it('has nothing to say about absent input', () => {
    // An empty field while editing means "keep the stored credential".
    expect(credentialShapeWarning(null, 'subscription')).toBeNull();
    expect(credentialShapeWarning(undefined, 'subscription')).toBeNull();
    expect(credentialShapeWarning('', 'subscription')).toBeNull();
    expect(credentialShapeWarning('   ', 'subscription')).toBeNull();
  });

  it('recognises the browser login code and says where it actually goes', () => {
    // The real incident. `claude setup-token` opens a browser; when the browser
    // cannot reach the CLI's local callback (SSH, WSL2, containers) it shows a
    // login code — an OAuth authorization code and state joined by "#" — which
    // belongs in the TERMINAL. The token is printed after that. Pasted here it
    // is sent as a bearer token and returns a bare 401.
    const loginCode =
      'w3eAQYFP6kBVIjmSu8qouOXlO2meOHELresMLj4iDb6BdRNB#5nzgCVO-26Apg5kqNjlkSDiTtDlJTFno_szKmD3DWFA';
    const warning = credentialShapeWarning(loginCode, 'subscription');

    expect(warning).toContain('login code');
    expect(warning).toContain('terminal');
  });

  it('flags a value that is not an Anthropic credential at all', () => {
    const warning = credentialShapeWarning('definitely-not-a-credential', 'subscription');
    expect(warning).toContain('setup-token');
  });

  it('does not mistake an Anthropic credential containing "#" for a login code', () => {
    // The login-code check is deliberately narrow: it requires BOTH a "#" and
    // the absence of the vendor prefix, so a real credential is never
    // misdiagnosed as the wrong artefact entirely.
    expect(credentialShapeWarning('sk-ant-oat01-abc#def', 'subscription')).toBeNull();
  });

  it('tailors the not-an-anthropic-credential message to the mode', () => {
    expect(credentialShapeWarning('nonsense', 'subscription')).toContain('setup-token');
    expect(credentialShapeWarning('nonsense', 'api-key')).toContain('API key');
  });

  it('flags an API key pasted into a subscription profile', () => {
    // Right vendor, wrong kind: this would be sent as a bearer token and
    // rejected, producing exactly the confusing 401 this check prevents.
    const warning = credentialShapeWarning(API_KEY, 'subscription');
    expect(warning).toContain('API key');
    expect(warning).toContain('subscription');
  });

  it('flags a subscription token pasted into an api-key profile', () => {
    const warning = credentialShapeWarning(OAUTH, 'api-key');
    expect(warning).toContain('subscription token');
  });

  it('flags a credential containing whitespace, which means a broken paste', () => {
    expect(credentialShapeWarning('sk-ant-oat01-abc def', 'subscription')).toContain('space');
    expect(credentialShapeWarning('sk-ant-oat01-abc\ndef', 'subscription')).toContain('space');
  });

  it('tolerates surrounding whitespace, which is a harmless paste artefact', () => {
    // Leading/trailing space is trimmed everywhere else too; only *interior*
    // whitespace indicates a genuinely broken copy.
    expect(credentialShapeWarning(`  ${OAUTH}  `, 'subscription')).toBeNull();
  });

  it('says nothing when the auth mode is unknown, for either credential kind', () => {
    // A provider that declares no auth modes leaves the mode undefined. There
    // is no mismatch to report against a choice the user never made, so
    // neither kind may trigger the pairing warnings.
    expect(credentialShapeWarning(API_KEY, undefined)).toBeNull();
    expect(credentialShapeWarning(OAUTH, undefined)).toBeNull();
  });
});
