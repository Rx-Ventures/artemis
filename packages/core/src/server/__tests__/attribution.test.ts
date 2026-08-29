/**
 * Token expiry, and the record of which token did what.
 *
 * The two land together because they answer halves of the same question about
 * a credential carried to another machine: how long it lasts, and what it did
 * while it lasted.
 */

import { describe, expect, it, vi } from 'vitest';

import type { RunHandle, ServerConnection } from '@rx-artemis/protocol';
import {
  connectionHasExpired,
  NO_CAPABILITIES,
  REMOTE_RUNS_PATH,
  remoteRunPath,
  SERVER_HEALTH_PATH,
} from '@rx-artemis/protocol';

import type { RunSource } from '../completions.js';
import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, isStreamReply, type ServerContext } from '../http.js';
import { createWorkspaceResolver } from '../workspaces.js';

const LIVE_TOKEN = 'live-token-abcdefghijklmnopqrstuvwx';
const DEAD_TOKEN = 'dead-token-abcdefghijklmnopqrstuvwx';

const LIVE: ServerConnection = {
  id: 'conn-live',
  label: 'Laptop',
  workspace: { kind: 'directory', path: '/w' },
  token: LIVE_TOKEN,
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
};

const DEAD: ServerConnection = {
  id: 'conn-dead',
  label: 'Old laptop',
  workspace: { kind: 'directory', path: '/w' },
  token: DEAD_TOKEN,
  createdAt: 0,
  expiresAt: Date.now() - 1,
};

const catalogue: Catalogue = { read: async () => [], invalidate: () => undefined };

function handle(runId: string): RunHandle {
  return {
    runId,
    providerId: 'claude',
    profileId: 'prof-a',
    cwd: '/w',
    status: 'running',
    capabilities: NO_CAPABILITIES,
    startedAt: 0,
  };
}

const runs: RunSource = {
  startRun: () => Promise.reject(new Error('not under test')),
  subscribe: () => () => undefined,
  interrupt: async () => undefined,
  respondToPermission: async () => undefined,
  disposeRun: async () => undefined,
  listRuns: async () => [handle('run-a')],
  getRun: async (runId) => (runId === 'run-a' ? handle('run-a') : undefined),
  runEvents: async () => ({ events: [], truncated: false }),
  startUserRun: async (input) => ({ ...handle('run-new'), cwd: input.cwd }),
  send: async () => ({ deliveredImmediately: true }),
  interruptRun: async () => ({ stillQueued: [] }),
  stopTask: async () => undefined,
};

function ask(
  url: string,
  context: Partial<ServerContext> = {},
  { token = LIVE_TOKEN, method = 'GET', body }: { token?: string; method?: string; body?: unknown } = {},
): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    {
      method,
      url,
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body }),
    },
    {
      connections: [LIVE, DEAD],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
      runs,
      workspaces: createWorkspaceResolver(),
      ...context,
    },
  );
}

describe('token expiry', () => {
  it('has no opinion about a connection that never expires', () => {
    expect(connectionHasExpired({ ...LIVE, expiresAt: undefined }, Date.now())).toBe(false);
  });

  it('expires at the instant, not after it', () => {
    const at = 1_000;
    expect(connectionHasExpired({ ...LIVE, expiresAt: at }, at - 1)).toBe(false);
    expect(connectionHasExpired({ ...LIVE, expiresAt: at }, at)).toBe(true);
  });

  it('lets a live token through', async () => {
    expect((await ask(REMOTE_RUNS_PATH)).status).toBe(200);
  });

  it('refuses an expired one, and says so rather than "invalid"', async () => {
    const reply = await ask(REMOTE_RUNS_PATH, {}, { token: DEAD_TOKEN });
    expect(reply.status).toBe(401);
    if (isStreamReply(reply)) throw new Error('expected a body');
    const body = reply.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('expired_api_key');
    // The distinction is the whole point: a person holding this needs to know
    // to ask for a new one, not to debug the server.
    expect(body.error.message).toContain('expired');
  });

  it('leaves /health answerable — it is reached before any token is read', async () => {
    expect((await ask(SERVER_HEALTH_PATH, {}, { token: DEAD_TOKEN })).status).toBe(200);
  });

  it('records the refusal against the connection it was for', async () => {
    const onRemoteAccess = vi.fn();
    await ask(REMOTE_RUNS_PATH, { onRemoteAccess }, { token: DEAD_TOKEN });
    expect(onRemoteAccess).toHaveBeenCalledWith({
      kind: 'remote.token.expired',
      connectionId: 'conn-dead',
    });
  });
});

describe('the attribution record', () => {
  it('names the token that started a run', async () => {
    const onRemoteAccess = vi.fn();
    const reply = await ask(REMOTE_RUNS_PATH, { onRemoteAccess }, {
      method: 'POST',
      body: {
        input: { providerId: 'claude', profileId: 'prof-a', cwd: '/w', prompt: 'hello' },
      },
    });
    expect(reply.status).toBe(200);
    expect(onRemoteAccess).toHaveBeenCalledWith({
      kind: 'remote.run.started',
      connectionId: 'conn-live',
      runId: 'run-new',
      profileId: 'prof-a',
      cwd: '/w',
    });
  });

  it('names the verb on a steering act', async () => {
    const onRemoteAccess = vi.fn();
    await ask(remoteRunPath('run-a', 'interrupt'), { onRemoteAccess }, {
      method: 'POST',
      body: {},
    });
    expect(onRemoteAccess).toHaveBeenCalledWith({
      kind: 'remote.run.acted',
      connectionId: 'conn-live',
      action: 'interrupt',
      runId: 'run-a',
      profileId: 'prof-a',
    });
  });

  it('gives answering a permission prompt its own kind', async () => {
    const onRemoteAccess = vi.fn();
    await ask(remoteRunPath('run-a', 'respond-permission'), { onRemoteAccess }, {
      method: 'POST',
      body: { requestId: 'req-1', decision: { behavior: 'allow' } },
    });
    expect(onRemoteAccess).toHaveBeenCalledWith({
      kind: 'remote.permission.answered',
      connectionId: 'conn-live',
      action: 'respond-permission',
      runId: 'run-a',
      profileId: 'prof-a',
    });
  });

  it('carries no prompt, message or token — only ids and verbs', async () => {
    const onRemoteAccess = vi.fn();
    await ask(REMOTE_RUNS_PATH, { onRemoteAccess }, {
      method: 'POST',
      body: {
        input: {
          providerId: 'claude',
          profileId: 'prof-a',
          cwd: '/w',
          prompt: 'the secret plan',
        },
      },
    });
    await ask(remoteRunPath('run-a', 'send'), { onRemoteAccess }, {
      method: 'POST',
      body: { text: 'another secret' },
    });

    const serialised = JSON.stringify(onRemoteAccess.mock.calls);
    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain(LIVE_TOKEN);
  });

  it('says nothing at all about reads', async () => {
    const onRemoteAccess = vi.fn();
    await ask(REMOTE_RUNS_PATH, { onRemoteAccess });
    await ask(remoteRunPath('run-a', 'events'), { onRemoteAccess });
    expect(onRemoteAccess).not.toHaveBeenCalled();
  });

  it('is optional: a host that wants no record gets none and nothing breaks', async () => {
    const reply = await ask(remoteRunPath('run-a', 'interrupt'), {}, { method: 'POST', body: {} });
    expect(reply.status).toBe(200);
  });
});
