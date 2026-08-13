/**
 * A disclosure's open state, remembered across the component's own lifetime.
 *
 * Wraps `useState` so that the *first* value can come from
 * {@link recallFold} and every change writes back to it. Two rules fall out of
 * that, and both are the point:
 *
 *  - **A `defaultOpen` is a default, not a rule.** It decides the first draw of
 *    a fold nobody has touched. It does not get to reopen one the reader closed,
 *    which is what a bare `useState(defaultOpen)` did on every remount.
 *  - **Only a click is recorded.** The memory is written from the setter, never
 *    from a render, so rendering a fold does not pin its default into the map.
 *
 * `key` is optional, so the same hook serves the disclosures that want no memory
 * at all — a permission prompt's detail fold has nothing to remember, since the
 * prompt itself is gone a moment later. Passing `undefined` is plain `useState`
 * with one dead branch, which is cheaper than two code paths in every caller.
 */

import { useCallback, useState } from 'react';

import { recallFold, rememberFold } from '../lib/foldMemory';

export function useFold(
  key: string | undefined,
  defaultOpen = false,
): readonly [boolean, (open: boolean) => void] {
  /*
   * The initialiser runs once per mount, which is exactly the intent: this is a
   * fold's opening position, not a value that tracks the memory afterwards. Two
   * rows showing one key are not a case that arises — every caller keys its fold
   * by the transcript id it is rendered under, and the lists are keyed by the
   * same id, so a component instance is never handed a different key than the
   * one it mounted with.
   */
  const [open, setOpen] = useState(() =>
    key === undefined ? defaultOpen : (recallFold(key) ?? defaultOpen),
  );

  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (key !== undefined) rememberFold(key, next);
    },
    [key],
  );

  return [open, set];
}
