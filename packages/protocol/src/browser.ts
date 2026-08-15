/**
 * A browser, as the two sides of the app have to agree on it.
 * ============================================================================
 *
 * The dock holds three unlike things — a file the agent wrote, a shell the user
 * asked for, and now a page. This is the contract for the third, and it is
 * shaped much more like the terminal's than like the preview's, for one reason:
 * a page is a **live thing with state**. It has a scroll position, a session
 * cookie, a half-filled form. A preview is a snapshot and is cheap to rebuild;
 * a browser is not, and throwing one away because the user glanced at another
 * conversation would make the feature unusable in the same way killing a
 * `pnpm dev` would. So it lives and dies by the terminal's rules — see
 * `renderer/state/dock.ts`.
 *
 * ## What is *not* here: the page itself
 *
 * There is no channel that carries a page's HTML, its DOM, or its pixels to the
 * renderer, and that absence is the whole architecture. The page is drawn by a
 * `WebContentsView` that the **main process** owns and positions; the renderer
 * never holds it, never frames it, and cannot read it. What crosses this
 * boundary is an opaque id, a rectangle, and the handful of strings a piece of
 * chrome needs to draw an address bar — {@link BrowserState}.
 *
 * That is why an in-app browser is safe to point at any site at all. The page
 * runs in its own session with no preload script, so it has no `window.artemis`
 * and no bridge of any kind; and it is a sibling of the renderer rather than a
 * frame inside it, so there is no parent document for it to reach into. The
 * containment is structural. See `main/browser.ts` for the other half.
 *
 * ## The id is minted by main, and that is a security property
 *
 * Exactly as {@link import('./terminal.js').TerminalInfo} explains: a
 * {@link BrowserId} is issued by `main/browser.ts` and is only ever echoed by
 * the renderer, which is what makes "navigate browser X" impossible to aim at a
 * browser the caller was never handed.
 *
 * ## Geometry crosses the boundary, which is unusual and unavoidable
 *
 * Every other surface in Artemis is laid out by CSS. This one cannot be: a
 * `WebContentsView` is a native view stacked on the window, not an element in
 * the document, so *someone* has to tell main where the page goes. The renderer
 * measures a placeholder element and reports the rectangle — see
 * {@link BrowserLayoutRequest} — which makes layout a message rather than a
 * style rule, with all the tearing that implies during a resize.
 *
 * It is worth being plain that this is the cost of the feature rather than a
 * flaw in it. The alternative that keeps layout in CSS is an `<iframe>`, and an
 * iframe cannot show most of the web: `X-Frame-Options` and `frame-ancestors`
 * exist precisely to stop it, and every site worth opening sends one.
 */

import type { BrowserId, RunId } from './ids.js';

/**
 * Schemes this channel will load.
 *
 * `http` and `https`, and deliberately nothing else. The three that are
 * conspicuously absent are absent for three different reasons, and none of them
 * is an oversight:
 *
 *  - **`javascript:`** is not an address, it is code, and a channel that
 *    accepted one would be a way to run script in a page the user is looking at
 *    by way of a string in an IPC payload.
 *  - **`data:`** is a page with no origin, which makes it the standard way to
 *    smuggle markup past anything that reasons about hosts.
 *  - **`file:`** is a real temptation and still a no. Artemis already shows
 *    local files, through `files.read` and `preview.open`, and both hand back
 *    something inert. Granting a *browsing context* a `file:` origin is a
 *    different act: it is a page, with script, sitting on the user's disk.
 *
 * Note what this list does **not** narrow: any host, any port. That is the
 * feature — a dev server on `localhost:5173` and a vendor's documentation are
 * the same kind of thing to a browser, and a scheme check is the honest place
 * to draw the line rather than a host allow-list nobody could keep current.
 */
export const BROWSER_SCHEMES = ['http:', 'https:'] as const;

/**
 * Turn what somebody typed into a URL, or decide it was not one.
 *
 * Pure, and exported so that **both sides run the same rule**: the renderer to
 * tell the user their input will not go anywhere before they press Enter, and
 * main to decide what actually loads. Main's answer is the authoritative one —
 * the renderer's copy is a courtesy, and `validateBrowserNavigate` re-derives
 * it rather than trusting a URL the renderer resolved.
 *
 * ## There is no search engine here, on purpose
 *
 * A browser that answers `how do i center a div` with a search page is what
 * people expect, and this deliberately does not. The address bar of a browser
 * embedded in a coding tool receives internal hostnames, staging URLs, and —
 * regularly, by accident — a token or a path someone meant to paste elsewhere.
 * Making the failure mode of a typo "silently send it to a third party" is a
 * bad trade for saving one step, and it is not a decision this layer should be
 * making quietly on the user's behalf.
 *
 * So a fragment that is not an address is refused, and the reader is told why.
 * Anyone who wants a search has a search engine one paste away, and pasting it
 * is an act of consent this rule preserves.
 */
