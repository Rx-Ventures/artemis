/**
 * The address a local-server profile points at.
 *
 * The rule this file defends is that the *only* refusals are things that
 * cannot work. A user running `llama-server` has already made a series of
 * choices Artemis has no opinion about — which port, which interface, whether
 * it is on this machine at all — and a validator with taste rather than rules
 * would reject the setup rather than the typo.
 *
 * Two refusals are load-bearing and worth naming here:
 *
 *  - **A missing scheme is refused, not guessed.** Prefixing `http://` onto
 *    something the user meant to be `https://` would send their key over the
 *    wire in clear, which is a worse outcome than a red line under a field.
 *  - **Credentials in the URL are refused.** The address is displayed, logged
 *    and stored in plain JSON; the key field is the one that is encrypted.
 */

import { describe, expect, it } from 'vitest';

import { baseUrlProblem, normalizeBaseUrl } from './profile.js';

describe('baseUrlProblem', () => {
  it('accepts the shapes a local server actually takes', () => {
    // Loopback with a port, another machine, a tunnel with TLS, a LAN name,
    // and an IPv6 literal — every one of these is somebody's real setup.
    for (const address of [
      'http://127.0.0.1:8080',
      'http://localhost:1234',
      'http://192.168.1.40:8080',
      'https://llama.tail1234.ts.net',
      'https://models.example.com:8443',
      'http://[::1]:8080',
      'http://box.local:11434',
      'https://example.com/llama',
    ]) {
      expect(baseUrlProblem(address)).toBeNull();
    }
  });

  it('refuses a bare host and port rather than guessing a scheme', () => {
    // The likeliest thing to be typed, and the one place a guess could do
    // real harm: assuming `http:` for an endpoint the user meant to be
    // `https:` sends the key in clear over whatever network is between them.
    const problem = baseUrlProblem('127.0.0.1:8080');
    expect(problem).toContain('http://');
  });

  it('names a scheme it cannot reach instead of calling it missing', () => {
    // `ws://` and a bare address are different mistakes with different fixes,
    // and one message for both would send the user looking for the wrong one.
    expect(baseUrlProblem('ws://127.0.0.1:8080')).toContain('ws');
    expect(baseUrlProblem('file:///models/llama.gguf')).toContain('file');
  });

  it('refuses credentials in the address, pointing at the field that holds them', () => {
    const problem = baseUrlProblem('http://user:hunter2@127.0.0.1:8080');
    expect(problem).toContain('API key field');
  });

  it('refuses an address that names no host', () => {
    expect(baseUrlProblem('http://')).toContain('no host');
    expect(baseUrlProblem('http:///v1')).toContain('no host');
  });

  it('refuses a port that is not a number', () => {
    expect(baseUrlProblem('http://127.0.0.1:eighty')).toContain('port');
    // ...and does not mistake an IPv6 literal's own colons for one.
    expect(baseUrlProblem('http://[fe80::1]:8080')).toBeNull();
  });

  it('refuses nothing at all', () => {
    expect(baseUrlProblem('')).toContain('required');
    expect(baseUrlProblem('   ')).toContain('required');
    expect(baseUrlProblem(undefined)).toContain('required');
    expect(baseUrlProblem(42)).toContain('required');
  });

  it('does not ask whether anything is listening', () => {
    // A server that is off is the ordinary state of a desktop, and the
    // availability probe is what reports it. Refusing to *save* the address
    // would be the same mistake as refusing a config directory not yet made.
    expect(baseUrlProblem('http://127.0.0.1:9')).toBeNull();
  });
});

describe('normalizeBaseUrl', () => {
  it('stores one spelling, so two profiles cannot differ by an invisible slash', () => {
    expect(normalizeBaseUrl('  http://127.0.0.1:8080/  ')).toBe('http://127.0.0.1:8080');
    expect(normalizeBaseUrl('http://127.0.0.1:8080///')).toBe('http://127.0.0.1:8080');
    expect(normalizeBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('leaves a path alone but for its trailing slash', () => {
    // A server behind a reverse proxy at `/llama` is a real deployment, and
    // the adapter appends `/v1/...` to whatever this returns.
    expect(normalizeBaseUrl('https://example.com/llama/')).toBe('https://example.com/llama');
  });
});
