/**
 * The session surface, and the property it exists to enforce: a connection
 * token sees exactly the conversations its own scope created — not another
 * token's, and never the serving user's desktop history.
 *
 * Everything here goes through `handleServerRequest`, because the guarantee
 * is only real at the boundary: routes, auth, the ledger, and the resume gate
 * exercised together.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, type ServerContext, type SessionSource } from '../http.js';
import { createSessionLedger, type SessionLedger } from '../ledger.js';

const TOKEN_A = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = 'token-cccccccccccccccccccccccccccccccc';

/** Two tokens pinned to one directory — one person's two laptops. */
const LAPTOP_ONE = {
  id: 'conn-a',
  label: 'Laptop one',
  workspace: { kind: 'directory' as const, path: '/work/repo' },
  token: TOKEN_A,
  createdAt: 0,
};
const LAPTOP_TWO = {
  id: 'conn-b',
  label: 'Laptop two',
  workspace: { kind: 'directory' as const, path: '/work/repo' },
  token: TOKEN_B,
  createdAt: 0,
};
/** A different principal: same server, different directory. */
const STRANGER = {
  id: 'conn-c',
  label: 'Someone else',
  workspace: { kind: 'directory' as const, path: '/work/other' },
  token: TOKEN_C,
  createdAt: 0,
};

const PROFILES: readonly ServerProfile[] = [
  {
    id: 'prof-a' as ServerProfile['id'],
    slug: 'work-max',
    label: 'Work Max',
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: NO_CAPABILITIES,
    models: [
      {
        route: 'work-max/opus',
        id: 'opus',
        label: 'Opus 5',
        note: 'The big one.',
        profileId: 'prof-a' as ServerProfile['id'],
        profileSlug: 'work-max',
        profileLabel: 'Work Max',
        providerId: 'claude',
        thinkingLevels: [],
        adaptiveThinking: false,
        fastMode: false,
        ultracode: false,
      },
    ],
  },
];

const catalogue: Catalogue = {
  read: async () => PROFILES,
  invalidate: () => undefined,
};

/** A store that knows two conversations under prof-a in /work/repo. */
const sessionSource: SessionSource = {
  list: async (query) => ({
    sessions:
      query.profileId === 'prof-a' && query.cwd === '/work/repo'
        ? [
            {
              id: 'sess-1' as never,
              providerId: 'claude' as never,
              profileId: 'prof-a' as never,
              cwd: '/work/repo',
              title: 'First conversation',
              firstPrompt: 'hello',
              updatedAt: 111,
            },
            {
              id: 'sess-2' as never,
              providerId: 'claude' as never,
              profileId: 'prof-a' as never,
              cwd: '/work/repo',
              title: 'Second conversation',
              updatedAt: 222,
            },
          ]
        : [],
    hasMore: false,
  }),
  messages: async (query) => ({
    events: [
      {
        type: 'text.complete',
        runId: query.runId,
        seq: 0,
        ts: 1,
        messageId: 'm1',
        role: 'assistant',
        text: `stored text of ${query.sessionId}`,
      } as unknown as AgentEvent,
    ],
    hasMore: false,
  }),
};

/**
 * Flush before removing: the ledger persists lazily, and an `rm` racing a
 * write mid-flight recreates the file under the directory being removed —
 * ENOTEMPTY, intermittently. The same trap the routine store's tests hit.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

async function freshLedger(): Promise<{ ledger: SessionLedger; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-ledger-'));
  const ledger = createSessionLedger(dir);
  cleanups.push(async () => {
    await ledger.flush();
    await rm(dir, { recursive: true, force: true });
  });
  await ledger.load();
  return { ledger, dir };
}

function context(ledger: SessionLedger, extra: Partial<ServerContext> = {}): ServerContext {
  return {
    connections: [LAPTOP_ONE, LAPTOP_TWO, STRANGER],
    version: '0.0.0',
    catalogue,
    startedAt: 1_700_000_000_000,
    ledger,
    sessions: sessionSource,
    ...extra,
  };
}

function get(url: string, token: string) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
  };
}

/** Record sess-1 and sess-2 as LAPTOP_ONE's, the way the router does. */
function seedOwnership(ledger: SessionLedger): void {
  for (const sessionId of ['sess-1', 'sess-2']) {
    ledger.record({
      sessionId,
      connectionId: LAPTOP_ONE.id,
      profileId: 'prof-a',
      workspaceKey: 'dir:/work/repo',
      cwd: '/work/repo',
    });
  }
}

