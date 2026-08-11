/**
 * Every name this app has shipped under.
 * ============================================================================
 *
 * `app.getPath('userData')` is derived from the app name. A rename therefore
 * points the app at a directory that does not exist yet, and every profile and
 * every session history the user had is *still on disk* — under the old name,
 * where nothing looks for it any more. To the user it reads as the app deleting
 * their accounts.
 *
 * This module is separate from `index.ts` for one reason: `index.ts` imports
 * `electron` at the top level, so it cannot be loaded in a unit test, and the
 * rule below is exactly the kind that needs one. It has already been broken
 * once — a rename *replaced* the outgoing name in the list instead of adding to
 * it, which strands everything written under it. `appNames.test.ts` pins the
 * chain so that removing an entry fails rather than ships.
 *
 * ## The rule
 *
 * **When renaming the app: change {@link APP_NAME}, and add the outgoing name
 * to the front of {@link PREVIOUS_APP_NAMES}. Never edit or remove an entry.**
 *
 * A user who skipped a version upgrades straight from whichever name they last
 * ran, so an entry is load-bearing forever — dropping one is indistinguishable
 * from deleting their data. The list only grows.
 */

/**
 * What the app calls itself now.
 *
 * The package is `@rx-artemis/desktop`, which would otherwise put user data in a
 * nested `@rx-artemis/desktop` directory and name the OS keychain entry after
 * it. Naming the app keeps the credential store's identity stable and legible.
 */
export const APP_NAME = 'Artemis';

/**
 * Names this app used to ship under, newest first.
 *
 * Deliberately does *not* contain {@link APP_NAME}. Listing the current name
 * here is how the chain broke the first time: the entry reads as "the app's
 * name", so a rename updates it in place and the outgoing name — the one
 * holding the user's data — silently drops off the end.
 *
 * The full chain to date is Libra → Apollo → Artemis.
 */
export const PREVIOUS_APP_NAMES = ['Apollo', 'Libra'] as const;

/**
 * Which abandoned user-data directory to adopt, if any.
 *
 * Newest first: someone who ran Artemis *and* Apollo *and* Libra has stale Libra
 * data sitting beside the directory they actually care about, and taking the
 * older one would silently roll them back.
 *
 * `exists` is injected rather than imported so this is testable without a
 * filesystem — it is the only thing the decision depends on.
 *
 * @param parent  The directory holding every app's user data.
 * @param current `app.getPath('userData')` for the name in force now.
 * @param exists  Whether a path is present on disk.
 * @param join    Path join, injected so the caller's platform rules apply.
 * @returns The directory to move to `current`, or `null` to start fresh.
 */
export function previousUserDataDir(
  parent: string,
  current: string,
  exists: (path: string) => boolean,
  join: (...parts: string[]) => string,
): string | null {
  // Whatever is here now is newer than anything an older name left behind, so
  // it is never overwritten.
  if (exists(current)) return null;

  for (const name of PREVIOUS_APP_NAMES) {
    const previous = join(parent, name);
    if (previous === current || !exists(previous)) continue;
    return previous;
  }
  return null;
}
