#!/usr/bin/env python3
"""Generate the round-five seed-pair mockups.

Rounds two and three settled the layout and the language axes. Round five
decides the palette's *origin*: a theme is a `{canvas, accent}` seed pair and
every other colour token is computed from it — surface lifts, ink floors and
contrast walks — instead of nineteen hand-picked values.

Every file this writes differs from the others in its seed pair and the tokens
derived from it, and in nothing else. The structural CSS and the session markup
are imported from `_build.py` byte-identical, the type is held at the shipped
Geist pair, and the radii and washes are one value across all six. The control
is the shipped palette verbatim, per the always-include-a-control rule.

The derivation enforces its own floors (gamut, AA text contrast, 3:1 component
contrast) using the same math as `apps/desktop/renderer/src/lib/oklch.ts`, and
logs every floor it applies into the emitted file's banner comment. A separate
node script, `_seedcheck.mts`, re-verifies the emitted files with the repo's
own oklch.ts — the generator enforces, the repo validator confirms.

    python3 docs/design/_seed_build.py

Writes 5a-control.html … 5f-violet-split.html next to this file.
"""

import math
import pathlib

import _build  # round three's generator: BASE, WINDOW and FIT are the layout

OUT = pathlib.Path(__file__).parent

# ───────────────────────────────────────────────────────────────────────────
# OKLCH math, ported line for line from renderer/src/lib/oklch.ts so the
# derivation can check what it emits. The node seedcheck re-runs these checks
# through the TypeScript original.
# ───────────────────────────────────────────────────────────────────────────


def to_linear_srgb(l, c, h):
    hr = h * math.pi / 180
    L = l / 100
    a = c * math.cos(hr)
    b = c * math.sin(hr)
    l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
    return (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    )


def in_gamut(t, eps=1e-4):
    return all(-eps <= v <= 1 + eps for v in to_linear_srgb(*t))


