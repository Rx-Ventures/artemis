/**
 * The headless server's configuration: the same `server.json` the desktop
 * app's Server tab writes, read and written by a CLI instead.
 *
 * File compatibility is a feature, not an accident. A data directory that
 * started life under the desktop app — connections minted in Settings —
 * serves identically when mounted into a container, and vice versa. Nothing
 * in the shape says which wrote it.
 *
 * What this module deliberately does not have is the desktop host's legacy
 * single-`token` migration: a headless deployment postdates connections, so
 * an unknown key here is an unknown key.
 *
 * There is one way in besides the CLI — see {@link mergeBootstrapConnections},
 * which lets an orchestrated deployment declare its connections in the
 * environment because it has no interactive shell to mint them from.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ServerConnection, ServerWorkspace } from '@rx-artemis/protocol';
import { DEFAULT_SERVER_PORT, isValidServerPort, normalizeWorkspace } from '@rx-artemis/protocol';

export const SERVER_CONFIG_FILE = 'server.json';

export interface HeadlessConfig {
  readonly port: number;
  readonly autoStart: boolean;
  readonly connections: readonly ServerConnection[];
}

function readWorkspace(value: unknown): ServerWorkspace | null {
  if (typeof value !== 'object' || value === null) return null;
  const workspace = value as { kind?: unknown; path?: unknown; perSession?: unknown };
  if (workspace.kind === 'directory' && typeof workspace.path === 'string' && workspace.path.length > 0) {
    return { kind: 'directory', path: workspace.path };
  }
  if (workspace.kind === 'ephemeral') {
    return normalizeWorkspace({ kind: 'ephemeral', perSession: workspace.perSession !== false });
  }
  if (workspace.kind === 'none') return { kind: 'none' };
  return null;
}

/**
 * Read stored connections, dropping anything malformed — the same rule the
 * desktop host applies, for the same reason: a connection is a credential
 * plus a grant, and half-parsing one would invent authority nobody granted.
 *
 * ---------------------------------------------------------------------------
 * WHY AN UNREADABLE `expiresAt` DROPS THE WHOLE ROW
 * ---------------------------------------------------------------------------
 *
 * Every other narrowing on a connection fails closed if it is skipped: an
 * `allow` that does not parse means the token sees nothing it was not going to
 * see anyway, because absent means unrestricted and unrestricted is what the
 * operator would have had to grant on purpose. Expiry is the one field where
 * skipping it fails *open* — a token minted to stop working on Friday, whose
 * expiry this reader could not make sense of, would load as a token that never
 * stops working at all, and would do it silently. So a row that declares an
 * expiry this reader cannot use is dropped exactly as a row with a bad token
 * is: the credential stops working, which is the direction a parse failure
 * about a deadline is allowed to fail in.
 */
function readConnections(value: unknown): ServerConnection[] {
  if (!Array.isArray(value)) return [];
  const out: ServerConnection[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const workspace = readWorkspace(row['workspace']);
    if (
      typeof row['id'] !== 'string' ||
      row['id'].length === 0 ||
      typeof row['token'] !== 'string' ||
      row['token'].length < 32 ||
      workspace === null
    ) {
      continue;
    }
    // Present-but-unusable is a refusal; absent is "this token never expires",
    // which is the documented default. See the section comment above.
    const expiresAt = row['expiresAt'];
    if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
      continue;
    }
    out.push({
      id: row['id'],
      label: typeof row['label'] === 'string' ? row['label'] : row['id'],
      workspace,
      token: row['token'],
      createdAt: typeof row['createdAt'] === 'number' ? row['createdAt'] : 0,
      ...(Array.isArray(row['allow']) ? { allow: row['allow'] as never } : {}),
      /*
       * Strictly `=== true`, and written only when it is.
       *
       * This is an administrative grant — it lets a token add accounts to the
       * server and sign them in — so every other value a file or an
       * environment variable can hold has to land as "no". `"true"`, `1` and
       * `"yes"` are all things an operator might type into a JSON blob, and
       * each of them means the operator was not careful enough for this to be
       * the thing that grants it.
       *
       * Absent rather than `false` when it is off, so a connection written by
       * this build is byte-identical to one written by the last for every
       * deployment that never asked for the grant.
       */
      ...(row['manageProfiles'] === true ? { manageProfiles: true } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      /*
       * Carried through rather than read, because this file is shared with the
       * desktop app and the headless server never stamps this field itself.
       * Dropping it here and then rewriting the file — which `connection
       * create` and the bootstrap merge both do — would erase the desktop's
       * record of which tokens are still in use, and that column is the one
       * that decides whether a token is safe to delete.
       */
      ...(typeof row['lastUsedAt'] === 'number' ? { lastUsedAt: row['lastUsedAt'] } : {}),
    });
  }
  return out;
}

