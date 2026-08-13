/**
 * The fold memory, on its own.
 *
 * Three lines of code with one property worth pinning: `undefined` and `false`
 * are different answers. A fold nobody has touched has to fall back to its
 * caller's default — which is what lets a group holding a failure open itself on
 * first sight — and a fold the reader closed has to stay closed even though the
 * default says open. Collapse those two and the bug this file exists to fix
 * comes back in whichever direction the collapse went.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { forgetFolds, recallFold, rememberFold } from './foldMemory';

beforeEach(forgetFolds);

describe('recallFold', () => {
  it('says nothing about a fold that was never touched', () => {
    // Not `false`. The caller's `defaultOpen` is only reachable through this
    // being `undefined`.
    expect(recallFold('g:t:toolu_1')).toBeUndefined();
  });

  it('gives back what was recorded, in both directions', () => {
    rememberFold('g:t:toolu_1', false);
    rememberFold('t:toolu_2', true);

    expect(recallFold('g:t:toolu_1')).toBe(false);
    expect(recallFold('t:toolu_2')).toBe(true);
  });

  it('keeps the last answer for a key', () => {
    rememberFold('t:toolu_1', true);
    rememberFold('t:toolu_1', false);

    expect(recallFold('t:toolu_1')).toBe(false);
  });

  it('keeps the folds of one row apart from each other', () => {
    // A tool card, its input fold and its result fold all hang off one item id.
    // A reader who opened the result and closed the input meant both.
    rememberFold('t:toolu_1', true);
    rememberFold('t:toolu_1:input', false);
    rememberFold('t:toolu_1:result', true);

    expect(recallFold('t:toolu_1')).toBe(true);
    expect(recallFold('t:toolu_1:input')).toBe(false);
    expect(recallFold('t:toolu_1:result')).toBe(true);
  });
});

describe('forgetFolds', () => {
  it('drops everything', () => {
    rememberFold('t:toolu_1', true);
    forgetFolds();

    // Tests share a module registry across the cases in a file, so without this
    // one test's clicks decide another test's first render.
    expect(recallFold('t:toolu_1')).toBeUndefined();
  });
});
