/**
 * How heavily one live run weighs on the account it is running on.
 *
 * The constants this file exercises are an informed guess and say so in their
 * own header. So almost nothing here asserts a *magnitude* — the assertions are
 * about **ordering** and **invariants**, which are the parts that have to stay
 * true when somebody calibrates the numbers against real consumption. A test
 * that pinned `runLoadFactor` at 48 would fail on the day the guess improved,
 * which is the day it should be easiest to change.
 *
 * The one relationship worth naming out loud is the one the whole table exists
 * to encode: **a Fable ultracode session weighs more than an Opus max one**,
 * despite `max` sitting above `xhigh` on the effort ladder the picker draws.
 * Effort lengthens one turn; ultracode multiplies how many turns there are.
 */

import { describe, expect, it } from 'vitest';

import {
  BASELINE_RESERVATION_POINTS,
  effortLoadFactor,
  modelLoadFactor,
  reservationFor,
  runLoadFactor,
  ULTRACODE_MULTIPLIER,
} from './planLoad.js';

describe('modelLoadFactor', () => {
  it('orders the families small to large', () => {
    expect(modelLoadFactor('haiku')).toBeLessThan(modelLoadFactor('sonnet'));
    expect(modelLoadFactor('sonnet')).toBeLessThan(modelLoadFactor('opus'));
    expect(modelLoadFactor('opus')).toBeLessThan(modelLoadFactor('fable'));
  });

  it('reads a family out of whatever spelling the catalogue used', () => {
    // Ids are not stable across catalogues — the built-in list says `fable`,
    // a live one says `claude-fable-5[1m]`. A table keyed by id would fall
    // through to the default the moment a live catalogue landed, silently
    // reweighting every running session.
    const expected = modelLoadFactor('fable');
    for (const id of ['fable', 'claude-fable-5', 'claude-fable-5[1m]', 'CLAUDE-FABLE-5']) {
      expect(modelLoadFactor(id)).toBe(expected);
    }
  });

  it('assumes a middling model for one it has never heard of', () => {
    // Not the largest. This is a guess about an unknown id, and guessing "most
    // expensive" would push the recommender off an account on no evidence.
    expect(modelLoadFactor('gpt-5.4')).toBe(modelLoadFactor('sonnet'));
    expect(modelLoadFactor('')).toBe(modelLoadFactor('sonnet'));
    expect(modelLoadFactor(null)).toBe(modelLoadFactor('sonnet'));
    expect(modelLoadFactor(undefined)).toBe(modelLoadFactor('sonnet'));
    expect(modelLoadFactor('gpt-5.4')).toBeLessThan(modelLoadFactor('fable'));
  });
});

describe('effortLoadFactor', () => {
  it('climbs the ladder', () => {
    const ladder = ['low', 'medium', 'high', 'xhigh', 'max'].map(effortLoadFactor);
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1] as number);
    }
  });

  it('falls back to medium, where both providers default', () => {
    expect(effortLoadFactor('enthusiastic')).toBe(effortLoadFactor('medium'));
    expect(effortLoadFactor(null)).toBe(effortLoadFactor('medium'));
    expect(effortLoadFactor(undefined)).toBe(effortLoadFactor('medium'));
    expect(effortLoadFactor('')).toBe(effortLoadFactor('medium'));
  });
});

describe('runLoadFactor', () => {
  it('weighs a Fable ultracode run above an Opus max one', () => {
    // The relationship the table exists to encode, and the one a recalibration
    // must preserve. `max` outranks `xhigh` on the ladder; ultracode still wins,
    // because it multiplies the number of turns rather than their depth.
    const fable = runLoadFactor({ model: 'fable', effort: 'xhigh', ultracode: true });
    const opus = runLoadFactor({ model: 'opus', effort: 'max' });
    expect(fable).toBeGreaterThan(opus);
  });

  it('compounds model and effort', () => {
    expect(runLoadFactor({ model: 'opus', effort: 'max' })).toBe(
      modelLoadFactor('opus') * effortLoadFactor('max'),
    );
  });

  it('applies ultracode on top of whatever effort was set', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const plain = runLoadFactor({ model: 'sonnet', effort });
      expect(runLoadFactor({ model: 'sonnet', effort, ultracode: true })).toBe(
        plain * ULTRACODE_MULTIPLIER,
      );
    }
  });

  it('treats an absent flag as off', () => {
    const plain = runLoadFactor({ model: 'sonnet', effort: 'high' });
    expect(runLoadFactor({ model: 'sonnet', effort: 'high', ultracode: false })).toBe(plain);
    expect(runLoadFactor({ model: 'sonnet', effort: 'high' })).toBe(plain);
  });

  it('answers for a run it knows nothing about', () => {
    // A run whose model and effort are both unreported still reserves
    // *something*: it is running, and that is the fact the recommender was
    // missing. Silence must not read as "free".
    expect(runLoadFactor({})).toBeGreaterThan(0);
  });
});

describe('reservationFor', () => {
  it('is nothing for an idle account', () => {
    expect(reservationFor([])).toBe(0);
    expect(reservationFor(undefined)).toBe(0);
  });

  it('adds up, because the second session is the one that was being missed', () => {
    const one = reservationFor([{ model: 'sonnet', effort: 'medium' }]);
    const two = reservationFor([
      { model: 'sonnet', effort: 'medium' },
      { model: 'sonnet', effort: 'medium' },
    ]);
    expect(two).toBe(one * 2);
  });

  it('is denominated in baseline points', () => {
    // The one magnitude worth pinning: a Sonnet/medium run is the unit the
    // single tuning knob is expressed in, so this is the definition of that
    // knob rather than a claim about real consumption.
    expect(reservationFor([{ model: 'sonnet', effort: 'medium' }])).toBe(
      BASELINE_RESERVATION_POINTS,
    );
  });

  it('is not clamped, so six heavy sessions outweigh three', () => {
    // Flattening everything past 100 to "full" would put the choice between
    // over-committed accounts back to list order — quite possibly landing on
    // the most loaded one. See `recommendProfile`, which does not clamp either.
    const three = reservationFor(
      Array.from({ length: 3 }, () => ({ model: 'fable', effort: 'xhigh', ultracode: true })),
    );
    const six = reservationFor(
      Array.from({ length: 6 }, () => ({ model: 'fable', effort: 'xhigh', ultracode: true })),
    );
    expect(six).toBeGreaterThan(three);
    expect(six).toBe(three * 2);
  });
});
