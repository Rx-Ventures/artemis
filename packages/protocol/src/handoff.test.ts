/**
 * When the work should be handed on.
 *
 * The policy, tested apart from anything that acts on it — which is the point of
 * `handoffTrigger` being a pure function of a reading and a set of rules. Every
 * case here is built from literals; whether the reading itself is fresh is a
 * different question and has a different home.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HANDOFF_THRESHOLDS,
  handoffTrigger,
  windowFor,
  type HandoffThreshold,
} from './handoff.js';
import type { PlanUsage, PlanUsageWindow } from './usage.js';

const window = (
  id: string,
  utilization: number | null,
  label = id,
): PlanUsageWindow => ({ id, label, utilization, resetsAt: null });

const usage = (...windows: PlanUsageWindow[]): PlanUsage => ({
  available: true,
  windows,
  fetchedAt: 0,
});

describe('handoffTrigger', () => {
  it('says nothing while every window is under its own threshold', () => {
    expect(
      handoffTrigger(usage(window('five_hour', 89), window('seven_day', 97))),
    ).toBeNull();
  });

  it('fires on the 5-hour window at 90', () => {
    // Boundary included: "reach 90%" means 90 is the moment, not the first
    // reading after it.
    const trigger = handoffTrigger(usage(window('five_hour', 90)));
    expect(trigger?.threshold.id).toBe('five_hour');
    expect(trigger?.utilization).toBe(90);
  });

  it('holds the weekly window to a much tighter margin than the 5-hour one', () => {
    // The asymmetry is the whole design: 5-hourly refills within the day, so
    // margin there is cheap. Weekly is gone for days, so it is ridden close to
    // the edge. A single threshold for both would either waste a week's budget
    // or hand off too late to matter.
    expect(handoffTrigger(usage(window('seven_day', 94)))).toBeNull();
    expect(handoffTrigger(usage(window('five_hour', 94)))?.threshold.id).toBe('five_hour');
    expect(handoffTrigger(usage(window('seven_day', 98)))?.threshold.id).toBe('seven_day');
  });

  it('finds Fable however the account happens to spell its bucket', () => {
    // The per-model buckets vary by account. A rule written against one
    // account's spelling would silently never fire on the next, which is the
    // failure mode that argues for matching a family rather than an id.
    const trigger = handoffTrigger(usage(window('model_scoped:Fable', 96, 'Fable')));
    expect(trigger?.threshold.id).toBe('fable');

    const byLabel = handoffTrigger(usage(window('model_scoped', 96, 'Fable weekly')));
    expect(byLabel?.threshold.id).toBe('fable');
  });

  it('does not read another model’s bucket as Fable’s', () => {
    expect(handoffTrigger(usage(window('model_scoped:Opus', 99, 'Opus')))).toBeNull();
  });

  it('takes the fullest bucket within the model family', () => {
    // Same reasoning as `focusedWindow`: averaging several buckets describes
    // none of them, and the one closest to full is the one that will stop you.
    const found = windowFor(
      usage(window('model_scoped:Fable', 40, 'Fable'), window('model_scoped:Fable-hi', 96, 'Fable')),
      DEFAULT_HANDOFF_THRESHOLDS[2] as HandoffThreshold,
    );
    expect(found?.utilization).toBe(96);
  });

  it('treats an unreported reading as unknown rather than as full or empty', () => {
    // `null` means the provider did not say. Reading it as 0 would suppress a
    // handoff that was due; reading it as 100 would fire one on no evidence.
    expect(handoffTrigger(usage(window('five_hour', null)))).toBeNull();
    expect(handoffTrigger(usage(window('five_hour', null), window('seven_day', 99)))?.threshold.id).toBe(
      'seven_day',
    );
  });

  it('says nothing at all for an account with no plan limits', () => {
    // API-key, Bedrock and Vertex billing is metered rather than capped, and
    // `available: false` is the documented, expected state for it — not an
    // error, and not a reason to hand anything off.
    expect(handoffTrigger({ available: false, windows: [], fetchedAt: 0 })).toBeNull();
    expect(handoffTrigger(null)).toBeNull();
    expect(handoffTrigger(undefined)).toBeNull();
  });

  it('reports in threshold order when more than one rule is met', () => {
    // Both are true, and either is a correct thing to say. Order beats picking
    // by overshoot because the result becomes a sentence a person reads, and
    // arithmetic nobody can see is a poor way to choose one.
    const trigger = handoffTrigger(usage(window('seven_day', 99), window('five_hour', 99)));
    expect(trigger?.threshold.id).toBe('five_hour');
  });

  it('honours thresholds it is given instead of the defaults', () => {
    const strict: readonly HandoffThreshold[] = [
      { id: 'five_hour', label: '5-hour', at: 50, match: { kind: 'window', id: 'five_hour' } },
    ];
    expect(handoffTrigger(usage(window('five_hour', 60)), strict)?.utilization).toBe(60);
    expect(handoffTrigger(usage(window('five_hour', 60)))).toBeNull();
  });

  it('rounds the reading it reports, because it is going into a sentence', () => {
    expect(handoffTrigger(usage(window('five_hour', 90.4)))?.utilization).toBe(90);
    expect(handoffTrigger(usage(window('five_hour', 90.6)))?.utilization).toBe(91);
  });
});
