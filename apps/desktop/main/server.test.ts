/**
 * The server host: what it remembers, and what it refuses to do on its own.
 *
 * The lifecycle itself — binding, auth, routing — is `packages/core`'s and is
 * tested there against a real socket. What is only true here is the *policy*:
 * the server is off unless the stored config says otherwise, a fresh install
 * has no connections and so is reachable by nobody, a hand-edited config cannot
 * talk it into a port or a grant it should not have, and a legacy single-token
 * config is carried forward without inventing an authority for it.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IPC, type ServerState } from '@rx-artemis/protocol';

import type { EngineHost } from './engine.js';
import { assertResponseSafe, looksLikeSecretValue } from './redact.js';
import {
  createServerHost,
  newServerToken,
  SERVER_CONFIG_FILE,
  type ServerHost,
} from './server.js';

/** An engine with no profiles: the catalogue is not what this file is about. */
const engine = {
  require: () => ({
    listProfiles: async () => [],
    listProviders: async () => [],
    listProviderModels: async () => ({ models: [], live: false }),
    // The event feed subscribes on first bind; a fake with nothing to say
    // still has to accept the listener.
    subscribe: () => () => undefined,
    getRun: () => undefined,
  }),
} as unknown as EngineHost;

let dir = '';
let hosts: ServerHost[] = [];
let pushed: ServerState[] = [];

function host(): ServerHost {
  const created = createServerHost({
    engine,
    userDataDir: dir,
    appVersion: '1.1.1',
    broadcast: (state) => pushed.push(state),
  });
  hosts.push(created);
  return created;
}

async function storedConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, SERVER_CONFIG_FILE), 'utf8')) as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artemis-server-'));
  pushed = [];
  hosts = [];
});

