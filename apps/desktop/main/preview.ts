/**
 * Showing a page the agent wrote.
 * ============================================================================
 *
 * An agent asked to "make an artifact" writes an `.html` file and stops. Until
 * this file existed Artemis had nothing to do with that: the transcript drew a
 * diff of the source, and the only way to see the *page* was to leave the app.
 * This is what turns that file into something on screen.
 *
 * ## Why a scheme of its own, and not an iframe full of the markup
 *
 * The obvious implementation — `<iframe srcdoc={html}>` — cannot work here, and
 * the reason is worth stating because it is not obvious until it fails. A
 * `srcdoc` frame (and a `blob:` or `data:` one) **inherits its parent's
 * Content-Security-Policy**. Artemis's renderer runs under `default-src 'none';
 * script-src 'self'`, which is exactly the policy that makes the transcript safe
 * to render — and under it every artifact worth previewing is a blank rectangle,
 * because an artifact is inline script and inline style and nothing else.
 *
 * Relaxing the renderer's own CSP to fix that would be the wrong trade by a wide
 * margin: it would loosen the policy protecting the transcript, the session list
 * and the composer in order to render one frame.
 *
 * A response served from a scheme of its own gets *its own* CSP header, so the
 * frame can be permissive about the things an artifact needs (inline script,
 * inline style, `eval`) while the page hosting it stays locked down. The two
 * policies never meet.
 *
 * ## What contains the frame, given that its script really does run
 *
 * Four things, none of which is the CSP that lets the script run at all:
 *
 *  1. **`sandbox="allow-scripts"` without `allow-same-origin`** — the renderer's
 *     side of this, in `ArtifactPane`. The document lands in an opaque origin:
 *     no access to the parent DOM, no storage, no cookies. Granting both of
 *     those tokens together is the one combination that would undo this, which
 *     is why the pane spells out why it does not.
 *  2. **No network, twice over.** `connect-src 'none'` in the policy below, and
 *     `applySessionPolicy`'s request lockdown underneath it, which cancels
 *     anything from the renderer that is not Artemis's own origin. An artifact
 *     that reaches for a CDN gets nothing.
 *  3. **No IPC.** `isTrustedFrame` requires the *main* frame, so nothing in a
 *     nested frame can reach a privileged handler no matter what it calls.
 *  4. **A snapshot, not a path.** See below.
 *
 * ## The bytes are copied at grant time
 *
 * `grantPreview` reads the file once and keeps the bytes; the handler serves
 * them from memory and never touches the filesystem. That is three properties
 * for the price of one map:
 *
 *  - **No path traversal.** The handler resolves a token to a buffer. There is
 *    no path in the URL to sanitise, so there is no `../..` to get wrong.
 *  - **No TOCTOU.** What is served is what was checked, not whatever is at that
 *    path by the time the frame asks for it.
 *  - **It is a record.** The pane keeps showing the page as it was when it was
 *    opened, which is the same promise the transcript makes about everything
 *    else in it.
 *
 * The cost is that a preview does not follow later edits — reopening is what
 * refreshes it — and that a page referencing a sibling file (`./chart.css`)
 * renders without it. Both are real, and both are the honest shape of "one file,
 * exactly as it was" rather than "a web server pointed at your home directory".
 */

import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { protocol } from 'electron';

import type { PreviewOpenResponse } from '@rx-artemis/protocol';

import { createLogger } from './log.js';

const log = createLogger('preview');

/**
 * The scheme previews are served from.
 *
 * Named rather than inlined because four files have to agree on it: this one
 * serves it, `security.ts` exempts it from the renderer's policy in two places,
 * and the renderer's CSP lists it in `frame-src`.
 */
export const PREVIEW_SCHEME = 'artemis-preview';

/**
 * What a preview may be, and how each is delivered.
 *
 * Two kinds, because two things are genuinely different. An `.html` page or an
 * `.svg` is a document a browser engine has to lay out — and, for HTML, one that
 * may execute script — so it is *framed*, from the scheme below. Markdown is
 * text: there is nothing in it to execute and nothing to lay out that the app
 * cannot already lay out, so it is handed to the renderer as source.
 *
 * That split is why markdown is here at all, having once been excluded. The
 * argument against it was that the transcript renders markdown already — true,
 * but only of markdown *in the conversation*. A `.md` file the agent writes to
 * disk is not in the conversation, and until it could be previewed there was
 * nowhere in Artemis to read it.
 */
const RENDERABLE: Readonly<Record<string, { kind: 'frame'; mediaType: string } | { kind: 'markdown' }>> = {
  '.html': { kind: 'frame', mediaType: 'text/html; charset=utf-8' },
  '.htm': { kind: 'frame', mediaType: 'text/html; charset=utf-8' },
  '.svg': { kind: 'frame', mediaType: 'image/svg+xml' },
  '.md': { kind: 'markdown' },
  '.markdown': { kind: 'markdown' },
};

/** True for a path this module is willing to render. Used by the IPC handler. */
export function isRenderablePath(path: string): boolean {
  return extname(path).toLowerCase() in RENDERABLE;
}

/**
 * The largest file worth putting in a frame.
 *
 * A ceiling rather than a guess at what is reasonable: the bytes are held in
 * memory for as long as the preview is open, and a runaway generated page
 * should fail with a sentence rather than with the window's memory.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * How many previews stay servable at once.
 *
 * Small on purpose. The pane shows one at a time, and the only reason to keep
 * any others is that a reload or a fast reopen should not 404. Oldest out first.
 */
const MAX_RETAINED = 8;

