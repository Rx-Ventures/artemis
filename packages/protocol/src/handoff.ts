/**
 * When an account is close enough to its limit that the work should be handed on.
 * ============================================================================
 *
 * Running out of plan mid-conversation is not a graceful failure. The provider
 * stops answering, the turn dies wherever it happened to be, and everything the
 * agent had worked out — which files matter, what it had already tried, what it
 * was about to do next — is left implicit in a transcript nobody is going to
 * read back. Picking the work up on another account means reconstructing all of
 * it by hand.
 *
 * So the answer is to stop *before* the wall rather than at it, and spend the
 * last of the budget writing down what the next session needs. This module is
 * the judgement of when that moment has arrived; it does no I/O and starts
 * nothing, which is what makes the policy testable in isolation from the
 * machinery that acts on it.
 *
 * ## Per window, not on the worst one
 *
 * {@link bindingWindow} answers "which limit will stop you", which is the right
 * question for a gauge and the wrong one here. The windows do not deserve the
 * same margin: the 5-hour window refills within the working day, so leaving a
 * little of it unspent costs almost nothing, while the weekly window is gone for
 * days and is worth riding much closer to the edge. Reducing them to one number
 * first would throw away exactly the distinction the thresholds encode.
 *
 * ## Why the numbers are not hardcoded
 *
 * They are a judgement about how much runway a handoff needs, and that depends
 * on how the account is used. The defaults are the ones the feature was
 * specified with, and they are defaults rather than constants.
 */

import { isModelScoped, type PlanUsage, type PlanUsageWindow } from './usage.js';

/**
 * A window to watch, and how full it may get before the work is handed on.
 *
 * `match` is a family rather than an id because the per-model weekly buckets a
 * plan meters separately vary by account — `model_scoped:Fable` on one, plain
 * `model_scoped` on another — and a rule written against one account's spelling
 * would silently never fire on the next.
 */
export interface HandoffThreshold {
  /** Stable key for the rule, so a preference can be stored against it. */
  readonly id: string;
  /** What to call this window in a sentence addressed to a person. */
  readonly label: string;
  /** Percent full, 0–100, at or above which the work should be handed on. */
  readonly at: number;
  /** Which window this rule is about. */
  readonly match: { readonly kind: 'window'; readonly id: string } | {
    readonly kind: 'model';
    /** Substring of the bucket name, matched case-insensitively. */
    readonly name: string;
  };
}

/**
 * The rules the feature ships with.
 *
 * Deliberately asymmetric, and each number is a different argument:
 *
 *  - **5-hour at 90%.** It refills within the working day, so the 10% left over
 *    is cheap — and it is the window that actually stops people, so it wants the
 *    widest margin of the three.
 *  - **Weekly at 98%.** Gone for days once spent. Handing off early here throws
 *    away budget that does not come back until the window rolls, so it is ridden
 *    close to the edge and the margin is only what a handoff itself costs.
 *  - **Fable at 95%.** Between the two, because it is metered separately and its
 *    exhaustion takes one model away rather than the account.
 */
export const DEFAULT_HANDOFF_THRESHOLDS: readonly HandoffThreshold[] = [
  { id: 'five_hour', label: '5-hour', at: 90, match: { kind: 'window', id: 'five_hour' } },
  { id: 'seven_day', label: 'weekly', at: 98, match: { kind: 'window', id: 'seven_day' } },
  { id: 'fable', label: 'Fable', at: 95, match: { kind: 'model', name: 'fable' } },
];

/** A rule that has been met, and the reading that met it. */
export interface HandoffTrigger {
  readonly threshold: HandoffThreshold;
  readonly window: PlanUsageWindow;
  /** The reading, 0–100, rounded for display. */
  readonly utilization: number;
}

/** The window a rule is about, or `null` when this plan does not report one. */
export function windowFor(
  usage: PlanUsage | null | undefined,
  threshold: HandoffThreshold,
): PlanUsageWindow | null {
  if (!usage?.available) return null;
  if (threshold.match.kind === 'window') {
    const wanted = threshold.match.id;
    return usage.windows.find((w) => w.id === wanted) ?? null;
  }
  // The most-consumed bucket whose name mentions the model, for the same reason
  // `focusedWindow` picks the worst within the family: averaging several buckets
  // would describe none of them, and the one closest to full is the one that
  // will stop you.
  const name = threshold.match.name.toLowerCase();
  let worst: PlanUsageWindow | null = null;
  for (const window of usage.windows) {
    if (!isModelScoped(window.id) || window.utilization === null) continue;
    if (!`${window.id} ${window.label}`.toLowerCase().includes(name)) continue;
    if (worst === null || window.utilization > (worst.utilization ?? -1)) worst = window;
  }
  return worst;
}

/**
 * The rule this reading has met, or `null` if none has.
 *
 * The *first* match in threshold order rather than the worst overshoot: the
 * result is a reason shown to a person, and "the 5-hour window is at 94%" is a
 * better sentence than one picked by arithmetic nobody can see. Where two rules
 * are met at once they are both true, and either is a correct thing to say.
 *
 * A window the provider reports without a number is not a match. `null`
 * utilization means "not reported", and treating an absent reading as either
 * full or empty would be inventing a fact — the same rule
 * {@link PlanUsageWindow.utilization} is documented under.
 */
export function handoffTrigger(
  usage: PlanUsage | null | undefined,
  thresholds: readonly HandoffThreshold[] = DEFAULT_HANDOFF_THRESHOLDS,
): HandoffTrigger | null {
  if (!usage?.available) return null;
  for (const threshold of thresholds) {
    const window = windowFor(usage, threshold);
    if (window?.utilization == null) continue;
    if (window.utilization >= threshold.at) {
      return { threshold, window, utilization: Math.round(window.utilization) };
    }
  }
  return null;
}
