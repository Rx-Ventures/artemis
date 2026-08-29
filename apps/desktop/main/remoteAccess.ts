/**
 * The one remote-origin grant, and where it lives.
 * ============================================================================
 *
 * Remote mode (ADR 0004) has the renderer fetch another machine's Artemis
 * directly, and two of the walls around the renderer live in main: the CSP
 * header and the `webRequest` lockdown. Both must be widened to exactly one
 * origin before a single remote request can leave the window, and both must be
 * widened *at boot* when the user last left the app connected — the renderer
 * reloads straight into remote mode and its first fetch races any IPC it
 * could have sent. So the origin is main's to persist, in its own file.
 *
 * Not `prefs.json`, which main deliberately never parses, and not the
 * renderer's own remote-bridge state: main needs precisely one fact — the
 * origin — and it needs it before any window exists. The **token** is
 * deliberately absent. Main never talks to the remote machine, so a token
 * here would be a credential stored where nothing uses it; it stays with the
 * renderer's remote-bridge config, which is the same posture as the server
 * connections `ServerState` already carries renderer-side on purpose.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createLogger } from './log.js';

const log = createLogger('remoteAccess');

/** Beside `server.json` and `prefs.json`, and named the way they are. */
export const REMOTE_ACCESS_FILE = 'remote.json';

interface StoredRemoteAccess {
  readonly version: 1;
  readonly origin: string | null;
}

/**
 * Normalize what a person typed into a bare origin, or refuse it.
 *
 * Accepts a full URL (`http://kronos.tail1234.ts.net:6472/`, path and all —
 * people paste the server's index URL) and the host-port shorthand
 * (`kronos:6472`), and reduces either to scheme + host + port. Refuses any
 * scheme but `http(s)` and any embedded credentials, because the value ends
 * up interpolated into a CSP directive and matched against request origins —
 * it must be an origin and nothing more.
 */
export function normalizeRemoteOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // Bare `host:port` parses as a URL whose scheme is the host, so the
  // http-prefixed form is tried as a fallback — but only when the input did
  // not *spell* a scheme. `file:///etc/passwd` names its scheme and must be
  // refused, not repaired into `http://file/…`.
  const spelledScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  for (const candidate of spelledScheme ? [trimmed] : [trimmed, `http://${trimmed}`]) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (parsed.username !== '' || parsed.password !== '') return null;
    return parsed.origin;
  }
  return null;
}

export interface RemoteAccess {
  /** Read the stored grant off disk. Never throws; missing starts null. */
  load(): Promise<void>;
  /** The origin right now, for the security policy's getter. */
  origin(): string | null;
  /**
   * Store a new grant, replace the old one, or withdraw with `null`.
   *
   * The input has been through {@link normalizeRemoteOrigin} by the IPC
   * handler; this trusts its caller only as far as re-checking costs nothing,
   * so it normalizes again rather than assuming.
   */
  configure(origin: string | null): Promise<string | null>;
}

export function createRemoteAccess(userDataDir: string): RemoteAccess {
  const path = join(userDataDir, REMOTE_ACCESS_FILE);
  let current: string | null = null;

  return {
    async load(): Promise<void> {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return; // First run, or never configured.
      }
      try {
        const stored = JSON.parse(raw) as Partial<StoredRemoteAccess>;
        current =
          typeof stored.origin === 'string' ? normalizeRemoteOrigin(stored.origin) : null;
      } catch {
        // A corrupt file grants nothing, which is the safe reading of it.
        current = null;
      }
    },

    origin(): string | null {
      return current;
    },

    async configure(origin: string | null): Promise<string | null> {
      current = origin === null ? null : normalizeRemoteOrigin(origin);
      const stored: StoredRemoteAccess = { version: 1, origin: current };
      try {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.tmp`;
        await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
        await rename(temp, path);
      } catch (error) {
        // The in-memory grant already applies; a failed write means the next
        // launch forgets it, which the user experiences as having to
        // reconnect — worth a log line, not a failure of the configure.
        log.warn('Could not persist the remote-access origin', error);
      }
      return current;
    },
  };
}
