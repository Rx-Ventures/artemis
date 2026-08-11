/**
 * Headroom, and which account to recommend on it.
 *
 * These are pure functions over readings the main process polls, and they are
 * the whole of the "Recommended" section's judgement — the UI does no ranking
 * of its own. What is tested here is mostly what the recommendation *refuses*
 * to say: the exclusions are the part that keeps it from sending someone to a
 * metered account, or advising on numbers from twenty minutes ago.
 */

import { describe, expect, it } from 'vitest';

import { resolvePlanWeight } from './planCapacity.js';
import {
  PLAN_USAGE_MAX_AGE_MS,
  planHeadroom,
  recommendProfile,
  type PlanUsage,
  type PlanUsageWindow,
} from './usage.js';

const NOW = 1_700_000_000_000;

function usage(
  windows: readonly (Pick<PlanUsageWindow, 'id' | 'utilization'> & { label?: string })[],
  overrides: Partial<PlanUsage> = {},
): PlanUsage {
  return {
    available: true,
    fetchedAt: NOW,
    windows: windows.map((w) => ({
      id: w.id,
      label: w.label ?? w.id,
      utilization: w.utilization,
      resetsAt: null,
    })),
    ...overrides,
  };
}

describe('planHeadroom', () => {
  it('measures the window closest to full, not the average', () => {
    // 5% weekly and 98% five-hourly is an account with 2% of room. An average
    // would call it 48% and send someone into a wall.
    const reading = usage([
      { id: 'seven_day', utilization: 5 },
      { id: 'five_hour', utilization: 98 },
    ]);
    expect(planHeadroom(reading)).toBe(2);
  });

  it('is null when there is no plan, and 0 when the plan is full', () => {
    // The distinction the meter turns on: "not applicable" must not render as
    // "nothing used", and "full" must not render as "unknown".
    expect(planHeadroom({ available: false, windows: [], fetchedAt: NOW })).toBeNull();
    expect(planHeadroom(usage([{ id: 'five_hour', utilization: 100 }]))).toBe(0);
  });

  it('is null when every window omits its number', () => {
    expect(planHeadroom(usage([{ id: 'five_hour', utilization: null }]))).toBeNull();
  });

  it('is null for a reading that does not exist', () => {
    expect(planHeadroom(null)).toBeNull();
    expect(planHeadroom(undefined)).toBeNull();
  });
});

