/**
 * Naming a session after the first thing said in it.
 *
 * A conversation is identifiable from its opening message and almost nothing
 * else, and the sidebar has always shown something worse: the provider's own
 * summary, which arrives late and only sometimes, or the raw first prompt,
 * which is a paragraph sliced at the pane's edge. So the moment a new session
 * exists, Artemis asks the smallest model the account has for a name and writes
 * it into the provider's own store, where every listing already reads it from.
 *
 * ## Where this sits
 *
 * Beside {@link RunRegistry}, not inside it. The registry has three jobs —
 * start runs, fan out events, guarantee termination — and every one of them is
 * on the path of a user waiting for output. Naming is on nobody's path: it is a
 * side effect of a run that must never delay one, never fail one, and never
 * touch its event stream. Keeping it a separate subscriber is what makes that
 * structural rather than careful.
 *
 * The host wires it in three lines:
 *
 * ```ts
 * const namer = new SessionNamer({ resolveAdapter, plan })
 * runs.subscribe((event) => namer.handleEvent(event))
 * const handle = await runs.start(input); namer.noteRun(input, handle.runId)
 * ```
 *
 * ## What it costs, and why that shape
 *
 * One completion on the cheapest model in the profile's catalogue, capped at a
 * few hundred input tokens and a handful of output tokens, once per new
 * conversation. Not per run — a run is one turn, and a ten-turn conversation is
 * ten runs. {@link SessionNamer.noteRun} ignores everything with a
 * `resumeSessionId`, which is precisely "not the first message", and every
 * session is named at most once for the life of the process.
 */

import type { AgentEvent, ProfileId, ProviderId, RunId, RunInput, SessionId } from '@rx-artemis/protocol';

import type { EnvBundle, ProviderAdapter } from '../adapters/types.js';

/**
 * How the namer finds the adapter for a provider.
 *
 * The same seam {@link RunRegistryOptions.resolveAdapter} draws, and a plain
 * function for the same reason: a test supplies `() => fakeAdapter` and the two
 * modules stay decoupled.
 */
export type AdapterLookup = (
  providerId: ProviderId,
) => ProviderAdapter | undefined | Promise<ProviderAdapter | undefined>;

/** Everything the host had to resolve before a session could be named. */
export interface SessionNamingPlan {
  /**
   * Which model to name with, as the provider spells it.
   *
   * Chosen by the host from the profile's catalogue with `lowestTierModel`, not
   * by the adapter and not from the run. Naming a session with the model the
   * user picked for real work would bill a frontier model for six words.
   */
  readonly model: string;
  /**
   * Credential-bearing environment, as a run gets. The naming call contacts the
   * model, so it needs the account.
   */
  readonly env: EnvBundle;
  /**
   * Store-only environment, as a listing gets: the config directory and no
   * credential. Writing a title touches a file, not an account.
   */
  readonly storeEnv: EnvBundle;
  /** See `ResolvedRunInput.inheritHostEnv`. */
  readonly inheritHostEnv?: boolean;
}

/**
 * Resolve what naming this run would take, or `null` for "do not".
 *
 * `null` is a first-class answer and the common one on a machine that cannot
 * do this: no profile, no catalogue, or a catalogue in which nothing declares a
 * {@link import('@rx-artemis/protocol').ProviderModelOption.tier}. Returning it
 * costs nothing and leaves the session named the way it always was.
 */
export type SessionNamingResolver = (context: {
  readonly profileId: ProfileId;
  readonly providerId: ProviderId;
  readonly cwd: string;
}) => Promise<SessionNamingPlan | null> | SessionNamingPlan | null;

/** Reports failures the namer handled rather than propagated. */
export type SessionNamingErrorReporter = (
  error: unknown,
  context: { readonly runId: RunId; readonly sessionId?: SessionId },
) => void;