def contrast(a, b):
    def lum(t):
        r, g, bl = (min(1, max(0, v)) for v in to_linear_srgb(*t))
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl

    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def hue_distance(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


# ───────────────────────────────────────────────────────────────────────────
# The derivation. This is the artefact the round is judging — the rules are
# written out in _seeds.md and implemented here, once.
# ───────────────────────────────────────────────────────────────────────────

# Status hues are fixed by decision, not derived: tools-cyan moved 250 → 210
# because any blue accent forces it out from under the 40° pairwise rule.
STATUS_DARK = {
    "cyan": (80, 0.10, 210),
    "sage": (64, 0.035, 310),
    "mint": (84, 0.17, 150),
    "amber": (85, 0.155, 85),
    "signal": (70, 0.18, 25),
}
STATUS_LIGHT = {
    "cyan": (48, 0.10, 210),
    "sage": (50, 0.03, 310),
    "mint": (50, 0.13, 150),
    "amber": (50, 0.098, 85),
    "signal": (52, 0.19, 25),
}


def shrink_into_gamut(t, log, name):
    l, c, h = t
    while not in_gamut((l, c, h)) and c > 0:
        c = round(c - 0.005, 3)
    if c != t[1]:
        log.append(f"{name}: chroma {t[1]} clips at L{t[0]} H{t[2]}, shrunk to {c}")
    return (l, c, h)


def walk_status(status, grounds, direction, log):
    """Each status colour walks its lightness in 0.5 steps, away from the
    grounds, until it clears AA with a hair of margin on both."""
    out = {}
    for name, (l, c, h) in status.items():
        l0 = l
        (l, c, h) = shrink_into_gamut((l, c, h), log, name)
        while min(contrast((l, c, h), g) for g in grounds) < 4.55:
            l += 0.5 * direction
        if l != l0:
            log.append(f"{name}: L{l0} fails AA on the lifted panel, walked to L{l}")
        out[name] = (l, c, h)
    return out


def derive_dark(canvas_l, accent, floor_accent=True):
    """Dark pass. `canvas_l` is the ground; every surface is a lift off it.
    `accent` is (L, C, H); `floor_accent=False` lets a bracket variant keep a
    seed the floor would otherwise correct, so the bracket exists at all."""
    log = []
    t = {
        # The six surfaces: computed lifts off the canvas, chroma zero.
        # The schedule is the shipped geometry made explicit — at canvas 9 it
        # reproduces today's abyss/panel/raised/float/inset/line exactly.
        "abyss": (canvas_l, 0, 0),
        "inset": (canvas_l + 1.5, 0, 0),
        "panel": (canvas_l + 4, 0, 0),
        "raised": (canvas_l + 7, 0, 0),
        "float": (canvas_l + 9.5, 0, 0),
        "line": (canvas_l + 18, 0, 0),
        # Inks are fixed, not derived: the canvas is bounded (9–18) so they
        # always clear AA on the panel. Neutral substrate, neutral inks.
        "ink": (96, 0, 0),
        "ink-muted": (77, 0, 0),
        "ink-faint": (62, 0, 0),
    }

    ls = canvas_l + 41
    while contrast((ls, 0, 0), t["panel"]) < 3.0:
        ls += 0.5
        log.append(f"line-strong: walked to L{ls} for 3:1 on the panel")
    t["line-strong"] = (ls, 0, 0)

    grounds = (t["abyss"], t["panel"])
    faint = min(contrast(t["ink-faint"], g) for g in grounds)
    assert faint >= 4.5, f"canvas {canvas_l} is out of bounds: ink-faint at {faint:.2f}"

    # The accent: a deep fill that text sits ON, not a bright ink. It must
    # clear 3:1 against the panel as a component; it cannot and does not try
    # to clear 4.5:1 as text — that is beam-text's job.
    la, ca, ha = shrink_into_gamut(accent, log, "beam")
    if floor_accent:
        while contrast((la, ca, ha), t["panel"]) < 3.0:
            la += 0.5
        if la != accent[0]:
            log.append(f"beam: L{accent[0]} under 3:1 on the panel, walked to L{la}")
    else:
        ratio = contrast((la, ca, ha), t["panel"])
        if ratio < 3.0:
            log.append(
                f"beam: {ratio:.2f}:1 on the panel — the 3:1 floor is OFF in this "
                "file so the bracket exists; see the cost box"
            )
    t["beam"] = (la, ca, ha)
    t["beam-dim"] = shrink_into_gamut((la - 8, round(ca * 0.85, 3), ha), log, "beam-dim")
    t["beam-ink"] = (97, 0.014, ha)
    assert contrast(t["beam-ink"], t["beam"]) >= 4.5, "beam-ink fails on beam"

    # beam-text: the accent's hue at reading lightness — the lowest half-step
    # that keeps 4.75:1 on the panel (AA plus the margin the shipped file keeps).
    bl = 75.0
    while bl - 0.5 >= 50 and contrast((bl - 0.5, 0.14, ha), t["panel"]) >= 4.75:
        bl -= 0.5
    t["beam-text"] = shrink_into_gamut((bl, 0.14, ha), log, "beam-text")

    t.update(walk_status(STATUS_DARK, grounds, +1, log))
    # Near-black tinted inks clip easily — the shipped file's own history has
    # a --beam-ink that did. Checked, not eyed.
    t["amber-ink"] = shrink_into_gamut((18, 0.045, 85), log, "amber-ink")
    return t, log


def derive_light(accent):
    """Light pass, from the same seeds. Paper anchors at 100 and the surfaces
    are computed drops below it; the canvas seed contributes its chroma policy
    (zero — neutral) and the accent seed its hue and construction. The accent
    deepens four points and doubles as its own text, which is the deep-fill
    argument in one line: no lightness surgery for light mode."""
    log = []
    t = {
        "abyss": (96.5, 0, 0),
        "inset": (95.5, 0, 0),
        "panel": (100, 0, 0),
        "raised": (94, 0, 0),
        "float": (100, 0, 0),
        "line": (89, 0, 0),
        "line-strong": (64, 0, 0),
        "ink": (22, 0, 0),
        "ink-muted": (43, 0, 0),
        "ink-faint": (52, 0, 0),
    }
    grounds = (t["abyss"], t["panel"])

    la, ca, ha = accent
    beam = shrink_into_gamut((la - 4, round(ca - 0.02, 3), ha), log, "beam")
    bl, bc, _ = beam
    while min(contrast((bl, bc, ha), g) for g in grounds) < 4.75:
        bl -= 0.5
        log.append(f"beam: deepened to L{bl} for AA-as-text on paper")
    t["beam"] = (bl, bc, ha)
    t["beam-dim"] = shrink_into_gamut((bl - 8, bc, ha), log, "beam-dim")
    t["beam-ink"] = (98, 0.005, ha)
    assert contrast(t["beam-ink"], t["beam"]) >= 4.5, "beam-ink fails on beam"
    t["beam-text"] = t["beam"]

    t.update(walk_status(STATUS_LIGHT, grounds, -1, log))
    t["amber-ink"] = (98, 0.005, 85)
    return t, log


# The shipped palette, verbatim from renderer/src/index.css — the control.
CONTROL = {
    "abyss": (9, 0.003, 250),
    "inset": (10.5, 0.003, 250),
    "panel": (13, 0.003, 250),
    "raised": (16, 0.004, 250),
    "float": (18.5, 0.005, 250),
    "line": (27, 0.004, 250),
    "line-strong": (50, 0.006, 250),
    "ink": (97, 0.002, 250),
    "ink-muted": (76, 0.004, 250),
    "ink-faint": (60, 0.005, 250),
    "beam": (86, 0.14, 192),
    "beam-dim": (74, 0.12, 192),
    "beam-ink": (16, 0.025, 192),
    "beam-text": (86, 0.14, 192),  # the bright ink IS its own text today
    "cyan": (80, 0.1, 250),
    "sage": (64, 0.035, 310),
    "mint": (84, 0.17, 150),
    "amber": (85, 0.155, 85),
    "amber-ink": (16, 0.03, 85),
    "signal": (70, 0.18, 25),
}


# ───────────────────────────────────────────────────────────────────────────
# Emission: derived tokens → the mockup's variable vocabulary.
# ───────────────────────────────────────────────────────────────────────────


def fmt(t):
    l, c, h = t
    ls = f"{l:g}"
    cs = f"{c:g}"
    return f"oklch({ls}% {cs} {h:g})"


def wash(t, alpha):
    l, c, h = t
    return f"oklch({l:g}% {c:g} {h:g} / {alpha})"


# Held constant across all six files: the only variable this round is colour.
HELD = """
  --sans: 'Geist', ui-sans-serif, system-ui, sans-serif; --display: var(--sans); --prose: var(--sans);
  --mono: 'Geist Mono', ui-monospace, Menlo, monospace;
  --fs: 13px; --lh-prose: 1.55; --w-hi: 600; --tr-hi: -0.01em; --tr-ui: 0.01em;
  --r: 4px; --r-sm: 3px; --r-win: 6px; --r-pill: 999px; --gap: 9px;
  --sh-win: none;"""

FONTS = "@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap');"

# Identical in every file. The accent is a fill; where the layout uses it as
# text (the back link, the send affordance, inline code) it takes beam-text.
SHARED_CSS = """
/* Round five varies the seed pair only. Type, radius, washes and every
   structural rule are one value across all six files; the token block above
   is the only thing allowed to differ. Accent-as-text takes --accent-text —
   a deep fill cannot be read at 13px, and pretending otherwise is how the
   bright-ink teal happened. */
a.back { color: var(--accent-text); }
.status .send { color: var(--accent-text); }
code { font: 12px var(--mono); color: var(--accent-text); }"""

# The split file's one extra block: the ChatGPT-desktop pattern, dark rail on
# light content. It scopes the dark pass to the window header and sidebar and
# changes nothing else — the two palettes are the 5b and 5e derivations.
SPLIT_CSS = """
/* Split-tone: the rail and header take the dark pass verbatim. */
.hdr { background: var(--d-panel); border-bottom-color: var(--d-line); }
.hdr .icon { border-color: var(--d-line); color: var(--d-ink-2); }
.lights i { background: var(--d-line-2); }
.crumb { color: var(--d-ink-2); } .crumb b { color: var(--d-ink); } .crumb span { color: var(--d-ink-3); }
.ctx { color: var(--d-amber); }
.ctxbar { background: var(--d-inset); }
.ctxbar i { background: var(--d-amber); }
.side .card { background: var(--d-panel); border-color: var(--d-line); }
.side .icon { border-color: var(--d-line); color: var(--d-ink-2); }
.side .proj { color: var(--d-ink-3); }
.side .sess { color: var(--d-ink-2); }
.side .sess.on { background: var(--d-inset); color: var(--d-ink); border-left-color: var(--d-beam); }
.side .sess .dot { background: var(--d-line-2); }
.side .sess .dot.run { background: var(--d-cyan); }
.side .sess .dot.gate { background: var(--d-amber); }
.side .sess .ago { color: var(--d-ink-3); }
.upd .a { color: var(--d-ink); } .upd .b { color: var(--d-ink-3); }
.newbtn { background: var(--d-beam); color: var(--d-beam-ink); }"""


def tokens_css(t, mode):
    void = t["abyss"][0] - (1.5 if mode == "dark" else 3)
    pairs = [
        ("void", fmt((void, *t["abyss"][1:]))),
        ("bg", fmt(t["abyss"])),
        ("chrome", fmt(t["panel"])),
        ("well", fmt(t["inset"])),
        ("bar", fmt(t["raised"])),
        ("ph-bg", fmt(t["panel"])),
        ("line", fmt(t["line"])),
        ("line-2", fmt(t["line-strong"])),
        ("ink", fmt(t["ink"])),
        ("ink-2", fmt(t["ink-muted"])),
        ("ink-3", fmt(t["ink-faint"])),
        ("accent", fmt(t["beam"])),
        ("accent-ink", fmt(t["beam-ink"])),
        ("accent-text", fmt(t["beam-text"])),
        ("tool", fmt(t["cyan"])),
        ("think", fmt(t["sage"])),
        ("dele", fmt(t["beam-text"])),
        ("ok", fmt(t["mint"])),
        ("warn", fmt(t["amber"])),
        ("warn-ink", fmt(t["amber-ink"])),
        ("err", fmt(t["signal"])),
        ("add-bg", wash(t["mint"], 0.10)),
        ("del-bg", wash(t["signal"], 0.10)),
        ("gate-bg", wash(t["amber"], 0.07)),
        ("syn-kw", fmt(t["beam-text"])),
        ("syn-st", fmt(t["mint"])),
        ("syn-fn", fmt(t["ink"])),
        ("syn-nu", fmt(t["amber"])),
    ]
    lines = []
    for i in range(0, len(pairs), 3):
        lines.append("  " + " ".join(f"--{k}: {v};" for k, v in pairs[i : i + 3]))
    return "\n".join(lines)


def dark_rail_css_tokens(d):
    pairs = [
        ("d-panel", fmt(d["panel"])),
        ("d-inset", fmt(d["inset"])),
        ("d-line", fmt(d["line"])),
        ("d-line-2", fmt(d["line-strong"])),
        ("d-ink", fmt(d["ink"])),
        ("d-ink-2", fmt(d["ink-muted"])),
        ("d-ink-3", fmt(d["ink-faint"])),
        ("d-beam", fmt(d["beam"])),
        ("d-beam-ink", fmt(d["beam-ink"])),
        ("d-cyan", fmt(d["cyan"])),
        ("d-amber", fmt(d["amber"])),
    ]
    lines = []
    for i in range(0, len(pairs), 3):
        lines.append("  " + " ".join(f"--{k}: {v};" for k, v in pairs[i : i + 3]))
    return "\n".join(lines)


TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title} — round five, the seed pair</title>
<style>
{fonts}
/* ── {title}. Round five: the palette from a seed pair.
   seeds: {seedline}
   Every colour below is DERIVED by _seed_build.py — the lift schedule, the
   ink floors and the contrast walks live there. The structural CSS and the
   session markup are imported byte-identical from _build.py. To change this
   file, change the seed and re-run: python3 docs/design/_seed_build.py
{floorlog}   ─────────────────────────────────────────────────────────────────────── */
:root {{
{tokens}
{held}
}}
{base}
{css}
</style>
</head>
<body>
<div class="page">
  <a class="back" href="index.html">← all six</a>
  <div class="kicker" style="margin-top:12px">{kicker}</div>
  <h1>{title}</h1>
{lede}
  <div class="spec">
{spec}
  </div>
{window}
  <div class="foot">
    <div class="box">
      <h3>What this seed argues</h3>
      <ul>
{wins}
      </ul>
    </div>
    <div class="box">
      <h3 class="cost">What it costs</h3>
      <ul>
{costs}
      </ul>
    </div>
  </div>
