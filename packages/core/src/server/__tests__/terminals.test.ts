/**
 * Remote terminals: who may see a shell, and who may end one.
 *
 * The interesting assertions here are all refusals. Opening a shell over the
 * wire is the least surprising part of the surface; what has to be pinned is
 * that a token cannot reach a terminal it did not open, cannot reach one the
 * *local window* opened, cannot open one outside its workspace pin, and cannot
 * take every slot from the person sitting at the machine.
 */

import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ServerConnection, TerminalEvent, TerminalInfo } from '@rx-artemis/protocol';
import {
  REMOTE_TERMINALS_PATH,
  remoteTerminalPath,
  type ServerTerminalBody,
  type ServerTerminalsBody,
} from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { createPushFeed } from '../feed.js';
import { handleServerRequest, isStreamReply, type ServerContext } from '../http.js';
import {
  createRemoteTerminals,
  MAX_REMOTE_TERMINALS_PER_FAMILY,
  type TerminalSource,
} from '../terminals.js';

const TOKEN = 'terminal-token-abcdefghijklmnopqrstu';
const SIBLING_TOKEN = 'sibling-token-abcdefghijklmnopqrstuv';
const STRANGER_TOKEN = 'stranger-token-abcdefghijklmnopqrstu';

/** Pinned to /w. */
const CONNECTION: ServerConnection = {
  id: 'conn-1',
  label: 'Laptop',
  workspace: { kind: 'directory', path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

/** A second token pinned to the *same* directory — the multi-device case. */
const SIBLING: ServerConnection = {
  id: 'conn-2',
  label: 'Desktop',
  workspace: { kind: 'directory', path: '/w' },
  token: SIBLING_TOKEN,
  createdAt: 0,
};

/** Pinned somewhere else entirely. */
const STRANGER: ServerConnection = {
  id: 'conn-3',
  label: 'Other',
  workspace: { kind: 'directory', path: '/elsewhere' },
  token: STRANGER_TOKEN,
  createdAt: 0,
};

const catalogue: Catalogue = { read: async () => [], invalidate: () => undefined };

/** A fake shell registry: ids, cwds, and what was written to each. */
function fakeSource(): TerminalSource & {
  readonly writes: string[];
  readonly closed: string[];
  readonly live: Set<string>;
  forget(id: string): void;
} {
  let next = 0;
  const live = new Set<string>();
  const writes: string[] = [];
  const closed: string[] = [];
  return {
    writes,
    closed,
    live,
    forget: (id) => live.delete(id),
    start: async ({ cwd }) => {
      next += 1;
      const id = `t${next}`;
      live.add(id);
      const info: TerminalInfo = {
        id: id as TerminalInfo['id'],
        shell: '/bin/zsh',
        cwd,
        startedAt: 0,
        exited: false,
      };
      return info;
    },
    write: (id, data) => {
      writes.push(`${id}:${data}`);
    },
    resize: () => undefined,
    close: (id) => {
      closed.push(id);
    },
    replay: (id) => ({ data: `tail of ${id}`, truncated: false }),
    has: (id) => live.has(id),
  };
}

function ask(
  url: string,
  context: Partial<ServerContext>,
  { token = TOKEN, method = 'GET', body }: { token?: string; method?: string; body?: unknown } = {},
): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    {
      method,
      url,
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body }),
    },
    {
      connections: [CONNECTION, SIBLING, STRANGER],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
      ...context,
    },
  );
}

async function json<T>(reply: Awaited<ReturnType<typeof handleServerRequest>>): Promise<T> {
  if (isStreamReply(reply)) throw new Error('expected a body');
  return reply.body as T;
}

