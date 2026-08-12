/**
 * Ordering the folder list.
 *
 * `sortFoldersByName` is the single answer to "what order are folders drawn
 * in", used by the composer's menu and by Appearance. It has its own tests
 * because the interesting cases are the ones a casual `.sort()` gets wrong and
 * that only show up on someone else's disk: a capitalised project name exiled
 * into an uppercase block above everything else, `run-10` sorting before
 * `run-2`, and two folders of the same name swapping places between renders.
 *
 * The rest of `paths.ts` is display logic covered through the components that
 * render it; this is the part with a contract worth stating on its own.
 */

import { describe, expect, it } from 'vitest';

import { sortFoldersByName } from './paths';

describe('sortFoldersByName', () => {
  it('orders by the folder name, not by the path it sits in', () => {
    const sorted = sortFoldersByName(['/work/zebra/api', '/archive/alpha/web']);

    // Sorting on the whole path would group by tree — every `/archive/…` before
    // every `/work/…` — which is an order the user cannot predict from the
    // names they can actually see in the menu.
    expect(sorted).toEqual(['/work/zebra/api', '/archive/alpha/web']);
  });

  it('ignores case, so a capitalised project is not exiled', () => {
    const sorted = sortFoldersByName(['/w/beta', '/w/Alpha', '/w/gamma']);

    expect(sorted).toEqual(['/w/Alpha', '/w/beta', '/w/gamma']);
  });

  it('counts numbers rather than comparing them character by character', () => {
    const sorted = sortFoldersByName(['/w/run-10', '/w/run-2']);

    expect(sorted).toEqual(['/w/run-2', '/w/run-10']);
  });

  it('breaks a tie on the full path, so same-named folders hold still', () => {
    const sorted = sortFoldersByName(['/work/b/api', '/work/a/api']);

    // Two checkouts of one repository is the case that makes the path visible
    // in the row at all. Without a tie-break their order would depend on the
    // input's, which changes every time either is opened.
    expect(sorted).toEqual(['/work/a/api', '/work/b/api']);
  });

  it('does not touch the array it was given', () => {
    const input = ['/w/zebra', '/w/alpha'];

    sortFoldersByName(input);

    // These lists live in a store where identity decides re-renders. Sorting in
    // place would be a mutation of state nobody asked for.
    expect(input).toEqual(['/w/zebra', '/w/alpha']);
  });
});