export async function loadConfig(dataDir: string): Promise<HeadlessConfig> {
  let stored: unknown = null;
  try {
    stored = JSON.parse(await readFile(join(dataDir, SERVER_CONFIG_FILE), 'utf8'));
  } catch {
    // Absent on first run; unrecoverable is recoverable — defaults work.
  }
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const port = record['port'];
  return {
    port: typeof port === 'number' && isValidServerPort(port) ? port : DEFAULT_SERVER_PORT,
    autoStart: record['autoStart'] === true,
    connections: readConnections(record['connections']),
  };
}

/**
 * Connections declared in the environment, folded into what is on disk.
 * ============================================================================
 *
 * `connection create` is the interactive path and stays the one a person uses.
 * It assumes a person, though — a terminal attached to the running container —
 * and there is a deployment shape where that assumption simply does not hold.
 * Under an orchestrator (Swarm, Dokploy, a Nomad job) a container is a cattle
 * process: `exec` into a specific replica is awkward at best, the filesystem
 * may be recreated on the next deploy, and the *first* token is the one thing
 * that cannot be minted from outside. The result is a server that comes up,
 * binds, answers `/health`, and is reachable by nobody — usable only by someone
 * who can get a shell inside it, which is exactly the person the deployment was
 * meant not to need.
 *
 * So a deployment may declare its connections the same way it declares every
 * other secret it holds: as an environment variable, from whatever the operator
 * already trusts with secrets. The token is *given* rather than generated,
 * because the point is that the thing deploying the server already knows what
 * it wants the token to be — it has to hand the same string to the clients.
 *
 * Three rules make that safe to leave switched on:
 *
 *  1. **Nothing is invented and nothing is removed.** A connection this
 *     variable does not name is untouched, and no row is ever deleted here.
 *     Removing a connection is `connection revoke`, and an env var that still
 *     names it does not resurrect it on the next boot — because the revoke
 *     deletes the row *and* the operator is expected to stop declaring it.
 *  2. **Validated exactly as stored rows are.** The declared entries go through
 *     the same {@link readConnections} gate, so a malformed one is dropped on
 *     precisely the terms a corrupt file's would be — including the 32-character
 *     floor on a token, which is the whole of what stands between this port and
 *     a guess.
 *  3. **Idempotent.** Re-running the same deployment converges rather than
 *     accumulating, because identity here is the token.
 *
 * ---------------------------------------------------------------------------
 * A DECLARATION THAT NAMES AN EXISTING TOKEN *UPDATES* ITS GRANT
 * ---------------------------------------------------------------------------
 *
 * This used to skip a token it had seen before, on the grounds that the file is
 * the truth. That is right for rows the file *owns* and wrong for rows this
 * variable created, and the difference showed up the first time a deployment
 * needed to widen one: the operator edited the environment, redeployed, and the
 * server kept serving the old grant with no way to say so. The only remedy was
 * to revoke the connection and re-declare it, which rotates the token every
 * client is configured with — a credential rotation as the price of a
 * permissions edit.
 *
 * So an entry whose token already exists now overwrites the *grant* — label,
 * workspace, allowance, expiry, and account administration — and preserves the
 * two fields that are this server's bookkeeping rather than the operator's
 * declaration: `id`, which is the handle `connection revoke` takes, and
 * `createdAt`, which is when this server first saw the token and not a claim
 * the environment gets to make. `lastUsedAt` is preserved for the same reason.
 *
 * Expiry is part of the grant and so is re-declared with it, which is the one
 * place this variable can *widen* a narrowing rather than tighten it: dropping
 * `expiresAt` from a declaration turns a token that stopped working on Friday
 * into one that does not. That is the same authority the operator already has —
 * they hold the token and can mint another — so it is theirs to write, but it
 * is written knowingly and not by omission, which is why the log below names
 * every row it changed.
 *
 * This does not contradict `ServerConnection.workspace`'s rule that a grant is
 * fixed once the token is minted. That rule protects a user from a *program*
 * widening its own authority after being handed a credential. Here the widening
 * is written by the person who deployed the server, in the same place they
 * wrote the token, and the alternative — silently ignoring what they declared —
 * is the failure mode this whole variable exists to prevent.
 */
