/**
 * The session-lifecycle log: a plain, append-only record of run transitions.
 *
 * Artemis historically wrote no logs at all, and every run-lifecycle incident —
 * a `run.end` lost to an app restart, a rival run started against a session the
 * provider was still writing — had to be reconstructed from side-effects in the
 * providers' own session files. This file is the antidote: one line per
 * lifecycle transition, written the moment it happens, so the next incident is
 * read rather than excavated.
 *
 * ## What a line is, and is not
 *
 * A line is a JSON object of *identifiers and event names*: run id, session id,
 * profile id, provider, the pane's project directory, timestamps. Never prompt
 * text, never message content, never tokens. That is enforced here rather than
 * promised: {@link SessionLifecycleLog.record} copies only the keys on the
 * allowlist, and only scalar values, so a content-bearing field added upstream
 * by accident is dropped at the door. The log lives under Artemis's own
 * user-data directory — beside `sessionOwners.json`, not in any shared config
 * directory — but machines get shared and files get pasted, so the redaction
 * rule holds regardless of where the file ends up.
 *
 * ## Why synchronous appends
 *
 * The events this records are exactly the ones that surround a crash, and a
 * buffered writer loses exactly the lines that matter — the `run.started` that
 * proves a run was live when the app died. `appendFileSync` hands each line to
 * the kernel before `record` returns, so an app crash cannot take it back.
 * Lifecycle transitions are rare (a handful per run, not per event), so the
 * cost is unmeasurable; this must never be called per streamed token.
 *
 * Recording never throws. A log that takes down the run it is describing has
 * inverted its purpose; a failed append is reported to the optional `onError`
 * and otherwise dropped.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { RunLifecycleEvent } from './registry.js';

/** File name of the log inside the user-data directory. */
export const SESSION_LIFECYCLE_LOG_FILE = 'session-lifecycle.log';

/**
 * The engine came up or went down.
 *
 * These two lines are what turn the log into a forensic instrument for the
 * upstream half of the phantom-done bug: a `run.started` with no `run.ended`
 * before the next `engine.started` is a run whose end was lost to a restart —
 * and the presence or absence of `engine.stopped` in between says whether that
 * restart was a quit or a crash.
 */
export interface EngineLifecycleEvent {
  readonly kind: 'engine.started' | 'engine.stopped';
}

/**
 * The config-directory lock's queue grew past the threshold.
 *
 * Every stored-history read is serialised process-wide through one promise
 * chain (see `withClaudeConfigDir` in the Claude adapter), so a slow read
 * stalls every read behind it. This line records the moment the queue got
 * deep: how deep, what just joined (`waiting`), and what was holding the lock
 * when it did (`holding`) — the three facts a stalled-sidebar incident needs.
 */
export interface HistoryLockQueueEvent {
  readonly kind: 'history.lock.queued';
  /** Calls pending on the lock — the one holding it plus everything queued. */
  readonly depth: number;
  /** The operation that just joined the queue. */
  readonly waiting: string;
  /** The operation holding the lock at that moment, when one had started. */
  readonly holding?: string;
}

/** Everything the log records. */
export type SessionLifecycleEvent = RunLifecycleEvent | EngineLifecycleEvent | HistoryLockQueueEvent;

/**
 * Every key a line may carry, `ts` aside.
 *
 * The allowlist is the redaction rule. The event union above already carries no
 * content at the type level, but types erase and callers evolve; this is the
 * runtime guarantee that a `prompt`, `text` or `message` field smuggled onto an
 * event object never reaches disk.
 */
const RECORDED_KEYS = [
  'kind',
  'runId',
  'sessionId',
  'profileId',
  'providerId',
  'cwd',
  'resumeSessionId',
  'reason',
  'synthesized',
  'mode',
  'depth',
  'waiting',
  'holding',
] as const;

/** Construction options for {@link SessionLifecycleLog}. */
export interface SessionLifecycleLogOptions {
  /** Absolute path of the log file. Parent directories are created on demand. */
  readonly file: string;
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number;
  /** Hears about appends that failed. Defaults to silence — never a throw. */
  readonly onError?: (error: unknown) => void;
}

/**
 * An append-only, crash-surviving, content-free lifecycle log.
 *
 * Create one per app, pointed into the user-data directory, and hand its
 * {@link record} to whatever observes lifecycle transitions — the
 * `RunRegistry`'s `onLifecycle` seam and the config-dir lock's queue reporter.
 */
export class SessionLifecycleLog {
  readonly #file: string;
  readonly #now: () => number;
  readonly #onError: ((error: unknown) => void) | undefined;
  #directoryReady = false;

  constructor(options: SessionLifecycleLogOptions) {
    this.#file = options.file;
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError;
  }

  /**
   * Append one event as one line, synchronously. Never throws.
   *
   * The line is `{ ts, ...allowlisted scalars }`, JSON-encoded, newline
   * terminated — `grep`-able by id and parseable as JSONL, which is the same
   * format the providers' own stores use.
   */
  record(event: SessionLifecycleEvent): void {
    try {
      const line: Record<string, string | number | boolean> = {
        ts: new Date(this.#now()).toISOString(),
      };
      const source = event as unknown as Record<string, unknown>;
      for (const key of RECORDED_KEYS) {
        const value = source[key];
        // Scalars only: an object under an allowed key could carry anything.
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          line[key] = value;
        }
      }
      this.#ensureDirectory();
      appendFileSync(this.#file, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      try {
        this.#onError?.(error);
      } catch {
        // A reporter that throws is not worth a second exception.
      }
    }
  }

  /**
   * Create the parent directory once, lazily.
   *
   * Lazily rather than in the constructor so that constructing the log can
   * never fail — the engine builds it before anything else is up — and once,
   * because a `mkdirSync` per append would be a stat on the hottest line.
   */
  #ensureDirectory(): void {
    if (this.#directoryReady) return;
    mkdirSync(path.dirname(this.#file), { recursive: true });
    this.#directoryReady = true;
  }
}
