/**
 * The picker's scrolling window.
 *
 * A long list scrolls instead of growing. The folder browser can offer a
 * directory with hundreds of entries and the conversation list grows without
 * limit; either would otherwise push the picker's own title off the top of
 * the screen.
 */

import { describe, expect, it } from 'vitest';

import { pickerWindow } from './Picker.js';

describe('pickerWindow', () => {
  it('shows everything when everything fits', () => {
    expect(pickerWindow(0, 4, 12)).toEqual({ top: 0, size: 4 });
    expect(pickerWindow(3, 4, 12)).toEqual({ top: 0, size: 4 });
  });

  it('keeps the selection roughly centred once the list outgrows the window', () => {
    expect(pickerWindow(0, 100, 10)).toEqual({ top: 0, size: 10 });
    expect(pickerWindow(50, 100, 10)).toEqual({ top: 45, size: 10 });
    // And never scrolls past the end, so the last row stays reachable.
    expect(pickerWindow(99, 100, 10)).toEqual({ top: 90, size: 10 });
  });

  it('survives an empty list', () => {
    expect(pickerWindow(0, 0, 12)).toEqual({ top: 0, size: 1 });
  });
});
