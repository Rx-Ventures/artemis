/**
 * The bug report card — the last thing in the sidebar, always there.
 *
 *      ╭────────────────────────────────╮
 *      │ [ + New session       ⌘N ] [◧] │
 *      │ ▾ Sessions · 47                │
 *      │   …                            │
 *      ╰────────────────────────────────╯
 *      ╭────────────────────────────────╮
 *      │ ↓ Artemis 0.7.0 is available ✕ │  ← UpdateCard, when there is one
 *      │ [ Update now ]                 │
 *      ╰────────────────────────────────╯
 *      ╭────────────────────────────────╮
 *      │ ⛭ Report a bug               → │  ← this
 *      ╰────────────────────────────────╯
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
 * of the sidebar rather than as a notice, which is the distinction that lets it
 * sit under `UpdateCard` without the two competing — an update is news and looks
 * like it, this is a door and looks like one.
 */

import { useState, type ReactElement } from 'react';
import { BugIcon } from 'lucide-react';

import { BugReportDialog } from './BugReportDialog';

export function BugReportCard(): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
        The session card's chrome, like `UpdateCard` — same radius, border, fill,
        shadow and ring — so the foot of the sidebar reads as a stack of siblings
        rather than a panel with things bolted under it. `shrink-0` for the same
        reason it is there: the card above is `flex-1` and would otherwise give up
        the list's rows to this one line.
      */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex shrink-0 items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-2 text-2xs text-ink-muted transition-colors hover:bg-raised/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <BugIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-left">Report a bug</span>
      </button>

      {open && <BugReportDialog onClose={() => setOpen(false)} />}
    </>
  );
}
