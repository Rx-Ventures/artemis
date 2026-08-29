# Round five: the palette from a seed pair

Round three settled the language axes; round four settled the refreshed layout.
What neither settled is where a palette *comes from*. Today's ships as nineteen
hand-picked values, each argued for in `index.css` — good arguments, and the
reason every palette change so far has been a full re-argument.

This round implements the settled decisions from the overhaul prep (see
`docs/research/OVERHAUL-PREP.md` and ADR 0001, *themes derive from seeds*):
a theme is a **`{canvas, accent}` seed pair** and every other colour token is
computed from it. The dark canvas is bare neutral grey at T3-boring depth. The
accent is a deep blue-violet **fill** that light text sits on — the shipped
bright-ink teal at L86 was judged hard on the eyes and is rejected. Tools-cyan
moves 250 → 210, because any blue accent forces it out from under the 40° rule.

## What is being decided

Not "is 264 pretty". Three questions, each given its own file:

1. **Does the derivation hold up** — do two numbers plus rules produce a
   palette as considered as nineteen hand decisions? (5b vs 5a.)
2. **Is the settled seed the right point on its line?** 5c and 5d bracket it —
   accent one notch dimmer, canvas one notch lighter — so judging picks a
   point rather than rubber-stamping the only point shown.
3. **Do the same seeds survive light and split-tone** without hand surgery?
   (5e, 5f.)

## What is held constant

Per round three's method, everything that is not the variable:

- **The layout is byte-identical across all six files** — `_seed_build.py`
  imports the structural CSS and the session markup from `_build.py` rather
  than copying them, so it cannot drift. Anything you see differing is the
  seed pair and its derived tokens.
- **The session is the hard one**, unchanged — see `_session.md`.
- **Type is held at the shipped Geist pair.** Not because Geist won — round
  three argues it must go — but because it is the incumbent, the control's
  face, and this round's only variable is colour.
- **Radii, washes, weights and sizes** are one value across all six.
- **The control is the shipped palette verbatim** (teal 192 at L86, 9%
  ground, 250-hue tint in every grey), per the always-include-a-control rule.

The one licensed exception: `5f-violet-split.html` adds a single CSS block
that scopes the dark pass to the window header and sidebar. That block is the
variable that file exists to test.

## The derivation rules

Implemented once, in `_seed_build.py`. The generator enforces every floor
below with a Python port of `renderer/src/lib/oklch.ts`, logs each floor it
applies into the emitted file's banner comment, and `_seedcheck.mts`
re-verifies the emitted files through the TypeScript original — the generator
enforces, the repo validator confirms.

### Dark: surfaces are lifts off the canvas

The canvas seed is one number, the ground's lightness `L` (bounded 9–18),
at **chroma zero** — no accent tint in the greys; that was decided against.
The lift schedule is the shipped geometry made explicit: at canvas 9 it
reproduces today's surfaces exactly, which is the round's quiet control on
the rule itself.

| token | rule | at seed 15.5 |
| --- | --- | --- |
| `--abyss` | L | 15.5% |
| `--inset` | L + 1.5 | 17% |
| `--panel` | L + 4 | 19.5% |
| `--raised` | L + 7 | 22.5% |
| `--float` | L + 9.5 | 25% |
| `--line` | L + 18 | 33.5% |
| `--line-strong` | L + 41, walked up in 0.5 steps until ≥3:1 on the panel | 56.5% |

Inks are fixed, not derived — `96 / 77 / 62`, chroma zero — and the canvas
bound guarantees they clear AA on the panel. Neutral substrate, neutral inks.

### Dark: the accent is a fill, and it derives a text companion

The accent seed is `(L, C, H)` — here `(52, 0.21, 264)`, the middle of the
settled 48–55 window (T3 Code sits at `oklch(0.488 0.217 264)`).

| token | rule | at the settled seed |
| --- | --- | --- |
| `--beam` | the seed, chroma shrunk 0.005 at a time into sRGB, then L walked up until the fill clears **3:1 on the panel** | `oklch(52% 0.21 264)` |
| `--beam-dim` | L − 8, C × 0.85 | `oklch(44% 0.178 264)` |
| `--beam-ink` | `97% 0.014 H` — light text **on** the fill, asserted ≥4.5:1 on it | `oklch(97% 0.014 264)` |
| `--beam-text` | the accent's hue at C 0.14, walked **down** to the last half-step that holds ≥4.75:1 on the panel | `oklch(61.5% 0.14 264)` |

`--beam-text` is the one place the derivation bends, and it is a bend of
role, not of value: a deep fill cannot be read as 13px text (52% measures
~3.2:1 on the panel, nowhere near AA), so accent-as-text is its own derived
token. At conversion time `palette.test.ts` must learn the same distinction —
`beam` moves out of the READABLE set (it is owed 3:1 as a component, which it
clears) and `beam-text` takes its place at 4.5.

