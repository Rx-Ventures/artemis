/**
 * Which account a session actually ran under.
 *
 * A profile's config directory is normally its own store, so this question
 * answers itself: a transcript found under `p2/projects/` is `p2`'s, and no
 * bookkeeping is needed anywhere. The shared-config feature breaks that. It
 * symlinks `projects/` from every profile into the user's own `~/.claude` —
 * deliberately, so history stops splitting four ways — and from then on every
 * profile enumerates one store and the directory a transcript was found in says
 * nothing about who paid for it.
 *
 * Nothing in the provider's own files closes the gap. The transcript records a
 * session id, a directory, a branch and a CLI version, and no account. The
 * per-profile `history.jsonl` does carry session ids, but only the interactive
 * CLI writes it, so it is empty for every session Artemis drives. The
 * `sessions/<pid>.json` locks carry the pair and are deleted when the process
 * exits. There is no file to read the answer out of, which is why this exists:
 * Artemis knows the account at the moment it starts a run, and this is where it
 * writes that down before the knowledge is gone.
 *
 * ## Where this sits
 *
 * Beside {@link RunRegistry} and next to {@link SessionNamer}, wired the same
 * way and for the same reason — the registry's three jobs are all on the path
 * of a user waiting for output, and this is on nobody's:
 *
 * ```ts
 * const owners = new SessionOwners({ userDataDir })
 * runs.subscribe((event) => owners.handleEvent(event))
 * const handle = await runs.start(input); owners.noteRun(input, handle.runId)
 * ```
 *
 * It differs from the namer in the one way that matters here: the namer
 * deliberately ignores resumed and forked runs, because those are not first
 * messages. This records *every* run. A resume is exactly when an unattributed
 * session becomes attributable — the user picked an account and opened it — and
 * ignoring resumes would mean the sidebar could only ever learn about
 * conversations started after this shipped.
 *
 * ## Artemis's own bookkeeping, and outside the shared store on purpose
 *
 * The document lives under Artemis's user-data directory, beside
 * `profiles.json`. It must not live in the config directory: that is the thing
 * being shared, so a ledger written there would be visible to every profile
 * that shares it and would answer the question by asserting it.
 *
 * Nothing here is authoritative about anything else. A missing entry is the
 * ordinary state for history that predates this file, and it means "not known",
 * never "not owned" — see {@link SessionSummary.profileIsUnknown} for what a
 * consumer does with that, which is to show no account rather than guess one.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  ProfileId,
  RunId,
  RunInput,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';

/** File name of the ledger inside the user-data directory. */
export const SESSION_OWNERS_FILE = 'sessionOwners.json';

/** Schema version of the persisted document. */
export const SESSION_OWNERS_VERSION = 1;

/**
 * How many sessions to remember.
 *
 * Generous, because an entry is two short strings and a number, and the cost of
 * forgetting one is a row that goes back to showing no account — small, but
 * visible, and it would land on exactly the old conversations a user keeps
 * around because they matter. Pruning is oldest-first by {@link Owned.seenAt},
 * which is the closest thing to "least likely to be opened again" available
 * without tracking reads.
 */
export const SESSION_OWNERS_LIMIT = 20_000;

/**
 * How many un-started runs to hold before dropping the oldest.
 *
 * The same backstop {@link SessionNamer} keeps, for the same reason: a run that
 * is registered and never reports a session leaves an entry behind, and an
 * unbounded map fed by a loop is a leak. Small, because entries live from
 * `runs.start` resolving to the first event — milliseconds, normally.
 */
const PENDING_LIMIT = 256;

/** One recorded ownership. */
interface Owned {
  readonly profileId: ProfileId;
  /** When this was last confirmed, ms since epoch. The pruning key. */
  readonly seenAt: number;
}

/** The persisted document. */
interface PersistedDocument {
  readonly version: number;
  readonly sessions: Record<string, Owned>;
}

/** Reported instead of thrown — see {@link SessionOwnersOptions.onError}. */
export type SessionOwnersErrorReporter = (error: unknown, context: { readonly stage: string }) => void;

export interface SessionOwnersOptions {
  /** Artemis's user-data directory. The document lands directly inside it. */
  readonly userDataDir: string;
  /**
   * Where failures go.
   *
   * Every one of them is survivable and none is worth an exception: a ledger
   * that cannot be read leaves rows unattributed, which is the state they were
   * in before this existed, and a ledger that cannot be written loses a label.
   * Neither is a reason to fail a run or blank a sidebar, and this class is
   * wired into both paths.
   */
  readonly onError?: SessionOwnersErrorReporter;
  /** Clock seam, for tests. */
  readonly now?: () => number;
}