describe('recommendProfile', () => {
  it('names the account with the most room, and the window that decides it', () => {
    const result = recommendProfile(
      [
        { profileId: 'work', usage: usage([{ id: 'five_hour', utilization: 90 }]) },
        {
          profileId: 'personal',
          usage: usage([
            { id: 'five_hour', utilization: 30 },
            { id: 'seven_day', utilization: 40, label: '7 days' },
          ]),
        },
      ],
      { now: NOW },
    );

    expect(result?.profileId).toBe('personal');
    // 60, from the weekly window — the tighter of that account's two.
    expect(result?.headroom).toBe(60);
    expect(result?.binding.label).toBe('7 days');
    expect(result?.candidates).toBe(2);
  });

  it('never recommends an account that bills per token', () => {
    /*
      The exclusion that matters most. An API-key or Bedrock profile reports
      `available: false` because it is metered rather than capped; ranking it
      would read as infinite room and turn "my plan is full" into a silent
      switch to per-token billing.
    */
    const result = recommendProfile(
      [
        { profileId: 'plan', usage: usage([{ id: 'five_hour', utilization: 99 }]) },
        {
          profileId: 'metered',
          usage: { available: false, windows: [], fetchedAt: NOW },
        },
      ],
      { now: NOW },
    );

    expect(result).toBeNull();
  });

  it('ignores a reading older than the staleness window', () => {
    const stale = usage([{ id: 'five_hour', utilization: 10 }], {
      fetchedAt: NOW - PLAN_USAGE_MAX_AGE_MS - 1,
    });
    const fresh = usage([{ id: 'five_hour', utilization: 80 }]);

    // The stale account has far more room on paper and is still not the answer:
    // it may have been drained by another window since it was read.
    expect(
      recommendProfile(
        [
          { profileId: 'stale', usage: stale },
          { profileId: 'fresh', usage: fresh },
          { profileId: 'other', usage: usage([{ id: 'five_hour', utilization: 85 }]) },
        ],
        { now: NOW },
      )?.profileId,
    ).toBe('fresh');
  });

  it('treats a reading stamped in the future as current, not infinitely stale', () => {
    // A clock disagreeing with itself is not evidence that the reading is old.
    const result = recommendProfile(
      [
        { profileId: 'ahead', usage: usage([{ id: 'five_hour', utilization: 10 }], { fetchedAt: NOW + 60_000 }) },
        { profileId: 'here', usage: usage([{ id: 'five_hour', utilization: 50 }]) },
      ],
      { now: NOW },
    );
    expect(result?.profileId).toBe('ahead');
  });

  it('says nothing when only one account can be ranked', () => {
    // A "Recommended" heading over the only profile with a plan repeats the row
    // below it. The section earns its space when there is a choice.
    expect(
      recommendProfile([{ profileId: 'only', usage: usage([{ id: 'five_hour', utilization: 20 }]) }], {
        now: NOW,
      }),
    ).toBeNull();
  });

  it('skips accounts that have never been read', () => {
    expect(
      recommendProfile(
        [
          { profileId: 'known', usage: usage([{ id: 'five_hour', utilization: 20 }]) },
          { profileId: 'unread', usage: null },
          { profileId: 'missing', usage: undefined },
        ],
        { now: NOW },
      ),
    ).toBeNull();
  });

  it('skips an account whose windows all omit their numbers', () => {
    const result = recommendProfile(
      [
        { profileId: 'blank', usage: usage([{ id: 'five_hour', utilization: null }]) },
        { profileId: 'a', usage: usage([{ id: 'five_hour', utilization: 20 }]) },
        { profileId: 'b', usage: usage([{ id: 'five_hour', utilization: 30 }]) },
      ],
      { now: NOW },
    );
    expect(result?.profileId).toBe('a');
    expect(result?.candidates).toBe(2);
  });

  it('keeps the caller order on a tie, so the label does not swap between polls', () => {
    const tied = [
      { profileId: 'first', usage: usage([{ id: 'five_hour', utilization: 40 }]) },
      { profileId: 'second', usage: usage([{ id: 'five_hour', utilization: 40 }]) },
    ];
    expect(recommendProfile(tied, { now: NOW })?.profileId).toBe('first');
    // Same inputs, same answer — the property that makes it stable across polls.
    expect(recommendProfile(tied, { now: NOW })?.profileId).toBe('first');
  });

  it('recommends a full account when it is the least full one', () => {
    // Everything is exhausted and the menu still has to answer honestly rather
    // than go blank: 0% free is a fact, and hiding it would read as "no data".
    const result = recommendProfile(
      [
        { profileId: 'a', usage: usage([{ id: 'five_hour', utilization: 100 }]) },
        { profileId: 'b', usage: usage([{ id: 'five_hour', utilization: 100 }]) },
      ],
      { now: NOW },
    );
    expect(result?.headroom).toBe(0);
  });

  it('answers null for no accounts at all', () => {
    expect(recommendProfile([], { now: NOW })).toBeNull();
  });

  describe('across plans', () => {
    /*
      The limit of what any of this can claim. Providers report utilization as a
      percentage of a ceiling they never state — the Claude payload is
      `utilization` plus `resets_at`, and `subscription_type` is a bare word
      that cannot separate one Max tier from another. So a ranking across plans
      is a ranking of percentages unless every plan involved publishes its size
      relative to its provider's baseline — which is what `basis` reports, so
      the UI can word the claim to match what was actually compared.
    */
    it('claims a like-for-like comparison only when one plan is involved', () => {
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 70 }], { subscriptionType: 'max' }),
          },
          {
            profileId: 'b',
            usage: usage([{ id: 'five_hour', utilization: 20 }], { subscriptionType: 'max' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('b');
      expect(result?.basis).toBe('same-plan');
      expect(result?.subscriptionType).toBe('max');
    });

    it('does not claim one when the accounts are on different plans', () => {
      // A team account 60% free may hold less work than a max account 40% free.
      // The ranking still happens — a percentage ranking is useful — but it is
      // flagged so the row can say "of its own plan" instead of "most room".
      const result = recommendProfile(
        [
          {
            profileId: 'work',
            usage: usage([{ id: 'five_hour', utilization: 60 }], { subscriptionType: 'max' }),
          },
          {
            profileId: 'team',
            usage: usage([{ id: 'five_hour', utilization: 40 }], { subscriptionType: 'team' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('team');
      expect(result?.basis).toBe('percentage');
      expect(result?.subscriptionType).toBe('team');
    });

    it('treats an unreported plan as its own kind rather than as a match', () => {
      // "Unknown" is not evidence of being the same plan as "max".
      const result = recommendProfile(
        [
          {
            profileId: 'named',
            usage: usage([{ id: 'five_hour', utilization: 50 }], { subscriptionType: 'max' }),
          },
          { profileId: 'unnamed', usage: usage([{ id: 'five_hour', utilization: 10 }]) },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('unnamed');
      expect(result?.basis).toBe('percentage');
      expect(result?.subscriptionType).toBeUndefined();
    });

    it('reads two spellings of one plan as one plan', () => {
      // The tier is a free-text string from the provider; `Max` and `max` are
      // not two plans, and treating them as such would hedge a comparison that
      // is in fact like-for-like.
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 50 }], { subscriptionType: 'Max' }),
          },
          {
            profileId: 'b',
            usage: usage([{ id: 'five_hour', utilization: 10 }], { subscriptionType: 'max' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('same-plan');
    });

    it('ignores the plan of an account that was never in the running', () => {
      // A metered profile is excluded before ranking, so its (absent) plan must
      // not be what drops the basis from same-plan to percentage.
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 50 }], { subscriptionType: 'max' }),
          },
          {
            profileId: 'b',
            usage: usage([{ id: 'five_hour', utilization: 10 }], { subscriptionType: 'max' }),
          },
          { profileId: 'api-key', usage: { available: false, windows: [], fetchedAt: NOW } },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('same-plan');
      expect(result?.candidates).toBe(2);
    });
  });

  describe('weighted by plan size', () => {
    /*
      The question a percentage ranking gets wrong, and the one the plan table
      exists to answer: a Max plan holds twenty times a Pro plan's session, so
      the account with the smaller *share* free can easily have far more room.
      Providers publish that ratio in the product name even though they publish
      no absolute capacity, and a ratio is all an ordering needs.
    */
    const claude = (utilization: number, plan: string, subscriptionType: string) => ({
      usage: usage([{ id: 'five_hour', utilization }], { subscriptionType }),
      providerId: 'claude' as const,
      capacity: resolvePlanWeight({ providerId: 'claude', pinned: plan }),
    });

    it('prefers the bigger plan when the smaller one has a larger share free', () => {
      const result = recommendProfile(
        [
          { profileId: 'pro', ...claude(10, 'claude:pro', 'pro') },
          { profileId: 'max', ...claude(70, 'claude:max-20x', 'max') },
        ],
        { now: NOW },
      );

      // Pro is 90% free and Max 20x is 30% free — but 30% of twenty Pro windows
      // is six Pro windows, against nine tenths of one.
      expect(result?.profileId).toBe('max');
      expect(result?.basis).toBe('weighted');
      expect(result?.plan?.label).toBe('Max 20x');
    });

    it('still prefers the smaller plan when it genuinely has more capacity', () => {
      // The weighting has to be able to lose, or it is not a comparison at all.
      // An untouched Pro window scores 100; a Max 20x with 1% of its window
      // left scores 20. Twenty times a sliver is still less than a whole one.
      const result = recommendProfile(
        [
          { profileId: 'pro', ...claude(0, 'claude:pro', 'pro') },
          { profileId: 'max', ...claude(99, 'claude:max-20x', 'max') },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('pro');
      expect(result?.basis).toBe('weighted');
    });

    it('falls back to percentages when any plan publishes no ratio', () => {
      // A Team seat is not sold as a multiple of Pro, so the set cannot be
      // weighed at all — one unweighable account demotes the whole comparison.
      const result = recommendProfile(
        [
          { profileId: 'pro', ...claude(10, 'claude:pro', 'pro') },
          {
            profileId: 'team',
            usage: usage([{ id: 'five_hour', utilization: 70 }], { subscriptionType: 'team' }),
            providerId: 'claude',
            capacity: resolvePlanWeight({ providerId: 'claude', subscriptionType: 'team' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('percentage');
      expect(result?.profileId).toBe('pro');
    });

    it('never weighs one provider against another', () => {
      /*
        Both baselines weigh 1 and they are not the same size: Claude Pro and
        Codex Plus are each their own provider's smallest paid plan, and nobody
        publishes a rate between them. Two fully-documented plans still cannot
        be compared by capacity across that line.
      */
      const result = recommendProfile(
        [
          { profileId: 'claude', ...claude(70, 'claude:max-20x', 'max') },
          {
            profileId: 'codex',
            usage: usage([{ id: 'primary', utilization: 10 }], { subscriptionType: 'plus' }),
            providerId: 'codex',
            capacity: resolvePlanWeight({ providerId: 'codex', pinned: 'codex:plus' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('percentage');
      // And so the winner is the one with the larger share, not the larger plan.
      expect(result?.profileId).toBe('codex');
    });

    it('reports that an unpinned tier was assumed', () => {
      // `max` alone cannot say which Max. The floor is used, the ranking still
      // happens, and the flag is what lets the UI offer to be told.
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 70 }], { subscriptionType: 'max' }),
            providerId: 'claude',
            capacity: resolvePlanWeight({ providerId: 'claude', subscriptionType: 'max' }),
          },
          { profileId: 'b', ...claude(80, 'claude:pro', 'pro') },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('a');
      expect(result?.basis).toBe('weighted');
      expect(result?.assumedPlan).toBe(true);
      // The floor, not the tier the account might actually be on.
      expect(result?.plan?.label).toBe('Max 5x');
    });

    it('does not call a same-plan set weighted', () => {
      // Multiplying every side by the same number changes no order, and "most
      // room" is the stronger, simpler claim. See `basisFor`.
      const result = recommendProfile(
        [
          { profileId: 'a', ...claude(70, 'claude:max-20x', 'max') },
          { profileId: 'b', ...claude(20, 'claude:max-20x', 'max') },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('same-plan');
    });
  });
});
