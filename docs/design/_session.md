# The session every mockup renders

The first pass at these was four turns, two tool calls and one approval. That is
a marketing shot, not a harness — it proves nothing about a layout, because
nothing in it is hard to lay out.

So every mockup now renders **the same real session**, and it is one that
actually happened: `pnpm sandbox:check` reporting an escape, the diagnosis, the
fix, and the re-run. The point is that each design has to survive the same
awkward content, and they can be compared on how they cope rather than on how
they look empty.

## What is in it, and why each piece is there

| Element | Why a layout has to face it |
| --- | --- |
| **A diff**, +6/−3 with context | The single most common artifact in agent work, and the widest. Any design that only handles prose falls over here. |
| **Failing test output**, 14 lines with a stack | Wide, monospaced, mostly noise with two useful lines. Tests whether a design can show a wall without becoming one. |
| **A grep with 40 hits**, truncated | Long, repetitive, needs truncation the user can trust. |
| **A command that fails, then a retry** | The normal shape of agent work. A design that assumes success looks wrong most of the time. |
| **A todo list mutating across turns** | Rewritten in place, which a transcript is bad at — this is what forced the dock's tasks pane to exist. |
| **Two delegated agents**, one still running | Work happening outside any turn. |
| **28 turns** with the scroll position mid-session | Density and wayfinding: can you tell where you are? |
| **Context at 78%** | Pressure. The thing you notice only when it is nearly gone. |
| **A permission gate** on a destructive command | The one moment the UI must interrupt. |

## What to judge

Not "which is prettiest". Which one still reads at turn 28 with a diff, a stack
trace and a truncated grep on screen at once — and which one you could work in
for six hours.
