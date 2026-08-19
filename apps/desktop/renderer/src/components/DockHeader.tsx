/**
 * The bar at the top of a dock pane.
 *
 * There was no such thing before this file. `FileViewer` drew its own at
 * `px-3 py-1.5` and `BrowserPane` drew its own at `px-1.5 py-1` — two tabs,
 * two heights, from vertical padding applied to content of different sizes. So
 * switching between them moved the body's top edge, which is the sort of thing
 * nobody reports and everybody feels: the content jumps when you change tabs,
 * in a panel whose whole job is to hold still while you read the conversation
 * beside it.
 *
 * `AgentPane` has a bar that looks like a third instance and is not one. It is
 * a conditional error strip — "could not read this agent" — and its own comment
 * calls it a footnote. A message that appears only on failure is not chrome the
 * body's origin depends on, so it keeps its own shape.
 *
 * That is what the roadmap meant by the dock having "grown a tab at a time".
 * The fix is not a redesign of any one pane; it is that the panes stop each
 * having an opinion about a bar they share.
 *
 * ## 26px, and why it is a fixed height rather than padding
 *
 * A height plus `items-center` gives every pane the same bar whatever it puts
 * in it — a path, a row of nav buttons, a warning. Padding does not: a pane
 * with a 20px button and a pane with a line of 11px text get different heights
 * from identical padding, which is exactly how the three drifted apart.
 *
 * 26px matches the dock's own tab strip (`h-7` minus its border), so the tab
 * you clicked and the bar under it read as one piece of chrome rather than two
 * stacked bars.
 *
 * ## It is not a title bar
 *
 * The tab already names the thing. This bar carries what the tab could not fit:
 * a file's size and line count, a browser's address and controls, a warning
 * about what is being shown. A pane with nothing to add should not render one
 * at all — `TasksPane` and `PreviewPane` correctly have none, and adding an
 * empty bar for symmetry would cost 26px of a panel that is already the
 * narrowest thing on screen.
 */

import type { ReactElement, ReactNode } from 'react';

import { cn } from '../lib/utils';

export interface DockHeaderProps {
  readonly children: ReactNode;
  /**
   * Horizontal padding. Two values, because a bar of text and a bar of icon
   * buttons genuinely want different insets — a button carries its own — and
   * the thing that has to be shared is the *height*, which is what was
   * actually drifting.
   */
  readonly inset?: 'text' | 'controls';
  readonly className?: string;
}

export function DockHeader({
  children,
  inset = 'text',
  className,
}: DockHeaderProps): ReactElement {
  return (
    <div
      data-slot="dock-header"
      className={cn(
        'flex h-[26px] shrink-0 items-center gap-2 border-b border-line',
        inset === 'text' ? 'px-3' : 'px-1.5',
        className,
      )}
    >
      {children}
    </div>
  );
}
