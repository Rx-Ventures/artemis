/**
 * The palette control, in the window's own chrome.
 * ============================================================================
 *
 * Next to the settings button rather than inside settings, and that is the
 * whole argument for how it looks. The theme is the one preference whose entire
 * effect is the thing you are already looking at — every surface it changes is
 * on screen the moment it is pressed, so burying it one modal deep would mean
 * opening a dialog to change something the dialog then covers up.
 *
 * ---------------------------------------------------------------------------
 * WHY A RADIOGROUP AND NOT THREE BUTTONS
 * ---------------------------------------------------------------------------
 *
 * Same argument `settings/pane.tsx` makes at length: three mutually exclusive
 * answers to one question. `aria-pressed` buttons would announce three
 * independent toggles, and hand-rolling arrow-key roving focus is how you end
 * up with a subtly wrong copy of a pattern Radix already ships. Selection
 * follows focus, which is right for a control where every option is instantly
 * visible and instantly reversible.
 *
 * The Radix primitive is used directly rather than `@/components/ui/radio-group`
 * — the only place in the app that does. That component is a circle with an
 * indicator dot baked into its markup, which is correct for the stacked cards in
 * `ChoiceList` and cannot be styled into a segmented control without fighting
 * the indicator it renders unconditionally.
 *
 * ---------------------------------------------------------------------------
 * ICON-ONLY, LIKE ITS NEIGHBOURS
 * ---------------------------------------------------------------------------
 *
 * The three controls to its right are icon-only with the name in a tooltip, and
 * this header is 40px of chrome that already has a project, a title and the
 * window buttons in it. Three text labels would make the palette the widest
 * thing up here and the least important thing up here at the same time. So each
 * segment carries the same contract `IconButton` enforces one control over: the
 * name is the tooltip *and* the accessible name, never only a picture.
 *
 * Sized against `icon-sm` (`size-7`) so the row of controls shares a baseline —
 * the segments are `size-6` inside a `p-0.5` track, which comes out at 28px.
 */

import type { ReactElement } from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';

import { setTheme, useApp, type Theme } from '../state/store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ThemeOption {
  readonly id: Theme;
  readonly label: string;
  /** The accessible name and the tooltip. One string, both jobs. */
  readonly name: string;
  readonly icon: ReactElement;
}

/*
 * "System" first: it is the default, and the only one of the three that keeps
 * answering after you walk away — see the media listener in `state/store.ts`.
 * The value you get without choosing comes before the values you choose.
 */
const OPTIONS: readonly ThemeOption[] = [
  {
    id: 'system',
    label: 'System',
    name: 'System theme',
    icon: <MonitorIcon className="size-3.5" aria-hidden="true" />,
  },
  {
    id: 'light',
    label: 'Light',
    name: 'Light theme',
    icon: <SunIcon className="size-3.5" aria-hidden="true" />,
  },
  {
    id: 'dark',
    label: 'Dark',
    name: 'Dark theme',
    icon: <MoonIcon className="size-3.5" aria-hidden="true" />,
  },
];

export function ThemeToggle(): ReactElement {
  const theme = useApp((s) => s.theme);

  return (
    <RadioGroupPrimitive.Root
      aria-label="Theme"
      value={theme}
      onValueChange={(next) => setTheme(next as Theme)}
      // `no-drag` for the reason every other control up here carries it: the
      // header is the window's drag region, and without it a press on a segment
      // starts moving the window instead of choosing a palette.
      // `rounded-md` says what `min(var(--radius-md),12px)` used to compute:
      // `--radius` is 8px now, so the clamp never bites and the arbitrary
      // value was a number pretending to be a decision. The track's edge is a
      // hairline — Console's `.seg3` is `border: var(--hair)`, an alpha of the
      // ink rather than a drawn rule.
      className="no-drag flex shrink-0 items-center gap-0.5 rounded-md border border-hairline bg-inset p-0.5"
    >
      {OPTIONS.map((option) => {
        // Driven from the value rather than a `data-[state=checked]` selector.
        // The attribute spelling has moved between Radix versions — this app's
        // own `radio-group.tsx` and `ChoiceList` disagree about it today — and
        // the component already knows which one is selected.
        const active = option.id === theme;
        return (
          <Tooltip key={option.id}>
            <TooltipTrigger asChild>
              <RadioGroupPrimitive.Item
                value={option.id}
                aria-label={option.name}
                className={cn(
                  // `rounded-sm` — 4.8px against the mockup's 5px segment,
                  // one step inside the track's own radius, which is what
                  // keeps a nested rounded rectangle from looking bulged.
                  'flex size-6 cursor-pointer items-center justify-center rounded-sm border outline-none transition-colors',
                  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                  active
                    ? 'border-beam/30 bg-beam/10 text-beam-text'
                    : 'border-transparent text-ink-faint hover:bg-raised hover:text-ink-muted',
                )}
              >
                {option.icon}
              </RadioGroupPrimitive.Item>
            </TooltipTrigger>
            <TooltipContent>{option.name}</TooltipContent>
          </Tooltip>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