describe('the terminal routes', () => {
  it('answers 501 when the deployment has no shells to offer', async () => {
    const reply = await ask(REMOTE_TERMINALS_PATH, {});
    expect(reply.status).toBe(501);
  });

  it('opens a shell in the connection pin and lists it back', async () => {
    const terminals = createRemoteTerminals({ source: fakeSource() });
    const started = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
      method: 'POST',
      body: { cols: 80, rows: 24 },
    });
    expect(started.status).toBe(200);
    const body = await json<ServerTerminalBody>(started);
    // No cwd was sent, so the pin itself is the honest answer.
    expect(body.terminal.cwd).toBe(resolve('/w'));

    const listed = await json<ServerTerminalsBody>(await ask(REMOTE_TERMINALS_PATH, { terminals }));
    expect(listed.terminals.map((t) => String(t.id))).toEqual([String(body.terminal.id)]);
  });

  it('admits a directory beneath the pin and refuses one outside it', async () => {
    const terminals = createRemoteTerminals({ source: fakeSource() });
    const inside = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
      method: 'POST',
      body: { cwd: '/w/packages/core', cols: 80, rows: 24 },
    });
    expect((await json<ServerTerminalBody>(inside)).terminal.cwd).toBe(resolve('/w/packages/core'));

    const outside = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
      method: 'POST',
      body: { cwd: '/etc', cols: 80, rows: 24 },
    });
    expect(outside.status).toBe(403);
  });

  /*
   * The spelling a raw prefix test admits. `/w/../../etc` starts with `/w/` as
   * a string and names `/etc`; this cwd reaches `node-pty` directly, so it is
   * the same hazard the run route has and gets the same confinement.
   */
  it('refuses a cwd that climbs out of the pin with dot segments', async () => {
    const source = fakeSource();
    const terminals = createRemoteTerminals({ source });
    for (const cwd of ['/w/../../etc', '/w/./../..', '/w/sub/../../../etc', '/w/..']) {
      const reply = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
        method: 'POST',
        body: { cwd, cols: 80, rows: 24 },
      });
      expect(reply.status).toBe(403);
    }
    // Nothing was spawned on any of them.
    expect(source.live.size).toBe(0);
  });

  it('does not admit a sibling directory sharing the pin’s prefix', async () => {
    const terminals = createRemoteTerminals({ source: fakeSource() });
    const reply = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
      method: 'POST',
      body: { cwd: '/w-other', cols: 80, rows: 24 },
    });
    expect(reply.status).toBe(403);
  });

  it('normalizes a path that stays inside the pin', async () => {
    const terminals = createRemoteTerminals({ source: fakeSource() });
    const started = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
      method: 'POST',
      body: { cwd: '/w/packages/../packages/core', cols: 80, rows: 24 },
    });
    expect((await json<ServerTerminalBody>(started)).terminal.cwd).toBe(resolve('/w/packages/core'));
  });

  it('refuses a size that is not a positive integer', async () => {
    const terminals = createRemoteTerminals({ source: fakeSource() });
    const reply = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
      method: 'POST',
      body: { cols: 0, rows: 24 },
    });
    expect(reply.status).toBe(400);
  });

  it('shares a shell with a token on the same pin and hides it from one that is not', async () => {
    const terminals = createRemoteTerminals({ source: fakeSource() });
    const started = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );
    const id = String(started.terminal.id);

    const sibling = await json<ServerTerminalsBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { token: SIBLING_TOKEN }),
    );
    expect(sibling.terminals.map((t) => String(t.id))).toEqual([id]);

    const stranger = await json<ServerTerminalsBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { token: STRANGER_TOKEN }),
    );
    expect(stranger.terminals).toEqual([]);

    // And it is not merely invisible in the list — it is unreachable by id,
    // with the same answer an absent one gets.
    const reach = await ask(remoteTerminalPath(id, 'write'), { terminals }, {
      token: STRANGER_TOKEN,
      method: 'POST',
      body: { data: 'ls\n' },
    });
    expect(reach.status).toBe(404);
  });

  it('never routes a shell the local window opened', async () => {
    const source = fakeSource();
    const feed = createPushFeed();
    const terminals = createRemoteTerminals({ source, feed });
    // A terminal this surface did not issue — main's own id.
    source.live.add('local-1');

    const reply = await ask(remoteTerminalPath('local-1', 'replay'), { terminals });
    expect(reply.status).toBe(404);

    // And its output does not reach the feed at all.
    terminals.observe({ type: 'data', id: 'local-1' as TerminalInfo['id'], data: 'secret' });
    expect(feed.head()).toBe(0);
  });

  it('publishes remote output scoped to the family that opened the shell', async () => {
    const source = fakeSource();
    const feed = createPushFeed();
    const terminals = createRemoteTerminals({ source, feed });
    const started = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );

    terminals.observe({ type: 'data', id: started.terminal.id, data: 'hello' });
    const published = feed.since(0).events;
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe('artemis:push:terminal-event');
    expect(published[0]?.scope.workspaceKey).toBe('dir:/w');
  });

  it('writes, resizes and replays through to the host', async () => {
    const source = fakeSource();
    const terminals = createRemoteTerminals({ source });
    const started = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );
    const id = String(started.terminal.id);

    await ask(remoteTerminalPath(id, 'write'), { terminals }, {
      method: 'POST',
      body: { data: 'ls\n' },
    });
    expect(source.writes).toEqual([`${id}:ls\n`]);

    const resized = await ask(remoteTerminalPath(id, 'resize'), { terminals }, {
      method: 'POST',
      body: { cols: 120, rows: 40 },
    });
    expect(resized.status).toBe(200);

    const replay = await ask(remoteTerminalPath(id, 'replay'), { terminals });
    expect(replay.status).toBe(200);
    expect((replay as { body: { data: string } }).body.data).toBe(`tail of ${id}`);
  });

  it('ends a shell only through close', async () => {
    const source = fakeSource();
    const terminals = createRemoteTerminals({ source });
    const started = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );
    const id = String(started.terminal.id);

    // Disposing the registry — what stopping the server does — must not kill it.
    terminals.dispose();
    expect(source.closed).toEqual([]);

    const again = createRemoteTerminals({ source });
    const reopened = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals: again }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );
    await ask(remoteTerminalPath(String(reopened.terminal.id), 'close'), { terminals: again }, {
      method: 'POST',
      body: {},
    });
    expect(source.closed).toEqual([String(reopened.terminal.id)]);
    expect(id).not.toBe(String(reopened.terminal.id));
  });

  it('caps how many live shells one family may hold', async () => {
    const terminals = createRemoteTerminals({ source: fakeSource(), maxPerFamily: 2 });
    const open = (): ReturnType<typeof ask> =>
      ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } });

    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(429);
    // The cap is per family, so the token on another pin is unaffected.
    const other = await ask(REMOTE_TERMINALS_PATH, { terminals }, {
      token: STRANGER_TOKEN,
      method: 'POST',
      body: { cols: 80, rows: 24 },
    });
    expect(other.status).toBe(200);
  });

  it('stops counting a shell that has exited', async () => {
    const source = fakeSource();
    const terminals = createRemoteTerminals({ source, maxPerFamily: 1 });
    const started = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );
    expect(
      (await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }))
        .status,
    ).toBe(429);

    terminals.observe({ type: 'exit', id: started.terminal.id, exitCode: 0 });
    expect(
      (await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }))
        .status,
    ).toBe(200);
    // The record survives the process, so the tab keeps its last words.
    const listed = await json<ServerTerminalsBody>(await ask(REMOTE_TERMINALS_PATH, { terminals }));
    expect(listed.terminals.find((t) => t.id === started.terminal.id)?.exited).toBe(true);
  });

  it('forgets a shell the host has forgotten', async () => {
    const source = fakeSource();
    const terminals = createRemoteTerminals({ source });
    const started = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );
    source.forget(String(started.terminal.id));
    const reply = await ask(remoteTerminalPath(String(started.terminal.id), 'replay'), { terminals });
    expect(reply.status).toBe(404);
  });

  it('records opening and closing against the connection that did it', async () => {
    const onAccess = vi.fn();
    const terminals = createRemoteTerminals({ source: fakeSource(), onAccess });
    const started = await json<ServerTerminalBody>(
      await ask(REMOTE_TERMINALS_PATH, { terminals }, { method: 'POST', body: { cols: 80, rows: 24 } }),
    );
    await ask(remoteTerminalPath(String(started.terminal.id), 'close'), { terminals }, {
      method: 'POST',
      body: {},
    });

    expect(onAccess.mock.calls.map(([event]) => event)).toEqual([
      {
        kind: 'remote.terminal.started',
        connectionId: 'conn-1',
        terminalId: String(started.terminal.id),
        cwd: resolve('/w'),
      },
      {
        kind: 'remote.terminal.closed',
        connectionId: 'conn-1',
        terminalId: String(started.terminal.id),
      },
    ]);
  });

  it('keeps the default family cap below the host ceiling', () => {
    // The local user must always be able to open one. See the constant.
    expect(MAX_REMOTE_TERMINALS_PER_FAMILY).toBeLessThan(16);
  });
});
