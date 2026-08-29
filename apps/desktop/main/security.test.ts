/**
 * The session's permission policy.
 *
 * `applySessionPolicy` installs its decisions as handlers rather than exporting
 * them, so the test stands up a session that keeps what it was handed and then
 * asks the handlers the questions Chromium asks.
 *
 * The case worth writing down is the clipboard. Artemis denied every permission
 * for four releases, which reads as the safe default and was not: a copy button
 * in the app is a user who has just asked, in as many words, for a string to be
 * put on their clipboard, and the deny took that away while leaving the button
 * looking like it had worked. The tests below pin both halves — that the write
 * is allowed to Artemis's own document, and that nothing else got in with it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';

vi.mock('electron', () => ({
  shell: { openExternal: () => Promise.resolve() },
}));

const { applySessionPolicy, isTrustedFrame, windowSecurityPreferences } = await import('./security');

const RENDERER_FILE_URL =
  'file:///Applications/Artemis.app/Contents/Resources/app.asar/out/renderer/index.html';
const DEV_SERVER = 'http://localhost:5173';

type CheckHandler = (
  contents: null,
  permission: string,
  requestingOrigin: string,
  details: unknown,
) => boolean;

type RequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { requestingUrl: string },
) => void;

/** Apply the policy to a session that only remembers what it was given. */
function handlersFor(devServerOrigin: string | null): {
  check: CheckHandler;
  request: RequestHandler;
} {
  let check: CheckHandler | undefined;
  let request: RequestHandler | undefined;

  const session = {
    webRequest: { onHeadersReceived: () => undefined, onBeforeRequest: () => undefined },
    setPermissionRequestHandler: (handler: RequestHandler) => {
      request = handler;
    },
    setPermissionCheckHandler: (handler: CheckHandler) => {
      check = handler;
    },
    setDevicePermissionHandler: () => undefined,
  };

  applySessionPolicy(session as unknown as Session, {
    devServerOrigin,
    rendererFileUrl: RENDERER_FILE_URL,
  });

  if (check === undefined || request === undefined) {
    throw new Error('applySessionPolicy installed no permission handler');
  }
  return { check, request };
}

/** What the check handler answers for one permission from one origin. */
function checks(permission: string, origin: string, devServerOrigin: string | null = null): boolean {
  return handlersFor(devServerOrigin).check(null, permission, origin, {});
}

/** What the request handler answers, which is the second question Chromium asks. */
function requests(permission: string, url: string, devServerOrigin: string | null = null): boolean {
  let granted: boolean | undefined;
  handlersFor(devServerOrigin).request(
    {},
    permission,
    (value) => {
      granted = value;
    },
    { requestingUrl: url },
  );
  return granted === true;
}

describe('clipboard writes', () => {
  it('are allowed to the packaged renderer, which is served from file:', () => {
    expect(checks('clipboard-sanitized-write', 'file://')).toBe(true);
  });

  it('are allowed to the dev server in development', () => {
    expect(checks('clipboard-sanitized-write', DEV_SERVER, DEV_SERVER)).toBe(true);
  });

  it('are allowed through the request handler too', () => {
    // A web API refused a permission *check* goes on to make a permission
    // *request*, so granting in only one of the two still fails the call.
    expect(requests('clipboard-sanitized-write', RENDERER_FILE_URL)).toBe(true);
  });
});

describe('everything else', () => {
  it('denies the clipboard to a page the agent wrote', () => {
    // The preview scheme carries untrusted HTML. It reaches the clipboard as
    // far as it reaches the network, which is not at all.
    expect(checks('clipboard-sanitized-write', 'artemis-preview://artifact/index.html')).toBe(false);
    expect(requests('clipboard-sanitized-write', 'artemis-preview://artifact/index.html')).toBe(
      false,
    );
  });

  it('denies the clipboard to any other origin', () => {
    expect(checks('clipboard-sanitized-write', 'https://example.com')).toBe(false);
    // The dev server's origin is only Artemis's when there is a dev server.
    expect(checks('clipboard-sanitized-write', DEV_SERVER)).toBe(false);
  });

  it('denies reading the clipboard, which no part of Artemis asks for', () => {
    expect(checks('clipboard-read', 'file://')).toBe(false);
    expect(checks('deprecated-sync-clipboard-read', 'file://')).toBe(false);
  });

  it('denies the permissions a UI rendering untrusted content should never hold', () => {
    for (const permission of ['geolocation', 'media', 'notifications', 'midi', 'openExternal']) {
      expect(checks(permission, 'file://')).toBe(false);
      expect(requests(permission, RENDERER_FILE_URL)).toBe(false);
    }
  });

  it('denies a permission whose origin does not parse', () => {
    expect(checks('clipboard-sanitized-write', '')).toBe(false);
    expect(checks('clipboard-sanitized-write', 'null')).toBe(false);
  });
});

