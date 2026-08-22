/**
 * Routines — the app keeps its own appointments.
 * ============================================================================
 *
 * The host that owns `routines.json`, the minute scheduler, and the history of
 * what fired. Modelled on `server.ts`, its next-door neighbour: same data
 * directory, same atomic write, same tolerant reader, same broadcast-on-change
 * contract with the renderer.
 *
 * ## A firing is an ordinary run
 *
 * Each due minute starts a fresh run through the ordinary engine —
 * `engine.startRun` with the routine's prompt, directory, profile and model —
 * so a routine's work gets everything a typed turn gets for free: a real
 * transcript, session history, the prompt library, ownership attribution. The
 * one difference is a `routineId` stamped into `RunInput.metadata`, which is
 * how firings are found again: the overlap guard reads it off `listRuns`, and
 * the history ledger records what each one became.
 *
 * ## The scheduler runs with no window open
 *
 * Unlike `planUsagePoll`, which skips cycles when nobody is looking, this is
 * the first main-process timer that does real work unwatched — that is the
 * point of a schedule. On macOS the app outlives its windows, and a routine
 * due at 09:00 fires at 09:00 whether or not a window exists to watch it.
 *
 * ## Sleep, and the one catch-up
 *
 * Timers do not fire while the machine sleeps; they fire late, on wake. The
 * tick notices the gap (a minute tick that arrives minutes late is a machine
 * that was asleep, not a timer that drifted) and runs the catch-up rule: for
 * each routine, the *newest* appointment missed during the gap — within seven
 * days — fires once, and older misses are let go. A laptop opened Monday does
 * not replay the weekend.
 *
 * ## Deliberately not Electron-aware
 *
 * Notifications and power events arrive through injected options rather than
 * `electron` imports, for the same reason `server.ts` has none: this file is
 * exercised by vitest in a plain Node environment, and the desktop wiring in
 * `index.ts` is one line per hook.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  AgentEvent,
  ProviderId,
  Routine,
  RoutineDraft,
  RoutineId,
  RoutinePatch,
  RoutineRunRecord,
  RoutineSchedule,
  RoutineSkipReason,
  RoutinesState,
  RoutineSnapshot,
  RunEndReason,
  RunId,
} from '@rx-artemis/protocol';
import {
  isProviderId,
  lastFireBetween,
  MAX_ROUTINE_HISTORY,
  nextFireAt,
  scheduleMatchesMinute,
  scheduleProblem,
} from '@rx-artemis/protocol';

import type { EngineHost } from './engine.js';
import { createLogger } from './log.js';

const log = createLogger('routines');

/** Beside `server.json` and `profiles.json`, and named the way they are. */
export const ROUTINES_CONFIG_FILE = 'routines.json';

/**
 * A tick that lands this much later than the minute it was aimed at is a
 * machine that was asleep (or a process that was suspended), and the catch-up
 * pass runs. Comfortably above worst-case event-loop lag, far below the
 * shortest schedulable interval.
 */
const SLEEP_GAP_MS = 90_000;

export interface RoutineHostOptions {
  readonly engine: EngineHost;
  /** Artemis's data directory — where {@link ROUTINES_CONFIG_FILE} lives. */
  readonly userDataDir: string;
  /** Push a new state to every window. */
  readonly broadcast: (state: RoutinesState) => void;
  /**
   * Show a desktop notification. Injected because this module must stay
   * runnable outside Electron; absent means firings finish silently.
   */
  readonly notify?: (title: string, body: string) => void;
}

export interface RoutineHost {
  /**
   * Read the file, settle anything the last quit left dangling, subscribe to
   * the engine, and start the minute tick. Never throws — a routines file
   * that cannot be read is an empty list, not a failed boot.
   */
  start(): Promise<void>;
  /** The state right now. Cheap; built from memory. */
  state(): RoutinesState;
  create(draft: RoutineDraft): Promise<RoutinesState>;
  update(id: RoutineId, patch: RoutinePatch): Promise<RoutinesState>;
  remove(id: RoutineId): Promise<RoutinesState>;
  /**
   * Fire one routine right now, schedule and pause notwithstanding — the
   * button beside every row. Still overlap-guarded: "run it again" while it
   * is running records a skip rather than stacking a second copy.
   */
  runNow(id: RoutineId): Promise<RoutinesState>;
  /** Stop the tick and the subscription, for app shutdown. */
  dispose(): Promise<void>;
}

