/**
 * The sign-in relay: `…/signin/oauth/*` while a loopback flow is live.
 *
 * What these pin is the gate and the pass-through. The director's answer is
 * the whole authorisation — a defined port both allows the relay and names
 * its target — and everything the browser needs to complete an OAuth hop
 * (status, Location, cookies, the page itself) crosses unchanged. Writes are
 * refused so the relay cannot become a general tunnel into the serving
 * machine's loopback.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, isStreamReply } from '../http.js';
import type { ProfileAdmin, SignInDirector } from '../signin.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';

const ADMIN = {
  id: 'conn-admin',
  label: 'Admin',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
  manageProfiles: true,
};

const PROFILES: readonly ServerProfile[] = [
  {
    id: 'prof-a' as ServerProfile['id'],
    slug: 'work',
    label: 'Work',
    provider: { id: 'codex', label: 'Codex', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: NO_CAPABILITIES,
    models: [],
  },
];

const catalogue: Catalogue = { read: async () => PROFILES, invalidate: () => undefined };

const fakeAdmin: ProfileAdmin = {
  create: async () => {
    throw new Error('not under test');
  },
  find: async () => undefined,
  update: async () => {
    throw new Error('not under test');
  },
  delete: async () => undefined,
};

function directorWithPort(port: number | undefined): SignInDirector {
  return {
    start: () => {
      throw new Error('not under test');
    },
    status: () => undefined,
    submitCode: () => {
      throw new Error('not under test');
    },
    cancel: () => undefined,
    loopbackPort: (profileId) => (profileId === 'prof-a' ? port : undefined),
    close: () => undefined,
  };
}

async function relay(
  url: string,
  port: number | undefined,
  method = 'GET',
): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    { method, url, headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` } },
    {
      connections: [ADMIN],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
      profileAdmin: fakeAdmin,
      signIns: directorWithPort(port),
    },
  );
}

async function drain(reply: Awaited<ReturnType<typeof handleServerRequest>>): Promise<string> {
  if (!isStreamReply(reply)) return JSON.stringify(reply.body);
  let out = '';
  for await (const chunk of reply.stream) out += chunk;
  return out;
}

describe('the sign-in relay', () => {
  let upstream: Server;
  let port = 0;
  const seen: { url: string; cookie?: string }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    upstream = createServer((request, response) => {
      seen.push({ url: request.url ?? '', ...(request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }) });
      if (request.url?.startsWith('/auth/start')) {
        response.writeHead(302, { location: 'https://auth.example.com/authorize?x=1' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'flow=abc' });
      response.end('<html>signed in</html>');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    await new Promise((resolve) => upstream.close(resolve));
  });

  it('passes a page through, cookies and all', async () => {
    const reply = await relay('/api/v0/profiles/prof-a/signin/oauth/done?code=xyz', port);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toContain('text/html');
    expect(reply.headers['set-cookie']).toBe('flow=abc');
    expect(await drain(reply)).toContain('signed in');
    expect(seen[0]?.url).toBe('/done?code=xyz');
  });

  it('hands a redirect back to the browser rather than following it', async () => {
    const reply = await relay('/api/v0/profiles/prof-a/signin/oauth/auth/start', port);
    expect(reply.status).toBe(302);
    expect(reply.headers['location']).toBe('https://auth.example.com/authorize?x=1');
  });

  it('is the enumeration-proof 404 when no flow is listening', async () => {
    const reply = await relay('/api/v0/profiles/prof-a/signin/oauth/anything', undefined);
    expect(reply.status).toBe(404);
  });

  it('refuses writes: the relay is a browser surface, not a tunnel', async () => {
    const reply = await relay('/api/v0/profiles/prof-a/signin/oauth/anything', port, 'POST');
    expect(reply.status).toBe(405);
  });

  it('answers 502 with a sentence when the flow died mid-hop', async () => {
    await new Promise((resolve) => upstream.close(resolve));
    const reply = await relay('/api/v0/profiles/prof-a/signin/oauth/x', port);
    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply)).toContain('Start the sign-in again');
    // Re-open so afterEach's close has something to close.
    upstream = createServer(() => undefined);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  });
});
