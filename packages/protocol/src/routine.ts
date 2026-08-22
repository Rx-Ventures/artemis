/**
 * Routines — work the app does on a schedule, without being asked twice.
 * ============================================================================
 *
 * A routine is a saved prompt with an appointment: instructions, a directory,
 * a profile to bill, and a schedule. When the schedule comes due, the main
 * process starts an ordinary run through the ordinary engine — same
 * transcripts, same history, same review surfaces as a turn the user typed —
 * tagged with the routine's id so its firings can be found again.
 *
 * This module is the *vocabulary*: the record, the schedule shapes, and the
 * pure minute-matching math. It deliberately contains no timer and no I/O —
 * the scheduler lives in the main process, and the renderer uses the same
 * functions here to show "next fires at" without asking anyone.
 *
 * ## Time is local, and minutes are the resolution
 *
 * Schedules are written in the machine's local time ("09:00 means my 09:00"),
 * which is what every desktop scheduler people already trust does. The floor
 * is one minute: the scheduler ticks on minute boundaries, and a schedule
 * cannot name anything finer.
 */

import type { ProviderId } from './provider.js';

/** Identifies one routine. A short random slug, minted by the main process. */
export type RoutineId = string;

/* -------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * When a routine fires.
 *
 * The presets cover what people actually schedule; `cron` is the escape hatch
 * for everything else, in the classic five-field dialect (see
 * {@link cronProblem} for the accepted subset). `manual` exists so a routine
 * can be kept — named, configured, run-now-able — without an appointment.
 */
export type RoutineSchedule =
  | { readonly kind: 'manual' }
  | {
      readonly kind: 'hourly';
      /** Minute of each hour, 0–59. */
      readonly minute: number;
    }
  | {
      readonly kind: 'daily';
      /** Local time of day, `"HH:MM"`. */
      readonly at: string;
    }
  | {
      readonly kind: 'weekdays';
      /** Local time of day, `"HH:MM"`, Monday through Friday. */
      readonly at: string;
    }
  | {
      readonly kind: 'weekly';
      /** Day of week, 0 = Sunday … 6 = Saturday — `Date.getDay`'s numbering. */
      readonly day: number;
      /** Local time of day, `"HH:MM"`. */
      readonly at: string;
    }
  | {
      readonly kind: 'cron';
      /** Five fields: minute, hour, day-of-month, month, day-of-week. */
      readonly expression: string;
    };

/* -------------------------------------------------------------------------- */
/* The record                                                                 */
/* -------------------------------------------------------------------------- */

/** Why a due firing was skipped instead of started. */
export type RoutineSkipReason = 'overlap' | 'paused' | 'engine-unavailable';

/**
 * How one firing went.
 *
 * `running` is a live row, not a verdict — it is rewritten when the run ends.
 * A `running` row found on disk at load is a run the app died under, and the
 * loader settles it as `interrupted`, because that is what happened to it.
 */
export type RoutineOutcome = 'running' | 'completed' | 'error' | 'interrupted' | 'skipped';

/** One firing, kept so "did last night's run work" has an answer. */
export interface RoutineRunRecord {
  /** When the scheduler acted, ms since epoch. */
  readonly firedAt: number;
  /** The run it started. Absent when the firing was skipped. */
  readonly runId?: string;
  /** The conversation it wrote, once the run reported one. */
  readonly sessionId?: string;
  readonly outcome: RoutineOutcome;
  /** Present iff {@link outcome} is `skipped`. */
  readonly skipReason?: RoutineSkipReason;
  /** The run's own end reason, kept verbatim when it adds detail. */
  readonly endReason?: string;
  /** True for the one make-up firing after a sleep. See the scheduler. */
  readonly catchUp?: boolean;
}

/** How many firings each routine remembers. Oldest are dropped. */
export const MAX_ROUTINE_HISTORY = 50;

/**
 * How far back a missed appointment is still worth making up.
 *
 * A laptop that slept through Tuesday 09:00 fires once on wake; one that was
 * in a drawer for a month does not replay September. Seven days, matching the
 * convention Claude Code Desktop set for the same feature.
 */
export const ROUTINE_CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A routine, as stored and as shown. */
export interface Routine {
  readonly id: RoutineId;
  /** Human name, e.g. "Morning triage". */
  readonly name: string;
  /** The prompt each firing sends. */
  readonly instructions: string;
  /** Absolute directory the run starts in. */
  readonly cwd: string;
  /** The account each firing bills. */
  readonly profileId: string;
  readonly providerId: ProviderId;
  /** Model for the run, as the provider spells it. Omit for the default. */
  readonly model?: string;
  readonly schedule: RoutineSchedule;
  /** A paused routine keeps its place in the list and fires nothing. */
  readonly paused: boolean;
  readonly createdAt: number;
  /** When the scheduler last acted on it, skip or fire alike. */
  readonly lastFiredAt?: number;
  /** Newest first. Capped at {@link MAX_ROUTINE_HISTORY}. */
  readonly history: readonly RoutineRunRecord[];
}

