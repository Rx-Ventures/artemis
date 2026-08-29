/**
 * The renderer's own Content-Security-Policy, checked against the frame it has
 * to allow.
 * ============================================================================
 *
 * `index.html` carries a `<meta http-equiv="Content-Security-Policy">` and
 * `applySessionPolicy` sets a CSP *header* on every response. Both apply, and
 * they are enforced **independently** — a request has to satisfy every policy
 * that covers the document, so what the app can actually do is the intersection.
 * A header that grants something the meta tag does not is not a grant.
 *
 * That is not a theoretical hazard. `frame-src` was missing from the meta tag
 * while the header had it, so `frame-src` there fell back to `default-src
 * 'self'` and every previewed page — HTML and SVG alike — was refused with
 * `ERR_BLOCKED_BY_CSP` before `preview.ts` was ever asked for the bytes. The
 * pane showed a white rectangle. Markdown looked fine throughout, because
 * markdown is rendered in place and never goes near a frame, which is precisely
 * what made it look like a problem with HTML.
 *
 * These read the two files as text rather than importing them. `preview.ts`
 * imports `electron`, which does not resolve under vitest, and the thing being
 * checked is genuinely that two files agree on a string — an HTML document
 * cannot import a TypeScript constant, and that is the whole reason they can
 * drift.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const INDEX_HTML = read('../index.html');
const PREVIEW_TS = read('../../main/preview.ts');
const SECURITY_TS = read('../../main/security.ts');
const STORE_TS = read('./state/store.ts');

/** The scheme name as `preview.ts` declares it — the one source of truth. */
const scheme = (() => {
  const match = /export const PREVIEW_SCHEME = '([^']+)'/.exec(PREVIEW_TS);
  if (!match?.[1]) throw new Error('PREVIEW_SCHEME is no longer declared the way this test reads it.');
  return match[1];
})();

/** The content of the renderer's meta CSP, as one string. */
const metaCsp = (() => {
  const match = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(INDEX_HTML);
  if (!match?.[1]) throw new Error('index.html no longer carries a meta CSP this test can read.');
  return match[1];
})();

const directive = (policy: string, name: string): string | undefined =>
  policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

