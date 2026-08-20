/**
 * The composer's slash command menu.
 * ============================================================================
 *
 * A listbox floated above the field while the draft is a single slash token.
 * Presentation only: it renders what {@link matchSlashCommands} decided and
 * reports clicks. The keyboard lives in `Composer.tsx`, because the keys it needs
 * are keys the composer already binds — Enter, Escape, the arrows — and one
 * handler that knows whether the menu is open is the only way those can be
 * resolved in the right order.
 *
 * ## Why it is not a Popover
 *
 * `ui/popover.tsx` moves focus into itself, which is exactly wrong here: the user
 * is typing, the textarea must keep the caret, and the menu is a view of what
 * they are typing rather than somewhere to go. So it is a plain absolutely
 * positioned div, with `aria-activedescendant` on the textarea doing the job
 * focus would otherwise do for a screen reader.
 *
 * `pointer-events-none` on the container with it re-enabled per row keeps the
 * gaps between rows click-through, so a stray click near the menu lands in the
 * transcript rather than being swallowed by a transparent box.
 */

import type { ReactElement } from 'react';

import { cn } from '@/lib/utils';
import type { SlashMatch } from '../lib/slashCommands';

/** The DOM id of one row, shared with the textarea's `aria-activedescendant`. */
export function slashOptionId(index: number): string {
  return `slash-option-${index}`;
}

/**
 * The listbox's id, named by the textarea's `aria-controls`.
 *
 * A constant rather than generated, because only one composer in the window can
 * have the menu open — it is anchored to the focused field, and there is one
 * caret. Two panes cannot both be typing.
 */
export const SLASH_LISTBOX_ID = 'slash-command-listbox';

export interface SlashCommandMenuProps {
  readonly matches: readonly SlashMatch[];
  /** Index into {@link matches} of the row Enter would accept. */
  readonly highlight: number;
  readonly onAccept: (name: string) => void;
  /**
   * Moves the highlight without accepting — the hover half of the interaction.
   *
   * Hover *moves* rather than previews, so that a mouse resting anywhere in the
   * menu and a subsequent Enter agree about what is selected. A menu whose
   * highlight and whose hover disagree is one where Enter does something other
   * than what the user is pointing at.
   */
  readonly onHighlight: (index: number) => void;
}

export function SlashCommandMenu({
  matches,
  highlight,
  onAccept,
  onHighlight,
}: SlashCommandMenuProps): ReactElement {
  return (
    <div
      className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 w-full"
      // Not `role="listbox"` on this wrapper: the list itself carries the role so
      // the padding around it is not part of the control.
    >
      <ul
        id={SLASH_LISTBOX_ID}
        role="listbox"
        aria-label="Slash commands"
        /*
          Scrolls rather than truncates. A capped list would quietly hide the
          match the user wanted and look identical to a list that had found
          everything — the failure this whole feature exists to end.
        */
        className="pointer-events-auto max-h-64 overflow-y-auto rounded-md border border-border bg-inset py-1 shadow-lg"
      >
        {matches.map((match, index) => (
          <li
            key={match.name}
            id={slashOptionId(index)}
            role="option"
            aria-selected={index === highlight}
            // `onMouseDown` and not `onClick`: the textarea loses focus on
            // mousedown, and a click handler would fire after the blur has
            // already closed the menu it was aiming at.
            onMouseDown={(event) => {
              event.preventDefault();
              onAccept(match.name);
            }}
            onMouseMove={() => onHighlight(index)}
            className={cn(
              'flex cursor-pointer items-baseline gap-2 px-2.5 py-1 text-sm',
              index === highlight && 'bg-accent',
            )}
          >
            <span className="truncate font-mono">/{match.label}</span>
            {/*
              The prefix, shown as provenance rather than as part of the name.
              It is what the user will actually be sending, so hiding it would
              be a lie — but it is not what they are looking for, so it does not
              get to be the brightest thing in the row.
            */}
            {match.prefix !== undefined && (
              <span className="truncate text-xs text-muted-foreground">{match.prefix}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
