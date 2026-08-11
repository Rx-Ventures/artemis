/**
 * How large one plan is next to another, on the same provider.
 *
 * ## Why this file can exist at all
 *
 * Providers report plan usage as a percentage of a ceiling they never state.
 * That makes two accounts on different plans incomparable from the payload
 * alone — 40% free on a Max plan may be far more work than 60% free on a Pro
 * one — and it is why {@link recommendProfile} refuses to claim capacity it
 * cannot measure.
 *
 * What providers *do* publish is the **ratio**, in the product name itself.
 * Anthropic's help centre states it in words: "Max 5x provides five times more
 * usage per session than the Pro plan", "Max 20x provides 20 times more usage
 * per session than the Pro plan". OpenAI documents Codex the same way — Pro is
 * "5x or 20x more Codex usage than Plus".
 *
 * A ratio is all a *ranking* needs. Nothing here claims to know how many tokens
 * a window holds, and nothing should ever be added that does: absolute figures
 * are deliberately unpublished, vary with context size and cache hits, and a
 * table of them would be a guess wearing the clothes of a fact. Ratios are
 * different in kind — they are the thing being sold, they are printed on the
 * tin, and they change only when the product line does.
 *
 * ## Three rules for editing this table
 *
 * 1. **Ratios only, and only published ones.** If a provider has not said
 *    "N times", the weight is `null` and the plan ranks by percentage like any
 *    other unknown. Team and Enterprise sit there today: both meter per seat or
 *    against a contract pool, and neither publishes a multiple of anything.
 *
 * 2. **Never across providers.** A Claude Pro window and a Codex Plus window
 *    are each their provider's baseline and nobody publishes a rate between
 *    them, so a weight of 1 here does not mean two providers' baselines match.
 *    {@link resolvePlanWeight} is keyed by provider and callers must not
 *    compare weights across one — see the guard in `recommendProfile`.
 *
 * 3. **No promotions.** Time-boxed boosts (OpenAI ran a 2x on one Pro tier into
 *    mid-2026) expire quietly, and a table that carried one would keep applying
 *    it for as long as nobody noticed. Standing product ratios only.
 *
 * ## The ambiguity that makes {@link Profile.planId} necessary
 *
 * Both providers report a plan *family* rather than a tier. Claude's usage
 * payload answers `max` for Max 5x and Max 20x alike; Codex answers `pro` for
 * both of its Pro tiers. The two differ fourfold, which is more than enough to
 * invert a ranking, and no other field distinguishes them.
 *
 * So a family is resolved to its **floor** — `max` is treated as Max 5x — and
 * the user can pin the exact plan on the profile. The floor is the safe
 * assumption in one specific sense: it can only ever understate an account, so
 * the failure is a recommendation not made rather than a user sent to a smaller
 * plan believing it is bigger. It is still a failure, which is why a reading
 * resting on it is marked `assumed` and the UI says so.
 *
 * Verified against provider documentation on 2026-08-11.
 */

import type { ProviderId } from './provider.js';

/**
 * One plan a provider sells, and how big it is relative to that provider's
 * baseline plan.
 */
export interface PlanCapacity {
  /** Stable id, `<provider>:<plan>`. What {@link Profile.planId} stores. */
  readonly id: string;
  readonly providerId: ProviderId;
  /** What the provider calls it, e.g. "Max 20x". */
  readonly label: string;
  /**
   * Multiple of this provider's baseline plan, or `null` when the provider
   * publishes no multiple. `null` is not "unknown pending research" — it is a
   * statement that the plan is not sold as a multiple of anything.
   */
  readonly weight: number | null;
  /**
   * The `subscriptionType` strings a provider reports for this plan, lowercased.
   *
   * Several plans can share one string: that is the ambiguity described in the
   * header, and it is why {@link isFamilyFloor} exists.
   */
  readonly reportedAs: readonly string[];
  /**
   * True when this is the smallest plan sharing its reported string, and so
   * the one assumed when the user has not pinned a tier.
   */
  readonly isFamilyFloor: boolean;
}

/**
 * Every plan Artemis can weigh, newest-known documentation applied.
 *
 * Ordered by provider then by size, which is the order the profile editor
 * offers them in — a list that jumps around is a list people mis-click.
 */