/** Construction options for {@link SessionNamer}. */
export interface SessionNamerOptions {
  readonly resolveAdapter: AdapterLookup;
  /** Profile → the model and environments a naming call needs. */
  readonly plan: SessionNamingResolver;
  /**
   * Called for anything that went wrong. Defaults to doing nothing, which is a
   * defensible default *here* specifically: every failure this swallows costs
   * the user a nicer label and nothing else.
   */
  readonly onError?: SessionNamingErrorReporter;
  /**
   * How long to wait before retrying a failed rename, in ms. Defaults to 1000.
   *
   * There is exactly one retry, and it exists for one race: the title is ready
   * within a second or two of `session.started`, and a provider that has not
   * finished writing the new session's file yet has nothing for the rename to
   * find. Waiting a beat and asking again fixes it; a third attempt would be
   * papering over a real failure. `0` retries immediately, for tests.
   */
  readonly renameRetryMs?: number;
}

/** What the namer remembers about a run until its session appears. */
interface PendingRun {
  readonly prompt: string;
  readonly profileId: ProfileId;
  readonly providerId: ProviderId;
  readonly cwd: string;
}

const DEFAULT_RENAME_RETRY_MS = 1_000;

/**
 * How many un-started runs to remember at once.
 *
 * A ceiling on a leak that should never happen: an entry is dropped when its
 * session appears or its run ends, and both are contractual. A run whose
 * adapter emitted neither would otherwise sit here for the life of the process.
 */
const MAX_PENDING = 64;

/**
 * Names new sessions from their opening message.
 *
 * One per application, wired to the run registry's event feed. Every method is
 * safe to call at any time, including after {@link dispose}.
 */
export class SessionNamer {
  readonly #resolveAdapter: AdapterLookup;
  readonly #plan: SessionNamingResolver;
  readonly #onError: SessionNamingErrorReporter | undefined;
  readonly #renameRetryMs: number;

  /** Runs whose opening message is known but whose session has not appeared. */
  readonly #pending = new Map<RunId, PendingRun>();
  /**
   * Sessions seen before their run was registered.
   *
   * The race is real and narrow: `RunRegistry.start()` begins pumping events
   * the moment the adapter returns, and the host cannot call
   * {@link noteRun} until that same call resolves. An adapter that emits
   * `session.started` immediately can therefore beat the registration. Holding
   * the id here closes the window from the other side.
   */
  readonly #earlySessions = new Map<RunId, SessionId>();
  /** Runs already named, or being named. Naming happens once. */
  readonly #handled = new Set<RunId>();
  /** In-flight naming work, so {@link dispose} can wait for it. */
  readonly #inFlight = new Set<Promise<void>>();

  readonly #abort = new AbortController();
  #closed = false;

  constructor(options: SessionNamerOptions) {
    this.#resolveAdapter = options.resolveAdapter;
    this.#plan = options.plan;
    this.#onError = options.onError;
    this.#renameRetryMs = Math.max(0, options.renameRetryMs ?? DEFAULT_RENAME_RETRY_MS);
  }

