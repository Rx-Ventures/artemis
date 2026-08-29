/**
 * The three facts every model row knows.
 * ============================================================================
 *
 * The model picker used to be profile-blind: it offered Fable identically
 * whether that account's Fable weekly window was untouched or `rejected`.
 * Everything it should have known was already computed one selector away —
 * per-model exhaustion in the plan windows, plan headroom in `bindingWindow`,
 * relative burn rate in `MODEL_LOAD` — and simply never read. This module is
 * the join, and nothing but the join: pure functions from catalogue entries and
 * plan readings to the facts a row renders.
 *
 * Three surfaces consume it — the run navigator, the palette's models page and
 * Settings § Models — so the derivation lives here once rather than three
 * times. The §5 hand-off picker is expected to be the fourth caller.
 *
 * ## Identity goes through `modelIdentity`, never string equality
 *
 * Usage windows name models the way the provider displays them
 * (`model_scoped:Fable`); catalogues name them the way the CLI addresses them
 * (`claude-fable-5[1m]`, or `fable` in the built-in list). Comparing those
 * strings raw matches nothing, which is exactly the bug class
 * `modelIdentity`/`isSameModel` exist for. Every join below normalises both
 * sides through that helper and then matches on delimited name segments, the
 * same family logic `modelLoadFactor` documents.
 */

import {
  MODEL_LOAD,
  PLAN_USAGE_MAX_AGE_MS,
  isModelScoped,
  isSameModel,
  modelIdentity,
} from '@rx-artemis/protocol';
import type {
  PlanUsage,
  PlanUsageWindow,
  ProviderModelOption,
} from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Identity: which window is about which model                                */
/* -------------------------------------------------------------------------- */

/** The prefix a named per-model bucket carries, e.g. `model_scoped:Fable`. */
const MODEL_SCOPED_PREFIX = 'model_scoped:';

/**
 * A window's model name wrapped as a catalogue option, so the join can run
 * through {@link modelIdentity} instead of reinventing its normalisation.
 * The name is the provider's `display_name` verbatim — presentation, not an
 * identifier — which is precisely why it needs the same treatment ids get.
 */
function windowAsOption(windowId: string): ProviderModelOption | null {
  if (!windowId.startsWith(MODEL_SCOPED_PREFIX)) return null;
  const name = windowId.slice(MODEL_SCOPED_PREFIX.length).trim();
  if (name.length === 0) return null;
  return { id: name, label: name, note: '' };
}

/**
 * Does a normalised window key name this catalogue option?
 *
 * Equality first — `isSameModel` covers the case where both sides carry full
 * ids. Then segment containment: the window says `fable`, the catalogue key is
 * `claude-fable-5`, and `fable` appears as a whole delimited segment of it.
 * Substring alone would be too loose (`us` is inside `opus`); whole-segment
 * matching is the same family rule `modelLoadFactor` applies, made exact.
 */
function windowNamesModel(windowOption: ProviderModelOption, model: ProviderModelOption): boolean {
  if (isSameModel(windowOption, model)) return true;
  const windowKeys = modelIdentity(windowOption);
  for (const key of modelIdentity(model)) {
    const segments = key.split(/[^a-z0-9.]+/);
    if (windowKeys.some((wk) => segments.includes(wk))) return true;
  }
  return false;
}

/**
 * The per-model weekly bucket that meters *this* model, or `null`.
 *
 * `null` covers three honest states — no reading, no per-model buckets on this
 * plan, or buckets that name other models — and callers must not tell them
 * apart here: all three mean "this model has no bucket of its own to report".
 * An unnamed `model_scoped` window is skipped rather than guessed at; a
 * verdict that cannot be attached to a model must not disable one.
 */
