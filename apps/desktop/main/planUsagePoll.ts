/**
 * Keeping every account's plan usage current, so the profile menu can advise.
 *
 * The status bar's meter reads the *active* profile, on demand, when its
 * popover opens. That answers "how much room have I got left here" and cannot
 * answer the question this file exists for — "which of my accounts should I be
 * running in right now" — because nothing had ever read the others. This walks
 * all of them on a timer and pushes what it finds, which is what turns a set of
 * per-profile gauges into a comparison.
 *
 * ## Why the poll lives in main
 *
 * Each reading spawns the provider's CLI. A renderer-side timer would spawn one
 * subprocess per profile *per window*, so opening a second Artemis window would
 * double the machine's load to compute the same numbers, and the numbers would
 * disagree between windows while the reads raced. One poller here, one cache
 * (the engine's), fanned out to whoever is open.
 *
 * ## What it is careful about
 *
 * A cycle is **serial**. Six accounts polled in parallel is six CLIs starting
 * at once, every five minutes, forever — the profiles screen already learned
 * this and queues its own reads for the same reason. Chained, the whole cycle
 * costs a few seconds of wall clock that nobody is waiting on.
 *
 * A cycle **cannot overlap its successor**: the next one is scheduled when the
 * last finishes, not on a fixed interval, so a machine where the CLI takes
 * thirty seconds per account does not accumulate cycles until it falls over.
 *
 * A cycle is **skipped while no window is open**. On macOS closing the last
 * window leaves the app running, and readings collected then can be observed by
 * nobody — they would be stale again by the time a window opened. The first
 * cycle after `start` runs immediately, so a freshly-opened app is not five
 * minutes behind.
 *
 * A failure is **per profile**. One account whose CLI is missing, wedged or
 * signed out must not stop the accounts behind it in the queue from being read,
 * which is exactly when the recommendation matters most.
 */

import { BrowserWindow } from 'electron';

import {
  IPC_PUSH,
  PLAN_USAGE_POLL_INTERVAL_MS,
  type PlanUsagePush,
  type ProfileId,
  type Unsubscribe,
} from '@rx-artemis/protocol';

import type { EngineHost } from './engine.js';
import { broadcast } from './ipc.js';
import { createLogger } from './log.js';
import { assertNoSecrets, RESPONSE_SCAN_POLICY } from './redact.js';

const log = createLogger('plan-usage');

/**
 * How long after the app starts the first cycle runs.
 *
 * Not zero. Boot is the busiest moment in the process — the engine is starting,
 * the window is loading, the renderer is fetching profiles and models — and a
 * fistful of CLI subprocesses landing in the middle of it delays the thing the
 * user is actually watching. Fifteen seconds is late enough to be out of the
 * way and early enough that the menu is right before anyone opens it.
 */
const FIRST_CYCLE_DELAY_MS = 15_000;

export interface PlanUsagePollOptions {
  /** Milliseconds between the end of one cycle and the start of the next. */
  readonly intervalMs?: number;
  /** Milliseconds before the first cycle. See {@link FIRST_CYCLE_DELAY_MS}. */
  readonly firstDelayMs?: number;
}

/**
 * Start re-reading every profile's plan usage on a timer.
 *
 * Returns a disposer. Calling it stops the schedule; a cycle already in flight
 * finishes its current profile and then stops pushing, because a reading that
 * lands after shutdown has nowhere to go.
 */
export function startPlanUsagePolling(
  engine: EngineHost,
  options: PlanUsagePollOptions = {},
): Unsubscribe {
  if (!engine.ready) return () => undefined;

  const intervalMs = options.intervalMs ?? PLAN_USAGE_POLL_INTERVAL_MS;
  const firstDelayMs = options.firstDelayMs ?? FIRST_CYCLE_DELAY_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void cycle(), delayMs);
  };

  const push = (profileId: ProfileId, payload: PlanUsagePush): void => {
    try {
      // The same standard the equivalent *response* is held to — see
      // `RESPONSE_SCAN_POLICY`, which already accounts for this shape
      // (`unavailableReason` is one of its content keys). A push is not a
      // weaker boundary than an invoke reply just because nobody asked for it.
      assertNoSecrets(payload, IPC_PUSH.planUsage, RESPONSE_SCAN_POLICY);
    } catch (error) {
      log.error(`Dropped plan usage for ${profileId}: it failed its credential-safety check`, error);
      return;
    }
    broadcast(IPC_PUSH.planUsage, payload);
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;

    // Nobody is looking. See the header: a reading collected now would be stale
    // before it could be read.
    if (BrowserWindow.getAllWindows().length === 0) {
      schedule(intervalMs);
      return;
    }

    try {
      const profiles = await engine.require().listProfiles({});
      for (const profile of profiles) {
        if (stopped) return;
        try {
          const usage = await engine.require().refreshPlanUsage({ profileId: profile.id });
          if (stopped) return;
          push(profile.id, { profileId: profile.id, usage });
        } catch (error) {
          // Routine: a profile pointed at a directory the CLI cannot read, a
          // provider that has been uninstalled, an account signed out. The next
          // account in the queue is unaffected, and so is the next cycle.
          log.debug(`Could not read plan usage for profile ${profile.id}`, error);
        }
      }
    } catch (error) {
      // Listing profiles failed, which is the whole cycle rather than one
      // account — the engine is unavailable or the profiles file is unreadable.
      log.debug('Skipped a plan-usage cycle', error);
    }

    schedule(intervalMs);
  };

  schedule(firstDelayMs);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