  /**
   * Record a run that has just started, so its session can be named.
   *
   * Call it for every run; the filtering is here rather than at the call site,
   * so the rule for what gets named lives in one place:
   *
   *  - **A resumed run is not a first message.** `resumeSessionId` means the
   *    conversation already exists and already has whatever name it has — very
   *    possibly one the user typed, which this must never overwrite.
   *  - **A fork is not either.** It carries its origin's transcript and, in
   *    Claude's case, a title derived from its origin's. Naming it from the
   *    prompt that forked it would describe the branch and not the work.
   *  - **An empty prompt names nothing.**
   *
   * @param runId The registry's id for the run — `RunInput.runId` may be absent.
   */
  noteRun(input: RunInput, runId: RunId): void {
    if (this.#closed) return;
    if (input.resumeSessionId !== undefined) return;
    if (this.#handled.has(runId)) return;

    const prompt = input.prompt.trim();
    if (prompt.length === 0) return;

    const record: PendingRun = {
      prompt,
      profileId: input.profileId,
      providerId: input.providerId,
      cwd: input.cwd,
    };

    // The session may already have arrived — see `#earlySessions`.
    const early = this.#earlySessions.get(runId);
    if (early !== undefined) {
      this.#earlySessions.delete(runId);
      this.#start(runId, early, record);
      return;
    }

    this.#pending.set(runId, record);
    this.#evictOverflow();
  }

  /**
   * Feed the run registry's event stream in.
   *
   * Only two event types matter, and neither is consumed: this is a subscriber
   * among others and must not change what anyone else sees.
   */
  handleEvent(event: AgentEvent): void {
    if (this.#closed) return;

    if (event.type === 'session.started') {
      const record = this.#pending.get(event.runId);
      if (record === undefined) {
        // Either a resumed run (never registered, nothing to do) or the race in
        // `#earlySessions`. Remembering it is cheap and `noteRun` decides.
        if (!this.#handled.has(event.runId)) {
          this.#earlySessions.set(event.runId, event.sessionId);
          this.#evictOverflow();
        }
        return;
      }
      this.#pending.delete(event.runId);
      this.#start(event.runId, event.sessionId, record);
      return;
    }

    if (event.type === 'run.end') {
      // A run that ended without ever reporting a session has nothing to name.
      this.#pending.delete(event.runId);
      this.#earlySessions.delete(event.runId);
    }
  }

  /**
   * Stop naming and wait for whatever is in flight.
   *
   * Called on shutdown, alongside `RunRegistry.disposeAll()`. Aborting rather
   * than waiting it out is deliberate: the app is closing, and a title is not
   * worth holding a subprocess open for. Never rejects.
   */
  async dispose(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    this.#pending.clear();
    this.#earlySessions.clear();
    await Promise.allSettled([...this.#inFlight]);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Kick naming off without waiting for it.
   *
   * Nothing above this awaits the result — that is the point. The work is
   * tracked in {@link #inFlight} only so {@link dispose} can drain it.
   */
  #start(runId: RunId, sessionId: SessionId, record: PendingRun): void {
    this.#handled.add(runId);
    const work = this.#name(runId, sessionId, record).catch((error: unknown) => {
      this.#report(error, runId, sessionId);
    });
    this.#inFlight.add(work);
    void work.finally(() => {
      this.#inFlight.delete(work);
    });
  }

  async #name(runId: RunId, sessionId: SessionId, record: PendingRun): Promise<void> {
    const adapter = await this.#resolveAdapter(record.providerId);
    // Both halves or neither: a title with nowhere to store it is a call that
    // spends the user's account for nothing. See the Codex adapter, which has
    // one half and therefore ships neither.
    if (adapter?.suggestSessionTitle === undefined || adapter.setSessionTitle === undefined) return;

    const plan = await this.#plan({
      profileId: record.profileId,
      providerId: record.providerId,
      cwd: record.cwd,
    });
    if (plan === null) return;
    if (this.#abort.signal.aborted) return;

    const title = await adapter.suggestSessionTitle({
      prompt: record.prompt,
      model: plan.model,
      env: plan.env,
      cwd: record.cwd,
      ...(plan.inheritHostEnv === undefined ? {} : { inheritHostEnv: plan.inheritHostEnv }),
      abortSignal: this.#abort.signal,
    });
    // Contractually already cleaned, and `null` means "no name" rather than a
    // failure — the session keeps the label it would have had.
    if (title === null || title.length === 0) return;
    if (this.#abort.signal.aborted) return;

    const update = {
      sessionId,
      title,
      cwd: record.cwd,
      env: plan.storeEnv,
    };

    try {
      await adapter.setSessionTitle(update);
    } catch (error) {
      // One retry, for the write that arrived before the provider had finished
      // creating the session file. See `renameRetryMs`.
      if (this.#abort.signal.aborted) throw error;
      await delay(this.#renameRetryMs, this.#abort.signal);
      if (this.#abort.signal.aborted) throw error;
      await adapter.setSessionTitle(update);
    }
  }

  /** Keep the bookkeeping maps from growing without bound. */
  #evictOverflow(): void {
    for (const map of [this.#pending, this.#earlySessions] as const) {
      while (map.size > MAX_PENDING) {
        const oldest = map.keys().next();
        if (oldest.done === true) break;
        map.delete(oldest.value);
      }
    }
  }

  #report(error: unknown, runId: RunId, sessionId: SessionId): void {
    if (!this.#onError) return;
    try {
      this.#onError(error, { runId, sessionId });
    } catch {
      // A reporter that throws is not worth a second exception.
    }
  }
}

/** Sleep, waking early if `signal` aborts. Never rejects. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // Never hold the process open for a retry.
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}
