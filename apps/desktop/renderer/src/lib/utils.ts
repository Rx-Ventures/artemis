/**
 * Class-name merge.
 *
 * This is the `cn` every shadcn/ui component imports (`@/lib/utils`), so its
 * location and name are fixed by the registry — do not move or rename it.
 *
 * `clsx` resolves the conditional forms; `tailwind-merge` then drops earlier
 * classes that a later one would fight with, so a caller can pass
 * `className="h-auto"` to a component whose base classes say `h-8` and get the
 * result they asked for rather than whichever rule happens to sit later in the
 * generated stylesheet.
 *
 * tailwind-merge is configured, not used bare: Artemis's type scale adds a
 * `text-2xs` step and a `text-2xs--line-height`, and the default config has no
 * way to know that `2xs` is a font size rather than a colour. Left unregistered
 * it would treat `text-2xs` and `text-ink-muted` as the same conflict group and
 * silently drop one of them.
 */

import clsx, { type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
