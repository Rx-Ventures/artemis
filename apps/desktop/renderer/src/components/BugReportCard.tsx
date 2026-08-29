/**
 * The bug report card — the last thing in the sidebar, always there.
 *
 *      │ [ + New session       ⌘N ] [◧] │
 *      │ ▾ Sessions · 47                │
 *      │   …                            │
 *      ├────────────────────────────────┤
 *      │ ⛭ Report a bug                 │  ← this
 *      └────────────────────────────────┘
 *
 * ## Why this gets the permanent slot the sidebar spent two versions clearing
 *
 * `Sidebar` argues at length that nothing belongs at the foot of the card, and
 * `UpdateCard` was built on the same premise: the space is empty until something
 * has news. That reasoning was about *controls the app already offered twice* —
 * a project switcher next to a session list that switches projects, a directory
 * button next to the chip that sets the directory. Their problem was duplication
 * in the most permanent spot in the window, not permanence itself.
 *
 * Reporting a bug is offered nowhere else, and it is the one action whose value
 * depends entirely on being findable at the moment it is wanted — which is a
 * moment the user did not plan for and will not go looking through menus during.
 * A repository that just went public makes that concrete: the people who hit the
 * bug now are people with no other channel to reach anyone about it.
 *
 * So it is permanent, and it is a row rather than a card's worth of furniture:
 * one line, one icon, muted, the height of a session row. It reads as the floor
 * of the sidebar rather than as a notice — a door, not news.
 *
 * ## Flat, because the sidebar is
 *
 * This was a rounded, bordered, filled card back when the sidebar was a stack
 * of them. The shell refresh took the cards away: the sidebar is one panel with
 * hairlines dividing it, and a rounded rectangle floating inside that with a
 * margin around it was the one piece of the old language left, which made it
 * read as something that had been pasted in. It is now a full-width row under
 * a hairline, and the hairline is the only thing separating it from the list —
 * the same rule every other boundary in the panel follows.
 */

import { useState, type ReactElement } from 'react';
import { BugIcon } from 'lucide-react';

import { BugReportDialog } from './BugReportDialog';

export function BugReportCard(): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
        `shrink-0` for the reason it has always been there: the list above is
        `flex-1` and would otherwise give up its rows to this one line.

        The focus ring is inset, because a row that meets both edges of the
        panel has no margin for a ring to sit in — an outset one would be
        clipped on the left and hang over the transcript on the right.
      */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex shrink-0 items-center gap-2 border-t border-hairline px-2.5 py-2 text-2xs text-ink-muted transition-colors hover:bg-wash hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <BugIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-left">Report a bug</span>
      </button>

      {open && <BugReportDialog onClose={() => setOpen(false)} />}
    </>
  );
}
