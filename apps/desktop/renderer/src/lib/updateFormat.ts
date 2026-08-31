/**
 * How an install in flight is put into words.
 *
 * These two lived in `UpdateCard.tsx` while the card at the foot of the sidebar
 * was the only place an update was described. The card is gone — the one update
 * surface is the chip in `AppHeader` now — but the About pane reports the same
 * install at length, so the formatting outlived the component that owned it and
 * had to land somewhere neither surface imports the other from.
 *
 * Pure functions over {@link UpdateProgress} and nothing else. Both take the
 * whole progress rather than a step, because both have something to say about
 * its absence: a reading that has not arrived yet is a real state, and one that
 * cannot count bytes is a different real state.
 *
 * ## Why the header chip does not use these
 *
 * `AppHeader`'s `busyLabel` writes the same fact in a different register on
 * purpose. It fills a `font-mono` chip, where the house rule is that mono means
 * machine output, so it prints the step token as the protocol spells it —
 * `downloading Artemis 2.2.0 — 42%`. {@link stepLabel} is prose, for a sentence
 * a person reads once: `Downloading 2.2.0… keep Artemis open.` Collapsing the
 * two would not remove a duplicate, it would pick one voice for two places that
 * are deliberately speaking differently.
 */

import type { UpdateProgress } from '@rx-artemis/protocol';

/**
 * What to call the step, in a sentence.
 *
 * Present participles, so the line reads as something in progress rather than
 * as a label: "Downloading 1.5.0… keep Artemis open." An absent reading falls
 * back to wording that is still true of every step.
 */
export function stepLabel(progress: UpdateProgress | null): string {
  switch (progress?.step) {
    case 'checking':
      // Reached only by a surface that renders the step on its own. The step
      // has no version to name — it runs to find out whether the offer has been
      // superseded — so a caller pairing this with a version should answer for
      // `checking` before it gets here.
      return 'Checking for';
    case 'downloading':
      return 'Downloading';
    case 'verifying':
      return 'Verifying';
    case 'unpacking':
      return 'Unpacking';
    case 'installing':
      return 'Installing';
    default:
      return 'Updating to';
  }
}

/** `84.2 MB of 196.0 MB`, or null when this step cannot count. @see stepLabel */
export function byteLine(progress: UpdateProgress | null): string | null {
  if (progress?.transferred == null) return null;
  const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
  return progress.total === null
    ? mb(progress.transferred)
    : `${mb(progress.transferred)} of ${mb(progress.total)}`;
}