/**
 * Records and answers which account each session ran under.
 *
 * One per application. Every method is safe to call at any time, including
 * before the first load and after {@link flush}.
 */
export class SessionOwners {
  readonly #file: string;
  readonly #userDataDir: string;
  readonly #onError: SessionOwnersErrorReporter | undefined;
  readonly #now: () => number;

  /** The ledger itself, or `null` until the first read finishes. */
  #owners: Map<SessionId, Owned> | null = null;
  /** In-flight load, so concurrent callers share one read. */
  #loading: Promise<Map<SessionId, Owned>> | null = null;

  /** Runs whose account is known but whose session has not been reported yet. */
  readonly #pending = new Map<RunId, ProfileId>();
  /**
   * Sessions reported before their run was registered.
   *
   * The same narrow race {@link SessionNamer} closes from the other side:
   * `RunRegistry.start()` begins pumping events the moment the adapter returns,
   * and the host cannot call {@link noteRun} until that call resolves.
   */
  readonly #earlySessions = new Map<RunId, SessionId>();

  /** Serialises writes, so two records cannot interleave into one file. */
  #writing: Promise<void> = Promise.resolve();
  /** Set by {@link record}, cleared by the write that persists it. */
  #dirty = false;
  /**
   * Claims that have been made but have not yet reached a write.
   *
   * {@link record} is deliberately synchronous — it is called from an event
   * handler on the run registry's feed, which must not be made to await a disk
   * read — so the work it starts outlives the call. A claim spends its first
   * moments inside {@link #load}, before it has touched {@link #writing} at
   * all, and {@link flush} awaiting only the write chain would sail straight
   * past it and report the ledger settled. On quit that is the account for
   * whichever session was started last: the one the user will look for first.
   */
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: SessionOwnersOptions) {
    this.#userDataDir = options.userDataDir;
    this.#file = path.join(options.userDataDir, SESSION_OWNERS_FILE);
    this.#onError = options.onError;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Record the account a run is executing under, so its session can be claimed.
   *
   * Called for every run with no filtering, which is the difference from
   * {@link SessionNamer.noteRun} — see the note at the top of this file about
   * resumes being the moment an old session becomes attributable.
   *
   * @param runId The registry's id for the run — `RunInput.runId` may be absent.
   */
  noteRun(input: RunInput, runId: RunId): void {
    // The session may already have arrived — see `#earlySessions`.
    const early = this.#earlySessions.get(runId);
    if (early !== undefined) {
      this.#earlySessions.delete(runId);
      this.record(early, input.profileId);
      return;
    }

    this.#pending.set(runId, input.profileId);
    this.#evictOverflow(this.#pending);
  }

  /**
   * Feed the run registry's event stream in.
   *
   * Nothing is consumed: this is one subscriber among several and must not
   * change what any other one sees.
   */
  handleEvent(event: AgentEvent): void {
    if (event.type === 'session.started') {
      const profileId = this.#pending.get(event.runId);
      if (profileId === undefined) {
        // The race in `#earlySessions`. Holding the id is cheap and `noteRun`
        // decides what it belongs to.
        this.#earlySessions.set(event.runId, event.sessionId);
        this.#evictOverflow(this.#earlySessions);
        return;
      }
      this.#pending.delete(event.runId);
      this.record(event.sessionId, profileId);
      return;
    }

    if (event.type === 'run.end') {
      /*
       * A last chance, and it is not redundant.
       *
       * `session.started` is the ordinary door and covers every run that got
       * far enough to have a session. A run that ends carrying a session id it
       * never announced — a transport that reports the pair only on the way
       * out, or an interrupt after the CLI had already written the file — would
       * otherwise leave a transcript on disk with nothing recorded about it.
       */
      const profileId = this.#pending.get(event.runId);
      if (profileId !== undefined && event.sessionId !== undefined) {
        this.record(event.sessionId, profileId);
      }
      this.#pending.delete(event.runId);
      this.#earlySessions.delete(event.runId);
    }
  }

  /**
   * Claim a session for an account, and persist it.
   *
   * Idempotent in the case that matters: re-recording the same pair refreshes
   * {@link Owned.seenAt} — which is what keeps a conversation the user actually
   * uses ahead of the pruning line — but does not rewrite the file, because a
   * ten-turn conversation is ten runs and none of them changes the answer.
   *
   * A *different* account for a session already recorded is honoured rather
   * than refused. That is not drift: with the store shared, resuming under
   * another account genuinely moves which one the conversation continues on and
   * bills to, and the row should say the one that will pay next.
   */
  record(sessionId: SessionId, profileId: ProfileId): void {
    const claim = this.#claim(sessionId, profileId).finally(() => {
      this.#inFlight.delete(claim);
    });
    this.#inFlight.add(claim);
  }

  /**
   * Every recorded ownership, loading the document on first use.
   *
   * Handed out as a read-only view of the live map rather than a copy: the
   * caller is a listing that reads it once and discards it, and copying twenty
   * thousand entries per sidebar refresh to protect against a mutation nobody
   * makes is a cost with no matching risk.
   */
  async all(): Promise<ReadonlyMap<SessionId, ProfileId>> {
    const owners = await this.#load();
    const view = new Map<SessionId, ProfileId>();
    for (const [sessionId, owned] of owners) view.set(sessionId, owned.profileId);
    return view;
  }

  /** The account recorded for one session, or `undefined` when none is. */
  async ownerOf(sessionId: SessionId): Promise<ProfileId | undefined> {
    const owners = await this.#load();
    return owners.get(sessionId)?.profileId;
  }

  /**
   * Drop everything recorded for these accounts.
   *
   * Called when a profile is deleted. A stale entry is not harmful on its own —
   * nothing resolves these ids back into accounts except by matching against
   * profiles that exist — but leaving them means a config directory reused for
   * a *new* profile could inherit the old one's claims, and an id is recycled
   * by exactly nothing except a user who pasted one.
   */
  async forget(profileIds: readonly ProfileId[]): Promise<void> {
    if (profileIds.length === 0) return;
    const drop = new Set<ProfileId>(profileIds);
    const owners = await this.#load();

    let removed = 0;
    for (const [sessionId, owned] of owners) {
      if (!drop.has(owned.profileId)) continue;
      owners.delete(sessionId);
      removed += 1;
    }
    if (removed === 0) return;

    this.#dirty = true;
    await this.#commit();
  }

  /**
   * Settle every claim made so far, and the write it schedules.
   *
   * For shutdown, and for tests. Claims are drained before the write chain and
   * in a loop, because a claim resolving can leave another behind it: each one
   * awaits a load and then a write, and both are points at which a later
   * {@link record} can arrive. Awaiting `#writing` alone would be the bug this
   * loop exists to rule out — see {@link #inFlight}.
   *
   * Terminates because nothing here starts a claim; only {@link record} does,
   * and callers of `flush` have stopped.
   */
  async flush(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight]);
    }
    await this.#writing;
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                */
  /* ------------------------------------------------------------------------ */

  async #claim(sessionId: SessionId, profileId: ProfileId): Promise<void> {
    try {
      const owners = await this.#load();
      const existing = owners.get(sessionId);
      owners.set(sessionId, { profileId, seenAt: this.#now() });

      // Nothing new to say. The timestamp moved, which keeps a live
      // conversation clear of the pruning line, but that is not worth a write
      // per turn — the next real change carries it.
      if (existing?.profileId === profileId) return;

      this.#prune(owners);
      this.#dirty = true;
      await this.#commit();
    } catch (error) {
      this.#onError?.(error, { stage: 'record' });
    }
  }

  /** Read the document once. A failure yields an empty ledger, not a throw. */
  async #load(): Promise<Map<SessionId, Owned>> {
    const loaded = this.#owners;
    if (loaded !== null) return loaded;
    this.#loading ??= this.#read();
    const owners = await this.#loading;
    this.#loading = null;
    return owners;
  }

  async #read(): Promise<Map<SessionId, Owned>> {
    const owners = new Map<SessionId, Owned>();
    try {
      const text = await readFile(this.#file, 'utf8');
      const raw: unknown = JSON.parse(text);
      if (isRecord(raw)) {
        const sessions = raw['sessions'];
        if (isRecord(sessions)) {
          for (const [sessionId, value] of Object.entries(sessions)) {
            const owned = parseOwned(value);
            // A hand-edited or half-written entry is skipped rather than
            // failing the read: one bad line must not cost every other label.
            if (owned !== null) owners.set(sessionId as SessionId, owned);
          }
        }
      }
    } catch (error) {
      // A file that is not there is the ordinary first-run state and not worth
      // reporting; anything else is.
      if (!isMissingFile(error)) this.#onError?.(error, { stage: 'read' });
    }
    this.#owners = owners;
    return owners;
  }

  /**
   * Persist, serialised behind whatever write is already going.
   *
   * The chain is what makes two concurrent {@link record} calls safe: each
   * awaits the previous one and then writes the *current* map, so the last
   * writer persists every claim rather than the one it happened to make.
   */
  async #commit(): Promise<void> {
    const next = this.#writing.then(async () => {
      if (!this.#dirty) return;
      this.#dirty = false;
      try {
        await this.#write();
      } catch (error) {
        // Re-dirtied, so the next claim retries rather than the ledger silently
        // diverging from memory until restart.
        this.#dirty = true;
        this.#onError?.(error, { stage: 'write' });
      }
    });
    this.#writing = next;
    await next;
  }

  async #write(): Promise<void> {
    const owners = this.#owners ?? new Map<SessionId, Owned>();
    const sessions: Record<string, Owned> = {};
    for (const [sessionId, owned] of owners) sessions[sessionId] = owned;

    const document: PersistedDocument = { version: SESSION_OWNERS_VERSION, sessions };
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const tmp = `${this.#file}.${randomUUID().slice(0, 8)}.tmp`;

    await mkdir(this.#userDataDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tmp, this.#file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  /** Oldest-first, down to the limit. See {@link SESSION_OWNERS_LIMIT}. */
  #prune(owners: Map<SessionId, Owned>): void {
    const overflow = owners.size - SESSION_OWNERS_LIMIT;
    if (overflow <= 0) return;

    const oldest = [...owners.entries()]
      .sort((a, b) => a[1].seenAt - b[1].seenAt)
      .slice(0, overflow);
    for (const [sessionId] of oldest) owners.delete(sessionId);
  }

  /** Drop the oldest entry once a run-keyed map runs past its backstop. */
  #evictOverflow(map: Map<RunId, unknown>): void {
    while (map.size > PENDING_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done === true) return;
      map.delete(oldest.value);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Applying a reading to a listing                                            */
