/**
 * The context every shadcn primitive in this app assumes is already there.
 *
 * Mounted once, in `main.tsx`, above `<App />` — deliberately not inside App.
 * `App` is a feature component and gets rewritten; this is infrastructure and
 * must not be able to disappear in a refactor. Radix's `Tooltip.Root` throws
 * if it cannot find a provider, so every `ReasonButton` in the app depends on
 * this being mounted.
 *
 * Radix and Sonner both portal into `document.body`. That is fine under the
 * renderer's CSP (`style-src 'self' 'unsafe-inline'` covers the inline
 * positioning styles they write) and fine for the theme, because the palette
 * class is on `<html>`, which is an ancestor of every portal target.
 */

import type { ReactElement, ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useApp } from '../state/store';

export function ArtemisProviders({ children }: { readonly children: ReactNode }): ReactElement {
  /*
   * Sonner is told the palette rather than shown it.
   *
   * Its toasts take their colours from `--normal-bg` and friends, which this
   * app points at the shared tokens — so the surface follows the theme without
   * any of this. What does not follow is everything sonner styles from its own
   * `theme` prop: the close button above all, which is drawn from sonner's
   * built-in pair and would stay a light glyph on a light toast.
   *
   * The store's value is handed over as-is, `'system'` included, because sonner
   * resolves that itself against the same media query the store uses. Two
   * listeners for one question, but they cannot disagree — and the alternative
   * is passing a resolved value that would silently stop tracking the OS if
   * sonner's own handling were ever relied on elsewhere.
   */
  const theme = useApp((s) => s.theme);

  return (
    /*
     * 250ms before the first tooltip, then none while the pointer stays in the
     * group. The registry default is 0, which makes a toolbar flicker a bubble
     * at every control the cursor crosses; 250 is long enough to mean "I am
     * looking at this" and short enough that a disabled control still answers
     * immediately when you go asking why.
     */
    <TooltipProvider delayDuration={250} skipDelayDuration={400}>
      {children}
      <Toaster position="bottom-right" closeButton richColors={false} theme={theme} />
    </TooltipProvider>
  );
}