/**
 * The policy the previewed document runs under.
 *
 * Permissive exactly where an artifact needs it and nowhere else. `'unsafe-inline'`
 * and `'unsafe-eval'` are the whole reason this file exists — an artifact is a
 * `<script>` tag — but note that no *host* source appears anywhere in the list:
 * with no host allowed, `script-src 'unsafe-inline'` permits the page's own
 * inline script and still refuses to fetch anyone else's. `connect-src 'none'`
 * says the same thing about XHR and `fetch`.
 *
 * `img-src`/`media-src` allow `data:` and `blob:` because a self-contained page
 * inlines its own images and a canvas export produces a blob; neither can reach
 * off the machine.
 *
 * There is deliberately **no `frame-ancestors`**, and it is the one omission
 * here that looks like a mistake. `'self'` is what it would want to say, and
 * `'self'` is precisely wrong: the framing page is Artemis's renderer, served
 * from `file:` in a packaged build and from the dev server otherwise, so the
 * preview's own origin is never the ancestor and the directive blocks the only
 * frame that is supposed to exist. (It does so with `ERR_BLOCKED_BY_RESPONSE`
 * and an empty pane, which is a memorable afternoon.) Enumerating both possible
 * ancestor origins instead would buy nothing: a `artemis-preview:` URL is
 * resolvable only inside this app's session, and only with a token nobody else
 * has been given.
 */
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

/** One granted preview: the bytes to serve, and what to call them. */
interface Preview {
  readonly body: Buffer;
  readonly mediaType: string;
  readonly title: string;
  readonly path: string;
}

/**
 * Insertion-ordered, which is what makes the eviction below "oldest first"
 * without storing a timestamp: `Map` iterates in insertion order, so the first
 * key is the oldest.
 */
const granted = new Map<string, Preview>();

/**
 * Read a file and make it renderable.
 *
 * Returns either a URL for a frame or the text itself, depending on what the
 * file is — see {@link RENDERABLE}. Throws a plain `Error` on anything that
 * stops it: the IPC layer turns that into a typed failure, and every message
 * here is written to be shown to the person who clicked Preview.
 */
export async function grantPreview(path: string): Promise<PreviewOpenResponse> {
  const renderable = RENDERABLE[extname(path).toLowerCase()];
  if (renderable === undefined) {
    throw new Error(
      `Artemis can preview HTML, SVG and Markdown files, and ${basename(path)} is none of those.`,
    );
  }

  const info = await stat(path).catch(() => null);
  if (info === null) throw new Error(`There is no file at ${path} any more.`);
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > MAX_BYTES) {
    throw new Error(
      `${basename(path)} is ${Math.round(info.size / 1024 / 1024)} MB, which is too large to preview.`,
    );
  }

  const body = await readFile(path);
  const title = basename(path);

  /*
   * Markdown never reaches the scheme below. It is decoded here and sent as
   * text, so nothing is granted, nothing is retained, and there is no URL to
   * expire — the pane holds the only copy for as long as it is open.
   */
  if (renderable.kind === 'markdown') {
    return { kind: 'markdown', text: body.toString('utf8'), title, path, bytes: body.byteLength };
  }
  const mediaType = renderable.mediaType;

  // Hex, and lowercase, because it becomes the URL's *host*: a standard scheme
  // lowercases and rejects a host with anything exotic in it, so a token that
  // was merely random-looking would fail to resolve for reasons no error
  // message would explain.
  const token = randomBytes(16).toString('hex');
  granted.set(token, { body, mediaType, title, path });

  while (granted.size > MAX_RETAINED) {
    const oldest = granted.keys().next();
    if (oldest.done === true) break;
    granted.delete(oldest.value);
  }

  return { kind: 'frame', url: `${PREVIEW_SCHEME}://${token}/`, title, path, bytes: body.byteLength };
}

/** Forget every granted preview. For teardown. */
export function clearPreviews(): void {
  granted.clear();
}

/**
 * Declare the scheme before the app is ready.
 *
 * Must run at module scope in the main entry point — `registerSchemesAsPrivileged`
 * is one of the handful of Electron calls that is silently a no-op after
 * `app.whenReady()`, and the failure it produces then is a frame that loads
 * nothing with no error anywhere.
 *
 * `standard` gives the response a real origin, without which the document is
 * opaque in ways that break ordinary relative-URL resolution inside it.
 * `secure` keeps it out of Chromium's insecure-context bucket, so the page is
 * not quietly denied APIs for being served from a scheme Chromium has never
 * heard of. Everything else is off: no fetch API, no CORS, no service workers —
 * a preview is one document that talks to nobody.
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        allowServiceWorkers: false,
        stream: false,
      },
    },
  ]);
}

/**
 * Serve granted previews. Call once, after the app is ready.
 *
 * Every response carries {@link PREVIEW_CSP} itself rather than relying on the
 * session-level header pass, because that pass deliberately skips this scheme —
 * see `applySessionPolicy`. This is the only place the previewed document's
 * policy is set, which is why it is set on the error responses too.
 */
export function servePreviews(): void {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const token = new URL(request.url).hostname;
    const preview = granted.get(token);
    if (preview === undefined) {
      log.warn('Refused a preview request for an unknown or expired token.');
      return new Response('This preview is no longer available. Open it again from the transcript.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP },
      });
    }

    return new Response(new Uint8Array(preview.body), {
      status: 200,
      headers: {
        'Content-Type': preview.mediaType,
        'Content-Security-Policy': PREVIEW_CSP,
        // The media type is decided here from the extension, so a page whose
        // bytes look like something else must not be re-sniffed into it.
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
}

/** True for a URL this module serves. Used by `security.ts`. */
export function isPreviewUrl(url: string): boolean {
  return url.startsWith(`${PREVIEW_SCHEME}://`);
}