export const PLAN_CAPACITIES: readonly PlanCapacity[] = [
  /*
   * Claude. Pro is the baseline the Max tiers are sold as multiples of.
   *
   * Team and Enterprise carry no weight on purpose. Team meters per seat and
   * Enterprise against a negotiated pool; neither is published as "N times Pro",
   * and inventing a number for the plans most likely to be a company's would be
   * the worst place to be wrong.
   */
  {
    id: 'claude:pro',
    providerId: 'claude',
    label: 'Pro',
    weight: 1,
    reportedAs: ['pro'],
    isFamilyFloor: true,
  },
  {
    id: 'claude:max-5x',
    providerId: 'claude',
    label: 'Max 5x',
    weight: 5,
    reportedAs: ['max'],
    isFamilyFloor: true,
  },
  {
    id: 'claude:max-20x',
    providerId: 'claude',
    label: 'Max 20x',
    weight: 20,
    reportedAs: ['max'],
    isFamilyFloor: false,
  },
  {
    id: 'claude:team',
    providerId: 'claude',
    label: 'Team',
    weight: null,
    reportedAs: ['team'],
    isFamilyFloor: true,
  },
  {
    id: 'claude:enterprise',
    providerId: 'claude',
    label: 'Enterprise',
    weight: null,
    reportedAs: ['enterprise'],
    isFamilyFloor: true,
  },

  /*
   * Codex. Plus is the baseline; Pro is sold as 5x or 20x of it.
   *
   * Business matches Plus's per-seat limits and then draws on a workspace credit
   * pool, and Enterprise/Edu on flexible pricing have no fixed limit at all —
   * usage scales with credits. A pool is not a multiple, so neither carries a
   * weight: an account that can buy its way past the limit is not something a
   * percentage ranking describes.
   */
  {
    id: 'codex:plus',
    providerId: 'codex',
    label: 'Plus',
    weight: 1,
    reportedAs: ['plus'],
    isFamilyFloor: true,
  },
  {
    id: 'codex:pro-5x',
    providerId: 'codex',
    label: 'Pro 5x',
    weight: 5,
    reportedAs: ['pro'],
    isFamilyFloor: true,
  },
  {
    id: 'codex:pro-20x',
    providerId: 'codex',
    label: 'Pro 20x',
    weight: 20,
    reportedAs: ['pro'],
    isFamilyFloor: false,
  },
  {
    id: 'codex:business',
    providerId: 'codex',
    label: 'Business',
    weight: null,
    reportedAs: ['business'],
    isFamilyFloor: true,
  },
  {
    id: 'codex:enterprise',
    providerId: 'codex',
    label: 'Enterprise',
    weight: null,
    reportedAs: ['enterprise', 'edu'],
    isFamilyFloor: true,
  },
];

/** The plans one provider sells, in display order. For the profile editor. */
export function plansForProvider(providerId: ProviderId): readonly PlanCapacity[] {
  return PLAN_CAPACITIES.filter((plan) => plan.providerId === providerId);
}

/** Look one up by the id a profile pinned. */
export function planCapacityById(id: string | undefined): PlanCapacity | null {
  if (id === undefined || id === '') return null;
  return PLAN_CAPACITIES.find((plan) => plan.id === id) ?? null;
}

/** What a resolved plan weighs, and how confident that is. */
export interface ResolvedPlanWeight {
  readonly plan: PlanCapacity;
  /**
   * The multiple to rank by, or `null` when this plan publishes none — in which
   * case the caller must fall back to percentages rather than substitute a 1.
   */
  readonly weight: number | null;
  /**
   * True when the tier was inferred from an ambiguous reported string rather
   * than pinned by the user. See the header: the inference is the family floor,
   * so an `assumed` weight is a lower bound and never an over-claim.
   */
  readonly assumed: boolean;
}

/**
 * Which plan an account is on, and what it weighs.
 *
 * `pinned` wins over what the provider reported, because it is the only source
 * that can tell Max 5x from Max 20x — but only when it belongs to the same
 * provider. A pin left behind by repointing a profile at a different provider's
 * config directory would otherwise weigh a Codex account on Claude's ladder.
 *
 * Returns `null` when nothing identifies the plan at all, which is the ordinary
 * state for an account whose usage has not been read yet.
 */
export function resolvePlanWeight(input: {
  readonly providerId: ProviderId;
  readonly subscriptionType?: string | undefined;
  readonly pinned?: string | undefined;
}): ResolvedPlanWeight | null {
  const pinned = planCapacityById(input.pinned);
  if (pinned && pinned.providerId === input.providerId) {
    return { plan: pinned, weight: pinned.weight, assumed: false };
  }

  const reported = input.subscriptionType?.trim().toLowerCase();
  if (reported === undefined || reported === '') return null;

  const family = PLAN_CAPACITIES.filter(
    (plan) => plan.providerId === input.providerId && plan.reportedAs.includes(reported),
  );
  if (family.length === 0) return null;

  // The floor of the family, and `assumed` whenever the family holds more than
  // one tier — that is precisely the case the reported string cannot resolve.
  const floor = family.find((plan) => plan.isFamilyFloor) ?? family[0];
  if (floor === undefined) return null;
  return { plan: floor, weight: floor.weight, assumed: family.length > 1 };
}
