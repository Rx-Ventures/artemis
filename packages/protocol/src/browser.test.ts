/**
 * `browserUrlFor`, which decides what an embedded browser is allowed to load.
 *
 * This is the narrowest and most security-relevant function in the package: it
 * is the gate between a string somebody typed — or a string that arrived over
 * IPC claiming somebody typed it — and a page that will run script inside the
 * app's window. So the cases that matter most here are the refusals.
 *
 * Three groups, in descending order of how bad it would be to get wrong:
 *
 *  - **Schemes that are not the web.** `javascript:` is code, `data:` is a page
 *    with no origin, `file:` is the user's disk. Each has to be refused
 *    outright rather than repaired into something loadable.
 *  - **Smuggling.** A control character inside an address is how one host is
 *    shown to a reader while a different one is parsed.
 *  - **The ordinary cases**, which have to keep working or the feature is not a
 *    browser: a bare domain, a dev server, a deep link.
 */

import { describe, expect, it } from 'vitest';

import { browserUrlFor } from './browser.js';

describe('schemes it refuses', () => {
  it('refuses javascript:, which is a program rather than an address', () => {
    expect(browserUrlFor('javascript:alert(1)')).toBeNull();
    expect(browserUrlFor('JaVaScRiPt:alert(1)')).toBeNull();
  });

  it('refuses data:, which is a page with no origin', () => {
    expect(browserUrlFor('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('refuses file:, which is the user’s disk', () => {
    // The temptation this exists to resist: Artemis shows local files through
    // two other channels, both of which hand back something inert.
    expect(browserUrlFor('file:///etc/passwd')).toBeNull();
    expect(browserUrlFor('file://localhost/etc/passwd')).toBeNull();
  });

  it('refuses other schemes rather than guessing at them', () => {
    for (const one of ['about:blank', 'chrome://settings', 'mailto:a@b.com', 'ftp://x.com']) {
      expect(browserUrlFor(one)).toBeNull();
    }
  });

  /*
   * The repair-step trap. A version of this that fell through to "no scheme, so
   * prefix https://" would turn every refusal above into a load.
   */
  it('does not repair a refused scheme by prefixing one it accepts', () => {
    // Never a string: a refusal that fell through to the no-scheme branch would
    // come back as `https://javascript:alert(1)`, which is a load rather than a
    // refusal. `null` is the only acceptable answer for any of these.
    for (const one of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(typeof browserUrlFor(one)).toBe('object');
      expect(browserUrlFor(one)).toBeNull();
    }
  });
});

describe('smuggling', () => {
  it('refuses an address containing a control character', () => {
    // `https://good.com` to a reader, something else to a parser.
    expect(browserUrlFor('https://good.com\u0000@evil.com')).toBeNull();
    expect(browserUrlFor('https://good.com\n@evil.com')).toBeNull();
    expect(browserUrlFor('https://good\u001f.com')).toBeNull();
    expect(browserUrlFor('https://good.com\u007f')).toBeNull();
  });

  it('refuses anything with whitespace, which is prose rather than a host', () => {
    expect(browserUrlFor('how do i center a div')).toBeNull();
    expect(browserUrlFor('https://good.com evil.com')).toBeNull();
    expect(browserUrlFor('https://good.com\tevil.com')).toBeNull();
  });

  it('refuses an http(s) URL with no host at all', () => {
    expect(browserUrlFor('https://')).toBeNull();
    expect(browserUrlFor('http:/example.com')).toBeNull();
  });

  it('refuses an implausibly long address by length rather than by parsing', () => {
    expect(browserUrlFor(`https://example.com/${'a'.repeat(5_000)}`)).toBeNull();
  });
});

describe('addresses it accepts', () => {
  it('keeps an absolute URL, normalising only the scheme’s case', () => {
    expect(browserUrlFor('https://example.com/docs?q=1#top')).toBe(
      'https://example.com/docs?q=1#top',
    );
    expect(browserUrlFor('HTTPS://Example.com/Docs')).toBe('https://Example.com/Docs');
  });

  it('accepts plain http, which a local server may be the only speaker of', () => {
    expect(browserUrlFor('http://example.com')).toBe('http://example.com');
  });

  it('guesses https for a bare domain', () => {
    // Not http: guessing http for a real site is how a browser downgrades a
    // connection that would have been encrypted.
    expect(browserUrlFor('example.com')).toBe('https://example.com');
    expect(browserUrlFor('docs.example.co.uk/getting-started')).toBe(
      'https://docs.example.co.uk/getting-started',
    );
  });

  it('guesses http for a dev server, which is the case that matters here', () => {
    expect(browserUrlFor('localhost:5173')).toBe('http://localhost:5173');
    expect(browserUrlFor('localhost')).toBe('http://localhost');
    expect(browserUrlFor('127.0.0.1:8080/health')).toBe('http://127.0.0.1:8080/health');
    expect(browserUrlFor('[::1]:3000')).toBe('http://[::1]:3000');
  });

  it('trims, because an address bar receives pasted whitespace', () => {
    expect(browserUrlFor('  https://example.com  ')).toBe('https://example.com');
  });
});

describe('fragments that are not addresses', () => {
  /*
   * The product decision this pins: no search engine. A typo does not become a
   * request to a third party — see the function's own header for why that trade
   * is made this way round in a coding tool.
   */
  it('refuses a bare word rather than searching for it', () => {
    expect(browserUrlFor('artemis')).toBeNull();
    expect(browserUrlFor('what is a webcontentsview')).toBeNull();
  });

  it('refuses the empty string', () => {
    expect(browserUrlFor('')).toBeNull();
    expect(browserUrlFor('   ')).toBeNull();
  });

  it('refuses something dot-shaped with no plausible tail', () => {
    expect(browserUrlFor('1.2')).toBeNull();
    expect(browserUrlFor('file.')).toBeNull();
  });
});
