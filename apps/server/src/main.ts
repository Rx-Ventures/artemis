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
 * And one for deployments that cannot run this CLI interactively at all:
 *
 *   ARTEMIS_BOOTSTRAP_CONNECTIONS   a JSON array of connections to make sure
 *                          exist, merged into server.json at startup. For
 *                          orchestrated deploys — Swarm, Nomad, a PaaS — where
 *                          there is no shell to run `connection create` in and
 *                          therefore no way to mint the *first* token, leaving
 *                          the server reachable by nobody. Idempotent; the CLI
 *                          remains the interactive path and the file remains
 *                          the truth for every connection this does not name.
 *                          See `config.ts`.
 *   ARTEMIS_SIGNIN_TIMEOUT_MS   how long a sign-in driven from a client waits
 *                          for the person to finish before the login
 *                          subprocess is killed. Default 10m. See
 *                          `server/signin.ts` in core.
 *
 * Every request still authenticates with a connection token; nothing here
 * relaxes that. See the core ledger for how sessions are scoped per token.
 *
 * ---------------------------------------------------------------------------
 * SIGNING AN ACCOUNT IN, FROM SOMEWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * `profile add` registers an account and prints the login command to run
 * *inside this environment* — which assumes a shell inside this environment.
 * The same orchestrated deployments that cannot mint the first token cannot run
 * that command either, so a connection may be granted account administration
 * (`connection create --manage-profiles`, or `"manageProfiles": true` in
 * `ARTEMIS_BOOTSTRAP_CONNECTIONS`) and drive the login over HTTP from a desktop
 * Artemis instead. The grant is off unless asked for, and it is the only thing
 * that makes those routes visible — see `ServerConnection.manageProfiles`.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { DEFAULT_SERVER_PORT, isValidServerPort, summariseWorkspace } from '@rx-artemis/protocol';
import type { ServerConnection, ServerWorkspace } from '@rx-artemis/protocol';
import { createArtemisServer, signInCommand } from '@rx-artemis/core';

import type { HeadlessConfig } from './config.js';
import {
  loadConfig,
  mergeBootstrapConnections,
  saveConfig,
  newConnectionId,
  newConnectionToken,
} from './config.js';
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

/**
 * How long a client-driven sign-in may stay open.
 *
 * Read here rather than inside core, so the ceiling is one an operator sets
 * beside every other ceiling this process has. An unusable value is ignored
 * rather than fatal: a typo in a timeout must not stop a server from starting.
 */
function signInTimeoutMs(): number | undefined {
  const declared = Number(process.env['ARTEMIS_SIGNIN_TIMEOUT_MS']);
  return Number.isFinite(declared) && declared > 0 ? declared : undefined;
}

async function serve(): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  let config = await loadConfig(dir);
  config = await bootstrapFromEnvironment(dir, config);

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
    feed: host.feed,
    guard: host.guard,
    onRemoteAccess: host.recordAccess,
    // Present unconditionally: the surface it enables is gated per connection,
    // not per deployment, so a build that wired it and a connection that was
    // never granted it produce the same 404 — which is the point.
    profileAdmin: host.profileAdmin,
    ...(signInTimeoutMs() === undefined ? {} : { signInTimeoutMs: signInTimeoutMs() as number }),
    // No `terminals`: this process has no PTY surface — see the file header on
    // what a headless deployment gives up — so the terminal routes answer 501
    // and a remote window's dock shows no shells rather than an error.
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
 * Take on the connections the deployment declared, and say what happened.
 *
 * Written to disk rather than held in memory, so the result is
 * indistinguishable from a connection minted by the CLI: `connection list`
 * shows it, `connection revoke` deletes it, and the next boot needs no
 * environment at all. See {@link mergeBootstrapConnections} for the rules.
 *
 * The log line is deliberately loud and deliberately partial. Loud, because a
 * token appearing out of the environment is a grant of authority and the
 * operator should see it happen; partial, because the whole token would then be
 * in the container's logs, in whatever ships them, and in every place those are
 * kept — which is a worse leak than the one the variable already is. Eight
 * characters is enough to match against the value they configured and useless
 * to anyone who has only the log.
 */
