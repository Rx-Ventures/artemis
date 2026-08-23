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
    out.push({
      id: row['id'],
      label: typeof row['label'] === 'string' ? row['label'] : row['id'],
      workspace,
      token: row['token'],
      createdAt: typeof row['createdAt'] === 'number' ? row['createdAt'] : 0,
      ...(Array.isArray(row['allow']) ? { allow: row['allow'] as never } : {}),
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
