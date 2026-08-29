/**
 * The three facts every model row knows, and the join that produces them.
 *
 * The bug class this file guards is the vocabulary gap: usage windows name
 * models the way the provider displays them (`model_scoped:Fable`), catalogues
 * name them the way the CLI addresses them (`claude-fable-5[1m]` live,
 * `fable` built-in), and a join by string equality matches nothing — which is
 * exactly how a pin once silently fell out of the picker (`models.test.ts`
 * has that story). Every derivation here must survive both spellings.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { describe, expect, it } from 'vitest';
import { PLAN_USAGE_MAX_AGE_MS } from '@rx-artemis/protocol';
import type { PlanUsage, ProviderModelOption } from '@rx-artemis/protocol';

import {
  MATERIAL_HEADROOM_GAP,
  costPosture,
  describeReset,
  modelExhaustion,
  modelPressure,
  modelScopedWindow,
  recommendModel,
} from './modelFacts';

/* The same model, in each catalogue's vocabulary. */
const FABLE_BUILT_IN: ProviderModelOption = {
  id: 'fable',
  label: 'Fable 5',
  resolvedModel: 'claude-fable-5',
  note: '',
};
const FABLE_LIVE: ProviderModelOption = {
  id: 'claude-fable-5[1m]',
  label: 'Fable 5',
  resolvedModel: 'claude-fable-5',
  note: '',
};
const SONNET: ProviderModelOption = {
  id: 'sonnet',
  label: 'Sonnet 5',
  resolvedModel: 'claude-sonnet-5',
  note: '',
};
const OPUS: ProviderModelOption = {
  id: 'opus',
  label: 'Opus 5',
  resolvedModel: 'claude-opus-5',
  note: '',
};

const NOW = 1_700_000_000_000;

