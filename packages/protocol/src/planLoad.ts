/**
 * What the work already running is going to spend.
 * ============================================================================
 *
 * `recommendProfile` ranks accounts on a *polled* reading, and the poll is a
 * measurement that lags its own consequences. That is fine for a gauge and wrong
 * for a chooser, because the chooser's own decisions are what move the number it
 * is reading.
 *
 * The failure is a herd. Start a session; it adopts the account with the most
 * room and begins eating that account's window. Start another forty seconds
 * later; nothing has re-polled, so the same account still reads as the emptiest,
 * and it wins again. And again. Four or five live sessions pile onto one profile
 * while the rest sit idle, the account hits its limit, the readings finally catch
 * up, and the herd moves on to do the same thing to the next one.
 *
 * It gets *worse* with more accounts, which is the part worth sitting with. The
 * poll is serial by design — see `planUsagePoll.ts` — so eight profiles take the
 * best part of a minute to walk, and the next cycle starts five minutes after
 * the last one ends. Any given account is re-read about every six minutes. Six
 * minutes is several new sessions for someone working across a fistful of
 * accounts, so the feature degrades precisely as you scale the thing it exists to
 * manage.
 *
 * ## The correction: reserve what is already committed
 *
 * Before ranking, subtract from each account an estimate of what the runs
 * *already on it* are going to spend. An account with a live Fable/ultracode
 * session is not as empty as it reads, and the recommender should know that
 * without waiting for a poll to tell it.
 *
 * This is a **reservation against committed load**, not a correction of the past.
 * The question being answered is "where should the next session go", and what
 * makes an account a bad destination is the work already heading for it. A run
 * that started three seconds ago has consumed almost nothing and is nonetheless
 * the strongest reason not to pile a second one on top of it.
 *
 * ## Model and effort compound, and ultracode is not a rung
 *
 * Effort scales the depth of one turn. Ultracode scales the *number of turns*:
 * it fans work out across subagents and workflows, so it multiplies model calls
 * rather than lengthening one. That is why it is a separate multiplier here even
 * though the picker draws it as the top rung of the thinking ladder — and it is
 * why a Fable ultracode session outweighs an Opus max one several times over
 * despite `max` sitting above `xhigh` on that ladder.
 *
 * ## These numbers are not measured
 *
 * ------------------------------------------------------------------------
 * THE CONSTANTS BELOW ARE AN INFORMED GUESS AND HAVE NOT BEEN CALIBRATED
 * AGAINST REAL CONSUMPTION. They encode an *ordering* that is believed
 * correct and *magnitudes* that are plausible.
 * ------------------------------------------------------------------------
 *
 * They are deliberately gathered here, as named constants with one conversion
 * factor, so that recalibrating is an edit to this file and nothing else. The
 * tests assert the ordering and the invariants rather than the magnitudes, so
 * better numbers can be dropped in without touching them.
 *
 * If you are here to tune this: {@link BASELINE_RESERVATION_POINTS} is the
 * single knob for "how strongly does a live run push the recommender away". The
 * two tables are the *relative* shape and should only change if the models or
 * the effort ladder do.
 */

/** What one live run is doing, as far as its cost is concerned. */
export interface LiveRunLoad {
  /**
   * The model id, in whatever spelling the catalogue used.
   *
   * Ids are not stable across catalogues — the built-in list says `fable`, a
   * live one says `claude-fable-5[1m]` — which is why {@link modelLoadFactor}
   * matches on family rather than looking the id up in a table. See
   * `carryModelId` in the renderer's store for the same problem solved the same
   * way.
   */
  readonly model?: string | null;
  /** Reasoning-effort id: `low` … `max`. Absent means the provider default. */
  readonly effort?: string | null;
  /** Whether this run was asked to spend materially more compute. */
  readonly ultracode?: boolean;
}

/* -------------------------------------------------------------------------- */
/* The shape                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Relative load by model family, against Sonnet at 1.
 *
 * Families rather than ids, for the reason {@link LiveRunLoad.model} gives.
 * Ordered small to large so the fall-through default below is the middle of the
 * range rather than the top or the bottom.
 */
export const MODEL_LOAD: Readonly<Record<string, number>> = {
  haiku: 0.25,
  sonnet: 1,
  opus: 4,
  fable: 8,
};