describe("the renderer's meta CSP", () => {
  it('allows the preview scheme to be framed', () => {
    // Without this the frame is refused and the pane renders blank. There is no
    // fallback that saves it: `frame-src` absent means `default-src 'self'`, and
    // a preview is never 'self'.
    const frameSrc = directive(metaCsp, 'frame-src');
    expect(frameSrc).toBeDefined();
    expect(frameSrc).toContain(`${scheme}:`);
  });

  it('names the same scheme the main process serves', () => {
    // The two cannot share a constant, so the check is that they still agree.
    expect(metaCsp).toContain(`${scheme}:`);
    expect(SECURITY_TS).toContain('frame-src ${PREVIEW_SCHEME}:');
  });

  it('does not grant the frame an origin it could read the app from', () => {
    // Belt and braces on the pane's `sandbox="allow-scripts"`: whatever else
    // this policy says, it must not be the thing that lets a previewed page
    // reach back into the renderer.
    expect(metaCsp).not.toContain('allow-same-origin');
    expect(directive(metaCsp, 'script-src')).not.toContain('unsafe-eval');
  });

  /**
   * The terminal needed no opening, and this records that it was checked.
   *
   * xterm.js is the one dependency added since this file was written that draws
   * outside React's control, so the obvious worry is that it would need a
   * relaxation — and it does not. It writes inline `style` attributes, which
   * `style-src 'unsafe-inline'` already permits for React's sake; it paints into
   * a `<canvas>`, which no directive governs; it loads no worker, evaluates no
   * string, and fetches nothing. Its stylesheet is bundled by Vite and served
   * same-origin, like the fonts.
   *
   * The assertion is deliberately about what is *absent*: if a future xterm
   * addon (the WebGL renderer is the likely one) ever needs `worker-src blob:`
   * widened or `unsafe-eval` granted, this is the test that should be argued
   * with rather than quietly edited.
   */
  it('needs no relaxation for the terminal emulator', () => {
    expect(directive(metaCsp, 'script-src')).not.toContain('unsafe-eval');
    // Inline style is the one thing xterm relies on, and it was already granted
    // for React — so the terminal added no new permission at all.
    expect(directive(metaCsp, 'style-src')).toContain("'unsafe-inline'");
  });

  /**
   * The remote-mode split (ADR 0004): where each layer's connect-src grant
   * ends, and why the division is not a loosened posture wearing a comment.
   *
   * Remote mode fetches one user-configured origin. A static meta tag cannot
   * name a runtime value, so `connect-src` splits across the layers: this tag
   * carries the scheme-wide grant (its honest limit), and the *narrowing to
   * exactly one origin* lives in the two layers that can read the
   * configuration — the header CSP and the webRequest lockdown, both covered
   * behaviourally in `main/security.test.ts`. What this block pins is the
   * shape of the split itself: the meta widens connect-src and nothing else,
   * and the header builder interpolates a single normalized origin rather
   * than any wildcard.
   */
  it('widens connect-src for remote mode, and only connect-src', () => {
    expect(directive(metaCsp, 'connect-src')).toContain('http:');
    expect(directive(metaCsp, 'connect-src')).toContain('https:');
    // The breadth must not leak into the directives that gate execution.
    expect(directive(metaCsp, 'script-src')).not.toContain('http');
    expect(directive(metaCsp, 'frame-src')).toBe(`frame-src ${scheme}:`);
    expect(directive(metaCsp, 'default-src')).toBe("default-src 'self'");
  });

  it('leaves the exact-origin narrowing to the header, which never wildcards', () => {
    // The header builder takes the one configured origin and nothing wider —
    // the interpolation is the contract, and a `*` anywhere near connect-src
    // in `security.ts` would be the wildcard ADR 0004 forbids.
    expect(SECURITY_TS).toContain("`connect-src 'self' ${remoteOrigin}`");
    expect(SECURITY_TS).not.toMatch(/connect-src[^`\n]*\*/);
  });
});

/**
 * The theme boot script, and the three things that can silently unhook it.
 * ============================================================================
 *
 * `index.html` runs one inline script — it resolves the stored palette onto
 * `<html>` before the first paint, which the deferred module bundle cannot do.
 * Inline script is the thing this app's CSP exists to forbid, so it is granted
 * by hash instead of by `'unsafe-inline'`.
 *
 * Every failure mode here is invisible in development, which is what makes the
 * test worth its length. Dev strips the meta tag and serves a policy carrying
 * `'unsafe-inline'`, so the script runs there no matter what these hashes say;
 * the only place a stale hash shows up is a packaged build, as a flash of the
 * wrong palette on launch that nobody can reproduce.
 */
describe('the theme boot script', () => {
  /** The script's exact bytes — what a CSP hash is computed over. */
  const bootScript = (() => {
    const match = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML);
    if (!match?.[1]) throw new Error('index.html no longer carries an inline boot script.');
    return match[1];
  })();

  const bootHash = `'sha256-${createHash('sha256').update(bootScript, 'utf8').digest('base64')}'`;

  it('is granted by hash in the meta CSP', () => {
    // Recomputed rather than compared to a constant: the point is that the
    // hash in the file describes the script in the file, and a test holding
    // its own copy of the expected value would drift in the same direction.
    expect(directive(metaCsp, 'script-src')).toContain(bootHash);
  });

  it('is granted by the same hash in the production header', () => {
    expect(SECURITY_TS).toContain(bootHash);
  });

  /*
   * The relaxation that would quietly revoke the other one.
   *
   * Under CSP level 3, a `script-src` carrying any hash or nonce ignores
   * `'unsafe-inline'`. The development policy needs `'unsafe-inline'` for
   * Vite's Fast Refresh preamble, so naming the boot hash there would take
   * Fast Refresh out — the failure being a dead page on `$RefreshSig$ is not
   * defined`, which reads as a Vite problem rather than a CSP one.
   */
  it('is not named in the development policy, which would disable unsafe-inline', () => {
    const developmentCsp = /function developmentCsp\([\s\S]*?\n}/.exec(SECURITY_TS)?.[0];
    expect(developmentCsp).toBeDefined();
    expect(developmentCsp).toContain("'unsafe-inline'");
    expect(developmentCsp).not.toContain(bootHash);
  });

  /*
   * The script reads preferences the store writes, and neither can import from
   * the other — an HTML document cannot import a TypeScript constant, which is
   * the same reason the tests above exist.
   */
  it('reads the key the store actually writes', () => {
    const key = /const PREFS_KEY = '([^']+)'/.exec(STORE_TS)?.[1];
    expect(key).toBeDefined();
    expect(bootScript).toContain(`localStorage.getItem('${key ?? ''}')`);
  });

  it('accepts exactly the theme values the store will accept', () => {
    // A value the script honours but the store coerces away — or the reverse —
    // means the first paint and the first render disagree.
    for (const theme of ['light', 'dark', 'system']) {
      expect(bootScript).toContain(`'${theme}'`);
    }
    expect(STORE_TS).toContain("const THEMES: readonly Theme[] = ['system', 'light', 'dark']");
  });

  /*
   * Both sides answer "no matchMedia" with dark. If they ever disagreed, the
   * disagreement would only appear where `matchMedia` is missing — which is
   * nowhere a user runs and everywhere the tests run.
   */
  it('falls back to dark without matchMedia, as the store does', () => {
    expect(bootScript).toContain('!window.matchMedia ||');
    expect(STORE_TS).toContain("globalThis.matchMedia?.(DARK_QUERY).matches ?? true");
  });

  /*
   * Order matters for a policy delivered by meta: it governs only what follows
   * it. A boot script above the tag would be exempt from the very policy this
   * file is about, and every assertion above would still pass.
   */
  it('sits after the meta CSP, so the meta policy actually covers it', () => {
    expect(INDEX_HTML.indexOf('<script>')).toBeGreaterThan(
      INDEX_HTML.indexOf('http-equiv="Content-Security-Policy"'),
    );
  });

  /*
   * The static attribute is the failure mode's floor: a blocked or broken
   * script leaves a document that still renders the dark palette correctly,
   * rather than one with no palette class and every `dark:` variant inert.
   */
  it('leaves the static dark class in place as its fallback', () => {
    expect(INDEX_HTML).toContain('<html lang="en" class="dark">');
  });
});