export function mergeBootstrapConnections(
  existing: readonly ServerConnection[],
  declared: string,
): {
  readonly connections: readonly ServerConnection[];
  /** Only the rows this call added, for the operator's log. */
  readonly added: readonly ServerConnection[];
  /** Rows whose grant this call changed, in their new shape. Also worth logging. */
  readonly updated: readonly ServerConnection[];
  /** Entries that did not survive validation. Worth saying out loud. */
  readonly ignored: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(declared);
  } catch {
    // A whole unreadable variable, rather than one bad row in a good array.
    // Counted as one ignored entry so the caller has something to report: a
    // deployment whose token silently did nothing is the failure this feature
    // exists to prevent, and repeating it here would be its own bug.
    return { connections: existing, added: [], updated: [], ignored: 1 };
  }
  if (!Array.isArray(parsed)) {
    return { connections: existing, added: [], updated: [], ignored: 1 };
  }

  /*
   * The three fields a declaration has no business carrying, supplied here.
   *
   * An id is bookkeeping — the handle `connection revoke` takes — and asking a
   * deployment to invent stable unique ones is asking it to get them wrong.
   * `createdAt` is when this server first saw it, which is now; a value from
   * the environment would be a claim about the past that nobody checked, and
   * `lastUsedAt` would be the same claim about a request nobody made. Both of
   * those are this server's own observations, so a declared one is dropped
   * rather than merged: the merge below puts the stored value back.
   */
  const candidates = parsed.map((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const row = raw as Record<string, unknown>;
    const { lastUsedAt: _declaredLastUsedAt, ...rest } = row;
    return {
      ...rest,
      id: typeof row['id'] === 'string' && row['id'].length > 0 ? row['id'] : newConnectionId(),
      createdAt: Date.now(),
    };
  });

  // Identity is the token, here and in `resolveConnection`: two rows with the
  // same token are one grant however they are labelled, so a declaration that
  // repeats a stored token is an edit to that one grant rather than a second.
  const stored = new Map(existing.map((connection) => [connection.token, connection]));
  // And a declaration that repeats *itself* is one grant declared twice. The
  // first wins; a second row cannot be an edit to something this same pass
  // added, because there is nothing on disk yet for it to edit.
  const claimed = new Set<string>();
  const added: ServerConnection[] = [];
  const updated = new Map<string, ServerConnection>();
  const valid = readConnections(candidates);

  for (const connection of valid) {
    if (claimed.has(connection.token)) continue;
    claimed.add(connection.token);

    const prior = stored.get(connection.token);
    if (prior === undefined) {
      added.push(connection);
      continue;
    }
    // The declaration is the whole grant; the two fields below are this
    // server's own bookkeeping and are kept. See the section comment.
    const merged: ServerConnection = {
      ...connection,
      id: prior.id,
      createdAt: prior.createdAt,
      ...(prior.lastUsedAt === undefined ? {} : { lastUsedAt: prior.lastUsedAt }),
    };
    // Compared rather than written unconditionally, so the ordinary case — a
    // redeploy that changed nothing — neither rewrites `server.json` nor tells
    // the operator that something happened when nothing did.
    if (JSON.stringify(merged) !== JSON.stringify(prior)) updated.set(prior.id, merged);
  }

  const changed = added.length > 0 || updated.size > 0;
  return {
    connections: changed
      ? [...existing.map((connection) => updated.get(connection.id) ?? connection), ...added]
      : existing,
    added,
    updated: [...updated.values()],
    ignored: parsed.length - valid.length,
  };
}

export async function saveConfig(dataDir: string, config: HeadlessConfig): Promise<void> {
  const path = join(dataDir, SERVER_CONFIG_FILE);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** The same coin the desktop mints: 32 random bytes, base64url. */
export function newConnectionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newConnectionId(): string {
  return randomBytes(8).toString('hex');
}