/**
 * The `file:` allowlist, asked through `isTrustedFrame` — the exported surface
 * that sits directly on `isAllowedUrl`.
 *
 * The case that earns its own block: the allowlist once compared the *raw*
 * string against the renderer directory, so a URL that began with the right
 * prefix and then climbed out of it with `..` passed. The parsed URL resolves
 * dot segments before it is compared, and these tests pin that.
 */
describe('the file: allowlist', () => {
  const policy = { devServerOrigin: null, rendererFileUrl: RENDERER_FILE_URL };
  const rendererDir = RENDERER_FILE_URL.slice(0, RENDERER_FILE_URL.lastIndexOf('/') + 1);

  it('allows the built renderer bundle', () => {
    expect(isTrustedFrame(RENDERER_FILE_URL, true, policy)).toBe(true);
    expect(isTrustedFrame(`${rendererDir}assets/index.js`, true, policy)).toBe(true);
  });

  it('rejects a file URL that starts inside the bundle and .. climbs out', () => {
    const sneaky = `${rendererDir}../../../../../../../etc/passwd`;
    // The raw string really does begin with the allowed prefix — that is the
    // whole trap — and the resolved URL is nowhere near it.
    expect(sneaky.startsWith(rendererDir)).toBe(true);
    expect(isTrustedFrame(sneaky, true, policy)).toBe(false);
  });

  it('rejects the same climb spelled with %2e, which the URL parser also resolves', () => {
    const sneaky = `${rendererDir}%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd`;
    expect(isTrustedFrame(sneaky, true, policy)).toBe(false);
  });

  it('rejects any file outside the bundle directory', () => {
    expect(isTrustedFrame('file:///etc/passwd', true, policy)).toBe(false);
  });
});

/**
 * The window preferences, pinned.
 *
 * `windowSecurityPreferences` says in its own comment that it writes out values
 * which are already Electron's defaults, because a default that flips during a
 * routine dependency bump is how a hardened app quietly stops being one. Nothing
 * enforced that until this: the file was a statement of intent with no way to
 * fail. These assertions are the failure.
 *
 * `backgroundThrottling` sits with them and is not a security value. It is here
 * for the same structural reason — it is a Chromium default this app
 * deliberately overturns, and reverting it would be silent and would look like
 * agents dying rather than like a preference changing.
 */
describe('window preferences', () => {
  const preferences = windowSecurityPreferences('/tmp/preload.cjs', ['--artemis-version=0.0.0']);

  it('keeps the renderer sandboxed and off Node', () => {
    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.nodeIntegrationInWorker).toBe(false);
    expect(preferences.nodeIntegrationInSubFrames).toBe(false);
  });

  it('keeps web security on and the weaker embedders off', () => {
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
    expect(preferences.experimentalFeatures).toBe(false);
    expect(preferences.webviewTag).toBe(false);
  });

  it('does not let Chromium throttle a backgrounded window', () => {
    // The polls that keep a delegated agent's tab and the session feed moving
    // are ordinary timers. Throttled to once a minute — Chromium's default for a
    // window that is not in front — they stop while the user is in another
    // window, which is exactly when an agent is working unobserved, and the
    // window reads as dead on return.
    expect(preferences.backgroundThrottling).toBe(false);
  });

  it('passes the preload path and its arguments through', () => {
    expect(preferences.preload).toBe('/tmp/preload.cjs');
    expect(preferences.additionalArguments).toEqual(['--artemis-version=0.0.0']);
  });
});