afterEach(async () => {
  for (const created of hosts) await created.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe('createServerHost', () => {
  it('starts nothing on a fresh install', async () => {
    const created = host();
    await created.start();

    // The whole posture in one assertion: a machine that has never been asked
    // does not have a port open.
    expect(created.state().phase).toBe('stopped');
    expect(created.state().autoStart).toBe(false);
    expect(created.state().url).toBeUndefined();
  });

  it('has no connections on a fresh install, so nothing can reach it', async () => {
    // The starting posture: running and reachable are separate states, because
    // there is no ambient credential to leak.
    const created = host();
    await created.start();
    expect(created.state().connections).toEqual([]);
  });

  it('issues a connection bound to the workspace chosen at creation', async () => {
    const created = host();
    await created.start();

    const state = await created.createConnection({
      label: 'Kronos',
      workspace: { kind: 'directory', path: '/tmp/kronos' },
    });

    const connection = state.connections[0];
    expect(connection?.label).toBe('Kronos');
    expect(connection?.workspace).toEqual({ kind: 'directory', path: '/tmp/kronos' });
    expect(connection?.token.length).toBeGreaterThanOrEqual(32);
  });

  it('keeps connections across launches', async () => {
    const first = host();
    await first.start();
    await first.createConnection({ label: 'A', workspace: { kind: 'ephemeral' } });
    const token = first.state().connections[0]?.token;

    const second = host();
    await second.start();
    expect(second.state().connections[0]?.token).toBe(token);
    expect(second.state().connections[0]?.workspace).toEqual({
      kind: 'ephemeral',
      perSession: true,
    });
  });

  it('revokes one without touching the others', async () => {
    const created = host();
    await created.start();
    await created.createConnection({ label: 'A', workspace: { kind: 'none' } });
    await created.createConnection({ label: 'B', workspace: { kind: 'none' } });

    const doomed = created.state().connections[0];
    const state = await created.deleteConnection(doomed?.id ?? '');

    expect(state.connections.map((c) => c.label)).toEqual(['B']);
  });

  it('renames one, which is the only editable field', async () => {
    const created = host();
    await created.start();
    await created.createConnection({ label: 'Old', workspace: { kind: 'ephemeral' } });
    const id = created.state().connections[0]?.id ?? '';

    const state = await created.renameConnection(id, 'New');
    expect(state.connections[0]?.label).toBe('New');
    // The grant is untouched: a rename must never widen what a token reaches.
    expect(state.connections[0]?.workspace).toEqual({ kind: 'ephemeral', perSession: true });
  });

  it('writes the config owner-only, because it holds every token', async () => {
    const created = host();
    await created.start();
    await created.createConnection({ label: 'A', workspace: { kind: 'ephemeral' } });

    const mode = (await stat(join(dir, SERVER_CONFIG_FILE))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('drops a stored connection whose token is too short to be one', async () => {
    // Dropped rather than repaired: a connection is a credential plus a grant,
    // and half-parsing one would invent an authority nobody granted.
    await writeFile(
      join(dir, SERVER_CONFIG_FILE),
      JSON.stringify({
        port: 6472,
        autoStart: false,
        connections: [
          { id: 'a', label: 'Short', workspace: { kind: 'none' }, token: 'short' },
          {
            id: 'b',
            label: 'Fine',
            workspace: { kind: 'ephemeral' },
            token: 'x'.repeat(40),
          },
        ],
      }),
      'utf8',
    );

    const created = host();
    await created.start();
    expect(created.state().connections.map((c) => c.label)).toEqual(['Fine']);
  });

  it('drops a connection whose directory is not absolute', async () => {
    // A relative path would resolve against wherever the app was launched from,
    // which is not a folder anybody chose.
    await writeFile(
      join(dir, SERVER_CONFIG_FILE),
      JSON.stringify({
        connections: [
          {
            id: 'a',
            label: 'Relative',
            workspace: { kind: 'directory', path: 'code/thing' },
            token: 'x'.repeat(40),
          },
        ],
      }),
      'utf8',
    );

    const created = host();
    await created.start();
    expect(created.state().connections).toEqual([]);
  });

  it('carries a legacy single token forward without granting it a directory', async () => {
    // Something may already be configured with it, so it is not dropped — but
    // the old token never had a workspace, and promoting it to one would hand
    // out write access nobody asked for.
    await writeFile(
      join(dir, SERVER_CONFIG_FILE),
      JSON.stringify({ port: 6472, autoStart: false, token: 'y'.repeat(40) }),
      'utf8',
    );

    const created = host();
    await created.start();
    const [connection] = created.state().connections;
    expect(connection?.token).toBe('y'.repeat(40));
    expect(connection?.workspace).toEqual({ kind: 'none' });
  });

  it('ignores a port a hand-edited config should not have asked for', async () => {
    await writeFile(
      join(dir, SERVER_CONFIG_FILE),
      JSON.stringify({ port: 80, autoStart: false, token: 'x'.repeat(40) }),
      'utf8',
    );

    const created = host();
    await created.start();
    // 80 needs root on Unix. The default stands rather than a bind that fails
    // every launch with a permissions error.
    expect(created.state().port).not.toBe(80);
  });

  it('binds at startup only when the config says to, and reports where', async () => {
    await writeFile(
      join(dir, SERVER_CONFIG_FILE),
      // Port 0: the OS picks a free one, so the test cannot collide with
      // whatever else is listening on this machine.
      JSON.stringify({ port: 0, autoStart: true, token: 'x'.repeat(40) }),
      'utf8',
    );

    const created = host();
    await created.start();

    expect(created.state().phase).toBe('running');
    expect(created.state().boundPort).toBeGreaterThan(0);
    expect(created.state().url).toContain(`127.0.0.1:${created.state().boundPort}`);
  });

  it('persists a port change and rebinds a running server', async () => {
    const created = host();
    await created.start();
    await created.configure({ port: 0 });
    await created.listen();
    const first = created.state().boundPort;

    // Reconfiguring to 0 again asks for another free port, which is the
    // observable half of "it rebound".
    await created.configure({ port: 0 });
    expect(created.state().phase).toBe('running');
    expect(created.state().boundPort).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(0);
    expect(await storedConfig()).toMatchObject({ port: 0 });
  });

  it('reports a port it could not bind instead of claiming to be running', async () => {
    const first = host();
    await first.start();
    await first.configure({ port: 0 });
    await first.listen();
    const taken = first.state().boundPort ?? 0;

    const second = host();
    await second.start();
    await second.configure({ port: taken });
    const state = await second.listen();

    expect(state.phase).toBe('error');
    expect(state.lastError?.code).toBe('port_in_use');
    // And the message names the fix, not the errno.
    expect(state.lastError?.message).toMatch(/different/i);
  });

  it('revokes without restarting, because tokens are read per request', async () => {
    const created = host();
    await created.start();
    await created.configure({ port: 0 });
    await created.listen();
    await created.createConnection({ label: 'A', workspace: { kind: 'ephemeral' } });

    const state = await created.deleteConnection(created.state().connections[0]?.id ?? '');

    expect(state.connections).toEqual([]);
    // Still up: revocation is not a restart, and other connections keep working.
    expect(state.phase).toBe('running');
  });

  it('clears a failure when the user stops, and is safe to stop twice', async () => {
    const first = host();
    await first.start();
    await first.configure({ port: 0 });
    await first.listen();

    const second = host();
    await second.start();
    await second.configure({ port: first.state().boundPort ?? 0 });
    await second.listen();
    expect(second.state().phase).toBe('error');

    expect((await second.close()).lastError).toBeUndefined();
    expect((await second.close()).phase).toBe('stopped');
  });

  it('tells every window about each change', async () => {
    const created = host();
    await created.start();
    pushed = [];

    await created.configure({ autoStart: true });
    expect(pushed.at(-1)?.autoStart).toBe(true);
  });
});

describe('tokens and the credential scanner', () => {
  it('never issues one the response scanner would reject', () => {
    /*
     * base64url contains `-`, so a random token can spell `sk-…` and trip the
     * Anthropic-key rule — measured at about one in eleven thousand. Connections
     * cross IPC on every `server:*` response, so an unlucky one would make the
     * Server pane throw forever, with an error about a leak that never happened.
     *
     * 200k draws: a regression that removed the guard would be expected to
     * produce ~17 offenders here, so this fails essentially always rather than
     * flaking. Straight against the generator, because going through
     * `createConnection` would mean 200k atomic file writes.
     */
    for (let index = 0; index < 200_000; index += 1) {
      const token = newServerToken();
      if (looksLikeSecretValue(token)) {
        expect.unreachable(`generated a credential-shaped token: ${token}`);
      }
    }
  });

  it('produces a state the IPC layer will actually let through', async () => {
    const created = host();
    await created.start();
    await created.createConnection({ label: 'A', workspace: { kind: 'ephemeral' } });

    // The same assertion `ipc.ts` makes on every response, against a real one.
    expect(() => assertResponseSafe({ state: created.state() }, IPC.serverStatus)).not.toThrow();
  });
});

describe('conversations a program started', () => {
  it('is empty until the server runs something', async () => {
    const created = host();
    await created.start();
    expect(created.isServerSession('sess-1')).toBe(false);
  });

  it('remembers them across launches, so the sidebar stays clean after a restart', async () => {
    // The ledger is the only record: a server turn writes a transcript
    // indistinguishable from one the user typed, so a forgotten id means that
    // conversation reappears in the sidebar for good.
    const first = host();
    await first.start();
    await writeFile(
      join(dir, 'serverSessions.json'),
      JSON.stringify({ ids: ['sess-from-a-program'] }),
      'utf8',
    );

    const second = host();
    await second.start();
    expect(second.isServerSession('sess-from-a-program')).toBe(true);
    expect(second.isServerSession('sess-the-user-started')).toBe(false);
  });

  it('starts clean rather than failing when the ledger is corrupt', async () => {
    // Losing this costs visibility, not correctness — a few server
    // conversations become visible, which must not stop the app booting.
    await writeFile(join(dir, 'serverSessions.json'), 'not json at all', 'utf8');

    const created = host();
    await expect(created.start()).resolves.toBeUndefined();
    expect(created.isServerSession('anything')).toBe(false);
  });
});