export function browserUrlFor(typed: string): string | null {
  const text = typed.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return null;
  /*
   * Whitespace and control characters, rejected before anything else parses.
   *
   * A space is the cheapest possible proof that this is prose rather than an
   * address. The control characters matter more: a tab or a newline inside a
   * URL is the classic way to smuggle one host past a reader while a parser
   * sees another, and refusing the whole string is the only reading of it that
   * cannot be wrong.
   */
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return null;

  const absolute = ABSOLUTE.exec(text);
  if (absolute !== null) {
    return `${(absolute[1] as string).toLowerCase()}://${absolute[2] as string}${absolute[3] ?? ''}`;
  }

  /*
   * Not an http(s) address. If it declared some *other* scheme the answer is
   * no, with deliberately no repair step: prefixing `https://` onto
   * `javascript:alert(1)` would turn every refusal above into a load.
   *
   * The exception is the reason this check is not simply `SCHEME.test`.
   * `localhost:5173` is a scheme named `localhost` to any regex that only looks
   * for a colon — and it is also the single most common thing anyone will type
   * into a browser embedded in a coding tool. A colon followed by digits and
   * then a delimiter is a **port**, not a scheme, so it falls through to the
   * host rules below rather than being refused.
   */
  if (SCHEME.test(text) && !HOST_PORT.test(text)) return null;

  const host = text.split(/[/?#]/, 1)[0] ?? '';
  /*
   * `localhost`, `127.0.0.1:5173`, `[::1]:8080` — the dev-server case, and the
   * one place `http` is the right guess. Everything else gets `https`, because
   * guessing `http` for a real site is how a browser silently downgrades a
   * connection that would have been encrypted; a host that genuinely only
   * speaks `http` redirects there itself, at its own choosing.
   */
  const local = LOCAL_HOST.test(host);
  if (!local && !DOMAIN_HOST.test(host)) return null;
  return `${local ? 'http' : 'https'}://${text}`;
}

/**
 * Why this is regular expressions and not `new URL`.
 *
 * This package has no `lib.dom` and no `@types/node` — see its index header. It
 * is compiled against `ES2023` and nothing else, so that the same file is
 * loadable by main, by the preload in a locked-down context, and by the
 * renderer. `URL` is a host global in all three and a type in none of them.
 *
 * Hand-parsing is the smaller price. What this function has to get right is the
 * **scheme**, which is the security property, and a scheme is the least
 * ambiguous part of a URL to recognise. Everything downstream of that — punycode,
 * percent-encoding, the exact host grammar — is left to Chromium, which parses
 * URLs for a living and is the thing that will actually load this string.
 */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `http(s)://host[rest]`, with a host that is not empty. */
const ABSOLUTE = /^(https?):\/\/([^/?#]+)([/?#].*)?$/i;

/**
 * `host:port`, which {@link SCHEME} cannot tell from a scheme.
 *
 * The digits and the delimiter are both load-bearing. `data:1234` would match a
 * looser rule and is not a host, so the port has to be followed by the end of
 * the string or by something that starts a path, a query or a fragment.
 */
const HOST_PORT = /^[A-Za-z][A-Za-z0-9+.-]*:\d+(?:[/?#]|$)/;

/** A loopback host, with an optional port. The one place `http` is meant. */
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/** `example.com`, `docs.example.co.uk:8443`. A dot and a plausible tail. */
const DOMAIN_HOST = /^[^:@]+\.[A-Za-z]{2,}(?::\d+)?$/;

/**
 * Longest address this will resolve.
 *
 * Browsers themselves stop somewhere around here, and the bound exists so that
 * a pathological paste is refused by a length check rather than by three
 * regular expressions. All of them are linear — no nested quantifiers, for the
 * reason `validate.ts` writes out about base64 — so this is tidiness rather
 * than a defence against backtracking.
 */
const MAX_URL_LENGTH = 4_096;

/**
 * What a browser is, once it exists.
 *
 * Everything a tab and an address bar need, and nothing about the page's
 * contents — see the file header for why that boundary is where it is.
 */
export interface BrowserInfo {
  readonly id: BrowserId;
  readonly openedAt: number;
  readonly state: BrowserState;
}

/**
 * Where a browser is and what it is doing.
 *
 * Sent whole rather than as a diff. It is six small fields that change together
 * — a navigation moves the url, the title, the loading flag and both history
 * flags in one go — and a renderer applying four separate deltas would draw at
 * least one frame of a chimera: the new page's title over the old page's url.
 */
export interface BrowserState {
  /** Where the page actually is. Empty before the first load resolves. */
  readonly url: string;
  /**
   * The page's own title, or the host when it has not offered one.
   *
   * Untrusted display text, exactly like a session title: a page chooses this,
   * so it is length-capped by main and rendered as text, never as markup.
   */
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /**
   * Why the last navigation failed, when it did.
   *
   * Present until the next navigation starts. A string rather than a code
   * because the only consumer is a sentence shown to the person who typed the
   * address — see `main/browser.ts` for the translation from Chromium's own
   * error names, which are not sentences.
   */
  readonly failure?: string;
}

/** A browser's state changed. The only event this channel pushes. */
export interface BrowserStateEvent {
  readonly type: 'state';
  readonly id: BrowserId;
  readonly state: BrowserState;
}

/**
 * A browser's renderer process died — a crash, or the OS reclaiming it.
 *
 * Reported rather than repaired. Main destroys the view and forgets the id, so
 * this is the renderer's cue to drop the tab; silently reloading would put the
 * user back on a page that had just crashed, which is a loop rather than a fix.
 */
export interface BrowserGoneEvent {
  readonly type: 'gone';
  readonly id: BrowserId;
  readonly reason: string;
}

/**
 * A browser exists that the renderer did not ask for.
 *
 * The agent's half of this feature. When a tool opens a page, the view is
 * created in main and the renderer finds out here — which is what puts a tab in
 * the strip and makes the agent's browsing **something the user watches** rather
 * than something that happens to a hidden window. That was the whole point of
 * the request this feature answers.
 *
 * `runId` is how the renderer decides which conversation the tab belongs to.
 * Absent would mean "nobody's", which cannot happen — a browser the *renderer*
 * opened never travels on this event, because the renderer already knows.
 */
export interface BrowserOpenedEvent {
  readonly type: 'opened';
  readonly id: BrowserId;
  readonly browser: BrowserInfo;
  readonly runId: RunId;
}

/** Everything a browser pushes at the renderer. One union, one channel. */
export type BrowserEvent = BrowserStateEvent | BrowserGoneEvent | BrowserOpenedEvent;

/** Every browser event type, for the preload's shape check. */
export const BROWSER_EVENT_TYPES = ['state', 'gone', 'opened'] as const;

/**
 * Open a browser.
 *
 * `query` is what a person typed, not a resolved URL, and that is deliberate:
 * {@link browserUrlFor} is the one place the rule lives, and having the renderer
 * resolve it would make this channel accept a URL that no version of that rule
 * produced. Omitted means an empty browser with its address bar waiting.
 */
export interface BrowserOpenRequest {
  readonly query?: string;
}

export interface BrowserOpenResponse {
  readonly browser: BrowserInfo;
}

/** Go somewhere. Same `query`-not-URL rule as {@link BrowserOpenRequest}. */
export interface BrowserNavigateRequest {
  readonly id: BrowserId;
  readonly query: string;
}

export interface BrowserNavigateResponse {
  readonly id: BrowserId;
  /** Where it is actually going, once the rule has been applied. */
  readonly url: string;
}

/** The four buttons beside the address bar. */
export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop';

export interface BrowserCommandRequest {
  readonly id: BrowserId;
  readonly command: BrowserCommand;
}

export interface BrowserCommandResponse {
  readonly id: BrowserId;
}

/** A rectangle in the window's own coordinates, in device-independent pixels. */
export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the page goes, and whether it is on screen at all.
 *
 * The two travel together because they change together and because they are
 * sent often — on every resize frame, and on every tab switch. Splitting them
 * would double the traffic on the one path in this contract that is allowed to
 * be chatty.
 *
 * `visible: false` is not a synonym for "off screen". A hidden view is detached
 * from the window rather than moved outside it, because a native view parked at
 * negative coordinates still composites, still paints, and on some platforms
 * still shows through a rounded corner. Detaching is the only reliable hide —
 * and it is *not* a close: the page keeps running, which is the entire point of
 * a browser that survives you looking at something else.
 */
export interface BrowserLayoutRequest {
  readonly id: BrowserId;
  readonly bounds: BrowserBounds;
  readonly visible: boolean;
}

export interface BrowserLayoutResponse {
  readonly id: BrowserId;
}

/**
 * Destroy a browser.
 *
 * The only thing that ends one, exactly like `terminal.close`. Switching
 * conversation, closing a pane and reloading the window all leave it alive.
 */
export interface BrowserCloseRequest {
  readonly id: BrowserId;
}

export interface BrowserCloseResponse {
  readonly id: BrowserId;
}

/** Every browser main is holding. The reload story; see `TerminalListRequest`. */
export interface BrowserListRequest {
  readonly unused?: never;
}

export interface BrowserListResponse {
  readonly browsers: readonly BrowserInfo[];
}
