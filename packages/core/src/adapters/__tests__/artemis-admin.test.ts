/**
 * Administering a remote Artemis: what the laptop sends, and what it makes of
 * the answers.
 *
 * The server end of this contract is pinned in `server/__tests__/http.test.ts`;
 * these are the client half. Three things are worth holding still, and none of
 * them is the happy path:
 *
 *  - **The address and the token.** Both come from the profile's environment,
 *    through the same two helpers a *run* uses. A second derivation here would
 *    be a second place for the address to be wrong.
 *  - **404 is an answer, not a fault.** The server refuses to distinguish "no
 *    flow here" from "your connection may not ask", so both arrive as nothing
 *    to show — and a poller that threw on it would fill the screen with banners
 *    for the ordinary case.
 *  - **The server's own sentence reaches the user.** A duplicate label the
 *    caller cannot see is the whole of what they need to correct.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelRemoteSignIn,
  createRemoteAccount,
  readRemoteAccounts,
  readRemoteSignIn,
  submitRemoteSignInCode,
} from '../artemis/admin.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472/',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly auth: string | undefined;
  readonly body: string | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answer every request from a path → body table, recording what was asked. */
function stubFetch(answer: (path: string) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method,
        auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return answer(new URL(String(url)).pathname);
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readRemoteAccounts', () => {
  it('asks both questions at once, with the profile token', async () => {
    // Two answers in one round trip because they are one question on screen:
    // may I show this at all, and what is already here?
    const seen = stubFetch((path) =>
      path.endsWith('/connection')
        ? jsonResponse({ id: 'c1', manageProfiles: true })
        : jsonResponse({ object: 'artemis.profiles', profiles: [{ id: 'p1', label: 'work' }] }),
    );

    const answer = await readRemoteAccounts(ENV);

    expect(answer.manageProfiles).toBe(true);
    expect(answer.profiles).toHaveLength(1);
    // The trailing slash on the base URL is stripped: `//api/v0/…` is a 404
    // that reads as a missing route.
    expect(seen.map((call) => call.url).sort()).toEqual([
      'http://server.tail:6472/api/v0/connection',
      'http://server.tail:6472/api/v0/profiles',
    ]);
    expect(seen.every((call) => call.auth === 'Bearer tok-123')).toBe(true);
  });

  it('reads a server that has never heard of the grant as not granting it', async () => {
    // An older server sends nothing here. A missing field must land as "no",
    // or the UI offers an administrative surface the server then 404s.
    stubFetch((path) =>
      path.endsWith('/connection')
        ? jsonResponse({ id: 'c1' })
        : jsonResponse({ object: 'artemis.profiles', profiles: [] }),
    );

    expect((await readRemoteAccounts(ENV)).manageProfiles).toBe(false);
  });
});

describe('createRemoteAccount', () => {
  it('posts the label and hands back where the credential will live', async () => {
    const seen = stubFetch(() =>
      jsonResponse({
        object: 'artemis.profile',
        id: 'p2',
        label: 'work',
        providerId: 'claude',
        configDir: '/data/profiles/work',
      }),
    );

    const created = await createRemoteAccount(ENV, { label: 'work' });

    expect(created.configDir).toBe('/data/profiles/work');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe(JSON.stringify({ label: 'work' }));
  });

  it('passes the server’s own refusal through', async () => {
    // The caller holds the administrative grant and is creating a thing on
    // their own machine; "the request failed" leaves them with nothing to
    // correct.
    stubFetch(() =>
      jsonResponse(
        { error: { message: 'An account called "work" already exists on this server.' } },
        409,
      ),
    );

    await expect(createRemoteAccount(ENV, { label: 'work' })).rejects.toThrow(/already exists/);
  });
});

describe('the sign-in calls', () => {
  it('encodes the account id into the path', async () => {
    const seen = stubFetch(() =>
      jsonResponse({ object: 'artemis.signin', state: 'starting', profileId: 'a/b' }),
    );

    await readRemoteSignIn(ENV, 'a/b');
    expect(seen[0]?.url).toBe('http://server.tail:6472/api/v0/profiles/a%2Fb/signin');
  });

  it('reads a 404 as nothing to show rather than as a fault', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'No sign-in is in progress.' } }, 404));

    expect(await readRemoteSignIn(ENV, 'p1')).toBeNull();
    expect(await cancelRemoteSignIn(ENV, 'p1')).toBeNull();
  });

  it('sends the code as a body and nowhere else', async () => {
    // Not in the path, not in a query string — either would put a single-use
    // secret in every access log between here and the container.
    const seen = stubFetch(() =>
      jsonResponse({ object: 'artemis.signin', state: 'completing', profileId: 'p1' }),
    );

    await submitRemoteSignInCode(ENV, 'p1', 'S3CR3T');

    expect(seen[0]?.url).toBe('http://server.tail:6472/api/v0/profiles/p1/signin/code');
    expect(seen[0]?.url).not.toContain('S3CR3T');
    expect(seen[0]?.body).toBe(JSON.stringify({ code: 'S3CR3T' }));
  });

  it('names the address when nothing is answering', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    await expect(readRemoteSignIn(ENV, 'p1')).rejects.toThrow(/server\.tail:6472/);
  });
});
