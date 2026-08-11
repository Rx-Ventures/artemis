/**
 * The profile colour rules.
 *
 * Protocol has no I/O and no dependencies, so this is the whole surface: a
 * normaliser and the sentence it produces when a value is not a colour. Both
 * are applied in four places — the form, the IPC boundary, the profile store on
 * the way in, and the profile store on the way back out of a hand-editable JSON
 * file — which is exactly why they are defined once and tested here rather than
 * re-derived at each of them.
 */

import { describe, expect, it } from 'vitest';

import { normalizeProfileColor, profileColorProblem } from './profile.js';

describe('normalizeProfileColor', () => {
  it('passes a full lowercase hex through unchanged', () => {
    expect(normalizeProfileColor('#7c8cff')).toBe('#7c8cff');
  });

  it('lowercases, because the colour input accepts nothing else', () => {
    // `<input type="color">` silently shows black for `#7C8CFF`, which looks
    // like the app ate the value.
    expect(normalizeProfileColor('#7C8CFF')).toBe('#7c8cff');
  });

  it('expands the three-digit form', () => {
    expect(normalizeProfileColor('#abc')).toBe('#aabbcc');
    expect(normalizeProfileColor('#ABC')).toBe('#aabbcc');
  });

  it('accepts a missing hash and surrounding space', () => {
    expect(normalizeProfileColor('7c8cff')).toBe('#7c8cff');
    expect(normalizeProfileColor('  #7c8cff  ')).toBe('#7c8cff');
  });

  it('rejects anything that is not hex', () => {
    // CSS colour syntax is deliberately out of scope: the value ends up in a
    // `style` attribute, and "whatever CSS accepts" is not a rule for that.
    for (const value of ['rebeccapurple', 'rgb(1,2,3)', '#12345', '#1234567', '#gggggg', '']) {
      expect(normalizeProfileColor(value)).toBeNull();
    }
  });

  it('rejects a value that is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['#abc']]) {
      expect(normalizeProfileColor(value)).toBeNull();
    }
  });
});

describe('profileColorProblem', () => {
  it('accepts absence, because a profile with no colour is the default state', () => {
    expect(profileColorProblem(undefined)).toBeNull();
    expect(profileColorProblem(null)).toBeNull();
    expect(profileColorProblem('')).toBeNull();
    expect(profileColorProblem('   ')).toBeNull();
  });

  it('accepts every form the normaliser accepts', () => {
    for (const value of ['#abc', '#AABBCC', 'aabbcc', ' #7c8cff ']) {
      expect(profileColorProblem(value)).toBeNull();
    }
  });

  it('explains a rejection in a sentence, with an example', () => {
    const problem = profileColorProblem('purple');
    expect(problem).not.toBeNull();
    expect(problem).toContain('#rrggbb');
  });
});
