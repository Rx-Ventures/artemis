/**
 * The session mutations: rename, tag, delete, each one route.
 *
 * What these pin is the boundary, not the storage: every id is scoped by the
 * ledger exactly as the reads are ("not yours" answers like "not there"), a
 * host that did not wire a write answers 501 rather than pretending, and the
 * one irreversible act — deletion — leaves an attribution line.
 */

import { describe, expect, it } from 'vitest';

import type { ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { RemoteAccessEvent } from '../../sessions/lifecycleLog.js';
import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, type SessionSource } from '../http.js';
import { workspaceKeyFor, type SessionLedger } from '../ledger.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const OTHER_TOKEN = 'other-token-abcdefghijklmnopqrstuvwx';

const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

/** A second directory connection, whose scope must not reach conn-1's rows. */
const STRANGER = {
  id: 'conn-2',
  label: 'Stranger',
  workspace: { kind: 'directory' as const, path: '/elsewhere' },
  token: OTHER_TOKEN,
  createdAt: 0,
};

const PROFILES: readonly ServerProfile[] = [
  {
    id: 'prof-a' as ServerProfile['id'],
    slug: 'work',
    label: 'Work',
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: NO_CAPABILITIES,
    models: [],
  },
];

const catalogue: Catalogue = {
  read: async () => PROFILES,
  invalidate: () => undefined,
};

/** A ledger holding exactly one session, owned by {@link CONNECTION}'s workspace. */
function ledgerWith(sessionId: string): SessionLedger {
  const entry = {
    sessionId,
    connectionId: CONNECTION.id,
    profileId: 'prof-a',
    workspaceKey: workspaceKeyFor(CONNECTION),
    cwd: '/w',
  };
  return {
    get: (id) => (id === sessionId ? (entry as never) : undefined),
    mayAccess: (scope, id) => id === sessionId && scope.workspaceKey === entry.workspaceKey,
  } as never;
}

interface Recorded {
  renames: unknown[];
  deletes: unknown[];
  tags: unknown[];
  access: RemoteAccessEvent[];
}

function harness(source: Partial<SessionSource>): {
  recorded: Recorded;
  ask: (
    url: string,
    method: string,
    body?: unknown,
    token?: string,
  ) => ReturnType<typeof handleServerRequest>;
} {
  const recorded: Recorded = { renames: [], deletes: [], tags: [], access: [] };
  const sessions: SessionSource = {
    list: async () => ({ sessions: [], hasMore: false }),
    messages: async () => ({ events: [], hasMore: false }),
    ...source,
  };
  return {
    recorded,
    ask: (url, method, body, token = TOKEN) =>
      handleServerRequest(
        {
          method,
          url,
          headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
          ...(body === undefined ? {} : { body }),
        },
        {
          connections: [CONNECTION, STRANGER],
          version: '1.1.1',
          catalogue,
          startedAt: 1_700_000_000_000,
          ledger: ledgerWith('sess-1'),
          sessions,
          onRemoteAccess: (event) => recorded.access.push(event),
        },
      ),
  };
}

describe('rename', () => {
  it('stores the title through the host and answers with what was stored', async () => {
    const { recorded, ask } = harness({
      rename: async (query) => {
        recorded.renames.push(query);
        return { title: 'A tidy name' };
      },
    });
    const reply = await ask('/api/v0/sessions/sess-1/rename', 'POST', { title: '  A tidy name  ' });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ object: 'artemis.session.renamed', title: 'A tidy name' });
    expect(recorded.renames[0]).toMatchObject({ profileId: 'prof-a', sessionId: 'sess-1', cwd: '/w' });
  });

  it('refuses a body with no usable title', async () => {
    const { ask } = harness({ rename: async () => ({ title: 'x' }) });
    expect((await ask('/api/v0/sessions/sess-1/rename', 'POST', { title: '   ' })).status).toBe(400);
    expect((await ask('/api/v0/sessions/sess-1/rename', 'POST', {})).status).toBe(400);
    expect((await ask('/api/v0/sessions/sess-1/rename', 'POST', { title: 7 })).status).toBe(400);
  });

  it('answers 501 when the host wired no rename', async () => {
    const { ask } = harness({});
    expect((await ask('/api/v0/sessions/sess-1/rename', 'POST', { title: 'x' })).status).toBe(501);
  });
});

describe('tag', () => {
  it('writes a tag, and clears one with null', async () => {
    const { recorded, ask } = harness({
      tag: async (query) => {
        recorded.tags.push(query);
        return true;
      },
    });
    expect((await ask('/api/v0/sessions/sess-1/tag', 'POST', { tag: 'archived' })).status).toBe(200);
    expect((await ask('/api/v0/sessions/sess-1/tag', 'POST', { tag: null })).status).toBe(200);
    expect(recorded.tags).toMatchObject([{ tag: 'archived' }, { tag: null }]);
  });

  it('refuses a tag that is neither a string nor null', async () => {
    const { ask } = harness({ tag: async () => true });
    expect((await ask('/api/v0/sessions/sess-1/tag', 'POST', { tag: 7 })).status).toBe(400);
  });
});

describe('delete', () => {
  it('destroys through the host and leaves the one attribution line', async () => {
    const { recorded, ask } = harness({
      delete: async (query) => {
        recorded.deletes.push(query);
        return true;
      },
    });
    const reply = await ask('/api/v0/sessions/sess-1', 'DELETE');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ object: 'artemis.session.deleted', deleted: true });
    expect(recorded.access).toMatchObject([
      { kind: 'remote.session.deleted', connectionId: 'conn-1', sessionId: 'sess-1' },
    ]);
  });

  it('says deleted: false for a session already gone, and logs nothing', async () => {
    const { recorded, ask } = harness({ delete: async () => false });
    const reply = await ask('/api/v0/sessions/sess-1', 'DELETE');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ deleted: false });
    expect(recorded.access).toEqual([]);
  });
});

describe('the boundary', () => {
  it("hides another connection's session behind the same 404 as a missing one", async () => {
    const { recorded, ask } = harness({
      rename: async () => ({ title: 'x' }),
      delete: async () => true,
      tag: async () => true,
    });
    for (const [url, method, body] of [
      ['/api/v0/sessions/sess-1/rename', 'POST', { title: 'x' }],
      ['/api/v0/sessions/sess-1/tag', 'POST', { tag: 'archived' }],
      ['/api/v0/sessions/sess-1', 'DELETE', undefined],
    ] as const) {
      const foreign = await ask(url, method, body, OTHER_TOKEN);
      expect(foreign.status).toBe(404);
      const absent = await ask(url.replace('sess-1', 'sess-9'), method, body);
      expect(absent.status).toBe(404);
      expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(absent.body));
    }
    expect(recorded.renames).toEqual([]);
    expect(recorded.deletes).toEqual([]);
    expect(recorded.access).toEqual([]);
  });
});