/* -------------------------------------------------------------------------- */

/**
 * Put the recorded account on a summary whose owner an adapter could only pick.
 *
 * The other half of the feature, and pure so that it can be reasoned about on
 * its own: {@link SessionOwners} is the memory, this is what the memory is
 * *for*. Returns the summary unchanged whenever it has nothing to add, which is
 * every ordinary unshared row and every shared row this install has never
 * opened.
 *
 * Three conditions, and each one is a wrong answer avoided:
 *
 *  - **Only where the adapter flagged a pick.** A summary without
 *    `profileIsUnknown` came from a store exactly one profile reaches, and its
 *    `profileId` is a fact from the filesystem. A ledger entry disagreeing with
 *    that is the ledger being stale, not the directory being wrong.
 *  - **Only where something was recorded.** An unrecorded session keeps the
 *    flag, and the sidebar shows no account. Guessing is what this exists to
 *    stop.
 *  - **Only among the profiles that reach this store.** A recorded account
 *    whose config directory no longer shares the store cannot be the answer for
 *    a row read out of it — the profile was re-pointed or un-shared since — and
 *    naming it would aim a resume at a directory the transcript is not in.
 */
export function attributeSession(
  summary: SessionSummary,
  recorded: ReadonlyMap<SessionId, ProfileId>,
): SessionSummary {
  if (summary.profileIsUnknown !== true) return summary;

  const owner = recorded.get(summary.id);
  if (owner === undefined) return summary;

  const sharers = [summary.profileId, ...(summary.alsoInProfiles ?? [])];
  if (!sharers.includes(owner)) return summary;

  // Destructured out rather than set false: absent is what "this is a fact"
  // looks like on this field. See `SessionSummary.profileIsUnknown`.
  const { profileIsUnknown, alsoInProfiles, ...rest } = summary;
  const others = sharers.filter((profileId) => profileId !== owner);
  return {
    ...rest,
    profileId: owner,
    ...(others.length === 0 ? {} : { alsoInProfiles: others }),
  };
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOwned(value: unknown): Owned | null {
  if (!isRecord(value)) return null;
  const profileId = value['profileId'];
  if (typeof profileId !== 'string' || profileId.length === 0) return null;
  const seenAt = value['seenAt'];
  return {
    profileId: profileId as ProfileId,
    // A missing or nonsensical timestamp becomes the epoch rather than the
    // read failing: it only orders pruning, and "prune this first" is the
    // right answer for a record nobody can date.
    seenAt: typeof seenAt === 'number' && Number.isFinite(seenAt) ? seenAt : 0,
  };
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}