describe('GET /api/v0/sessions', () => {
  it('answers 501 when this build keeps no history', async () => {
    const { ledger } = await freshLedger();
    const reply = await handleServerRequest(
      get('/api/v0/sessions', TOKEN_A),
      context(ledger, { sessions: undefined }),
    );
    expect(reply.status).toBe(501);
  });

  it('lists a scope its own conversations, enriched from the store', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_A), context(ledger));
    expect(reply.status).toBe(200);
    const body = reply.body as { sessions: { id: string; title: string; cwd: string }[] };
    expect(body.sessions.map((row) => row.id).sort()).toEqual(['sess-1', 'sess-2']);
    expect(body.sessions[0]?.cwd).toBe('/work/repo');
    expect(body.sessions.map((row) => row.title).sort()).toEqual([
      'First conversation',
      'Second conversation',
    ]);
  });

  it('shows the same history to a second token with the same pin', async () => {
    // The multi-device case this feature exists for: one person, one
    // directory, a token per laptop.
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_B), context(ledger));
    const body = reply.body as { sessions: { id: string }[] };
    expect(body.sessions).toHaveLength(2);
  });

  it('shows nothing to a token pinned elsewhere', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_C), context(ledger));
    expect(reply.status).toBe(200);
    expect((reply.body as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it('never lists a session the ledger does not own', async () => {
    // The desktop user's own history: real in the store, absent from the
    // ledger. The store answers with it; the route must not.
    const { ledger } = await freshLedger();
    ledger.record({
      sessionId: 'sess-1',
      connectionId: LAPTOP_ONE.id,
      profileId: 'prof-a',
      workspaceKey: 'dir:/work/repo',
      cwd: '/work/repo',
    });
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_A), context(ledger));
    const body = reply.body as { sessions: { id: string }[] };
    // sess-2 exists in the store but was never recorded — invisible.
    expect(body.sessions.map((row) => row.id)).toEqual(['sess-1']);
  });
});

describe('GET /api/v0/sessions/{id}/messages', () => {
  it('replays an owned conversation', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(
      get('/api/v0/sessions/sess-1/messages', TOKEN_A),
      context(ledger),
    );
    expect(reply.status).toBe(200);
    const body = reply.body as { events: { text?: string }[] };
    expect(body.events[0]?.text).toBe('stored text of sess-1');
  });

  it('answers the same 404 for absent and for foreign', async () => {
    // A token must not be able to sound out which ids exist.
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const absent = await handleServerRequest(
      get('/api/v0/sessions/no-such/messages', TOKEN_A),
      context(ledger),
    );
    const foreign = await handleServerRequest(
      get('/api/v0/sessions/sess-1/messages', TOKEN_C),
      context(ledger),
    );
    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(foreign.body));
  });
});

describe('the resume gate on chat completions', () => {
  function chat(sessionId: string, token: string) {
    return {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
      body: {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'continue' }],
        artemis: { sessionId },
      },
    };
  }

  it('refuses to resume a conversation outside the scope', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(
      chat('sess-1', TOKEN_C),
      context(ledger, {
        // Present so the gate is the thing refusing, not the 501.
        runs: {} as never,
        workspaces: { resolve: async () => ({ path: '/work/other', ephemeral: false }) } as never,
      }),
    );
    expect(reply.status).toBe(404);
    expect(JSON.stringify(reply.body)).toContain('No such conversation');
  });

  it('refuses the desktop user\'s own sessions the same way', async () => {
    const { ledger } = await freshLedger();
    // Nothing recorded at all: the id names a conversation the person had in
    // that directory themselves. Structurally unreachable.
    const reply = await handleServerRequest(
      chat('the-users-private-session', TOKEN_A),
      context(ledger, {
        runs: {} as never,
        workspaces: { resolve: async () => ({ path: '/work/repo', ephemeral: false }) } as never,
      }),
    );
    expect(reply.status).toBe(404);
  });
});

describe('the ledger itself', () => {
  it('survives a restart, and migrates the v1 array to unowned entries', async () => {
    const { ledger, dir } = await freshLedger();
    ledger.record({
      sessionId: 'sess-x',
      connectionId: 'conn-a',
      profileId: 'prof-a',
      workspaceKey: 'dir:/work/repo',
      cwd: '/work/repo',
    });
    await ledger.flush();

    const stored = JSON.parse(await readFile(join(dir, 'serverSessions.json'), 'utf8')) as {
      version: number;
      entries: { sessionId: string }[];
    };
    expect(stored.version).toBe(2);
    expect(stored.entries[0]?.sessionId).toBe('sess-x');

    const reloaded = createSessionLedger(dir);
    await reloaded.load();
    expect(reloaded.has('sess-x')).toBe(true);
    expect(
      reloaded.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'dir:/work/repo' }, 'sess-x'),
    ).toBe(true);
  });

  it('keeps v1 entries hidden from the sidebar and reachable by nobody', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-ledger-v1-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const { writeFile } = await import('node:fs/promises');
    // The desktop's real v1 shape: `{ ids: [...] }`.
    await writeFile(join(dir, 'serverSessions.json'), JSON.stringify({ ids: ['old-1', 'old-2'] }), 'utf8');

    const ledger = createSessionLedger(dir);
    await ledger.load();
    expect(ledger.has('old-1')).toBe(true);
    // No recorded owner means no scope matches — a migration must not invent
    // an access grant.
    expect(
      ledger.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'dir:/work/repo' }, 'old-1'),
    ).toBe(false);
    expect(
      ledger.listFor({ profileIds: ['prof-a'], workspaceKey: 'dir:/work/repo' }),
    ).toHaveLength(0);
  });

  it('scopes ephemeral workspaces to the connection that made them', async () => {
    const { ledger } = await freshLedger();
    ledger.record({
      sessionId: 'scratch-1',
      connectionId: 'conn-x',
      profileId: 'prof-a',
      workspaceKey: 'conn:conn-x',
      cwd: '/tmp/scratch/abc',
    });
    expect(
      ledger.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'conn:conn-x' }, 'scratch-1'),
    ).toBe(true);
    expect(
      ledger.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'conn:conn-y' }, 'scratch-1'),
    ).toBe(false);
  });
});