function usage(
  windows: readonly {
    readonly id: string;
    readonly utilization: number | null;
    readonly status?: 'ok' | 'warning' | 'rejected';
    readonly resetsAt?: number | null;
  }[],
  fetchedAt = NOW,
): PlanUsage {
  return {
    available: true,
    fetchedAt,
    windows: windows.map((w) => ({
      id: w.id,
      label: w.id.replace(/_/g, ' '),
      utilization: w.utilization,
      resetsAt: w.resetsAt ?? null,
      ...(w.status === undefined ? {} : { status: w.status }),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Identity joins                                                             */
/* -------------------------------------------------------------------------- */

describe('joining a usage window to a catalogue entry', () => {
  it('matches the display name against the live catalogue id', () => {
    // The pair that string equality gets wrong: the window says "Fable", the
    // live catalogue says "claude-fable-5[1m]".
    const reading = usage([{ id: 'model_scoped:Fable', utilization: 50 }]);
    expect(modelScopedWindow(FABLE_LIVE, reading)?.id).toBe('model_scoped:Fable');
  });

  it('matches the display name against the built-in alias', () => {
    const reading = usage([{ id: 'model_scoped:Fable', utilization: 50 }]);
    expect(modelScopedWindow(FABLE_BUILT_IN, reading)?.id).toBe('model_scoped:Fable');
  });

  it('does not hand one model’s bucket to another', () => {
    const reading = usage([{ id: 'model_scoped:Fable', utilization: 50 }]);
    expect(modelScopedWindow(SONNET, reading)).toBeNull();
    expect(modelScopedWindow(OPUS, reading)).toBeNull();
  });

  it('skips an unnamed model_scoped window rather than guessing', () => {
    // A verdict that cannot be attached to a model must not disable one.
    const reading = usage([{ id: 'model_scoped', utilization: 99, status: 'rejected' }]);
    expect(modelScopedWindow(FABLE_LIVE, reading)).toBeNull();
  });

  it('answers nothing off a metered account', () => {
    const metered: PlanUsage = { available: false, windows: [], fetchedAt: NOW };
    expect(modelScopedWindow(FABLE_LIVE, metered)).toBeNull();
    expect(modelScopedWindow(FABLE_LIVE, null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Fact 1: exhaustion                                                         */
/* -------------------------------------------------------------------------- */

describe('exhaustion', () => {
  it('fires only on the provider’s rejected verdict, never a percentage', () => {
    // 99% is a forecast; rejected is a fact. The row disables on the fact.
    const nearlyOut = usage([{ id: 'model_scoped:Fable', utilization: 99 }]);
    expect(modelExhaustion(FABLE_LIVE, nearlyOut, NOW)).toBeNull();

    const out = usage([{ id: 'model_scoped:Fable', utilization: 97, status: 'rejected' }]);
    expect(modelExhaustion(FABLE_LIVE, out, NOW)).not.toBeNull();
  });

  it('carries the reason and the reset time inline', () => {
    const resetsAt = NOW + 4 * 60 * 60_000;
    const out = usage([
      { id: 'model_scoped:Fable', utilization: 97, status: 'rejected', resetsAt },
    ]);
    const exhaustion = modelExhaustion(FABLE_LIVE, out, NOW);
    expect(exhaustion?.reason).toMatch(/limit is reached — requests are being refused/);
    expect(exhaustion?.reason).toMatch(/resets /);
  });

  it('does not disable Sonnet because Fable is out', () => {
    const out = usage([{ id: 'model_scoped:Fable', utilization: 97, status: 'rejected' }]);
    expect(modelExhaustion(SONNET, out, NOW)).toBeNull();
  });

  it('is not triggered by a rejected shared window', () => {
    // A spent five-hour window stops everything; that is pressure, not this
    // model's own bucket, and the row must not claim the model was singled out.
    const out = usage([{ id: 'five_hour', utilization: 100, status: 'rejected' }]);
    expect(modelExhaustion(FABLE_LIVE, out, NOW)).toBeNull();
  });
});

describe('describeReset', () => {
  it('answers nothing when the provider reported nothing', () => {
    expect(describeReset(null, NOW)).toBeNull();
  });

  it('says a past reset is happening now rather than printing a stale clock', () => {
    expect(describeReset(NOW - 1, NOW)).toBe('resetting now');
  });

  it('leads with the wall-clock time', () => {
    expect(describeReset(NOW + 60 * 60_000, NOW)).toMatch(/^resets /);
  });
});

/* -------------------------------------------------------------------------- */
/* Fact 2: pressure                                                           */
/* -------------------------------------------------------------------------- */

describe('pressure', () => {
  it('binds every model with the shared windows', () => {
    const reading = usage([
      { id: 'five_hour', utilization: 64 },
      { id: 'seven_day', utilization: 12 },
    ]);
    const pressure = modelPressure(SONNET, reading);
    expect(pressure?.window.id).toBe('five_hour');
    expect(pressure?.utilization).toBe(64);
  });

  it('lets a model’s own bucket outbind the shared windows', () => {
    const reading = usage([
      { id: 'five_hour', utilization: 20 },
      { id: 'model_scoped:Fable', utilization: 80 },
    ]);
    expect(modelPressure(FABLE_LIVE, reading)?.window.id).toBe('model_scoped:Fable');
    // …and only that model's: Sonnet is bound by the shared window.
    expect(modelPressure(SONNET, reading)?.window.id).toBe('five_hour');
  });

  it('lets a rejected verdict outrank any percentage', () => {
    const reading = usage([
      { id: 'five_hour', utilization: 90 },
      { id: 'model_scoped:Fable', utilization: 40, status: 'rejected' },
    ]);
    const pressure = modelPressure(FABLE_LIVE, reading);
    expect(pressure?.window.status).toBe('rejected');
    expect(pressure?.window.id).toBe('model_scoped:Fable');
  });

  it('answers nothing when there is no usable number', () => {
    const reading = usage([{ id: 'five_hour', utilization: null }]);
    expect(modelPressure(SONNET, reading)).toBeNull();
    expect(modelPressure(SONNET, null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Fact 3: cost posture                                                       */
/* -------------------------------------------------------------------------- */

describe('cost posture', () => {
  it('prints the exact MODEL_LOAD multipliers', () => {
    // The settled decision names these numbers; the rows must show them.
    expect(costPosture({ id: 'haiku', label: 'Haiku', note: '' })?.multiplier).toBe(0.25);
    expect(costPosture(SONNET)?.multiplier).toBe(1);
    expect(costPosture(OPUS)?.multiplier).toBe(4);
    expect(costPosture(FABLE_BUILT_IN)?.multiplier).toBe(8);
  });

  it('resolves the same posture from every spelling of the model', () => {
    expect(costPosture(FABLE_LIVE)).toEqual(costPosture(FABLE_BUILT_IN));
  });

  it('orders the pips with the multipliers', () => {
    const pips = (m: ProviderModelOption) => costPosture(m)?.pips ?? 0;
    expect(pips({ id: 'haiku', label: 'Haiku', note: '' })).toBeLessThan(pips(SONNET));
    expect(pips(SONNET)).toBeLessThan(pips(OPUS));
    expect(pips(OPUS)).toBeLessThan(pips(FABLE_LIVE));
  });

  it('says nothing about a family the table has never heard of', () => {
    // No pips is honest; a confident default multiplier is a guess printed as
    // a fact — the difference between this and `modelLoadFactor`'s fallback.
    expect(costPosture({ id: 'gpt-9', label: 'GPT-9', note: '' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The Recommended row                                                        */
/* -------------------------------------------------------------------------- */

describe('recommendModel', () => {
  const PINNED = [FABLE_LIVE, SONNET, OPUS];

  /** Fable's bucket rejected, everything else roomy: Sonnet should win. */
  const fableOut = usage([
    { id: 'five_hour', utilization: 10 },
    { id: 'model_scoped:Fable', utilization: 97, status: 'rejected' },
  ]);

  it('names a pinned model with materially more headroom', () => {
    const rec = recommendModel(PINNED, FABLE_LIVE, fableOut, NOW);
    expect(rec).not.toBeNull();
    // Sonnet and Opus tie at 90% headroom; the earlier pin keeps the title,
    // the same tie rule recommendProfile applies to accounts.
    expect(rec?.model.id).toBe('sonnet');
    expect(rec?.headroom).toBe(90);
    expect(rec?.selectedHeadroom).toBe(0);
    expect(rec?.candidates).toBe(3);
  });

  it('recognises the selected model under either of its names', () => {
    // The pane may hold the built-in alias while the pins hold the live id —
    // the join must go through modelIdentity, or the selected model would be
    // "not ranked" and the row would vanish.
    const rec = recommendModel(PINNED, FABLE_BUILT_IN, fableOut, NOW);
    expect(rec?.model.id).toBe('sonnet');
  });

  it('says nothing when the gap is not material', () => {
    const close = usage([
      { id: 'model_scoped:Fable', utilization: 50 },
      { id: 'model_scoped:Sonnet', utilization: 50 - MATERIAL_HEADROOM_GAP + 1 },
    ]);
    expect(recommendModel([FABLE_LIVE, SONNET], FABLE_LIVE, close, NOW)).toBeNull();
  });

  it('says nothing when the winner is the selected model', () => {
    const sonnetOut = usage([
      { id: 'model_scoped:Sonnet', utilization: 97, status: 'rejected' },
      { id: 'five_hour', utilization: 5 },
    ]);
    expect(recommendModel([FABLE_LIVE, SONNET], FABLE_LIVE, sonnetOut, NOW)).toBeNull();
  });

  it('says nothing on a stale reading', () => {
    // Same freshness bar as recommendProfile: a recommendation is a claim
    // about now, and it expires rather than quietly ageing.
    const old = usage(
      [
        { id: 'five_hour', utilization: 10 },
        { id: 'model_scoped:Fable', utilization: 97, status: 'rejected' },
      ],
      NOW - PLAN_USAGE_MAX_AGE_MS - 1,
    );
    expect(recommendModel(PINNED, FABLE_LIVE, old, NOW)).toBeNull();
  });

  it('says nothing with fewer than two rankable candidates', () => {
    const rec = recommendModel([FABLE_LIVE], FABLE_LIVE, fableOut, NOW);
    expect(rec).toBeNull();
  });

  it('says nothing with no reading, no plan, or no selection', () => {
    expect(recommendModel(PINNED, FABLE_LIVE, null, NOW)).toBeNull();
    expect(
      recommendModel(PINNED, FABLE_LIVE, { available: false, windows: [], fetchedAt: NOW }, NOW),
    ).toBeNull();
    expect(recommendModel(PINNED, undefined, fableOut, NOW)).toBeNull();
  });
});
