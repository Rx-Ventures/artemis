/**
 * The plan table, and the one inference it is allowed to make.
 *
 * This table is the only place in Artemis that claims to know something about a
 * provider's plans beyond what the provider's own payload said. That makes it
 * the file most able to be confidently wrong, so what is asserted here is
 * mostly the boundary of what it may contain: published ratios, never absolute
 * capacities; per-provider, never across; and a documented `null` wherever a
 * provider sells seats or credits instead of a multiple.
 */

import { describe, expect, it } from 'vitest';

import {
  PLAN_CAPACITIES,
  planCapacityById,
  plansForProvider,
  resolvePlanWeight,
} from './planCapacity.js';

describe('the plan table', () => {
  it('gives every plan a unique, provider-prefixed id', () => {
    // The id is stored on a profile and read back by a later build, so a
    // collision or a rename is a pin that silently stops applying.
    const ids = PLAN_CAPACITIES.map((plan) => plan.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const plan of PLAN_CAPACITIES) expect(plan.id.startsWith(`${plan.providerId}:`)).toBe(true);
  });

  it('gives each provider exactly one baseline plan', () => {
    // Weights are multiples *of* something. Two baselines on one provider, or
    // none, would make every ratio on that provider meaningless.
    for (const providerId of new Set(PLAN_CAPACITIES.map((p) => p.providerId))) {
      const baselines = plansForProvider(providerId).filter((plan) => plan.weight === 1);
      expect(baselines.length).toBe(1);
    }
  });

  it('gives each reported family exactly one floor', () => {
    /*
      The floor is what an unpinned account is assumed to be. A family with two
      floors would resolve arbitrarily; one with none would resolve to nothing
      and silently drop the account out of weighted ranking.
    */
    const families = new Map<string, number>();
    for (const plan of PLAN_CAPACITIES) {
      for (const reported of plan.reportedAs) {
        const key = `${plan.providerId}:${reported}`;
        if (plan.isFamilyFloor) families.set(key, (families.get(key) ?? 0) + 1);
      }
    }
    for (const count of families.values()) expect(count).toBe(1);
  });

  it('makes the floor of every family its smallest plan', () => {
    // "Assumed" is only safe because it understates. A floor that was not the
    // smallest tier would let an assumption flatter an account instead.
    for (const plan of PLAN_CAPACITIES) {
      if (!plan.isFamilyFloor || plan.weight === null) continue;
      const siblings = PLAN_CAPACITIES.filter(
        (other) =>
          other.providerId === plan.providerId &&
          other.reportedAs.some((r) => plan.reportedAs.includes(r)) &&
          other.weight !== null,
      );
      for (const sibling of siblings) expect(plan.weight).toBeLessThanOrEqual(sibling.weight ?? 0);
    }
  });

  it('carries no weight for plans sold as seats or credit pools', () => {
    // Team, Enterprise, Business: metered per seat or against a contract pool,
    // and published as a multiple of nothing. A weight here would be invented.
    for (const id of ['claude:team', 'claude:enterprise', 'codex:business', 'codex:enterprise']) {
      expect(planCapacityById(id)?.weight).toBeNull();
    }
  });

  it('keeps the published Max and Pro ratios', () => {
    // Anthropic: "Max 5x provides five times more usage per session than the
    // Pro plan"; "Max 20x provides 20 times". OpenAI documents Codex Pro the
    // same way against Plus. These are the only numbers the table asserts.
    expect(planCapacityById('claude:max-5x')?.weight).toBe(5);
    expect(planCapacityById('claude:max-20x')?.weight).toBe(20);
    expect(planCapacityById('codex:pro-5x')?.weight).toBe(5);
    expect(planCapacityById('codex:pro-20x')?.weight).toBe(20);
  });
});

describe('resolvePlanWeight', () => {
  it('assumes the floor of an ambiguous family, and says that it did', () => {
    // The whole reason profiles can pin a plan: `max` is both Max 5x and Max
    // 20x, four times apart, and the payload has nothing else to go on.
    const resolved = resolvePlanWeight({ providerId: 'claude', subscriptionType: 'max' });
    expect(resolved?.plan.id).toBe('claude:max-5x');
    expect(resolved?.weight).toBe(5);
    expect(resolved?.assumed).toBe(true);
  });

  it('does not call an unambiguous family an assumption', () => {
    const resolved = resolvePlanWeight({ providerId: 'claude', subscriptionType: 'pro' });
    expect(resolved?.plan.id).toBe('claude:pro');
    expect(resolved?.assumed).toBe(false);
  });

  it('lets a pin override the reported family', () => {
    const resolved = resolvePlanWeight({
      providerId: 'claude',
      subscriptionType: 'max',
      pinned: 'claude:max-20x',
    });
    expect(resolved?.weight).toBe(20);
    expect(resolved?.assumed).toBe(false);
  });

  it('ignores a pin belonging to another provider', () => {
    /*
      Reachable by repointing a profile at a different provider's config
      directory. Weighing a Codex plan on Claude's ladder is worse than not
      weighing at all, because both scales have a plan called "Pro".
    */
    const resolved = resolvePlanWeight({
      providerId: 'claude',
      subscriptionType: 'max',
      pinned: 'codex:pro-20x',
    });
    expect(resolved?.plan.id).toBe('claude:max-5x');
    expect(resolved?.assumed).toBe(true);
  });

  it('resolves a seat plan to a null weight rather than to nothing', () => {
    // The distinction the caller needs: "this is a Team account and Team
    // publishes no ratio" is a different answer from "no idea what this is",
    // and only the first can be shown to the user.
    const resolved = resolvePlanWeight({ providerId: 'claude', subscriptionType: 'team' });
    expect(resolved?.plan.id).toBe('claude:team');
    expect(resolved?.weight).toBeNull();
  });

  it('answers null when nothing identifies the plan', () => {
    expect(resolvePlanWeight({ providerId: 'claude' })).toBeNull();
    expect(resolvePlanWeight({ providerId: 'claude', subscriptionType: '' })).toBeNull();
    // A tier this build has never heard of. Falling back to the baseline would
    // rank an unknown plan as if it were the smallest one sold.
    expect(resolvePlanWeight({ providerId: 'claude', subscriptionType: 'ultra' })).toBeNull();
  });

  it('is case- and space-insensitive about what the provider reported', () => {
    expect(resolvePlanWeight({ providerId: 'claude', subscriptionType: ' Max ' })?.plan.id).toBe(
      'claude:max-5x',
    );
  });
});