export function modelScopedWindow(
  model: ProviderModelOption,
  usage: PlanUsage | null | undefined,
): PlanUsageWindow | null {
  if (!usage?.available) return null;
  for (const window of usage.windows) {
    if (!isModelScoped(window.id)) continue;
    const named = windowAsOption(window.id);
    if (named === null) continue;
    if (windowNamesModel(named, model)) return window;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Fact 1: exhaustion                                                         */
/* -------------------------------------------------------------------------- */

/** Why a model cannot be picked right now, with when that changes. */
export interface ModelExhaustion {
  /** The bucket doing the refusing. */
  readonly window: PlanUsageWindow;
  /** One sentence for the row, reset time included when known. */
  readonly reason: string;
}

/**
 * Present when this model's own weekly bucket is `rejected`.
 *
 * The verdict, not the percentage, is what decides — a rejected window at 97%
 * is out, not "3% from out" (see `PlanLimitStatus`). The row renders
 * present-but-disabled with this reason attached, following the palette's
 * `GatedItem` precedent: struck through with the explanation, never hidden.
 */
export function modelExhaustion(
  model: ProviderModelOption,
  usage: PlanUsage | null | undefined,
  now: number,
): ModelExhaustion | null {
  const window = modelScopedWindow(model, usage);
  if (window === null || window.status !== 'rejected') return null;
  const reset = describeReset(window.resetsAt, now);
  return {
    window,
    reason: `Its ${window.label} limit is reached — requests are being refused${
      reset === null ? '' : ` · ${reset}`
    }.`,
  };
}

/**
 * A reset instant as a short clause, or `null` when the provider gave none.
 *
 * The exact wall-clock time leads, for the reason the usage popover gives:
 * "in 4h" needs arithmetic before anyone can decide whether to wait. A reset
 * more than a day out carries its weekday so "3:00 PM" cannot read as today.
 */
export function describeReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  if (resetsAt - now <= 0) return 'resetting now';
  const at = new Date(resetsAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `resets ${
    sameDay
      ? clock
      : `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock}`
  }`;
}

/* -------------------------------------------------------------------------- */
/* Fact 2: pressure                                                           */
/* -------------------------------------------------------------------------- */

/** How close this model is to being stopped, and by which window. */
export interface ModelPressure {
  /** The window that would stop this model first. */
  readonly window: PlanUsageWindow;
  /**
   * Utilization to print, 0–100, or `null` when the window carries a verdict
   * but no number. A rejected window still *draws* full whatever this reads —
   * the same rule `PlanUsageMeter` renders by.
   */
  readonly utilization: number | null;
}

/**
 * The window that binds *this* model on *this* profile.
 *
 * Not `bindingWindow(usage)`: that one may be another model's bucket, and a
 * full Opus bucket is no reason to tint the Sonnet row. This is the worse of
 * the shared windows (which every model burns) and the model's own scoped
 * bucket (which only it does) — a rejected verdict outranks any percentage,
 * exactly as `bindingWindow` documents.
 */
export function modelPressure(
  model: ProviderModelOption,
  usage: PlanUsage | null | undefined,
): ModelPressure | null {
  if (!usage?.available) return null;

  // Shared windows bind every model; other models' buckets bind only them.
  const candidates: PlanUsageWindow[] = usage.windows.filter((w) => !isModelScoped(w.id));
  const own = modelScopedWindow(model, usage);
  if (own !== null) candidates.push(own);

  let worst: PlanUsageWindow | null = null;
  for (const window of candidates) {
    if (worst === null) {
      worst = window;
      continue;
    }
    if (window.status === 'rejected' && worst.status !== 'rejected') {
      worst = window;
      continue;
    }
    if (worst.status === 'rejected') continue;
    if ((window.utilization ?? -1) > (worst.utilization ?? -1)) worst = window;
  }

  if (worst === null) return null;
  if (worst.status !== 'rejected' && worst.utilization === null) return null;
  return { window: worst, utilization: worst.utilization };
}

/* -------------------------------------------------------------------------- */
/* Fact 3: cost posture                                                       */
/* -------------------------------------------------------------------------- */

/** What picking this model costs, relative to the plan's baseline burn. */
export interface CostPosture {
  /** The `MODEL_LOAD` family the id resolved to, e.g. `fable`. */
  readonly family: string;
  /** The exact multiplier, e.g. `8` — Sonnet is the 1× baseline. */
  readonly multiplier: number;
  /** How many `$` pips to draw, 1–4, monotone in the multiplier. */
  readonly pips: number;
}

/**
 * The `MODEL_LOAD` multiplier for this model, or `null` for a family the table
 * has never heard of.
 *
 * `null` rather than the table's middle default on purpose. `modelLoadFactor`
 * guesses "middling" because a reservation needs *some* number; a row detail
 * printed as fact must not — an unknown model shows no pips rather than a
 * confident `1×`.
 *
 * Matching mirrors `modelLoadFactor`: longest family first, checked against
 * every normalised identity key, so `fable`, `claude-fable-5` and
 * `claude-fable-5[1m]` all resolve to the same posture.
 */
export function costPosture(model: ProviderModelOption): CostPosture | null {
  const keys = modelIdentity(model);
  if (keys.length === 0) return null;
  const families = Object.keys(MODEL_LOAD).sort((a, b) => b.length - a.length);
  for (const family of families) {
    if (!keys.some((key) => key.includes(family))) continue;
    const multiplier = MODEL_LOAD[family];
    if (multiplier === undefined) continue;
    return { family, multiplier, pips: pipsFor(multiplier) };
  }
  return null;
}

/**
 * Multiplier → pip count. The steps are the table's own values rather than a
 * log scale, so today's lineup reads $ / $$ / $$$ / $$$$ and a future family
 * lands between the neighbours it costs between.
 */
function pipsFor(multiplier: number): number {
  if (multiplier < 1) return 1;
  if (multiplier <= 1) return 2;
  if (multiplier <= 4) return 3;
  return 4;
}

/* -------------------------------------------------------------------------- */
/* The Recommended row                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How many percentage points of extra headroom make a different model worth a
 * heading. The analogue of `recommendProfile`'s two-candidate rule applied to
 * the gap: a model two points freer is noise that would swap the row between
 * polls, and a recommendation that churns teaches people to ignore it.
 */
export const MATERIAL_HEADROOM_GAP = 20;

/** Which pinned model has materially more room than the one selected. */
export interface ModelRecommendation {
  readonly model: ProviderModelOption;
  /** Percentage of the winner's binding window still unused, 0–100. */
  readonly headroom: number;
  /** The window that sets that number, so the UI can name it. */
  readonly binding: PlanUsageWindow;
  /** The selected model's own headroom, for the sentence explaining the gap. */
  readonly selectedHeadroom: number;
  /** How many pinned models were ranked. Never less than two. */
  readonly candidates: number;
}

/**
 * The pinned model with materially more headroom for this profile, or `null`.
 *
 * The exact analogue of `RecommendedProfile`, reusing `recommendProfile`'s
 * rules where they translate:
 *
 * - **Freshness.** A reading older than {@link PLAN_USAGE_MAX_AGE_MS} advises
 *   on nothing — same bar, same reason: a recommendation is a claim about now.
 * - **Two candidates.** With one rankable model there is no choice to make,
 *   and a heading over the only option repeats the row below it.
 * - **A reading with no usable number is not ranked.** Here that means a model
 *   whose pressure cannot be computed at all.
 * - **Ties keep catalogue order** — strictly-greater wins, so two models at the
 *   same headroom do not trade the label between polls.
 *
 * And one rule of its own: the winner must beat the *selected* model by
 * {@link MATERIAL_HEADROOM_GAP} points, and must not be the selected model
 * under any of its names ({@link isSameModel}, never id equality). Steering
 * someone off the model they chose is only worth doing when the difference is
 * material — most of the time the honest output is nothing, exactly as it is
 * for profiles.
 */
export function recommendModel(
  pinned: readonly ProviderModelOption[],
  selected: ProviderModelOption | undefined,
  usage: PlanUsage | null | undefined,
  now: number,
  options?: { readonly maxAgeMs?: number; readonly materialGap?: number },
): ModelRecommendation | null {
  if (selected === undefined) return null;
  if (!usage?.available) return null;
  const maxAge = options?.maxAgeMs ?? PLAN_USAGE_MAX_AGE_MS;
  if (Math.max(0, now - usage.fetchedAt) > maxAge) return null;

  const ranked: {
    readonly model: ProviderModelOption;
    readonly binding: PlanUsageWindow;
    readonly headroom: number;
  }[] = [];
  for (const model of pinned) {
    const pressure = modelPressure(model, usage);
    if (pressure === null) continue;
    const headroom =
      pressure.window.status === 'rejected' ? 0 : 100 - (pressure.utilization ?? NaN);
    if (Number.isNaN(headroom)) continue;
    ranked.push({ model, binding: pressure.window, headroom });
  }
  if (ranked.length < 2) return null;

  const current = ranked.find((r) => isSameModel(r.model, selected));
  if (current === undefined) return null;

  let best = ranked[0];
  if (best === undefined) return null;
  for (const candidate of ranked.slice(1)) {
    if (candidate.headroom > best.headroom) best = candidate;
  }

  if (isSameModel(best.model, selected)) return null;
  const gap = options?.materialGap ?? MATERIAL_HEADROOM_GAP;
  if (best.headroom - current.headroom < gap) return null;

  return {
    model: best.model,
    headroom: best.headroom,
    binding: best.binding,
    selectedHeadroom: current.headroom,
    candidates: ranked.length,
  };
}
