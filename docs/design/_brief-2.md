# Round two: additive only

## Why round one was all loss

The first five were judged as usability regressions, and that was right. The
cause was not taste. **They mocked up a simpler application than the one that
exists.**

What Artemis actually has today, from `App.tsx` and `WorkingArea.tsx`:

- a **grid of conversations**, up to four across and four down, where a pane is a
  whole session — its own directory, account, model, run, permission queue and
  transcript
- a **dock** beside the grid: browser, terminal, file viewer, tasks
- a **floating sidebar** card holding every project, most recent first
- a **per-pane status line** describing what the *next* prompt will do — profile,
  model, effort, permission mode, directory
- a **window header** that exists so hiding the sidebar stays reversible

Round one deleted, variously: the grid (all five rendered a single conversation),
the dock (Ledger), the sidebar (Ledger, Quiet), the status line (Quiet), and the
ability to see run state at all (Quiet). Yard proposed a board of cards as the
home screen, which is a strictly worse version of the grid Artemis already has —
cards you must open one at a time versus panes that are all live at once.

A design that removes an affordance is not bolder. It is just smaller.

## The rule this round

**Additive only.** Every mockup keeps the grid, the dock, the sidebar, the
per-pane composer and the status line. A design may *merge* chrome, but may not
remove information or add a step to anything you do today.

**One bet each**, against a cost that can be named in the current app.

**The palette is held constant** across all five. Round one varied colour and
layout together, so nothing could be compared. This round the palette is the
same in every file — new, higher contrast than today, same OKLCH structure and
the same colour *roles* — and layout is the only variable.

**Every file states what its bet costs**, in the file, at the bottom. A mockup
that claims to cost nothing is lying or is the control.

## The costs each one is aimed at

| # | Cost in the app today | The bet |
| --- | --- | --- |
| A | Nothing — it is the control | Change no layout at all. Palette, type, density, tool rendering only. |
| B | Four stacked bars per pane; in a 2×2 that is chrome four times over | Merge the pane header into the status line. One bar, same information. |
| C | At turn 28 you scroll and lose the shape of the session; a gate that scrolled off is invisible | A 16px spine per transcript: turn ticks by kind, gates and errors pinned. |
| D | With four panes running, finding *which one wants you* means reading all four | Sort the sidebar by what is waiting, and give the window one key that goes there. |
| E | A 400-line test wall pushes the conversation off screen and it never comes back | Big output collapses to a result line and opens in the dock, with an inline peek. |

Every mockup renders the same session as round one — see `_session.md` — but now
in a **two-pane grid with the dock open**, because that is the shape of the real
application and the reason round one was easy.