/** What creating a routine takes. The main process mints the rest. */
export interface RoutineDraft {
  readonly name: string;
  readonly instructions: string;
  readonly cwd: string;
  readonly profileId: string;
  readonly providerId: ProviderId;
  readonly model?: string;
  readonly schedule: RoutineSchedule;
  /** Defaults to false. */
  readonly paused?: boolean;
}

/**
 * A partial edit. Absent fields are left alone; `model: ''` clears the model,
 * the same convention `ProfilePatch` uses for its optionals.
 */
export interface RoutinePatch {
  readonly name?: string;
  readonly instructions?: string;
  readonly cwd?: string;
  readonly profileId?: string;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly schedule?: RoutineSchedule;
  readonly paused?: boolean;
}

/** A routine as the renderer sees it: the record plus what only main knows. */
export interface RoutineSnapshot extends Routine {
  /** The next appointment, ms since epoch. Absent for manual and paused. */
  readonly nextFireAt?: number;
  /** True while a firing's run is still going. */
  readonly running: boolean;
}

/** The whole routines surface, pushed to every window on any change. */
export interface RoutinesState {
  readonly routines: readonly RoutineSnapshot[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** `"HH:MM"`, 24-hour. Deliberately strict: a time the parser guessed at is an
 * appointment the user did not make. */
const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Read `"HH:MM"` into numbers, or nothing. */
export function parseTimeOfDay(at: string): { hour: number; minute: number } | undefined {
  const match = TIME_OF_DAY.exec(at.trim());
  if (match === null) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Why a time-of-day string cannot be used, or `null` when it can. */
export function timeOfDayProblem(at: string): string | null {
  return parseTimeOfDay(at) === undefined
    ? 'Times are written as HH:MM, 24-hour — 09:00, 17:30.'
    : null;
}

/** Why a schedule cannot be used, or `null` when it can. */
export function scheduleProblem(schedule: RoutineSchedule): string | null {
  switch (schedule.kind) {
    case 'manual':
      return null;
    case 'hourly':
      return Number.isInteger(schedule.minute) && schedule.minute >= 0 && schedule.minute <= 59
        ? null
        : 'The minute of the hour runs from 0 to 59.';
    case 'daily':
    case 'weekdays':
      return timeOfDayProblem(schedule.at);
    case 'weekly':
      if (!Number.isInteger(schedule.day) || schedule.day < 0 || schedule.day > 6) {
        return 'The day of the week runs from 0 (Sunday) to 6 (Saturday).';
      }
      return timeOfDayProblem(schedule.at);
    case 'cron':
      return cronProblem(schedule.expression);
    default:
      return 'Unknown schedule.';
  }
}

/* -------------------------------------------------------------------------- */
/* Cron, the classic five fields                                              */
/* -------------------------------------------------------------------------- */

/** Field order, with each field's valid range. */
const CRON_FIELDS: readonly { readonly name: string; readonly min: number; readonly max: number }[] =
  [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12 },
    { name: 'day of week', min: 0, max: 6 },
  ];

/**
 * Does one cron field cover a value?
 *
 * The accepted grammar per field: `*`, a number, `a-b`, either with `/step`,
 * and comma-lists of those. Names (`MON`, `JAN`) are not read — a schedule is
 * written once and runs forever, so the numeric forms are worth the
 * unambiguity.
 */
function cronFieldCovers(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    const [rangeText, stepText] = part.split('/', 2) as [string, string?];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) continue;

    let low: number;
    let high: number;
    if (rangeText === '*') {
      low = min;
      high = max;
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-', 2).map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      low = a as number;
      high = b as number;
    } else {
      const single = Number(rangeText);
      if (!Number.isInteger(single)) continue;
      // `n/step` reads as "from n to the top", which is cron's own rule.
      low = single;
      high = stepText === undefined ? single : max;
    }

    if (value < low || value > high) continue;
    if ((value - low) % step === 0) return true;
  }
  return false;
}

/** One field's syntax problem, or `null`. Mirrors {@link cronFieldCovers}. */
function cronFieldProblem(field: string, min: number, max: number, name: string): string | null {
  if (field === '') return `The ${name} field is empty.`;
  for (const part of field.split(',')) {
    const [rangeText, stepText, extra] = part.split('/');
    if (extra !== undefined) return `“${part}” has more than one “/”.`;
    if (stepText !== undefined) {
      const step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) return `“${part}” has a step that is not a count.`;
    }
    if (rangeText === '*') continue;
    const bounds = (rangeText ?? '').includes('-')
      ? (rangeText ?? '').split('-', 2).map(Number)
      : [Number(rangeText)];
    for (const bound of bounds) {
      if (!Number.isInteger(bound)) return `“${part}” is not a number, range or “*”.`;
      if (bound < min || bound > max) {
        return `“${part}” is outside the ${name} range ${min}–${max}.`;
      }
    }
  }
  return null;
}

