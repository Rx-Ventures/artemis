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

/**
 * A remote connection did something that spends, steers, or spawns.
 *
 * ---------------------------------------------------------------------------
 * WHY ATTRIBUTION LANDS HERE AND NOT IN A NEW FILE
 * ---------------------------------------------------------------------------
 *
 * Remote control (ADR 0004) creates a question the server has never had to
 * answer: *which token did this?* Until now the server's own traffic record was
 * counters and one `lastUsedAt` per connection, deliberately — a request log is
 * a transcript of what a person asked, and Artemis does not keep one. That
 * posture is right and it is also, on its own, useless the morning after: a run
 * that spent a plan overnight, a shell that was opened on the serving machine,
 * and no way to say which of four tokens did either.
 *
 * This log is the shape that answers it without becoming the thing the posture
 * refuses. It is *already* ids-and-event-names only, and it is already enforced
 * as such at the door by {@link RECORDED_KEYS} rather than promised in a
 * comment. So the record of remote acts is one more event kind on the same
 * line-per-transition file: `connectionId` names who, `kind` names what, and the
 * ids name which run, session or shell. There is nowhere for a prompt to go.
 *
 * What is deliberately *not* recorded: reads. Listing runs, replaying events,
 * reading the catalogue and holding the event stream open are how a remote
 * window draws a frame, and logging them would produce a line per frame and
 * bury the four lines a year that matter. Only acts that spend money, change
 * what a machine is doing, or start a process are named.
 */
export interface RemoteAccessEvent {
  readonly kind:
    /** A bridge token started a run — the one that spends a plan. */
    | 'remote.run.started'
    /** …steered a live one: send, interrupt, stop-task, dispose. */
    | 'remote.run.acted'
    /** …answered a permission prompt. Its own kind because it is the one
     *  that lets an agent touch the serving machine on somebody's say-so. */
    | 'remote.permission.answered'
    /** …opened a shell on the serving machine. */
    | 'remote.terminal.started'
    /** …closed one. */
    | 'remote.terminal.closed'
    /**
     * …added a serving account.
     *
     * The administrative acts below are the only ones on this record that
     * create something the server did not have rather than steering something
     * it already had, which is exactly why they are worth a line: an account
     * signed in from a laptop is a credential in a config directory on the
     * serving machine that every future run may spend, and the connection that
     * put it there is not the connection that pays for it. See
     * `ServerConnection.manageProfiles` for why the grant is separate.
     *
     * What is on these lines is a connection id and a profile id. The
     * verification URL the provider printed is not, and the code the user
     * pasted back is *emphatically* not — it is a single-use secret in flight,
     * and the whole point of {@link RECORDED_KEYS} is that neither has a field
     * to travel in even if a caller tried.
     */
    | 'remote.profile.created'
    /** …started the provider's login for one. */
    | 'remote.signin.started'
    /**
     * …handed over the code that finishes it.
     *
     * "Completed" from the caller's side: the code reached the subprocess's
     * stdin. Whether the provider *accepted* it is the CLI's answer and arrives
     * later, on the poll — a rejected code leaves the flow open and asks again,
     * and re-recording that would put a line on this file per typo.
     */
    | 'remote.signin.completed'
    /** …abandoned one, killing the subprocess. */
    | 'remote.signin.cancelled'
    /**
     * …destroyed a stored transcript.
     *
     * The one session mutation that earns a line: renames and tags are
     * cosmetic and reversible, a deletion is neither, and "which token
     * removed that conversation" is precisely the question this record
     * exists to answer.
     */
    | 'remote.session.deleted'
    /** A token was presented after its expiry and refused. */
    | 'remote.token.expired';
  /** Which connection. The whole point of the record. */
  readonly connectionId: string;
  /** The verb, for `remote.run.acted` — `send`, `interrupt`, `dispose`. */
  readonly action?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly profileId?: string;
  /** Which provider an added account belongs to. Set by the account acts only. */
  readonly providerId?: string;
  readonly terminalId?: string;
  readonly cwd?: string;
}

/** Everything the log records. */
export type SessionLifecycleEvent =
  | RunLifecycleEvent
  | EngineLifecycleEvent
  | HistoryLockQueueEvent
  | RemoteAccessEvent;

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
  // Remote attribution. `connectionId` is an id Artemis minted, never a token:
  // the token itself is a secret and could not be added here even by accident,
  // because `ServerConnection` is not what any of these events carry.
  'connectionId',
  'action',
  'terminalId',
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
