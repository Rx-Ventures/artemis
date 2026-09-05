/**
 * The plan windows, drawn as bars.
 *
 * A bar is read at a glance where three percentages have to be compared, so
 * it has to be honest at both ends: a window someone has started on must not
 * look untouched, and a window that is not yet full must not look full.
 */

import { describe, expect, it } from 'vitest';

import { meterBar, meterCells } from './StatusBar.js';

describe('meterBar', () => {
  it('fills in proportion', () => {
    expect(meterBar(0, 8)).toBe('░░░░░░░░');
    expect(meterBar(50, 8)).toBe('████░░░░');
    expect(meterBar(100, 8)).toBe('████████');
  });

  it('lights the first cell for any use at all', () => {
    // 1% of eight cells rounds to nothing; a window being used must not read
    // as a window untouched.
    expect(meterBar(1, 8)).toBe('█░░░░░░░');
    expect(meterBar(0.4, 8)).toBe('█░░░░░░░');
  });

  it('holds the last cell back until the window really is full', () => {
    // Otherwise 97% and 100% are the same picture, and the one that matters
    // is the one that stops you working.
    expect(meterBar(97, 8)).toBe('███████░');
    expect(meterBar(99.6, 8)).toBe('███████░');
    expect(meterBar(100, 8)).toBe('████████');
    expect(meterBar(140, 8)).toBe('████████');
  });
});

describe('meterCells', () => {
  it('gives up the bars before it squeezes the line beside them', () => {
    // The readings sit in a box that does not shrink; every cell is a column
    // taken from the account and model line, which truncates. Eight cells
    // each cost "BYPASS PERMISSIONS" its tail on a 140-column terminal.
    // The width given is this bar's own — the terminal less the rail.
    expect(meterCells(120)).toBe(5);
    expect(meterCells(100)).toBe(4);
    expect(meterCells(80)).toBe(0);
  });
});
