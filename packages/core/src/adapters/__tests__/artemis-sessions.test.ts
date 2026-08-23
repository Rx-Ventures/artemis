/**
 * The Artemis-server adapter's history surface: what the laptop asks, and
 * what it makes of the answers. The server end of the contract is pinned in
 * `server/__tests__/sessions.test.ts`; these are the client half — the wire
 * body mapped into `SessionSummary`s, replayed events re-stamped, and errors
 * that name the problem instead of masquerading as empty history.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArtemisAdapter } from '../artemis/adapter.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listSessions', () => {
  it('asks the sessions endpoint with the token, and maps the rows', async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          auth: (init?.headers as Record<string, string>)?.['authorization'],
        });
        return jsonResponse({
          object: 'artemis.sessions',
          sessions: [
            {
              id: 'sess-9',
              title: 'Fix the flaky test',
              firstPrompt: 'why is this flaky',
              updatedAt: 1234,
              profileSlug: 'work-max',
              cwd: '/srv/work/repo',
            },
          ],
        });
      }),
    );

    const adapter = createArtemisAdapter();
    const page = await adapter.listSessions!({
      profileId: 'artemis-profile' as never,
      cwd: '/wherever/the/laptop/is',
      env: ENV,
    });

    expect(calls[0]?.url).toBe('http://server.tail:6472/api/v0/sessions');
    expect(calls[0]?.auth).toBe('Bearer tok-123');
    expect(page.sessions).toHaveLength(1);
    const row = page.sessions[0]!;
    // The identity is this machine's profile; the directory is the server's —
    // a conversation's home is where it ran.
    expect(row.profileId).toBe('artemis-profile');
    expect(row.providerId).toBe('artemis');
    expect(row.cwd).toBe('/srv/work/repo');
    expect(row.title).toBe('Fix the flaky test');
    expect(row.updatedAt).toBe(1234);
  });

  it('rejects on a refusing server rather than claiming no history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: {} }, 401)));
    const adapter = createArtemisAdapter();
    await expect(
      adapter.listSessions!({ profileId: 'p' as never, cwd: '/x', env: ENV }),
    ).rejects.toThrow(/401/);
  });
});

describe('getSessionMessages', () => {
  it('re-stamps replayed events with the caller\'s run id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toBe(
          'http://server.tail:6472/api/v0/sessions/sess-9/messages',
        );
        return jsonResponse({
          object: 'artemis.session.messages',
          events: [
            { type: 'text.complete', runId: 'server-replay:sess-9', seq: 0, ts: 1, text: 'hi' },
          ],
          hasMore: false,
        });
      }),
    );

    const adapter = createArtemisAdapter();
    const transcript = await adapter.getSessionMessages!({
      profileId: 'p' as never,
      sessionId: 'sess-9' as never,
      runId: 'history:sess-9' as never,
      env: ENV,
    });
    expect(transcript.events[0]).toMatchObject({ runId: 'history:sess-9', text: 'hi' });
  });

  it('surfaces the server\'s 404 as its own sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: {} }, 404)));
    const adapter = createArtemisAdapter();
    await expect(
      adapter.getSessionMessages!({
        profileId: 'p' as never,
        sessionId: 'nope' as never,
        runId: 'r' as never,
        env: ENV,
      }),
    ).rejects.toThrow(/no such conversation/i);
  });
});

describe('listAllSessions', () => {
  it('collects per profile and names the servers it could not reach', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ object: 'artemis.sessions', sessions: [] }, 503)),
    );
    const adapter = createArtemisAdapter();
    const page = await adapter.listAllSessions!({
      profiles: [{ profileId: 'p1' as never, env: ENV }],
    });
    expect(page.sessions).toHaveLength(0);
    expect(page.unreadableProfiles).toEqual(['p1']);
  });
});
