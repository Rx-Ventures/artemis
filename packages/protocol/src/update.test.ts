/**
 * How far along an update is, when it can be said at all.
 *
 * The whole point of the type is that half its steps cannot count — an
 * unpacking `ditto` says nothing, a chunked download has no `content-length` —
 * so what is worth pinning here is the *refusals*. Every one of them exists
 * because the alternative is a bar that moves without meaning anything, which
 * is the failure this feature was written to end rather than to relocate.
 */

import { describe, expect, it } from 'vitest';

import { updatePercent, type UpdateProgress } from './update.js';

const at = (transferred: number | null, total: number | null): UpdateProgress => ({
  step: 'downloading',
  transferred,
  total,
});

describe('updatePercent', () => {
  it('reports the fraction, rounded for a place a person reads', () => {
    expect(updatePercent(at(50, 200))).toBe(25);
    expect(updatePercent(at(1, 3))).toBe(33);
    expect(updatePercent(at(2, 3))).toBe(67);
  });

  it('says nothing rather than something invented when a count is missing', () => {
    // The two honest unknowns: a step that cannot count its own progress, and
    // a server that never said how much it was sending.
    expect(updatePercent(at(null, 200))).toBeNull();
    expect(updatePercent(at(50, null))).toBeNull();
    expect(updatePercent(null)).toBeNull();
    expect(updatePercent(undefined)).toBeNull();
  });

  it('refuses a zero total rather than dividing by it', () => {
    // `0/0` is NaN and `50/0` is Infinity; both reach a style attribute as a
    // bar that renders wrong rather than not at all.
    expect(updatePercent(at(0, 0))).toBeNull();
    expect(updatePercent(at(50, 0))).toBeNull();
    expect(updatePercent(at(50, -1))).toBeNull();
  });

  it('refuses counts that are not finite numbers', () => {
    expect(updatePercent(at(Number.NaN, 200))).toBeNull();
    expect(updatePercent(at(50, Number.POSITIVE_INFINITY))).toBeNull();
  });

  it('clamps a body larger than the length its server promised', () => {
    // The counts come from different places — the byte counter and the header
    // — so they can disagree, and a bar past its own end is a rendering bug
    // dressed as a reading.
    expect(updatePercent(at(300, 200))).toBe(100);
    expect(updatePercent(at(-5, 200))).toBe(0);
  });

  it('is 0 at the start and 100 at the end, exactly', () => {
    // Both ends are load-bearing: 0 is what says a determinate bar exists at
    // all, and 100 is what stops it resting at 99 while the next step runs.
    expect(updatePercent(at(0, 200))).toBe(0);
    expect(updatePercent(at(200, 200))).toBe(100);
  });
});
