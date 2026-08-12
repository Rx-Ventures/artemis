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

const { applySessionPolicy } = await import('./security');

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