### Dark: status hues are decided, their lightness walks

Hues are fixed by decision — tools-cyan **210** (moved from 250), thinking
310, success 150, warning 85, error 25 — at the shipped L/C. Each colour then
shrinks into gamut and walks its lightness up in 0.5 steps until it clears
4.5:1 on both grounds with a hair of margin. At the settled seed nothing
needs to walk; at the 17.5 bracket nothing walks either — the palette just
runs closer to its floors (see 5d's cost box for the measured compression).

`--amber-ink` (text on the gate fill) is `18% 0.045 85` shrunk into gamut —
which it needs: **0.045 clips at L18 and the derivation shrinks it to 0.035.**
The TypeScript validator caught that; the Python floors originally did not
check inks-on-fills for gamut. Same class of bug as the near-black
`--beam-ink` that `palette.test.ts`'s header describes catching.

### Light: the same seeds, drops below paper

Light is not an inversion; it is a second pass of the same rules with paper
as the anchor. The canvas seed contributes its chroma policy (zero), the
accent seed its hue and construction.

| token | rule | value |
| --- | --- | --- |
| `--panel`, `--float` | paper, 100% | 100% |
| `--abyss` | paper − 3.5 | 96.5% |
| `--inset` | paper − 4.5 | 95.5% |
| `--raised` | paper − 6 | 94% |
| `--line` | paper − 11 | 89% |
| `--line-strong` | paper − 36 | 64% |
| inks | fixed `22 / 43 / 52`, chroma zero | — |
| `--beam` | seed L − 4, C − 0.02, deepened until ≥4.75:1 **as text** on paper | `oklch(48% 0.19 264)` |
| `--beam-text` | = `--beam` — the fill doubles as its own text on paper | same |
| status | shipped light L/C, hues as above, walked **down** if AA misses | cyan's chroma shrinks 0.10 → 0.08 (clips at L48 H210) |

That `beam-text = beam` line is the deep-fill argument in one row: one accent
construction survives both modes, where the shipped teal had to fall from L86
to L52 and give up 40% of its chroma to survive light at all.

### Split-tone

`5f` is the light pass with the dark pass's rail: the window header and
sidebar take the 5b tokens verbatim (as `--d-*` variables), scoped by one CSS
block. Nothing is derived differently; the two palettes are 5b and 5e.

## The six files

| file | seeds | what it tests |
| --- | --- | --- |
| `5a-control.html` | none — hand-picked | the shipped palette, the thing to beat |
| `5b-violet.html` | canvas 15.5 · accent 52/0.21/264 | **the settled direction** |
| `5c-violet-dim.html` | canvas 15.5 · accent 44/0.21/264 | bracket from below (3:1 floor off — it measures 2.21:1, priced in its cost box) |
| `5d-canvas-lift.html` | canvas 17.5 · accent 52/0.21/264 | bracket from above |
| `5e-violet-light.html` | same seeds → light pass | light, from the same two numbers |
| `5f-violet-split.html` | same seeds → both passes | dark rail, light content (ChatGPT desktop pattern) |

## Seedcheck: variant (b), verified through the repo's own validator

Output of `node docs/design/_seedcheck.mts`, which parses the emitted 5b and
5e token blocks and recomputes every claim with
`apps/desktop/renderer/src/lib/oklch.ts` — the same functions
`palette.test.ts` uses. Grounds are `--bg` (abyss) and `--chrome` (panel).

### dark (5b-violet.html)

Gamut: 25 tokens, 0 clip (pass)

| token | value | on --bg | on --chrome | rule | verdict |
| --- | --- | --- | --- | --- | --- |
| `--ink` | `oklch(96% 0 0)` | 17.40 | 16.28 | ≥4.5 text | pass |
| `--ink-2` | `oklch(77% 0 0)` | 9.43 | 8.82 | ≥4.5 text | pass |
| `--ink-3` | `oklch(62% 0 0)` | 5.37 | 5.02 | ≥4.5 text | pass |
| `--accent-text` | `oklch(61.5% 0.14 264)` | 5.18 | 4.84 | ≥4.5 text | pass |
| `--tool` | `oklch(80% 0.1 210)` | 10.82 | 10.12 | ≥4.5 text | pass |
| `--think` | `oklch(64% 0.035 310)` | 5.73 | 5.37 | ≥4.5 text | pass |
| `--ok` | `oklch(84% 0.17 150)` | 12.72 | 11.90 | ≥4.5 text | pass |
| `--warn` | `oklch(85% 0.155 85)` | 12.25 | 11.46 | ≥4.5 text | pass |
| `--err` | `oklch(70% 0.18 25)` | 6.75 | 6.32 | ≥4.5 text | pass |
| `--accent` | `oklch(52% 0.21 264)` | 3.37 | 3.16 | ≥3.0 fill | pass |
| `--line-2` | `oklch(56.5% 0 0)` | 4.29 | 4.01 | ≥3.0 boundary | pass |
| `--accent-ink` on `--accent` | `oklch(97% 0.014 264)` | — | 5.31 | ≥4.5 on fill | pass |
| `--warn-ink` on `--warn` | `oklch(18% 0.035 85)` | — | 11.80 | ≥4.5 on fill | pass |

### light (5e-violet-light.html)

Gamut: 25 tokens, 0 clip (pass)

| token | value | on --bg | on --chrome | rule | verdict |
| --- | --- | --- | --- | --- | --- |
| `--ink` | `oklch(22% 0 0)` | 15.64 | 17.31 | ≥4.5 text | pass |
| `--ink-2` | `oklch(43% 0 0)` | 7.32 | 8.11 | ≥4.5 text | pass |
| `--ink-3` | `oklch(52% 0 0)` | 4.98 | 5.51 | ≥4.5 text | pass |
| `--accent-text` | `oklch(48% 0.19 264)` | 6.18 | 6.84 | ≥4.5 text | pass |
| `--tool` | `oklch(48% 0.08 210)` | 5.71 | 6.32 | ≥4.5 text | pass |
| `--think` | `oklch(50% 0.03 310)` | 5.49 | 6.07 | ≥4.5 text | pass |
| `--ok` | `oklch(50% 0.13 150)` | 5.10 | 5.65 | ≥4.5 text | pass |
| `--warn` | `oklch(50% 0.098 85)` | 5.46 | 6.05 | ≥4.5 text | pass |
| `--err` | `oklch(52% 0.19 25)` | 5.49 | 6.08 | ≥4.5 text | pass |
| `--accent` | `oklch(48% 0.19 264)` | 6.18 | 6.84 | ≥3.0 fill | pass |
| `--line-2` | `oklch(64% 0 0)` | 3.04 | 3.36 | ≥3.0 boundary | pass |
| `--accent-ink` on `--accent` | `oklch(98% 0.005 264)` | — | 6.46 | ≥4.5 on fill | pass |
| `--warn-ink` on `--warn` | `oklch(98% 0.005 85)` | — | 5.71 | ≥4.5 on fill | pass |

### pairwise hue distances (accent + five status hues, both themes)

| pair | Δ° | verdict |
| --- | --- | --- |
| `accent` 264° ↔ `tool` 210° | 54 | pass |
| `accent` 264° ↔ `think` 310° | 46 | pass |
| `accent` 264° ↔ `ok` 150° | 114 | pass |
| `accent` 264° ↔ `warn` 85° | 179 | pass |
| `accent` 264° ↔ `err` 25° | 121 | pass |
| `tool` 210° ↔ `think` 310° | 100 | pass |
| `tool` 210° ↔ `ok` 150° | 60 | pass |
| `tool` 210° ↔ `warn` 85° | 125 | pass |
| `tool` 210° ↔ `err` 25° | 175 | pass |
| `think` 310° ↔ `ok` 150° | 160 | pass |
| `think` 310° ↔ `warn` 85° | 135 | pass |
| `think` 310° ↔ `err` 25° | 75 | pass |
| `ok` 150° ↔ `warn` 85° | 65 | pass |
| `ok` 150° ↔ `err` 25° | 125 | pass |
| `warn` 85° ↔ `err` 25° | 60 | pass |

All claims hold. The tightest number on the board is **264 ↔ 310 at 46°** —
six degrees over the rule. Legal, and the reason neither the accent nor the
thinking hue can drift in a later tune without re-running this check.

## Where the derivation had to bend

Recorded here so the bends are decisions rather than accidents:

1. **`--beam-text` exists.** A deep-fill accent cannot serve as text on a
   dark ground (3.16:1 where AA wants 4.5), so the seed derives an
   accent-as-text companion and the validator's READABLE list must swap
   `beam` → `beam-text` at conversion time, with `beam` checked at 3:1 as a
   component instead.
2. **`--amber-ink` chroma 0.045 → 0.035.** Near-black amber clips sRGB at
   L18. Caught by `_seedcheck.mts` running the TypeScript validator, not by
   eye and not by the Python port's original checks.
3. **Light tools-cyan chroma 0.10 → 0.08.** The 210 hue is narrower at L48
   than 250 was; the gamut shrink is automatic and logged in 5e's banner.
4. **Variant 5c ships with the 3:1 accent floor switched off** — deliberately,
   so the below-bracket exists. Its measured 2.21:1 is stated in its banner
   and its cost box. If 5c wins, the floor itself is what judging overturned.

## What to judge

Open 5a and 5b side by side first — that is the actual decision. Then 5c and
5d to place the seed on its two lines. Then 5e and 5f for whether the rules
survive leaving dark mode. The question is not which screenshot is prettiest;
it is whether anything in 5b reads *worse* than 5a at turn 28 with a diff, a
stack trace and a truncated grep on screen — and whether the accent being a
place instead of a glare is the relief the settled decision claims it is.