</div>
{fit}
</body>
</html>
"""


# ───────────────────────────────────────────────────────────────────────────
# The six variants. (b) is the settled direction; (c) and (d) bracket it from
# below and above so judging picks a point on a line instead of rubber-stamping
# the only point shown; (a) is the shipped palette, the control.
# ───────────────────────────────────────────────────────────────────────────

SEED_CANVAS = 15.5
SEED_ACCENT = (52, 0.21, 264)

VARIANTS = [
    dict(
        slug="5a-control",
        kicker="5A · CONTROL — THE SHIPPED PALETTE",
        title="Control",
        seedline="none — every value below is hand-picked, which is the point",
        derive=lambda: (CONTROL, []),
        mode="dark",
        lede=[
            "The palette that ships today, rendered in this round's frame so the seed variants have something to lose to: teal ink at L86 for the accent, a 9% ground, a 250-hue tint through every grey, and five surface lightnesses that were each picked by hand and argued for in <code>index.css</code>.",
            "Nothing here is derived. That is what the round is deciding — whether a two-number seed can beat a file of hand decisions, judged on the same session in the same frame.",
        ],
        wins=[
            "<b>It is the incumbent.</b> Every value was individually argued, checked and shipped; the worst text contrast on screen is 5.1:1 and nothing clips.",
            "<b>The accent is unmissable.</b> At L86 and chroma 0.14 the teal reads from across the room; no seed variant is louder.",
            "<b>One decision per token</b> — any single value can be tuned without a derivation rule caring.",
        ],
        costs=[
            "<b>Nothing. It is the control.</b> The claims against it live in the other five files: the bright-ink teal was judged hard on the eyes over a working day, and hand-picked surfaces are why every palette change so far has been a full re-argument instead of a re-seed.",
        ],
    ),
    dict(
        slug="5b-violet",
        kicker="5B · THE SETTLED DIRECTION",
        title="Beam 264",
        seedline=f"canvas oklch({SEED_CANVAS}% 0 0) · accent {fmt(SEED_ACCENT)}",
        derive=lambda: derive_dark(SEED_CANVAS, SEED_ACCENT),
        mode="dark",
        lede=[
            "<b>The settled direction, derived.</b> A bare neutral canvas at 15.5% — chroma zero, no accent tint in the greys — with every surface a computed lift off that one number. One deep blue-violet fill at 52%/0.21/264 that carries light text, T3-fashion, instead of a bright ink that glares on a dark ground.",
            "The accent becomes a <b>place</b> rather than a light source: the button, the active tab and the focused rail are somewhere text sits. Tools-cyan moves 250 → 210, because any blue accent forces it out from under the 40° pairwise rule.",
        ],
        wins=[
            "<b>Two numbers decide the theme.</b> Canvas and accent; the other nineteen tokens are the lift schedule and contrast walks in <code>_seed_build.py</code>. A future theme is a new seed pair, not a new argument.",
            "<b>The accent stops shouting.</b> A 52% fill under 97% text is read, not endured — the L86 teal was rejected as hard on the eyes, and this is the shape of the fix.",
            "<b>Neutral greys divorce the substrate from the accent.</b> Today the accent's hue tints every surface, so changing one means re-arguing all of them. At chroma zero the canvas is just depth.",
            "<b>The same construction survives light mode.</b> A deep fill needs no lightness surgery on paper — where the teal ink had to fall from L86 to L52 and give up 40% of its chroma.",
        ],
        costs=[
            "<b>A deep fill cannot be text.</b> At 52% the accent clears 3:1 on the panel as a component but nowhere near 4.5:1 as text, so the seed derives a companion — <code>beam-text</code>, the same hue walked down to the last half-step that holds 4.75:1 — and the app's validator has to learn the difference at conversion time. This is the one place the derivation bends, and the bend is in the file, not hidden.",
            "<b>Hue 264 is 23° from the violet round three called the least ownable hue available.</b> What buys it back is depth: nobody's AI-tool violet is a mid-lightness fill on a bare grey. If that argument fails by eye, the hue has to move — not the depth.",
            "<b>264 against thinking-310 is 46°</b> — six degrees of margin over the rule. Legal, and tight enough that neither hue can drift in a later tune without re-running the check.",
        ],
    ),
    dict(
        slug="5c-violet-dim",
        kicker="5C · BRACKET, FROM BELOW",
        title="Beam 264 · dimmer",
        seedline=f"canvas oklch({SEED_CANVAS}% 0 0) · accent oklch(44% 0.21 264) — 3:1 floor off",
        derive=lambda: derive_dark(SEED_CANVAS, (44, 0.21, 264), floor_accent=False),
        mode="dark",
        lede=[
            "Same seeds, accent one notch dimmer: 44% instead of 52%. The eyes-first argument taken one step past the settled direction — if 52% still reads as glare after six hours, this is the retreat position, priced now rather than discovered later.",
            "Everything else is identical to Beam 264 by construction: same canvas, same lifts, same status walk. Only the accent seed moved.",
        ],
        wins=[
            "<b>The quietest accent of the six.</b> At 44% the fill is barely louder than the float surface — the app at rest is almost monochrome, and the gate amber owns the room when it appears.",
            "<b>It brackets the target from below.</b> Judging picks a point on a line rather than approving the only point shown.",
        ],
        costs=[
            "<b>It fails the component floor.</b> At 44% the fill measures ≈2.2:1 against the panel, under the 3:1 the derivation enforces — the floor is switched off for this file so the bracket exists at all. Ship this and the button, the active tab and the focus ring all need a border's help to be found.",
            "<b>Hover has nowhere to go.</b> <code>beam-dim</code> derives to 36%, four points off the float surface — states built on the accent stop being tellable apart.",
        ],
    ),
    dict(
        slug="5d-canvas-lift",
        kicker="5D · BRACKET, FROM ABOVE",
        title="Beam 264 · canvas 17.5",
        seedline=f"canvas oklch(17.5% 0 0) · accent {fmt(SEED_ACCENT)}",
        derive=lambda: derive_dark(17.5, SEED_ACCENT),
        mode="dark",
        lede=[
            "Same seeds, canvas one notch lighter: 17.5% instead of 15.5% — T3 Code's actual depth rather than our reading of it. Every surface lifts with it by construction: the panel lands at 21.5%, the float at 27%.",
            "This is the other jaw of the bracket. If 15.5% reads as a hole and 17.5% reads as a surface, the settled number is defensible; if this one wins, the seed moves and nothing else has to.",
        ],
        wins=[
            "<b>Softest of the dark passes.</b> The window reads as an object in the room rather than a hole in the desktop, which is what the T3-boring reference actually looks like.",
            "<b>It brackets the target from above</b>, and it demonstrates the seed doing its job: one number moved and twelve tokens followed, two of them through logged contrast walks.",
        ],
        costs=[
            "<b>Every ratio compresses toward its floor.</b> The accent fill falls from 3.16:1 to 3.02:1 on the panel — one more half-point of canvas and the derivation starts walking the accent instead. <code>ink-faint</code> drops from 5.02:1 to 4.81:1, and <code>beam-text</code> has to sit half a point lighter to hold its 4.75 margin. Nothing fails; everything is nearer to failing.",
            "<b>The ground stops disappearing.</b> On a dark desktop 17.5% is a visible grey — the app becomes a lit rectangle, and the panes lose the trough that separates them.",
        ],
    ),
    dict(
        slug="5e-violet-light",
        kicker="5E · THE SAME SEEDS, LIGHT",
        title="Beam 264 · light",
        seedline=f"canvas oklch({SEED_CANVAS}% 0 0) · accent {fmt(SEED_ACCENT)} → light pass",
        derive=lambda: derive_light(SEED_ACCENT),
        mode="light",
        lede=[
            "The same two seeds run through the light derivation: paper anchors at 100% and every surface is a computed drop below it; the canvas seed contributes its chroma policy — zero, neutral — and the accent keeps its hue and construction, deepened four points. Not an inversion: a second pass of the same rules.",
            "This is where deep-fill collects its win. The 264 fill doubles as its own text on paper — <code>beam-text</code> and <code>beam</code> are the same token here — where the shipped teal had to fall from L86 to L52 and give up 40% of its chroma to survive light mode at all.",
        ],
        wins=[
            "<b>One accent construction, both modes.</b> The dark pass and this one share the seed and the fill-plus-light-text shape; nothing about the accent has to be re-decided for light.",
            "<b>The status walk runs downhill.</b> In light the derivation deepens any status colour that misses AA, same rule, opposite direction — the machinery is symmetric and it shows.",
        ],
        costs=[
            "<b>Light has 3.5 points of range where dark has 9.5.</b> Abyss, inset and raised sit within 2.5 points of paper, so the hairlines do nearly all the separating — a bad monitor takes more of this palette with it than it takes of the dark one.",
            "<b>The washes thin out.</b> A 10% amber wash over paper is fainter than the same wash over 15.5% grey; the gate leans harder on its border here.",
        ],
    ),
    dict(
        slug="5f-violet-split",
        kicker="5F · SPLIT-TONE — DARK RAIL, LIGHT CONTENT",
        title="Beam 264 · split",
        seedline=f"canvas oklch({SEED_CANVAS}% 0 0) · accent {fmt(SEED_ACCENT)} → both passes",
        derive=lambda: derive_light(SEED_ACCENT),
        mode="split",
        lede=[
            "Dark rail, light content — the ChatGPT desktop pattern, rendered for judging rather than argued about. The window header and sidebar take the dark pass verbatim; the panes, dock and composer take the light pass. One extra CSS block scopes the rail, and everything else is the two derivations unmodified.",
            "The claim under it: the rail is chrome you glance at and the transcript is text you read for hours, so the rail can keep the app's dark identity while the reading surface gets paper's contrast range.",
        ],
        wins=[
            "<b>The session list recedes and the work comes forward.</b> The eye goes where the paper is, which is where the transcript is.",
            "<b>Both derivations are exercised at once</b> — if the seed rules hold up here, they hold up anywhere a theme needs to compose.",
        ],
        costs=[
            "<b>Two palettes in one window is two of everything.</b> Focus, selection and every status colour must be checked twice, and the permission-gate amber has to carry the same urgency on grey and on paper.",
            "<b>The seam needs a rule no token owns.</b> Where the dark rail meets the light ground there is an edge that belongs to neither pass, and it is the first thing a screenshot shows.",
        ],
    ),
]


def spec_rows(v, t, dark_t=None):
    if v["slug"] == "5a-control":
        seed = ("SEED", "val", "none — hand-picked")
    else:
        seed = ("SEED", "val", v["seedline"].split(" → ")[0].split(" — ")[0])
    rows = [
        seed,
        ("GROUND", "sw", [fmt(t["abyss"]), fmt(t["panel"]), fmt(t["inset"])]),
        ("ACCENT", "sw", [fmt(t["beam"]), fmt(t["beam-text"]), fmt(t["beam-ink"])]),
        ("STATUS", "sw", [fmt(t["cyan"]), fmt(t["sage"]), fmt(t["mint"]), fmt(t["amber"]), fmt(t["signal"])]),
        ("HELD", "val", "Geist · 13px · radii · washes"),
    ]
    if dark_t is not None:
        rows.insert(2, ("RAIL", "sw", [fmt(dark_t["panel"]), fmt(dark_t["line"]), fmt(dark_t["ink"])]))
    return rows


def build():
    for v in VARIANTS:
        t, log = v["derive"]()
        css = SHARED_CSS
        tokens = tokens_css(t, "dark" if v["mode"] == "dark" else "light")
        dark_t = None
        if v["mode"] == "split":
            dark_t, dark_log = derive_dark(SEED_CANVAS, SEED_ACCENT)
            log = log + dark_log
            tokens += "\n" + dark_rail_css_tokens(dark_t)
            css = SHARED_CSS + "\n" + SPLIT_CSS
        floorlog = ""
        if log:
            floorlog = "".join(f"   floor: {line}\n" for line in log)
        html = TEMPLATE.format(
            title=v["title"],
            kicker=v["kicker"],
            seedline=v["seedline"],
            fonts=FONTS,
            floorlog=floorlog,
            tokens=tokens,
            held=HELD,
            base=_build.BASE,
            css=css,
            lede="\n".join(f'  <p class="note">{p}</p>' for p in v["lede"]),
            spec=_build.spec_html(spec_rows(v, t, dark_t)),
            window=_build.WINDOW,
            wins="\n".join(f"        <li>{w}</li>" for w in v["wins"]),
            costs="\n".join(f"        <li>{c}</li>" for c in v["costs"]),
            fit=_build.FIT,
        )
        (OUT / f'{v["slug"]}.html').write_text(html)
        print(f'wrote {v["slug"]}.html' + (f"  ({len(log)} floor(s) applied)" if log else ""))
        for line in log:
            print(f"   floor: {line}")


if __name__ == "__main__":
    build()
