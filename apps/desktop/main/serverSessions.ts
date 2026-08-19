/**
 * Which conversations belong to a program rather than to the person.
 * ============================================================================
 *
 * A turn that arrives over the HTTP server writes a session file exactly as a
 * turn typed into the app does — same provider, same config directory, same
 * transcript on disk. That is correct: it *is* a real conversation under a real
 * account, and it should be resumable, auditable and billed like any other.
 *
 * What it is not is something the user started, and the sidebar is a list of
 * conversations the user started. A script polling a summariser every minute
 * would otherwise push a person's own work off the top of their own history
 * within an hour.
 *
 * So this is the ledger of session ids the server created, and the session list
 * filters against it.
 *
 * ---------------------------------------------------------------------------
 * WHY A LEDGER AND NOT A TAG ON THE SESSION
 * ---------------------------------------------------------------------------
 *
 * `Capabilities.tagSession` exists and is what archiving is built on, so tagging
 * looks like the obvious mechanism. Two things rule it out. Only some providers
 * have it — Codex threads and the local endpoints do not — so a tag would hide
 * server runs for Claude and leave them visible everywhere else, which is worse
 * than not hiding them at all. And tagging is a *write to the provider's own
 * store*: it would mean mutating a transcript to record a fact about Artemis.
 *
 * A ledger beside `sessionOwners.json` is the same shape the app already uses
 * for the same kind of fact — something Artemis knows about a session that the
 * session itself does not say.
 *
 * ---------------------------------------------------------------------------
 * HIDDEN, NOT DELETED
 * ---------------------------------------------------------------------------
 *
 * Nothing here removes a transcript. The conversation is on disk, under the
 * account that ran it, exactly where the provider put it; this only decides
 * what the sidebar lists. That distinction matters if the user ever needs to
 * audit what a program did with their accounts — the record is intact, and this
 * file is the index of which records were not theirs.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createLogger } from './log.js';

const log = createLogger('server-sessions');

/** Beside `profiles.json`, `prefs.json` and `sessionOwners.json`. */
export const SERVER_SESSIONS_FILE = 'serverSessions.json';

/**
 * How many ids are kept.
 *
 * A cap rather than unbounded growth: a machine left running a polling client
 * accumulates one id per turn forever, and this file is read at startup. The
 * oldest are dropped first, and dropping one is not a failure — it means a very
 * old server conversation becomes visible in the sidebar, which is a cosmetic
 * regression rather than a leak.
 */
const MAX_TRACKED = 5_000;

export interface ServerSessions {
  /** Load the ledger. Never throws; a missing or corrupt file starts empty. */
  load(): Promise<void>;
  /** Record a session as server-created. Persisted lazily. */
  add(sessionId: string): void;
  /** Was this conversation started by a program rather than by the user? */
  has(sessionId: string): boolean;
  /** How many are tracked, for a test and for the pane if it ever shows one. */
  size(): number;
}

export function createServerSessions(userDataDir: string): ServerSessions {
  const path = join(userDataDir, SERVER_SESSIONS_FILE);

  /*
   * Insertion-ordered, which is what makes the cap meaningful: a `Set` keeps
   * the order ids were added, so trimming from the front drops the oldest.
   */
  let ids = new Set<string>();
  let writeScheduled = false;

  async function persist(): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      // Owner-only like its neighbours: this names conversations, which is a
      // fact about what the user has been doing.
      await writeFile(temp, `${JSON.stringify({ ids: [...ids] })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temp, path);
    } catch (error) {
      // Losing this costs visibility, not correctness: the worst outcome is a
      // server conversation appearing in the sidebar after a restart.
      log.debug('Could not persist the server-session ledger', error);
    }
  }

  /**
   * Write soon, not now.
   *
   * A streaming turn reports its session id once, but a busy server produces
   * one per conversation and an atomic write per turn would be an fsync on the
   * hot path of every request. Coalescing to one write per tick keeps a burst
   * of turns to a single file write.
   */
  function scheduleWrite(): void {
    if (writeScheduled) return;
    writeScheduled = true;
    setTimeout(() => {
      writeScheduled = false;
      void persist();
    }, 1_000).unref?.();
  }

  return {
    async load() {
      try {
        const stored: unknown = JSON.parse(await readFile(path, 'utf8'));
        const list = (stored as { ids?: unknown } | null)?.ids;
        if (Array.isArray(list)) {
          ids = new Set(list.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // Absent on first run; unreadable means starting empty, which shows a
        // few server conversations in the sidebar rather than failing a launch.
        ids = new Set();
      }
    },

    add(sessionId) {
      if (sessionId.length === 0 || ids.has(sessionId)) return;
      ids.add(sessionId);
      while (ids.size > MAX_TRACKED) {
        const oldest = ids.values().next().value;
        if (oldest === undefined) break;
        ids.delete(oldest);
      }
      scheduleWrite();
    },

    has: (sessionId) => ids.has(sessionId),
    size: () => ids.size,
  };
}
