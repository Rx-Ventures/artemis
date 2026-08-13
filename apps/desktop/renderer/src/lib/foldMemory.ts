/**
 * Which folds the reader opened or closed by hand.
 * ============================================================================
 *
 * A transcript's disclosures held their open state in `useState`, which lasts
 * exactly as long as the component. Switching sessions resets the pane's
 * transcript and rebuilds every row from its `defaultOpen`, so a work marker the
 * reader had collapsed came back open — and a marker containing a failure came
 * back open *every single time*, because `defaultOpen={group.failed > 0}` is a
 * rule that re-ran on every remount and quietly overruled the person who had
 * just closed it.
 *
 * This is the memory that outlives the component. A key, a boolean, and nothing
 * else.
 *
 * ---------------------------------------------------------------------------
 * WHY A MODULE MAP AND NOT STATE
 * ---------------------------------------------------------------------------
 *
 * Not the app store, and not the pane store. A fold's open state changes at the
 * rate a reader clicks, per row, and both stores fan every write out to their
 * subscribers — which is the exact cost `transcript.ts` exists to avoid, and the
 * reason a transcript row's state was local in the first place. Writing "the
 * reader opened row 41" into a store would re-render the column to remember it.
 *
 * Not persisted, either. This is a reading position, not a preference: it says
 * what someone was looking at a minute ago, and restoring a fold the way it was
 * left three days and one app launch ago is not obviously right — nor is
 * carrying a growing map of transcript row ids in `prefs.json` forever. The
 * issue that asked for this asked for the lifetime of the app run, which is also
 * the honest scope of the fact.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KEYS SURVIVE A SESSION SWITCH
 * ---------------------------------------------------------------------------
 *
 * Because transcript ids are derived from what the provider said, not from the
 * order Artemis heard it: a tool row is `t:<toolCallId>`, a text or thinking
 * block is `a:`/`k:<messageId>:<blockIndex>`, and a group is `g:` + its first
 * member's id. Replaying the same stored session produces the same ids, so a
 * key recorded before a switch still names the same row after it.
 *
 * Two consequences worth stating. Ids are provider-unique, so two sessions
 * cannot collide here even though the map is app-wide — and a *pending* row,
 * whose id is a local counter (`u:3`), is never a fold, so the one id scheme
 * that would collide is not in this map. And if a replay ever groups work
 * differently than the live run did, the group's id changes and its entry simply
 * does not match: the fold opens at its default, which is what it did before
 * this file existed.
 *
 * Growth is bounded by clicking. Only an explicit toggle writes here — a fold
 * that renders a thousand times and is never touched has no entry — so the map
 * holds one boolean per disclosure the reader actually operated in this run.
 */

const folds = new Map<string, boolean>();

/**
 * How the reader last left this fold, or `undefined` if they never touched it.
 *
 * `undefined` is meaningfully different from `false`: it is what lets a caller
 * fall back to its own default, so a group that fails still opens itself the
 * first time it is drawn.
 */
export function recallFold(key: string): boolean | undefined {
  return folds.get(key);
}

/** Record an explicit open or close. Called from the toggle, never from a render. */
export function rememberFold(key: string, open: boolean): void {
  folds.set(key, open);
}

/**
 * Forget every fold.
 *
 * For tests, which share a module registry across cases in a file and would
 * otherwise leak one test's clicks into the next. Nothing in the app calls it:
 * there is no gesture that means "forget where I was", and a session switch
 * emphatically does not.
 */
export function forgetFolds(): void {
  folds.clear();
}