export function createRoutineHost(options: RoutineHostOptions): RoutineHost {
  const configPath = join(options.userDataDir, ROUTINES_CONFIG_FILE);

  let routines: readonly Routine[] = [];
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The minute boundary the pending timer is aimed at. */
  let aimedAt = 0;
  /** Runs this host started and is still watching, run id → routine id. */
  const liveRuns = new Map<string, RoutineId>();
  let unsubscribe: (() => void) | undefined;

  /* ----------------------------------------------------------------------- */
  /* Snapshot and publish                                                    */
  /* ----------------------------------------------------------------------- */

  function snapshot(now = Date.now()): RoutinesState {
    const running = new Set(liveRuns.values());
    return {
      routines: routines.map((routine): RoutineSnapshot => {
        const next = routine.paused ? undefined : nextFireAt(routine.schedule, now);
        return {
          ...routine,
          ...(next === undefined ? {} : { nextFireAt: next }),
          running: running.has(routine.id),
        };
      }),
    };
  }

  /** Publish, and answer with what was published. */
  function publish(): RoutinesState {
    const state = snapshot();
    options.broadcast(state);
    return state;
  }

  /* ----------------------------------------------------------------------- */
  /* Persistence                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Writes are chained, never concurrent: two overlapping writers would race
   * each other's temp file, and the loser's snapshot — not necessarily the
   * older one — would win the rename. The tick calls this un-awaited, so the
   * chain is also what keeps a slow disk from stalling the schedule.
   */
  let persisting: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    persisting = persisting.then(async () => {
      const temp = `${configPath}.tmp`;
      try {
        await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
        // Owner-only, like its neighbours: instructions are the user's own
        // words, and words written for an agent are not for other accounts.
        await writeFile(temp, `${JSON.stringify({ routines }, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temp, configPath);
      } catch (error) {
        // Logged, not thrown — losing an edit across a restart is a nuisance;
        // failing the click that made it is worse.
        log.error('Could not persist the routines', error);
      }
    });
    return persisting;
  }

  async function load(): Promise<void> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      // Absent on first run; unreadable is recoverable. An empty list is a
      // working configuration.
      stored = null;
    }
    const record =
      typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    routines = readRoutines(record['routines']).map(settleDeadRuns);
  }

  /**
   * A `running` row found on disk is a run the app quit under. It is settled
   * as `interrupted` — which is what happened to it — so the history never
   * shows a spinner nothing can clear. The same rule the transcript's
   * `tool.end` contract states, one layer up.
   */
  function settleDeadRuns(routine: Routine): Routine {
    if (!routine.history.some((row) => row.outcome === 'running')) return routine;
    return {
      ...routine,
      history: routine.history.map((row) =>
        row.outcome === 'running' ? { ...row, outcome: 'interrupted' as const } : row,
      ),
    };
  }

  /* ----------------------------------------------------------------------- */
  /* History                                                                 */
  /* ----------------------------------------------------------------------- */

  function amendRoutine(id: RoutineId, change: (routine: Routine) => Routine): void {
    routines = routines.map((routine) => (routine.id === id ? change(routine) : routine));
  }

  function recordFiring(id: RoutineId, row: RoutineRunRecord): void {
    amendRoutine(id, (routine) => ({
      ...routine,
      lastFiredAt: row.firedAt,
      history: [row, ...routine.history].slice(0, MAX_ROUTINE_HISTORY),
    }));
  }

  function amendHistory(
    id: RoutineId,
    runId: string,
    change: (row: RoutineRunRecord) => RoutineRunRecord,
  ): void {
    amendRoutine(id, (routine) => ({
      ...routine,
      history: routine.history.map((row) => (row.runId === runId ? change(row) : row)),
    }));
  }

  /* ----------------------------------------------------------------------- */
  /* Watching the runs                                                       */
  /* ----------------------------------------------------------------------- */

  /** The transcript's seven reasons, folded to the ledger's three verdicts. */
  function outcomeFor(reason: RunEndReason): 'completed' | 'error' | 'interrupted' {
    if (reason === 'completed') return 'completed';
    if (reason === 'interrupted' || reason === 'disposed') return 'interrupted';
    return 'error';
  }

  function onAgentEvent(event: AgentEvent): void {
    const routineId = liveRuns.get(String(event.runId));
    if (routineId === undefined) return;

    // Any event may carry the session id, and adapters differ on which does —
    // the same every-event harvest `server.ts` performs, for the same reason.
    const sessionId = (event as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') {
      amendHistory(routineId, String(event.runId), (row) =>
        row.sessionId === sessionId ? row : { ...row, sessionId },
      );
    }

    if (event.type !== 'run.end') return;
    liveRuns.delete(String(event.runId));

    const outcome = outcomeFor(event.reason);
    amendHistory(routineId, String(event.runId), (row) => ({
      ...row,
      outcome,
      ...(event.reason === 'completed' ? {} : { endReason: event.reason }),
    }));
    void persist();
    publish();

    const routine = routines.find((entry) => entry.id === routineId);
    if (routine !== undefined && options.notify !== undefined) {
      const verdict =
        outcome === 'completed'
          ? 'finished'
          : outcome === 'interrupted'
            ? 'was interrupted'
            : 'failed';
      options.notify(routine.name, `The routine ${verdict}.`);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Firing                                                                  */
  /* ----------------------------------------------------------------------- */

  /** Is a run for this routine still going? Asked of memory, not the engine:
   * `liveRuns` is written before any await, so the guard cannot race a firing
   * this host started — and no one else starts routine runs. */
  function isRunning(id: RoutineId): boolean {
    return [...liveRuns.values()].includes(id);
  }

  function recordSkip(id: RoutineId, firedAt: number, reason: RoutineSkipReason): void {
    recordFiring(id, { firedAt, outcome: 'skipped', skipReason: reason });
  }

  async function fire(routine: Routine, firedAt: number, catchUp: boolean): Promise<void> {
    if (isRunning(routine.id)) {
      recordSkip(routine.id, firedAt, 'overlap');
      return;
    }
    if (!options.engine.ready) {
      recordSkip(routine.id, firedAt, 'engine-unavailable');
      return;
    }

    // Minted here rather than left to the engine so the ledger row and the
    // live-run map exist *before* the first event can arrive.
    const runId = `routine-${routine.id}-${String(firedAt)}` as RunId;
    liveRuns.set(String(runId), routine.id);
    recordFiring(routine.id, {
      firedAt,
      runId: String(runId),
      outcome: 'running',
      ...(catchUp ? { catchUp: true } : {}),
    });

    try {
      await options.engine.require().startRun({
        providerId: routine.providerId,
        profileId: routine.profileId,
        cwd: routine.cwd,
        prompt: routine.instructions,
        runId,
        ...(routine.model === undefined ? {} : { model: routine.model }),
        metadata: { routineId: routine.id, firedAt, ...(catchUp ? { catchUp: true } : {}) },
      });
    } catch (error) {
      // The run never started, so no `run.end` will settle the row.
      liveRuns.delete(String(runId));
      amendHistory(routine.id, String(runId), (row) => ({
        ...row,
        outcome: 'error',
        endReason: 'error',
      }));
      log.error(`Could not start routine ${routine.id}`, error);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The tick                                                                */
  /* ----------------------------------------------------------------------- */

  function nextBoundary(from: number): number {
    return Math.floor(from / 60_000) * 60_000 + 60_000;
  }

  function schedule(): void {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    const now = Date.now();
    aimedAt = nextBoundary(now);
    // A moment past the boundary, so the tick's own date is inside the minute
    // it is deciding about rather than on its edge.
    timer = setTimeout(() => void tick(), aimedAt - now + 250);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const now = Date.now();

    const minute = new Date(nextBoundary(now) - 60_000);

    /*
     * Woke up late: the machine slept through one or more boundaries. Every
     * missed minute is gone — run the catch-up rule over everything *before*
     * the minute we landed in, then fall through to the ordinary check for
     * that minute itself.
     */
    if (now - aimedAt >= SLEEP_GAP_MS) {
      await catchUp(minute);
    }
    let acted = false;
    // Id order — the same order every tick, so when several routines share a
    // minute they always fire in the same sequence.
    for (const routine of [...routines].sort((a, b) => a.id.localeCompare(b.id))) {
      if (routine.paused) continue;
      if (!scheduleMatchesMinute(routine.schedule, minute)) continue;
      await fire(routine, now, false);
      acted = true;
    }

    if (acted) {
      void persist();
      publish();
    }
    schedule();
  }

  /**
   * The one make-up firing per routine after a sleep or a relaunch: the
   * newest appointment missed since the routine last acted — bounded by the
   * seven-day window inside `lastFireBetween` — fired once, with the rest
   * let go.
   *
   * `currentMinute` is where the ordinary tick takes over: appointments in
   * that minute and later are its business, so the search stops just short of
   * it, and a routine whose schedule names the current minute is skipped here
   * entirely — the fresh firing about to happen *is* its catch-up, and a
   * make-up fired seconds before it would only collide with it.
   */
  async function catchUp(currentMinute: Date): Promise<void> {
    const before = currentMinute.getTime() - 1;
    let acted = false;
    for (const routine of [...routines].sort((a, b) => a.id.localeCompare(b.id))) {
      if (routine.paused) continue;
      if (scheduleMatchesMinute(routine.schedule, currentMinute)) continue;
      const baseline = routine.lastFiredAt ?? routine.createdAt;
      const missed = lastFireBetween(routine.schedule, baseline, before);
      if (missed === undefined) continue;
      await fire(routine, Date.now(), true);
      acted = true;
    }
    if (acted) {
      void persist();
      publish();
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The host                                                                */
  /* ----------------------------------------------------------------------- */

  return {
    async start() {
      if (started) return;
      started = true;
      await load();
      unsubscribe = options.engine.ready
        ? options.engine.require().subscribe(onAgentEvent)
        : undefined;
      /*
       * A boot is a wake: the app may have been closed over any number of
       * appointments. `lastFiredAt` bounds the search, so this fires at most
       * one make-up per routine — and nothing at all on an ordinary same-day
       * relaunch whose appointments were all kept.
       *
       * The horizon is the *next* boundary, not the current minute: the first
       * tick fires a minute from now, so an appointment in the minute the app
       * happened to launch in belongs to this pass or to nobody.
       */
      await catchUp(new Date(nextBoundary(Date.now())));
      publish();
      schedule();
    },

    state() {
      return snapshot();
    },

    async create(draft) {
      const routine = readRoutine({
        ...draft,
        id: randomBytes(8).toString('base64url'),
        paused: draft.paused === true,
        createdAt: Date.now(),
        history: [],
      });
      if (routine === undefined) {
        throw new Error('The routine draft is not usable.');
      }
      routines = [...routines, routine];
      await persist();
      return publish();
    },

    async update(id, patch) {
      amendRoutine(id, (routine) => {
        const merged = readRoutine({
          ...routine,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
          ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
          ...(patch.profileId === undefined ? {} : { profileId: patch.profileId }),
          ...(patch.providerId === undefined ? {} : { providerId: patch.providerId }),
          // The empty string clears, the same convention `ProfilePatch` uses.
          ...(patch.model === undefined
            ? {}
            : patch.model === ''
              ? { model: undefined }
              : { model: patch.model }),
          ...(patch.schedule === undefined ? {} : { schedule: patch.schedule }),
          ...(patch.paused === undefined ? {} : { paused: patch.paused }),
        });
        return merged ?? routine;
      });
      await persist();
      return publish();
    },

    async remove(id) {
      routines = routines.filter((routine) => routine.id !== id);
      await persist();
      return publish();
    },

    async runNow(id) {
      const routine = routines.find((entry) => entry.id === id);
      if (routine !== undefined) {
        await fire(routine, Date.now(), false);
        await persist();
      }
      return publish();
    },

    async dispose() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      // Flush the write chain: the tick persists un-awaited, and quitting
      // between the rename and the write would hand the next launch a ledger
      // missing the very firing the user just watched happen.
      await persisting;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the file                                                           */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Validate-and-rebuild one schedule. Shared with `validate.ts`, whose inputs
 * arrive over IPC and get exactly the treatment the file on disk gets. */
export function readSchedule(value: unknown): RoutineSchedule | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];

  let schedule: RoutineSchedule | undefined;
  if (kind === 'manual') schedule = { kind: 'manual' };
  else if (kind === 'hourly' && typeof record['minute'] === 'number') {
    schedule = { kind: 'hourly', minute: record['minute'] };
  } else if ((kind === 'daily' || kind === 'weekdays') && typeof record['at'] === 'string') {
    schedule = { kind, at: record['at'] };
  } else if (
    kind === 'weekly' &&
    typeof record['day'] === 'number' &&
    typeof record['at'] === 'string'
  ) {
    schedule = { kind: 'weekly', day: record['day'], at: record['at'] };
  } else if (kind === 'cron' && typeof record['expression'] === 'string') {
    schedule = { kind: 'cron', expression: record['expression'] };
  }

  if (schedule === undefined || scheduleProblem(schedule) !== null) return undefined;
  return schedule;
}

const OUTCOMES = new Set(['running', 'completed', 'error', 'interrupted', 'skipped']);
const SKIP_REASONS = new Set(['overlap', 'paused', 'engine-unavailable']);

function readHistory(value: unknown): readonly RoutineRunRecord[] {
  if (!Array.isArray(value)) return [];
  const rows: RoutineRunRecord[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const firedAt = record['firedAt'];
    const outcome = record['outcome'];
    if (typeof firedAt !== 'number' || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
      continue;
    }
    const skipReason = record['skipReason'];
    rows.push({
      firedAt,
      outcome: outcome as RoutineRunRecord['outcome'],
      ...(asString(record['runId']) === undefined ? {} : { runId: asString(record['runId']) }),
      ...(asString(record['sessionId']) === undefined
        ? {}
        : { sessionId: asString(record['sessionId']) }),
      ...(typeof skipReason === 'string' && SKIP_REASONS.has(skipReason)
        ? { skipReason: skipReason as RoutineSkipReason }
        : {}),
      ...(asString(record['endReason']) === undefined
        ? {}
        : { endReason: asString(record['endReason']) }),
      ...(record['catchUp'] === true ? { catchUp: true } : {}),
    });
    if (rows.length >= MAX_ROUTINE_HISTORY) break;
  }
  return rows;
}

/**
 * Validate-and-rebuild one routine. A row that cannot be read is dropped
 * rather than repaired — the same rule `server.ts` applies to connections,
 * because a repaired guess about *whose account bills* is worse than a lost
 * row the user recreates.
 */
function readRoutine(value: unknown): Routine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const id = asString(record['id']);
  const name = asString(record['name']);
  const instructions = asString(record['instructions']);
  const cwd = asString(record['cwd']);
  const profileId = asString(record['profileId']);
  const providerId = record['providerId'];
  const schedule = readSchedule(record['schedule']);
  const createdAt = record['createdAt'];

  if (
    id === undefined ||
    name === undefined ||
    instructions === undefined ||
    cwd === undefined ||
    !isAbsolute(cwd) ||
    profileId === undefined ||
    !isProviderId(providerId) ||
    schedule === undefined ||
    typeof createdAt !== 'number'
  ) {
    return undefined;
  }

  const lastFiredAt = record['lastFiredAt'];
  return {
    id,
    name,
    instructions,
    cwd,
    profileId,
    providerId: providerId as ProviderId,
    ...(asString(record['model']) === undefined ? {} : { model: asString(record['model']) }),
    schedule,
    paused: record['paused'] === true,
    createdAt,
    ...(typeof lastFiredAt === 'number' ? { lastFiredAt } : {}),
    history: readHistory(record['history']),
  };
}

/** Every readable routine in the stored list. Malformed rows are dropped. */
export function readRoutines(value: unknown): readonly Routine[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Routine[] = [];
  for (const raw of value) {
    const routine = readRoutine(raw);
    if (routine === undefined || seen.has(routine.id)) continue;
    seen.add(routine.id);
    result.push(routine);
  }
  return result;
}
