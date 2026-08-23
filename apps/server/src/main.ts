#!/usr/bin/env node
/**
 * Headless Artemis.
 *
 * One binary, four verbs:
 *
 *   artemis-server serve                       — bind and answer until signalled
 *   artemis-server profile add <label> ...     — register a serving account
 *   artemis-server connection create ...       — mint a token (prints it once)
 *   artemis-server connection list|revoke ...  — inspect and retract grants
 *
 * Configuration is environment-first, because the process is built to live in
 * a container:
 *
 *   ARTEMIS_DATA_DIR       where profiles.json, server.json, the session
 *                          ledger and the profile config directories live.
 *                          Default: ~/.artemis-server
 *   ARTEMIS_BIND_HOST      interface to bind. Default 127.0.0.1; a container
 *                          sets 0.0.0.0 and lets its published port and the
 *                          network in front of it govern reachability.
 *   ARTEMIS_PORT           overrides server.json's port when set.
 *   ARTEMIS_ALLOWED_HOSTS  comma-separated Host-header names to answer to,
 *                          or `any`. Defaults to `any` when the bind host is
 *                          not loopback — the Host check is DNS-rebinding
 *                          protection for loopback binds, and a deliberately
 *                          reachable server is guarded by its bind + auth.
 *
 * Every request still authenticates with a connection token; nothing here
 * relaxes that. See the core ledger for how sessions are scoped per token.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { DEFAULT_SERVER_PORT, isValidServerPort, summariseWorkspace } from '@rx-artemis/protocol';
import type { ServerConnection, ServerWorkspace } from '@rx-artemis/protocol';
import { createArtemisServer } from '@rx-artemis/core';

import { loadConfig, saveConfig, newConnectionId, newConnectionToken } from './config.js';
import { createHeadlessHost } from './host.js';

function dataDir(): string {
  const declared = process.env['ARTEMIS_DATA_DIR'];
  return resolve(declared !== undefined && declared.length > 0 ? declared : join(homedir(), '.artemis-server'));
}

function bindHost(): string {
  const declared = process.env['ARTEMIS_BIND_HOST'];
  return declared !== undefined && declared.length > 0 ? declared : '127.0.0.1';
}

function allowedHosts(): readonly string[] | 'any' | undefined {
  const declared = process.env['ARTEMIS_ALLOWED_HOSTS'];
  if (declared !== undefined && declared.length > 0) {
    return declared.trim() === 'any'
      ? 'any'
      : declared.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
  }
  const bind = bindHost();
  const loopback = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
  return loopback ? undefined : 'any';
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function serve(): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const config = await loadConfig(dir);

  const declaredPort = process.env['ARTEMIS_PORT'];
  const port =
    declaredPort !== undefined && declaredPort.length > 0 ? Number(declaredPort) : config.port;
  if (!Number.isInteger(port) || !isValidServerPort(port)) {
    fail(`"${String(port)}" is not a usable port.`);
  }

  if (config.connections.length === 0) {
    process.stderr.write(
      'No connections are configured — this server is reachable by nobody.\n' +
        'Mint one first:  artemis-server connection create --label laptop --directory /work/repo\n',
    );
  }

  const host = createHeadlessHost(dir);
  await host.ledger.load();

  const server = createArtemisServer({
    port,
    host: bindHost(),
    // Read fresh per request so a revocation lands without a restart — the
    // CLI writes server.json, and this re-read is what makes that matter.
    // Cached for a beat so a busy server is not hitting the disk per request.
    connections: connectionReader(dir, config.connections),
    version: '0.1.0-headless',
    catalogue: host.catalogue,
    runs: host.runSource,
    workspaces: host.workspaces,
    ledger: host.ledger,
    sessions: host.sessionSource,
    ...(allowedHosts() === undefined ? {} : { allowedHosts: allowedHosts() as never }),
    onError: (error) => {
      process.stderr.write(`server error: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });

  const bound = await server.listen();
  process.stdout.write(`Artemis server listening on ${bindHost()}:${String(bound)} (data: ${dir})\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    process.stdout.write('Shutting down…\n');
    void Promise.allSettled([server.close(), host.dispose()]).then(() => process.exit(0));
    // A wedged provider must not make the container unkillable.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Connections, re-read from disk at most every two seconds.
 *
 * The desktop host holds its config in memory and its UI writes through it;
 * here the CLI is a *separate process* writing server.json, and this is the
 * seam that makes `connection revoke` take effect on a running server.
 */
