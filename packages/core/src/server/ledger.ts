/**
 * Which server conversation belongs to which connection.
 * ============================================================================
 *
 * A turn that arrives over the HTTP server writes a real session under a real
 * account — resumable, auditable, billed like any other. Two different
 * consumers need to know *which* sessions those are, and they need different
 * halves of the same fact:
 *
 *  - The desktop sidebar needs "was this started by a program?", so it can
 *    keep a polling client from burying the person's own history. That was
 *    the whole of the original ledger (`serverSessions.ts` in the desktop
 *    app), and `has()` still answers it.
 *
 *  - The server's own session surface needs "*whose* is it?" — because a
 *    connection token is an identity, and one identity must not be able to
 *    list, read, or resume another's conversations. That is the half this
 *    file adds, and the reason the record grew an owner.
 *
 * ## The scope rule
 *
 * A connection's identity is its **pin**: the profile its turns bill and the
 * workspace they run in, both fixed when the token was created. Two tokens
 * with the same pin are the same principal — the same account writing to the
 * same store in the same directory — and they see each other's sessions,
 * which is precisely what lets one person's laptops share one history.
 * Different pins are different principals and see nothing of each other.
 *
 * The rule is enforced on every surface that takes a session id: listing,
 * replaying, and resuming. Resuming matters most — the session store under a
 * profile's config directory also holds every conversation the *desktop
 * user* ever had in that directory, and a token that could resume one would
 * be reading a private transcript through the model's context. A session is
 * reachable over HTTP only if this ledger says a same-pin connection created
 * it; the desktop user's own sessions are never recorded here, so they are
 * structurally unreachable, not merely refused.
 *
 * ## Durability, honestly stated
 *
 * The file is written lazily and capped. Losing an entry means a server
 * conversation stops being listable over HTTP and reappears in the desktop
 * sidebar — a cosmetic regression, not an access-control failure, because
 * access is granted by presence and absence only ever narrows. The cap drops
 * oldest first for the same reason the original ledger did: a machine left
 * polling accumulates one entry per conversation forever, and this file is
 * read at startup.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Beside `profiles.json` and the rest of the app's own records. */
export const SERVER_LEDGER_FILE = 'serverSessions.json';

/** Oldest dropped first past this. See the file comment for why that is safe. */
const MAX_TRACKED = 5_000;

/** The identity a session is owned by: a connection's pin, plus the token id. */
export interface LedgerEntry {
  readonly sessionId: string;
  /**
   * The connection that created it — kept for audit ("which token did this"),
   * deliberately not consulted for access. Access is the pin's.
   */
  readonly connectionId: string;
  /** The profile that actually served the session. */
  readonly profileId: string;
  /**
   * The workspace identity — see {@link workspaceKeyFor}. Matching on this
   * rather than on the resolved path is what keeps ephemeral scratch private:
   * every ephemeral conversation runs in its own directory, so path equality
   * would make each one visible to nobody, including its own creator.
   */
  readonly workspaceKey: string;
  /** The resolved directory the conversation ran in, for display. */
  readonly cwd: string;
  /** Epoch ms when the session was last recorded. */
  readonly at: number;
}

/** What a connection is allowed to see. */
export interface LedgerScope {
  /** Every profile this connection's allowance makes visible. */
  readonly profileIds: readonly string[];
  readonly workspaceKey: string;
}

/**
 * The workspace half of a connection's identity.
 *
 * A `directory` workspace is a place two tokens can genuinely share — the
 * same repository, the same store on disk — so its key is the path, and two
 * connections pinned to one directory see each other's history. That is the
 * multi-device case: one person, one repo, a token per laptop.
 *
 * Everything else — ephemeral scratch, `none` — is keyed to the connection
 * itself. A scratch directory is minted per conversation and shared with
 * nobody, so the only honest owner is the token that caused it to exist.
 */
export function workspaceKeyFor(connection: {
  readonly id: string;
  readonly workspace: { readonly kind: string; readonly path?: string };
}): string {
  return connection.workspace.kind === 'directory' && connection.workspace.path !== undefined
    ? `dir:${connection.workspace.path}`
    : `conn:${connection.id}`;
}

interface StoredLedger {
  readonly version: 2;
  readonly entries: readonly LedgerEntry[];
}

