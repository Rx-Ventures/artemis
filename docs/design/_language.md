# Round three: the layout stays, the language restarts

Round two settled the layout question: **keep it.** The grid, the dock, the
floating sidebar, the pane header, the composer and the status line are right,
and four attempts to improve on them all cost more than they returned.

What has never actually been chosen from scratch is the **design language** —
the visual system laid over that layout. It grew one decision at a time, each
defensible on its own, and the result reads like a stock dark developer app
because most of those decisions are the stock answer.

## The choices being restarted

Everything below is real, in `apps/desktop/renderer/src/index.css`, and every
one is well argued in the comments there. That is the point: they are good
answers to questions nobody re-asked.

| Choice today | Why it is worth re-opening |
| --- | --- |
| **Geist and Geist Mono** | It is Vercel's typeface. Shipping it means wearing another company's identity — the single largest reason the app reads as a clone of things built by that company's users. |
| **Six steps of elevation by fill** (`abyss`/`panel`/`raised`/`float`/`inset` + two line tokens) | Stacked greys are *the* shadcn-era idiom. It is also expensive: every surface needs a fill decision, and at six steps two adjacent ones are indistinguishable at 13px. |
| **Violet accent** (`--lunar`, hue 287) | Violet is the default accent of the current AI-tool generation. It is the least ownable hue available right now. |
| **Neutral greys pulled into the accent's hue** (285 at chroma ≤ 0.008) | A sound rule, but it means the accent choice silently determines the whole substrate. Restarting the accent restarts the greys. |
| **Colour is semantic only, never decorative** | Genuinely good discipline — but it is a *choice*, and it means the transcript cannot use colour to say who did something, only how badly it went. |
| **One radius, 7px, everywhere** | Uniform radius is a default, not a decision. Radius could carry meaning: machine surfaces square, human surfaces soft. |
| **shadcn/ui as the semantic layer** | The deepest one. It is why the component set has the proportions it has. Not proposed for removal here, but the token layer above it can be entirely ours. |

## What a direction has to answer

1. **How is depth expressed?** Fills, hairlines, weight, shadow, or nothing.
2. **What does colour mean?** Severity, actor, recency, or almost nothing.
3. **What carries hierarchy?** Size, weight, colour, space, or rule.
4. **What is the type doing?** One face or three; where mono stops and prose starts.
5. **What does shape mean?** Uniform radius, meaningful radius, or none.

## How these four are built

`_build.py` generates all four files from **one shared layout**. The structural
CSS — every width, height, gap and position — is identical across them, and so
is the markup. Only the language block differs: tokens, type, surface model,
radius, and the transcript grammar drawn on top of them.

That is deliberate. Round two varied palette and layout together and nothing
could be compared. Here the layout is byte-identical by construction, so any
difference you see is the language and nothing else.

Each renders the same session as before — see `_session.md` — and ends with what
its language costs, in the file.