/**
 * Relative load by reasoning effort, against `medium` at 1.
 *
 * The ids are the providers' own — Claude offers `low` through `max`, Codex
 * stops at `xhigh` — and an unknown one falls through to `medium`, which is
 * where both providers' defaults sit.
 */
export const EFFORT_LOAD: Readonly<Record<string, number>> = {
  low: 0.5,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

/**
 * What ultracode multiplies the whole thing by.
 *
 * A multiplier rather than a rung, because it changes the *number* of model
 * calls rather than the depth of one — see the header. Two is conservative for
 * something that can fan out a dozen subagents; it is set low deliberately,
 * because over-reserving on the commonest heavy mode would push the recommender
 * off an account after a single session.
 */
export const ULTRACODE_MULTIPLIER = 2;

/**
 * Percentage points of a **baseline plan's** binding window that one
 * Sonnet/medium run is expected to consume.
 *
 * The single knob. Baseline means the provider's reference plan — the one
 * `PLAN_CAPACITIES` weighs everything else against — so this number is
 * plan-independent, and `recommendProfile` scales it per account by that
 * account's own weight.
 *
 * At 0.75, a Sonnet/medium session reserves under a point and barely moves the
 * ranking, while a Fable/ultracode session reserves 48 — enough to send the next
 * session elsewhere unless the account really is much emptier than its rivals.
 * That asymmetry is the intent: the herd only ever formed around expensive work.
 */
export const BASELINE_RESERVATION_POINTS = 0.75;

/* -------------------------------------------------------------------------- */
/* The arithmetic                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The model's contribution, matched by family name inside whatever id arrived.
 *
 * Substring rather than exact lookup, because the same model is `fable`,
 * `claude-fable-5` and `claude-fable-5[1m]` depending on which catalogue named
 * it, and a table keyed by id would silently fall through to the default the
 * moment a live catalogue landed.
 *
 * Longest family first, so a hypothetical id containing two family names
 * resolves to the more specific one rather than to whichever was declared first.
 */
export function modelLoadFactor(model: string | null | undefined): number {
  if (typeof model !== 'string' || model.length === 0) return MODEL_LOAD['sonnet'] ?? 1;
  const id = model.toLowerCase();
  const families = Object.keys(MODEL_LOAD).sort((a, b) => b.length - a.length);
  for (const family of families) {
    if (id.includes(family)) return MODEL_LOAD[family] ?? 1;
  }
  // An unrecognised model is assumed to be a middling one. Not the largest:
  // this is a *guess* about an id nobody has taught this table about, and
  // guessing "most expensive" would push the recommender off an account on no
  // evidence at all.
  return MODEL_LOAD['sonnet'] ?? 1;
}

/** The effort's contribution, defaulting to `medium` for anything unknown. */
export function effortLoadFactor(effort: string | null | undefined): number {
  if (typeof effort !== 'string' || effort.length === 0) return EFFORT_LOAD['medium'] ?? 1;
  return EFFORT_LOAD[effort.toLowerCase()] ?? EFFORT_LOAD['medium'] ?? 1;
}

/** How heavy one run is, relative to a Sonnet/medium run at 1. */
export function runLoadFactor(run: LiveRunLoad): number {
  const base = modelLoadFactor(run.model) * effortLoadFactor(run.effort);
  return run.ultracode === true ? base * ULTRACODE_MULTIPLIER : base;
}

/**
 * What a set of live runs reserves, in baseline-plan percentage points.
 *
 * Additive: two sessions on one account reserve twice as much as one, which is
 * the whole point — the second session is exactly the thing the recommender was
 * failing to notice.
 *
 * Deliberately **not** clamped to 100. An account carrying six ultracode
 * sessions should score far below one carrying three, and flattening both to
 * "full" would put the choice back to list order among the worst candidates.
 * `recommendProfile` does not clamp either, for the same reason.
 */
export function reservationFor(runs: readonly LiveRunLoad[] | undefined): number {
  if (runs === undefined || runs.length === 0) return 0;
  let total = 0;
  for (const run of runs) total += runLoadFactor(run) * BASELINE_RESERVATION_POINTS;
  return total;
}