function connectionReader(
  dir: string,
  initial: readonly ServerConnection[],
): () => readonly ServerConnection[] {
  let cached = initial;
  let readAt = Date.now();
  let refreshing = false;
  return () => {
    if (Date.now() - readAt > 2_000 && !refreshing) {
      refreshing = true;
      void loadConfig(dir)
        .then((config) => {
          cached = config.connections;
          readAt = Date.now();
        })
        .finally(() => {
          refreshing = false;
        });
    }
    return cached;
  };
}

/* -------------------------------------------------------------------------- */
/* CLI verbs                                                                  */
/* -------------------------------------------------------------------------- */

function argOf(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

async function profileAdd(args: readonly string[]): Promise<void> {
  const label = argOf(args, 'label');
  const provider = argOf(args, 'provider') ?? 'claude';
  if (label === undefined) fail('profile add needs --label <name> [--provider claude] [--config-dir <path>]');

  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const host = createHeadlessHost(dir);
  const configDir = argOf(args, 'config-dir');
  const profile = await host.profiles.create({
    label,
    providerId: provider as never,
    ...(configDir === undefined ? {} : { configDir: resolve(configDir) }),
  } as never);
  process.stdout.write(
    `Profile "${label}" (${profile.id}) added.\n` +
      `Config directory: ${host.profiles.configDirFor(profile)}\n` +
      `Sign the account in from inside this environment, e.g.:\n` +
      `  CLAUDE_CONFIG_DIR=${host.profiles.configDirFor(profile)} claude login\n`,
  );
}

async function profileList(): Promise<void> {
  const host = createHeadlessHost(dataDir());
  const rows = await host.profiles.listMetadata();
  if (rows.length === 0) {
    process.stdout.write('No profiles. Add one: artemis-server profile add --label work\n');
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${row.id}  ${row.providerId}  ${row.label}\n`);
  }
}

function readWorkspaceArgs(args: readonly string[]): ServerWorkspace {
  const directory = argOf(args, 'directory');
  if (directory !== undefined) return { kind: 'directory', path: resolve(directory) };
  if (args.includes('--ephemeral')) return { kind: 'ephemeral', perSession: true };
  return { kind: 'none' };
}

async function connectionCreate(args: readonly string[]): Promise<void> {
  const label = argOf(args, 'label');
  if (label === undefined) {
    fail('connection create needs --label <name> and one of --directory <path> | --ephemeral');
  }
  const workspace = readWorkspaceArgs(args);
  if (workspace.kind === 'none') {
    process.stderr.write(
      'No workspace given — this connection will browse the catalogue but cannot run turns.\n',
    );
  }

  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const config = await loadConfig(dir);
  const connection: ServerConnection = {
    id: newConnectionId(),
    label,
    workspace,
    token: newConnectionToken(),
    createdAt: Date.now(),
  };
  await saveConfig(dir, { ...config, connections: [...config.connections, connection] });

  process.stdout.write(
    `Connection "${label}" (${connection.id}) — ${summariseWorkspace(workspace)}\n` +
      `Token (shown once; paste it into the profile's API-key field on the client):\n` +
      `${connection.token}\n`,
  );
}

async function connectionList(): Promise<void> {
  const config = await loadConfig(dataDir());
  if (config.connections.length === 0) {
    process.stdout.write('No connections.\n');
    return;
  }
  for (const connection of config.connections) {
    process.stdout.write(
      `${connection.id}  ${connection.label}  ${summariseWorkspace(connection.workspace)}\n`,
    );
  }
}

async function connectionRevoke(args: readonly string[]): Promise<void> {
  const id = args[0];
  if (id === undefined) fail('connection revoke needs the connection id (see: connection list)');
  const dir = dataDir();
  const config = await loadConfig(dir);
  const remaining = config.connections.filter((connection) => connection.id !== id);
  if (remaining.length === config.connections.length) fail(`No connection with id "${id}".`);
  await saveConfig(dir, { ...config, connections: remaining });
  process.stdout.write(`Connection ${id} revoked. A running server stops honouring it within seconds.\n`);
}

async function main(): Promise<void> {
  const [, , verb, noun, ...rest] = process.argv;
  if (verb === undefined || verb === 'serve') return serve();
  if (verb === 'profile' && noun === 'add') return profileAdd(rest);
  if (verb === 'profile' && noun === 'list') return profileList();
  if (verb === 'connection' && noun === 'create') return connectionCreate(rest);
  if (verb === 'connection' && noun === 'list') return connectionList();
  if (verb === 'connection' && noun === 'revoke') return connectionRevoke(rest);
  fail(
    'Usage: artemis-server [serve] | profile add|list | connection create|list|revoke\n' +
      `Data directory: ${dataDir()} (set ARTEMIS_DATA_DIR to move it)`,
  );
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
