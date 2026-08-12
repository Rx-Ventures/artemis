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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const INDEX_HTML = read('../index.html');
const PREVIEW_TS = read('../../main/preview.ts');
const SECURITY_TS = read('../../main/security.ts');

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
});
