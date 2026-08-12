/**
 * Renderer hardening.
 *
 * Everything Electron gets wrong by default, corrected in one place.
 *
 * The threat model is specific and worth stating, because it drives every
 * choice below: Artemis renders content it did not author. A transcript contains
 * model output; a tool result contains whatever was on disk; a session title
 * comes from a file the agent wrote. None of that is trusted input. The
 * renderer is therefore treated as a browser tab that might, one day, be
 * running someone else's script — and this file is what that tab is allowed to
 * do.
 *
 * Layered, so no single mistake is fatal:
 *
 *  1. **Process isolation.** `sandbox: true`, `contextIsolation: true`,
 *     `nodeIntegration: false`. The renderer has no `require`, no `process`, no
 *     `ipcRenderer` — only the frozen surface the preload exposes.
 *  2. **Content-Security-Policy** on every response, so injected markup cannot
 *     pull in remote script.
 *  3. **Navigation lockdown.** The window can only ever show Artemis's own UI.
 *     Every other URL is either opened in the user's real browser or dropped.
 *  4. **Network lockdown.** Chromium-side requests to anywhere but Artemis's own
 *     origin are cancelled outright.
 *
 * Note that (4) constrains the *renderer* only. The Claude Agent SDK runs in the
 * main process over Node's own networking, which does not pass through
 * Electron's `webRequest` stack — blocking the renderer's network access does
 * not interfere with the agent talking to the API.
 */

import { shell, type Session, type WebContents, type WebPreferences } from 'electron';

import { createLogger } from './log.js';
import { PREVIEW_SCHEME, isPreviewUrl } from './preview.js';

const log = createLogger('security');

/** Where the renderer is allowed to live. */
export interface SecurityPolicy {
  /**
   * Vite dev server origin, e.g. `http://localhost:5173`. Present in
   * development only; in a packaged app the renderer is loaded from `file:`.
   */
  readonly devServerOrigin: string | null;
  /** Absolute `file:` URL of the built renderer entry point. */
  readonly rendererFileUrl: string;
}

/* -------------------------------------------------------------------------- */
/* Content-Security-Policy                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Production CSP.
 *
 * `default-src 'none'` and then allow back exactly what the app needs. Note
 * what is *not* allowed: no remote origins at all, no `eval`, no form
 * submission, no plugins.
 *
 * `style-src` keeps `'unsafe-inline'` because React writes inline `style`
 * attributes and Tailwind injects a style element; there is no way to run a
 * React UI without it short of a nonce-rewriting pipeline. Inline *style* is a
 * far smaller hazard than inline *script*, which stays forbidden.
 *
 * `frame-src` is the one opening, and it is one scheme wide. Artemis frames
 * exactly one thing — a page the agent wrote, served by `preview.ts` — and that
 * scheme cannot name a remote origin because nothing but this app serves it.
 * The framed document runs under its own, much looser policy; what keeps the two
 * apart is that it is a *separate response* with a *separate header*, so nothing
 * an artifact is allowed to do is anything this page is allowed to do.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  `frame-src ${PREVIEW_SCHEME}:`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Development CSP.
 *
 * Two relaxations, both required by Vite and neither shipped:
 *
 *  - `'unsafe-inline'` in `script-src`, because `@vitejs/plugin-react` injects
 *    its Fast Refresh preamble as an inline module script.
 *  - the dev server origin in `connect-src`, for the HMR websocket.
 */