/**
 * The remote-origin widening (ADR 0004), and its exact edges.
 *
 * Remote mode needs the renderer to fetch one user-configured origin, and the
 * two runtime walls — the CSP header and the request lockdown — must open for
 * exactly that origin and nothing else. The assertions below pin all four
 * edges: the header names the origin verbatim (no wildcard), the lockdown
 * passes requests to it, a *withdrawn* grant stops matching on the very next
 * request, and neither navigation nor frame trust ever follows the grant —
 * the remote machine may be fetched from, and that is all.
 */
describe('the remote-origin grant', () => {
  const REMOTE = 'http://kronos.tail1234.ts.net:6472';

  type BeforeRequestHandler = (
    details: { url: string },
    callback: (response: { cancel: boolean }) => void,
  ) => void;
  type HeadersHandler = (
    details: { url: string; responseHeaders: Record<string, string[]> },
    callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
  ) => void;

  function sessionFor(remoteOrigin: () => string | null): {
    csp: (url: string) => string;
    allows: (url: string) => boolean;
  } {
    let onHeaders: HeadersHandler | undefined;
    let onBefore: BeforeRequestHandler | undefined;
    const session = {
      webRequest: {
        onHeadersReceived: (handler: HeadersHandler) => {
          onHeaders = handler;
        },
        onBeforeRequest: (handler: BeforeRequestHandler) => {
          onBefore = handler;
        },
      },
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setDevicePermissionHandler: () => undefined,
    };
    applySessionPolicy(session as unknown as Session, {
      devServerOrigin: null,
      rendererFileUrl: RENDERER_FILE_URL,
      remoteOrigin,
    });
    if (onHeaders === undefined || onBefore === undefined) {
      throw new Error('applySessionPolicy installed no webRequest handlers');
    }
    const headers = onHeaders;
    const before = onBefore;
    return {
      csp: (url: string): string => {
        let policy = '';
        headers({ url, responseHeaders: {} }, (response) => {
          policy = response.responseHeaders?.['Content-Security-Policy']?.[0] ?? '';
        });
        return policy;
      },
      allows: (url: string): boolean => {
        let allowed = false;
        before({ url }, (response) => {
          allowed = !response.cancel;
        });
        return allowed;
      },
    };
  }

  it('names exactly the configured origin in connect-src, and no wildcard', () => {
    const { csp } = sessionFor(() => REMOTE);
    const policy = csp(RENDERER_FILE_URL);
    expect(policy).toContain(`connect-src 'self' ${REMOTE}`);
    expect(policy).not.toContain('connect-src *');
    // Scheme-wide grants belong to the static meta fallback alone; the header
    // is the narrowing layer and must never carry one.
    expect(policy).not.toMatch(/connect-src [^;]*\shttp:(\s|;|$)/);
  });

  it('keeps connect-src at self with no grant configured', () => {
    const { csp } = sessionFor(() => null);
    expect(csp(RENDERER_FILE_URL)).toContain("connect-src 'self';");
  });

  it('lets requests through to the origin, and only the origin', () => {
    const { allows } = sessionFor(() => REMOTE);
    expect(allows(`${REMOTE}/api/v0/events`)).toBe(true);
    expect(allows('http://kronos.tail1234.ts.net:9999/api')).toBe(false);
    expect(allows('http://evil.example/api')).toBe(false);
    expect(allows('ws://kronos.tail1234.ts.net:6472/socket')).toBe(false);
  });

  it('stops matching the moment the grant is withdrawn', () => {
    let origin: string | null = REMOTE;
    const { allows, csp } = sessionFor(() => origin);
    expect(allows(`${REMOTE}/api/v0/runs`)).toBe(true);
    origin = null;
    expect(allows(`${REMOTE}/api/v0/runs`)).toBe(false);
    expect(csp(RENDERER_FILE_URL)).toContain("connect-src 'self';");
  });

  it('never trusts a frame on the remote origin for IPC', () => {
    // The grant is for *requests*. A frame that somehow showed the remote
    // machine's page must not be able to call privileged handlers.
    expect(
      isTrustedFrame(`${REMOTE}/index.html`, true, {
        devServerOrigin: null,
        rendererFileUrl: RENDERER_FILE_URL,
        remoteOrigin: () => REMOTE,
      }),
    ).toBe(false);
  });
});