async function bootstrapFromEnvironment(
  dir: string,
  config: HeadlessConfig,
): Promise<HeadlessConfig> {
  const declared = process.env['ARTEMIS_BOOTSTRAP_CONNECTIONS'];
  if (declared === undefined || declared.trim().length === 0) return config;

  const merged = mergeBootstrapConnections(config.connections, declared);
  if (merged.ignored > 0) {
    process.stderr.write(
      `ARTEMIS_BOOTSTRAP_CONNECTIONS: ${String(merged.ignored)} entr${merged.ignored === 1 ? 'y was' : 'ies were'} not usable and ${merged.ignored === 1 ? 'was' : 'were'} ignored.\n` +
        'Each needs a label, a workspace, and a token of at least 32 characters.\n',
    );
  }
  if (merged.added.length === 0 && merged.updated.length === 0) return config;

  const next: HeadlessConfig = { ...config, connections: merged.connections };
  await saveConfig(dir, next);
  for (const connection of merged.added) {
    process.stdout.write(
      `Bootstrapped connection "${connection.label}" (${connection.id}) — ` +
        `${describeGrant(connection)} — token ${connection.token.slice(0, 8)}…\n`,
    );
  }
  // Said separately, because it is a different piece of news: an existing
  // grant changed under a token that clients are already configured with.
  for (const connection of merged.updated) {
    process.stdout.write(
      `Updated connection "${connection.label}" (${connection.id}) from the environment — ` +
        `${describeGrant(connection)}\n`,
    );
  }
  return next;
}

/**
 * One line naming everything a connection may do.
 *
 * Expiry is on it because it is the one part of a grant that changes without
 * anyone touching the file, and an operator reading `connection list` to decide
 * what to revoke should not have to open `server.json` to find out that half
 * these rows stopped working last week.
 */
function describeGrant(connection: ServerConnection): string {
  const parts = [summariseWorkspace(connection.workspace)];
  if (connection.manageProfiles === true) parts.push('may add and sign in accounts');
  if (connection.expiresAt !== undefined) {
    parts.push(
      connection.expiresAt <= Date.now()
        ? `expired ${new Date(connection.expiresAt).toISOString()}`
        : `expires ${new Date(connection.expiresAt).toISOString()}`,
    );
  }
  return parts.join(', ');
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

  /*
   * Through the same seam the HTTP route uses.
   *
   * One implementation, so that an account added here and an account added
   * from a client are the same kind of thing: same duplicate-label rule, same
   * suggested directory when none is named, same `mkdir`. It also fixes the
   * invocation the deployment notes actually tell people to run — see
   * `host.ts`, where omitting `--config-dir` used to reach the store as
   * `undefined` and fail.
   */
  const created = await host.profileAdmin.create({
    label,
    providerId: provider,
    ...(configDir === undefined ? {} : { configDir: resolve(configDir) }),
  });

  /*
   * The provider's own line, composed rather than written out here.
   *
   * The hand-written version said `claude login`, which the CLI renamed to
   * `claude auth login`; it had been wrong for as long as it took anyone to
   * paste it. `signInCommand` builds the line from the same
   * `ProviderCredentialSpec` the adapter uses to *run* the login, so the
   * instruction cannot drift from the thing it instructs — and it quotes the
   * config directory, which the hand-written line did not and which any path
   * with a space in it needed.
   */
  const adapter = host.providers.get(created.providerId as never);
  const command =
    adapter === undefined
      ? undefined
      : signInCommand({ credentials: adapter.credentials, configDir: created.configDir });

  process.stdout.write(
    `Profile "${label}" (${created.id}) added.\n` +
      `Config directory: ${created.configDir}\n` +
      (command === undefined
        ? "Sign the account in from inside this environment with the provider's own login command.\n"
        : `Sign the account in from inside this environment:\n  ${command}\n` +
          'Or sign it in from a desktop Artemis, against a connection created with --manage-profiles.\n'),
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
  /*
   * Administration is a flag rather than a default, and the warning is not
   * decoration. This token can add accounts to the server and drive their
   * logins, which is the one authority here that is not bounded by a directory
   * or an allowance — so it belongs on the operator's own connection and on no
   * other.
   */
  const manageProfiles = args.includes('--manage-profiles');
  if (manageProfiles) {
    process.stderr.write(
      'This connection may add accounts to the server and sign them in. Keep the token to yourself — an editor or a script does not need it.\n',
    );
  }

  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const config = await loadConfig(dir);
  const connection: ServerConnection = {
    id: newConnectionId(),
    label,
    workspace,
    ...(manageProfiles ? { manageProfiles: true } : {}),
    token: newConnectionToken(),
    createdAt: Date.now(),
  };
  await saveConfig(dir, { ...config, connections: [...config.connections, connection] });

  process.stdout.write(
    `Connection "${label}" (${connection.id}) — ${describeGrant(connection)}\n` +
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
    process.stdout.write(`${connection.id}  ${connection.label}  ${describeGrant(connection)}\n`);
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
      '  connection create --label <name> [--directory <path> | --ephemeral] [--manage-profiles]\n' +
      `Data directory: ${dataDir()} (set ARTEMIS_DATA_DIR to move it)`,
  );
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