export interface SessionLedger {
  /** Load the file. Never throws; missing or corrupt starts empty. */
  load(): Promise<void>;
  /**
   * Record a session as created by a connection. Re-recording the same
   * session refreshes recency and ownership — the last writer is the one the
   * provider actually served, and moving to the tail keeps active
   * conversations clear of the cap.
   */
  record(entry: Omit<LedgerEntry, 'at'>): void;
  /** Was this session started by a program rather than by the person? */
  has(sessionId: string): boolean;
  /** The record itself, for a caller that has already passed {@link mayAccess}. */
  get(sessionId: string): LedgerEntry | undefined;
  /** Every session a connection with this pin may see, newest first. */
  listFor(scope: LedgerScope): readonly LedgerEntry[];
  /**
   * May a connection with this pin touch this session at all?
   *
   * The single authority for list, replay, *and* resume. False for a session
   * this ledger has never heard of — which is what makes the desktop user's
   * own history unreachable rather than merely unlisted.
   */
  mayAccess(scope: LedgerScope, sessionId: string): boolean;
  /** How many are tracked, for tests. */
  size(): number;
  /** Flush a pending write, for shutdown. */
  flush(): Promise<void>;
}

/** The one matching rule. An unowned (migrated) entry is in nobody's scope. */
function inScope(entry: LedgerEntry, scope: LedgerScope): boolean {
  return (
    entry.workspaceKey !== '' &&
    entry.workspaceKey === scope.workspaceKey &&
    scope.profileIds.includes(entry.profileId)
  );
}

export function createSessionLedger(dataDir: string): SessionLedger {
  const path = join(dataDir, SERVER_LEDGER_FILE);

  /** Insertion-ordered by recency; `record` re-inserts to move to the tail. */
  const entries = new Map<string, LedgerEntry>();

  let persisting: Promise<void> = Promise.resolve();
  let dirty = false;

  async function write(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    const stored: StoredLedger = { version: 2, entries: [...entries.values()] };
    try {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
      await rename(temp, path);
    } catch {
      // Losing a write narrows what is reachable over HTTP and widens nothing.
      // See the file comment; there is no better response than trying again on
      // the next change.
      dirty = true;
    }
  }

  function persistSoon(): void {
    dirty = true;
    persisting = persisting.then(write);
  }

  return {
    async load(): Promise<void> {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return; // First run, or unreadable — both start empty.
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      /*
       * Version 1 — the desktop's original ledger — was `{ ids: [...] }`,
       * session ids with no owner, written before the server had a session
       * surface. Those conversations keep their one original meaning (hidden
       * from the sidebar) and gain none of the new one: with no recorded pin
       * they match no connection's scope, so they are not listable or
       * resumable over HTTP. Recording an owner that was never known would be
       * inventing an access grant during a file migration. A bare array is
       * accepted too, for the same treatment.
       */
      const v1 = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { ids?: unknown }).ids)
          ? ((parsed as { ids: unknown[] }).ids)
          : null;
      if (v1 !== null && (parsed as { version?: unknown }).version === undefined) {
        for (const id of v1) {
          if (typeof id === 'string' && id.length > 0) {
            entries.set(id, {
              sessionId: id,
              connectionId: '',
              profileId: '',
              workspaceKey: '',
              cwd: '',
              at: 0,
            });
          }
        }
        return;
      }

      const stored = parsed as Partial<StoredLedger>;
      if (stored.version !== 2 || !Array.isArray(stored.entries)) return;
      for (const entry of stored.entries) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.sessionId === 'string' &&
          entry.sessionId.length > 0
        ) {
          entries.set(entry.sessionId, {
            sessionId: entry.sessionId,
            connectionId: typeof entry.connectionId === 'string' ? entry.connectionId : '',
            profileId: typeof entry.profileId === 'string' ? entry.profileId : '',
            workspaceKey: typeof entry.workspaceKey === 'string' ? entry.workspaceKey : '',
            cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
            at: typeof entry.at === 'number' ? entry.at : 0,
          });
        }
      }
    },

    record(entry): void {
      // Delete-then-set moves the id to the tail, so recency is insertion
      // order and the cap below always drops the stalest conversation.
      entries.delete(entry.sessionId);
      entries.set(entry.sessionId, { ...entry, at: Date.now() });
      while (entries.size > MAX_TRACKED) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      persistSoon();
    },

    has(sessionId): boolean {
      return entries.has(sessionId);
    },

    get(sessionId): LedgerEntry | undefined {
      return entries.get(sessionId);
    },

    listFor(scope): readonly LedgerEntry[] {
      const matched: LedgerEntry[] = [];
      for (const entry of entries.values()) {
        if (inScope(entry, scope)) matched.push(entry);
      }
      return matched.reverse();
    },

    mayAccess(scope, sessionId): boolean {
      const entry = entries.get(sessionId);
      return entry !== undefined && inScope(entry, scope);
    },

    size(): number {
      return entries.size;
    },

    flush(): Promise<void> {
      return persisting;
    },
  };
}