/** Why a cron expression cannot be used, or `null` when it can. */
export function cronProblem(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return 'Cron schedules take five fields: minute, hour, day of month, month, day of week.';
  }
  for (const [index, spec] of CRON_FIELDS.entries()) {
    const problem = cronFieldProblem(fields[index] as string, spec.min, spec.max, spec.name);
    if (problem !== null) return problem;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Does this schedule name this minute?
 *
 * The scheduler's whole question, asked once per minute with the tick's own
 * date. Seconds are ignored by construction — the caller passes a date, and
 * only its minute-resolution fields are read.
 */
export function scheduleMatchesMinute(schedule: RoutineSchedule, date: Date): boolean {
  switch (schedule.kind) {
    case 'manual':
      return false;
    case 'hourly':
      return date.getMinutes() === schedule.minute;
    case 'daily': {
      const at = parseTimeOfDay(schedule.at);
      return at !== undefined && date.getHours() === at.hour && date.getMinutes() === at.minute;
    }
    case 'weekdays': {
      const at = parseTimeOfDay(schedule.at);
      return (
        at !== undefined &&
        date.getDay() >= 1 &&
        date.getDay() <= 5 &&
        date.getHours() === at.hour &&
        date.getMinutes() === at.minute
      );
    }
    case 'weekly': {
      const at = parseTimeOfDay(schedule.at);
      return (
        at !== undefined &&
        date.getDay() === schedule.day &&
        date.getHours() === at.hour &&
        date.getMinutes() === at.minute
      );
    }
    case 'cron': {
      if (cronProblem(schedule.expression) !== null) return false;
      const fields = schedule.expression.trim().split(/\s+/) as [string, string, string, string, string];
      const minuteOk = cronFieldCovers(fields[0], date.getMinutes(), 0, 59);
      const hourOk = cronFieldCovers(fields[1], date.getHours(), 0, 23);
      const monthOk = cronFieldCovers(fields[3], date.getMonth() + 1, 1, 12);
      /*
       * Day-of-month and day-of-week combine with OR when both are
       * restricted, AND when only one is — Vixie cron's rule, kept because
       * every crontab the user has ever written behaves this way.
       */
      const domRestricted = fields[2] !== '*';
      const dowRestricted = fields[4] !== '*';
      const domOk = cronFieldCovers(fields[2], date.getDate(), 1, 31);
      const dowOk = cronFieldCovers(fields[4], date.getDay(), 0, 6);
      // An unrestricted field covers everything, so the AND arm collapses to
      // whichever field is restricted — or to `true` when neither is.
      const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
      return minuteOk && hourOk && monthOk && dayOk;
    }
    default:
      return false;
  }
}

/** The start of the minute after `from`. */
function nextMinuteBoundary(from: number): number {
  return Math.floor(from / 60_000) * 60_000 + 60_000;
}

/**
 * The next moment this schedule names, strictly after `from`.
 *
 * A minute-by-minute walk rather than closed-form date arithmetic, bounded at
 * just over a year so an unsatisfiable cron (February 30th) answers
 * `undefined` instead of walking forever. At worst ~530k cheap comparisons,
 * and it is called when a routine changes or a pane renders — not per tick.
 */
export function nextFireAt(schedule: RoutineSchedule, from: number): number | undefined {
  if (schedule.kind === 'manual') return undefined;
  if (scheduleProblem(schedule) !== null) return undefined;

  const limit = from + 370 * 24 * 60 * 60 * 1000;
  for (let at = nextMinuteBoundary(from); at <= limit; at += 60_000) {
    if (scheduleMatchesMinute(schedule, new Date(at))) return at;
  }
  return undefined;
}

/**
 * The most recent moment this schedule named in `(since, until]`, for the
 * catch-up rule: a machine that slept through appointments fires the newest
 * missed one, once, and lets the rest go.
 */
export function lastFireBetween(
  schedule: RoutineSchedule,
  since: number,
  until: number,
): number | undefined {
  if (schedule.kind === 'manual') return undefined;
  if (scheduleProblem(schedule) !== null) return undefined;

  // Walk backwards from `until`'s minute, so the answer is the newest match
  // and the common case (a recent miss) returns in a few steps.
  const floor = Math.max(since, until - ROUTINE_CATCH_UP_WINDOW_MS);
  for (let at = Math.floor(until / 60_000) * 60_000; at > floor; at -= 60_000) {
    if (scheduleMatchesMinute(schedule, new Date(at))) return at;
  }
  return undefined;
}

/** One line saying when a routine runs, for list rows and tooltips. */
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'manual':
      return 'Manual — runs only when you say';
    case 'hourly':
      return `Hourly at :${String(schedule.minute).padStart(2, '0')}`;
    case 'daily':
      return `Daily at ${schedule.at}`;
    case 'weekdays':
      return `Weekdays at ${schedule.at}`;
    case 'weekly': {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `${days[schedule.day] ?? 'Weekly'} at ${schedule.at}`;
    }
    case 'cron':
      return `Cron: ${schedule.expression}`;
    default:
      return 'Unknown schedule';
  }
}