function developmentCsp(origin: string): string {
  const wsOrigin = origin.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' data: blob: ${origin}`,
    `font-src 'self' data: ${origin}`,
    `connect-src 'self' ${origin} ${wsOrigin}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `frame-src ${PREVIEW_SCHEME}:`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/* -------------------------------------------------------------------------- */
/* Window preferences                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `webPreferences` for every Artemis window.
 *
 * Most of these are Electron's defaults on a modern version; they are written
 * out anyway. A default that silently flips in a future Electron release is
 * exactly the kind of change that turns a hardened app into an unhardened one
 * during a routine dependency bump, and an explicit value is also a place to
 * hang the reason.
 */
export function windowSecurityPreferences(preloadPath: string, extraArguments: readonly string[]): WebPreferences {
  return {
    preload: preloadPath,
    // The three that matter. Together they mean the renderer's only route to
    // the outside world is the preload's frozen API.
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,

    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    // `<webview>` is a second, weaker window with its own preferences. Artemis has
    // no use for one, so it is turned off rather than configured.
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    // Values passed to the preload through `process.argv`. The preload reads
    // them instead of asking main over IPC, which keeps `ArtemisBridge.version`
    // and `.platform` synchronous.
    additionalArguments: [...extraArguments],
    spellcheck: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Session-level policy                                                       */
/* -------------------------------------------------------------------------- */

function isAllowedUrl(url: string, policy: SecurityPolicy): boolean {
  if (url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // DevTools and Chromium's own internals.
  if (parsed.protocol === 'devtools:' || parsed.protocol === 'chrome-extension:') return true;

  if (parsed.protocol === 'file:') {
    // Only the built renderer bundle, not "any file on this machine".
    const rendererDir = policy.rendererFileUrl.slice(0, policy.rendererFileUrl.lastIndexOf('/') + 1);
    return url.startsWith(rendererDir);
  }

  if (policy.devServerOrigin) {
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin === policy.devServerOrigin;
    }
    // Vite's HMR socket. Allowed only against the dev server, and only because
    // `devServerOrigin` is non-null — in a packaged build this whole branch is
    // unreachable and no websocket is permitted to anywhere.
    //
    // The development CSP already lists this origin in `connect-src`; without
    // the matching allowance here the `webRequest` guard cancels the socket and
    // hot reload silently stops working, which is how this was found.
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      return parsed.origin === policy.devServerOrigin.replace(/^http/, 'ws');
    }
  }

  return false;
}

/**
 * The one permission Artemis grants, and the two ways it is kept small.
 *
 * `navigator.clipboard.writeText` is permission-gated in Chromium, and denying
 * every check is why each copy button in the app went through its motions and
 * left the clipboard holding whatever it held before: the command a new profile
 * asks you to run in a terminal, and the full text of a bug report too long for
 * a URL to carry. Neither said anything, because the call rejects and a click
 * handler that drops the promise has nothing to report. Both are exactly the
 * case where a user has asked, in as many words, for a string to be copied.
 *
 * Writing only, never reading. Putting a string the user just pointed at onto
 * the clipboard is not the capability of reading back what they last copied out
 * of a password manager, and Artemis has never wanted the second — so
 * `clipboard-read` stays denied along with everything else.
 *
 * And Artemis's own document only. The preview scheme serves a page the agent
 * wrote, and it reaches the clipboard exactly as far as it reaches the network,
 * which is not at all — its origin is neither `file:` nor the dev server, so it
 * falls through to the same `false` as a camera request.
 */
function isPermittedPermission(permission: string, requestingUrl: string, policy: SecurityPolicy): boolean {
  if (permission !== 'clipboard-sanitized-write') return false;

  let parsed: URL;
  try {
    parsed = new URL(requestingUrl);
  } catch {
    return false;
  }

  // The packaged renderer. Unlike `isAllowedUrl` this does not narrow to the
  // bundle's own directory, and does not need to: a permission check arrives as
  // an *origin*, which `file:` serializes without a path, and the one document
  // Artemis does not author is served over a scheme of its own rather than off
  // disk.
  if (parsed.protocol === 'file:') return true;

  return policy.devServerOrigin !== null && parsed.origin === policy.devServerOrigin;
}

/**
 * Open a URL in the user's own browser, if it is the kind of URL a browser
 * should be asked to open.
 *
 * The protocol check is the point: `shell.openExternal` hands the string to the
 * OS, which will happily launch a registered handler for `file:`, `smb:` or
 * some application's custom scheme. Model output is untrusted, and a link in a
 * transcript must not be able to launch an arbitrary local handler.
 */
export function openExternalSafely(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log.warn('Refused to open a malformed URL from the renderer.');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.warn(`Refused to open a ${parsed.protocol} URL externally.`);
    return;
  }
  void shell.openExternal(parsed.toString());
}

/**
 * Apply CSP, permission and network policy to a session.
 *
 * Call once, on `app.whenReady()`, before any window is created.
 */
export function applySessionPolicy(session: Session, policy: SecurityPolicy): void {
  const csp = policy.devServerOrigin ? developmentCsp(policy.devServerOrigin) : PRODUCTION_CSP;

  session.webRequest.onHeadersReceived((details, callback) => {
    // A preview response sets its own policy and must keep it. Overwriting it
    // with the app's would put the framed page back under `script-src 'self'`,
    // which is the exact policy the separate scheme exists to escape — and the
    // symptom would be a blank frame with no error anywhere. `preview.ts` is
    // the only thing this skips for, and every response it serves carries both
    // headers this branch would otherwise have set.
    if (isPreviewUrl(details.url)) {
      callback({});
      return;
    }

    // Strip any CSP the response already carried before setting ours, so a dev
    // server's header cannot end up merged with (and therefore looser than)
    // Artemis's own.
    const headers: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() === 'content-security-policy') continue;
      if (name.toLowerCase() === 'content-security-policy-report-only') continue;
      headers[name] = Array.isArray(value) ? value : [String(value)];
    }
    headers['Content-Security-Policy'] = [csp];
    headers['X-Content-Type-Options'] = ['nosniff'];
    callback({ responseHeaders: headers });
  });

  // Chromium may ask for camera, microphone, geolocation, notifications and so
  // on. Artemis needs none of them, and a UI that renders untrusted content
  // should never be in a position to ask. The single exception is writing the
  // clipboard from Artemis's own document — see `isPermittedPermission`.
  //
  // Both handlers, because a web API that is refused a permission *check* goes
  // on to make a permission *request*, and one of the two answering `false` is
  // enough to fail the call. Denying in only one place is a fix that works
  // until Chromium changes which question it asks first.
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (isPermittedPermission(permission, details.requestingUrl, policy)) {
      callback(true);
      return;
    }
    log.warn(`Denied a "${permission}" permission request from the renderer.`);
    callback(false);
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermittedPermission(permission, requestingOrigin, policy),
  );
  session.setDevicePermissionHandler(() => false);

  // Network lockdown. `file:`, `devtools:` and `blob:` are the renderer's own
  // bundle; anything reaching for http(s) that is not the dev server is
  // cancelled. In a packaged build this list contains no network origin at all.
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedUrl(details.url, policy)) {
      callback({ cancel: false });
      return;
    }
    // The preview frame's own document. Allowed here and *not* in
    // `isAllowedUrl`, which is deliberate: that function also decides what may
    // become the window's top-level page and which frames may call IPC, and a
    // page the agent wrote must never be either of those things.
    if (isPreviewUrl(details.url)) {
      callback({ cancel: false });
      return;
    }
    const protocol = details.url.slice(0, Math.max(details.url.indexOf(':') + 1, 0));
    if (protocol === 'data:' || protocol === 'blob:') {
      callback({ cancel: false });
      return;
    }
    log.warn(`Blocked a renderer request to ${protocol || 'an unparseable URL'}`);
    callback({ cancel: true });
  });
}

/* -------------------------------------------------------------------------- */
/* WebContents-level policy                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every `WebContents` already hardened.
 *
 * `hardenWebContents` is called from `app.on('web-contents-created')` *and*
 * from window creation, because neither call site should have to assume the
 * other ran. Without this set, the main window would end up with two
 * `will-navigate` listeners and a blocked link would open in the user's browser
 * twice.
 */
const hardened = new WeakSet<WebContents>();

/**
 * Lock down navigation for one `WebContents`.
 *
 * Wire this from `app.on('web-contents-created')` so it covers every frame the
 * app ever creates, not just the ones created deliberately. Idempotent.
 */
export function hardenWebContents(contents: WebContents, policy: SecurityPolicy): void {
  if (hardened.has(contents)) return;
  hardened.add(contents);

  // In-window navigation: a link, a redirect, `location.href = …`. The window
  // shows Artemis's UI and nothing else, for its whole lifetime.
  contents.on('will-navigate', (event, url) => {
    if (isAllowedUrl(url, policy)) return;
    event.preventDefault();
    log.warn('Blocked in-window navigation away from the app.');
    openExternalSafely(url);
  });

  // Same, for a frame that tries to navigate itself.
  //
  // A *sub*frame may additionally be a preview, which is how the pane's frame
  // gets its document in the first place. The main frame may not: `isMainFrame`
  // is what keeps a previewed page from being loaded as the window itself,
  // where it would no longer be inside a sandboxed frame and would no longer be
  // one of the things `isTrustedFrame` turns away.
  contents.on('will-frame-navigate', (event) => {
    if (isAllowedUrl(event.url, policy)) return;
    if (!event.isMainFrame && isPreviewUrl(event.url)) return;
    event.preventDefault();
    log.warn('Blocked frame navigation away from the app.');
    openExternalSafely(event.url);
  });

  // `target="_blank"`, `window.open(…)`. Never opens an Electron window — a new
  // Electron window would inherit the app's privileges; the user's browser is
  // both safer and what they actually expect from a link.
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  // `webviewTag` is already false, so this should be unreachable. It is here
  // because "should be unreachable" is not a security guarantee.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('Blocked an attempt to attach a <webview>.');
  });

  contents.on('render-process-gone', (_event, details) => {
    log.error(`Renderer process gone: ${details.reason}`);
  });
}

/**
 * Verify an IPC message came from Artemis's own top-level frame.
 *
 * Two checks, both necessary. The frame must be the *main* frame, so a nested
 * iframe (which is where injected content would end up) cannot call privileged
 * handlers. And its URL must be one this policy allows, so a frame that
 * navigated somewhere unexpected loses access even if it kept its
 * `WebContents`.
 */
export function isTrustedFrame(
  senderFrameUrl: string | undefined,
  isMainFrame: boolean,
  policy: SecurityPolicy,
): boolean {
  if (!isMainFrame) return false;
  if (!senderFrameUrl) return false;
  return isAllowedUrl(senderFrameUrl, policy);
}

/** Reject HTTP basic-auth prompts rather than showing the user a dialog. */
export function installNetworkAuthGuard(app: Electron.App): void {
  app.on('login', (event) => {
    // Deliberately no `callback(...)`: not calling it cancels the request.
    // Artemis never authenticates to a proxy or origin from the renderer, so a
    // prompt here would only ever be a credential-phishing surface.
    event.preventDefault();
    log.warn('Cancelled an HTTP authentication prompt.');
  });

  app.on('certificate-error', (event, _webContents, url, error, _certificate, callback) => {
    // Default behaviour already rejects; being explicit means a future edit has
    // to consciously choose to trust a bad certificate.
    event.preventDefault();
    log.error(`Rejected an invalid TLS certificate for ${new URL(url).origin}: ${error}`);
    callback(false);
  });
}
