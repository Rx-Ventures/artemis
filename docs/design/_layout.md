# Round four: a layout designed rather than accreted

Round two settled that the layout's *capabilities* are right and must not
shrink. That is not the same as saying the arrangement was designed. Reading
`App.tsx`'s own comments, most of it is accretion — each piece added to
compensate for the piece before it.

## What is actually accreted today

**The window header exists because the sidebar can't reopen itself.** In the
app's words: `Sidebar` renders `null` when collapsed — "not a rail, not a
sliver" — so its own close button cannot bring it back, and that control "has to
live somewhere always-mounted". A whole bar is load-bearing for a workaround.

**The update surface is two components.** `UpdateCard` when the sidebar is
showing, `UpdateBanner` when it is not. One message, two implementations,
because there was no single always-present place to put it.

**The status line repeats five segments per pane.** Correct that it describes
the *next run* rather than the window — but in a 2×2 that is twenty segments on
screen, most of them identical to each other.

**The dock is a drawer.** It is the window's, but panes are many, and nothing
in the arrangement says which pane a dock tab belongs to.

**Dock tabs eat horizontal space** in a panel that is already the narrowest
thing on screen.

## The refresh

Same capabilities, nothing removed, arranged on purpose:

1. **A navigator rail that never disappears.** 46px of icons — sessions,
   search, tasks, settings — always mounted. Collapse becomes *reversible by
   the rail itself*, which removes the only reason the header had to exist as a
   workaround. The session list expands beside it and can close without
   stranding anything.

2. **The command bar earns its place.** It is no longer a place to park a
   toggle. It carries what is true of the *window*: which pane is focused, the
   way into search, how many panes want you, context pressure, and settings.

3. **One update surface.** In the command bar, always, whatever else is open.

4. **The status line elides.** Model and permission mode always visible —
   those are the two that change behaviour — and the rest behind `⋯`. Round
   two's One Bar proved that nine facts do not fit on one line at pane width;
   this shows the two that matter and admits the rest are a click away.

5. **The dock gets a vertical tab rail and a scope.** Tabs move to a 34px
   icon column, so they stop competing with the panel's width, and a scope chip
   says whether you are seeing this pane's artifacts or every pane's. That is
   the honest answer to the question round two's Catch could not resolve.

6. **The pane header stays on top.** One Bar moved it to the floor and the
   render showed the name wrapping to three lines. Identity stays where every
   other tabbed application on the machine puts it.

## Two languages, one layout

`app.html` renders this layout and swaps between **Sheet** and **Signal** live.
Every colour, face, radius and weight is a token; the toggle rewrites one
attribute on `<html>`. The layout markup is shared, so the comparison is exact.

Six screens, because a transcript is not the whole application: the session
grid, a full 2×2, the dock's three other tabs, the command palette, the
profiles screen, and first run.
