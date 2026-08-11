/**
 * The rename chain is append-only.
 *
 * This file exists because the rule it pins was already broken once, and the
 * failure is silent, delayed, and reads to the user as the app deleting their
 * accounts. Renaming Apollo to Artemis *replaced* `'Apollo'` in the candidate
 * list with `'Artemis'` rather than adding to it, so every profile and session
 * written while the app was called Apollo stayed in
 * `~/Library/Application Support/Apollo` with nothing looking for it. Nothing
 * threw. The app simply started up with an empty profile list.
 *
 * A comment saying "never remove an entry" did not prevent that, which is the
 * argument for asserting it instead. The chain below is transcribed from the
 * commits that did each rename — `git log -S "app.setName"` — and every entry is
 * load-bearing forever: a user who skipped a version upgrades straight from
 * whichever name they last ran.
 */

import { describe, expect, it } from 'vitest';

import { APP_NAME, PREVIOUS_APP_NAMES, previousUserDataDir } from './appNames.js';

/** Every name the app has shipped under, oldest first. Only ever append. */
const SHIPPED_NAMES = ['Libra', 'Apollo', 'Artemis'] as const;

const join = (...parts: string[]): string => parts.join('/');

/** An `exists` predicate over a fixed set of directories. */
function present(...paths: readonly string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe('the app name chain', () => {
  it('accounts for every name the app has shipped under', () => {
    // The assertion that would have caught the Apollo regression: the current
    // name plus the previous ones must be the whole history, with nothing lost.
    expect([...PREVIOUS_APP_NAMES].reverse().concat(APP_NAME)).toEqual([...SHIPPED_NAMES]);
  });

  it('lists previous names newest first', () => {
    const oldestFirst = [...SHIPPED_NAMES].filter((name) => name !== APP_NAME);
    expect([...PREVIOUS_APP_NAMES]).toEqual(oldestFirst.reverse());
  });

  it('does not list the current name among the previous ones', () => {
    // Listing it is what made the regression look like a correct edit: the
    // entry reads as "the app's name", so a rename updates it in place and the
    // outgoing name drops off the end.
    expect(PREVIOUS_APP_NAMES).not.toContain(APP_NAME);
  });
});

describe('previousUserDataDir', () => {
  const parent = '/data';
  const current = '/data/Artemis';

  it('adopts the one directory that is there', () => {
    expect(previousUserDataDir(parent, current, present('/data/Libra'), join)).toBe('/data/Libra');
  });

  it('adopts the newest name when several survive', () => {
    // The case that regressed. Apollo is the name immediately before Artemis,
    // so it holds the newest data; taking Libra would silently roll the user
    // back to a state two renames old.
    const exists = present('/data/Apollo', '/data/Libra');
    expect(previousUserDataDir(parent, current, exists, join)).toBe('/data/Apollo');
  });

  it('leaves data alone once the current name has its own directory', () => {
    const exists = present(current, '/data/Apollo', '/data/Libra');
    expect(previousUserDataDir(parent, current, exists, join)).toBeNull();
  });

  it('starts fresh when no previous name is on disk', () => {
    expect(previousUserDataDir(parent, current, present('/data/Unrelated'), join)).toBeNull();
  });

  it('never adopts the current directory as its own predecessor', () => {
    // Defensive: were `APP_NAME` ever to reappear in the previous list, this
    // would be a `rename(x, x)` rather than a no-op.
    const sameName = '/data/Apollo';
    expect(previousUserDataDir(parent, sameName, present(sameName), join)).toBeNull();
  });
});
