#!/usr/bin/env python3
"""Generate the 7D full pass: every Artemis surface in the Console treatment.

7D won the round-seven surface judging. This file takes that treatment —
8px radii, alpha hairlines, sans chrome in sentence case, computed surface
lifts, a composer that reads as a card — and applies it to the *whole*
application rather than a single conversation, so the conversion can be
judged on the surfaces that actually cost work: the dock, the navigator,
the palette, settings, the permission gate, the banners and the empty state.

The arrangement here is Artemis's own — session list, pane grid, dock — not
round seven's simplified three-region shape. The navigator rail is gone: its
toggle rides the session list and relocates to the frame header when closed. Round six's
arrangement question stays open; this shows the treatment on what ships.

Language block is imported from _round7_build so 7D cannot drift between the
judging file and this one. Colour is round five's verdict via _seed_build.

    python3 docs/design/_round7d_build.py

Writes 7d-full.html next to this file.
"""

import math
import pathlib

import _round7_build as R7
import _seed_build as S

OUT = pathlib.Path(__file__).parent

DARK, _ = S.derive_dark(S.SEED_CANVAS, S.SEED_ACCENT)
LIGHT, _ = S.derive_light(S.SEED_ACCENT)

# ───────────────────────────────────────────────────────────────────────────
# Everything the shell holds. Sessions carry the states the list really has.
# ───────────────────────────────────────────────────────────────────────────

PINNED = [("The sandbox lets a write escape", "gate", "now", True)]
ARTEMIS = [
    ("Dock remembers its arrangement", "run", "4m", False),
    ("Probe the capability flags", "", "1h", False),
    ("OpenCode model configurator", "done", "3h", False),
]
CEREBRO = [
    ("Setup wizard for any bank", "run", "now", False),
    ("Local-only bank, no remote", "", "2d", False),
]

DOCK_TABS = [
    ("⌘", "terminal", True),
    ("◧", "browser", False),
    ("▤", "files", False),
    ("☰", "tasks", False),
    ("◈", "agent", False),
    ("▣", "preview", False),
]

SETTINGS_NAV = [
    ("Settings", ["Profiles", "Models", "Runs", "Instructions", "Permissions & access", "Appearance"]),
    ("This machine", ["Server", "Remote", "Routines", "This machine"]),
]

# ───────────────────────────────────────────────────────────────────────────
# The usage rings, ported from components/PlanUsageMeter.tsx rather than
# redrawn. Same 36-unit box, same radii and stroke, same twelve-o'clock start,
# same tone thresholds, same number-inside-the-ring, same mono label in front.
# The app draws up to three — 5hr, Week, Fable — and *skips* a window the plan
# does not report, because an unfilled ring reads as a ring at 0%.
# ───────────────────────────────────────────────────────────────────────────

RING_RADIUS = 15
RING_STROKE = 4
DISC_RADIUS = RING_RADIUS - RING_STROKE / 2
RING_CIRCUMFERENCE = 2 * math.pi * RING_RADIUS

# (arc, disc, text) — ringToneFor's four branches in the mockup vocabulary.
RING_TONES = {
    "ok": ("var(--ok)", "color-mix(in srgb, var(--ok) 12%, transparent)", "var(--ink-2)"),
    "warn": ("var(--warn)", "color-mix(in srgb, var(--warn) 15%, transparent)", "var(--warn)"),
    "bad": ("var(--err)", "color-mix(in srgb, var(--err) 15%, transparent)", "var(--err)"),
    "none": ("var(--line)", "color-mix(in srgb, var(--line) 25%, transparent)", "var(--ink-3)"),
}


def ring_tone(pct, rejected):
    if rejected or (pct is not None and pct >= 90):
        return "bad"
    if pct is None:
        return "none"
    return "warn" if pct >= 75 else "ok"


def usage_ring(pct, rejected=False):
    arc_c, disc_c, text_c = RING_TONES[ring_tone(pct, rejected)]
    # A rejected window draws full whatever its number reads — the geometry
    # says what the provider is doing, the number what it last reported.
    filled = 100 if rejected else (0 if pct is None else max(0, min(100, pct)))
    text = ("!" if rejected else "—") if pct is None else str(round(pct))
    # No arc at all at zero: a round cap on a zero-length dash paints a dot.
    arc = ""
    if filled > 0:
        dash = f"{RING_CIRCUMFERENCE * filled / 100:.3f} {RING_CIRCUMFERENCE:.3f}"
        arc = (f'<circle cx="18" cy="18" r="{RING_RADIUS}" fill="none" '
               f'stroke-width="{RING_STROKE}" stroke-linecap="round" '
               f'stroke-dasharray="{dash}" stroke="{arc_c}"/>')
    size = "8px" if len(text) > 2 else "9px"
    return (f'<span class="uring"><svg viewBox="0 0 36 36" aria-hidden="true">'
            f'<circle cx="18" cy="18" r="{DISC_RADIUS}" fill="{disc_c}"/>'
            f'<circle cx="18" cy="18" r="{RING_RADIUS}" fill="none" stroke-width="{RING_STROKE}" '
            f'stroke="color-mix(in srgb, var(--line) 60%, transparent)"/>{arc}</svg>'
            f'<i style="font-size:{size};color:{text_c}">{text}</i></span>')


def usage_rings(slots):
    return '<span class="meter">' + "".join(
        f'<span class="slot"><span class="sl">{label}</span>{usage_ring(pct, rej)}</span>'
        for label, pct, rej in slots) + "</span>"


# Two rings, which is what an account without a Fable bucket shows.
SLOTS = [("5hr", 61, False), ("Week", 88, False)]
# The same meter once the weekly window is spent — the state the hand-off
# picker and the rate-limit door are both about.
SLOTS_SPENT = [("5hr", 61, False), ("Week", 97, True)]

SHORTCUTS = [
    ("⌘K", "Command palette"), ("⌘N", "New session"), ("⌘B", "Session list"),
    ("⌘J", "Terminal"), ("⌘⇧B", "Browser"), ("⌘\\", "Split right"),
    ("⌘⇧\\", "Split down"), ("⌘I", "Run info"), ("⌘,", "Settings"),
    ("esc", "Deny · stop the run"),
]


def row(title, state, ago, on=False, pin=False):
    dot = f'<i class="dot {state}"></i>' if state else '<i class="dot"></i>'
    p = '<span class="pin">◆</span>' if pin else ""
    return (f'<div class="row{" on" if on else ""}">{dot}{p}<span class="t">{title}</span>'
            f'<span class="ago">{ago}</span></div>')


def session_list(menu=False):
    out = ['<div class="grp">Pinned</div>']
    out += [row(*s[:3], on=s[3] or i == 0, pin=True) for i, s in enumerate(PINNED)]
    out.append('<div class="grp">artemis <span class="ct">3</span></div>')
    out += [row(*s[:3]) for s in ARTEMIS]
    out.append('<div class="grp">cerebro <span class="ct">2</span></div>')
    out += [row(*s[:3]) for s in CEREBRO]
    out.append('<div class="grp">Archived <span class="ct">14</span></div>')
    return "\n            ".join(out)


# ───────────────────────────────────────────────────────────────────────────
# Transcript grammar — every row type the real transcript can render.
# ───────────────────────────────────────────────────────────────────────────

M_USER = """<div class="msg u"><div class="hov"><span class="hb">⑂ fork</span><span class="hb">↺ rewind</span></div>
                <div class="bub">The sandbox lets a write escape — the browser tab reached <code>~/.config</code> while the pane was scoped to the repo. Find where the scope is dropped.</div></div>"""

M_THINK = """<div class="msg a"><div class="think"><span class="cv">▾</span>Thought for 4s</div>
                <div class="thinkbody">Scope is attached when a tab spawns — but the dock can adopt a tab from another pane, and that path may never re-derive it.</div></div>"""

M_ACT = """<div class="msg a"><div class="act"><span class="cv">›</span>Ran 36 commands, read 6 files
                  <span class="tm">2m 14s</span></div></div>"""

M_TOOL = """<div class="msg a"><div class="step">
                  <span class="ic">⌕</span><span class="nm">Searched</span>
                  <span class="ar"><code>scopePath</code> · 14 files</span>
                  <span class="tm">0.4s</span><span class="cv">›</span></div></div>"""

M_TOOL_OPEN = """<div class="msg a"><div class="step open">
                  <span class="ic">✎</span><span class="nm">Edited</span>
                  <span class="ar"><code>state/dock.ts</code></span>
                  <span class="dd"><span class="p">+7</span><span class="m">−2</span></span>
                  <span class="tm">0.2s</span><span class="cv">⌄</span></div>
                <div class="fold"><div class="fh">Result <span class="cv">⌄</span></div></div></div>"""

M_PLAN = """<div class="msg a"><div class="plan">
                  <div class="pl done"><span class="m">✓</span>Reproduce the escape in a scoped pane</div>
                  <div class="pl done"><span class="m">✓</span>Trace scopePath through adoptTab</div>
                  <div class="pl now"><span class="m">◐</span>Re-derive scope at adoption</div>
                  <div class="pl"><span class="m">○</span>Cover the drag path in dock.test.ts</div>
                </div></div>"""

M_DELE = """<div class="msg a"><div class="chips">
                  <span class="chip"><i class="run"></i>explore · scope call sites<span class="tm">1m 02s</span></span>
                  <span class="chip"><i class="done"></i>read · dock.ts</span></div></div>"""

M_DIFF = """<div class="msg a"><div class="patch">
                  <div class="ph"><span class="f">state/dock.ts</span>
                    <span class="n"><span class="p">+7</span><span class="m">−2</span></span>
                    <span class="cv">⌄</span></div>
                  <pre><span class="c">  function adoptTab(tab, pane) {</span>
<span class="d">-   return { ...tab, paneId: pane.id }</span>
<span class="a">+   // a tab that changes hands re-derives its scope; the</span>
<span class="a">+   // one it arrived with belonged to the pane it left.</span>
<span class="a">+   return { ...tab, paneId: pane.id,</span>
<span class="a">+     scopePath: scopeFor(pane.session) }</span>
<span class="c">  }</span></pre></div></div>"""

M_ARTIFACT = """<div class="msg a"><div class="art">
                  <span class="ai">▣</span><div class="an"><b>scope-audit.md</b><span>written · 2.4 kB</span></div>
                  <span class="ab">Open</span></div></div>"""

M_ASK = """<div class="msg a"><div class="ask">
                  <div class="at"><span class="ac">◆</span>Write outside the repo?</div>
                  <div class="acd"><code>~/.config/artemis/settings.json</code></div>
                  <div class="aw">This pane is scoped to <b>artemis</b>. The path is outside it.</div>
                  <div class="are">Reason for denying (optional)</div>
                  <div class="ab2"><span class="b">Deny<span class="k">esc</span></span>
                    <span class="b">Deny &amp; stop run</span>
                    <span class="b">Allow for this session</span>
                    <span class="b go">Approve once<span class="k">⌘↵</span></span></div>
                </div></div>"""

M_SAID = """<div class="msg a"><div class="prose"><b>adoptTab</b> carries the old pane's <code>scopePath</code> across. A tab dragged out of a repo-scoped pane keeps the permissive scope, and the browser inherits it. The fix re-derives scope at adoption; the test covers the drag path.</div></div>"""

M_END = """<div class="msg a"><div class="end"><span>Run ended · 4m 12s · 38 turns · $1.24</span></div></div>"""

# Split across two screens rather than one: at 1000px a pane cannot show the
# whole grammar at once, and a mockup whose top half is scrolled off is not
# showing what it claims to. Live run first, settled run second.
THREAD_LIVE = "\n              ".join([M_USER, M_THINK, M_ACT, M_TOOL, M_PLAN, M_ASK])
THREAD_DONE = "\n              ".join(
    [M_USER, M_TOOL_OPEN, M_DELE, M_DIFF, M_ARTIFACT, M_SAID, M_END])
THREAD_SHORT = "\n              ".join([M_USER, M_TOOL, M_SAID])


# ───────────────────────────────────────────────────────────────────────────
# Extra CSS: everything round seven's four files did not need.
# ───────────────────────────────────────────────────────────────────────────

EXTRA = """
/* ── the frame header: identity left, command centre, controls right ────── */
.tl { display: flex; align-items: center; gap: 9px; flex: 1 1 0; min-width: 0; }
.tl .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc { flex: 0 1 auto; display: flex; justify-content: center; min-width: 0; }
.tr { display: flex; align-items: center; gap: 5px; flex: 1 1 0; justify-content: flex-end; }

/* The command bar earns the middle of the window. It was a 100px pill lost in
   a row of icons; at this width it reads as the way in rather than a button
   you have to already know about. */
.cmdbar { width: 460px; max-width: 100%; height: 30px; display: flex; align-items: center;
  gap: 9px; padding: 0 11px; border: var(--hair-in); background: var(--fill-in);
  border-radius: var(--r-ctl); font-size: var(--fs-ctl); color: var(--ink-3); }
.cmdbar .k { margin-left: auto; font: var(--f-meta); color: var(--ink-3);
  border: var(--hair); border-radius: 4px; padding: 1px 5px; }

/* One question, three exclusive answers, all three visible — the shape the
   app's own ThemeToggle argues for, in this treatment. */
.seg3 { display: flex; align-items: center; gap: 2px; padding: 2px; flex: none;
  border: var(--hair); background: var(--fill-in); border-radius: var(--r-ctl); }
.seg3 s { text-decoration: none; width: 24px; height: 24px; display: grid; place-items: center;
  border-radius: 5px; color: var(--ink-3); border: 1px solid transparent; }
.seg3 s.on { border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent-text); }
.sep { width: 1px; height: 16px; background: var(--line); flex: none; margin: 0 3px; display: block; }

/* Icons are drawn, not typed. */
.ico svg, .seg3 s svg, .sbt svg, .cmdbar svg { width: 14px; height: 14px; display: block; flex: none; }
.cmdbar svg { width: 13px; height: 13px; }

/* ── the pane opener ────────────────────────────────────────────────────── */
/* A plus that says what it can open, rather than five chords to remember.
   Anchored under its own button, not centred: a menu that belongs to a
   control should come out of that control. */
.scrim.anchor { place-items: start end; padding: 44px 12px 0 0; }
.menu { width: 268px; background: var(--float); border: var(--hair-in);
  border-radius: var(--r-comp); box-shadow: var(--sh-pop); padding: 6px; overflow: hidden; }
.menu .mg { font: var(--f-grp); letter-spacing: var(--tr-grp); text-transform: var(--case-grp);
  color: var(--ink-3); padding: 9px 9px 4px; }
.menu .mi { display: flex; align-items: center; gap: 10px; padding: 8px 9px;
  border-radius: var(--r-ctl); font-size: var(--fs-row); color: var(--ink-2); }
.menu .mi svg { width: 14px; height: 14px; flex: none; color: var(--ink-3); }
.menu .mi .k { margin-left: auto; font: var(--f-meta); color: var(--ink-3); }
.menu .mi .ct { margin-left: auto; font: var(--f-meta); color: var(--ink-3);
  border: var(--hair); border-radius: 999px; padding: 0 6px; }
/* Shown, disabled, with the sentence — never hidden. */
.menu .mi.off { color: var(--ink-3); }
.menu .mi.off .why { margin-left: auto; font: var(--f-meta); color: var(--warn); }
.ico.open { color: var(--ink-2); }

/* ── the task list ──────────────────────────────────────────────────────── */
/* Pane-level, on the same column as the messages so it lines up with them
   rather than with the pane's edge. */
.taskbar { flex: none; padding: 10px var(--pad-x-col) 0; }
.main.q .taskbar { padding: 8px var(--pad-x-col-q) 0; }
.taskbar .tasks { max-width: var(--w-col); margin: 0 auto; }
.tasks { border: var(--hair); border-radius: var(--r-card); background: var(--fill-card);
  overflow: hidden; }
.thead { display: flex; align-items: center; gap: 9px; padding: 8px 11px;
  font-size: var(--fs-meta); color: var(--ink-3); }
.thead .cv { color: var(--ink-3); font-size: 10px; }
.thead .cur { color: var(--ink); font-weight: 550; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.thead .pg { margin-left: auto; font: var(--f-meta); flex: none; }
.thead .pbar { width: 54px; height: 3px; border-radius: 2px; flex: none;
  background: color-mix(in srgb, var(--ink) 10%, transparent); overflow: hidden; }
.thead .pbar i { display: block; height: 100%; background: var(--accent); }
.tbody { border-top: var(--hair); padding: 6px 11px 9px; display: flex;
  flex-direction: column; gap: 3px; }
.ti { display: flex; gap: 9px; font-size: var(--fs-meta); color: var(--ink-3); }
.ti .m { width: 11px; flex: none; }
.ti.done { text-decoration: line-through; }
.ti.done .m { color: var(--ok); }
.ti.now { color: var(--ink); } .ti.now .m { color: var(--warn); }

/* ── the sidebar toggle ─────────────────────────────────────────────────── */
/* There is no rail. The toggle rides the thing it toggles — the session
   list's own heading — and moves into the frame header only when the list is
   gone and there is nowhere else for it to be. One control, two homes,
   never both at once. */
.sbt { width: 22px; height: 22px; border-radius: var(--r-ctl); display: grid;
  place-items: center; color: var(--ink-3); font-size: 12px; flex: none; }
.sb .head .sbt { margin-right: 6px; }
.top .sbt { margin-right: 2px; border: var(--hair); }

/* ── session list extras ────────────────────────────────────────────────── */
.grp .ct { margin-left: auto; color: var(--ink-3); font-weight: 400; }
.grp { display: flex; }
.row .ago { margin-left: auto; font: var(--f-meta); color: var(--ink-3); flex: none; }
.row .pin { color: var(--ink-3); font-size: 8px; }
.sb .filt { height: var(--h-btn); border-radius: var(--r-ctl); border: var(--hair-in);
  background: var(--fill-in); display: flex; align-items: center; gap: 7px; padding: 0 10px;
  font-size: var(--fs-ctl); color: var(--ink-3); }
.sb .head { display: flex; align-items: center; padding: 2px 2px 0; }
.sb .head .h { font: var(--f-grp); letter-spacing: var(--tr-grp); text-transform: var(--case-grp); color: var(--ink-3); }
.sb .head .x { margin-left: auto; color: var(--ink-3); font-size: 11px; }
.upd { border: var(--hair); border-radius: var(--r-ctl); padding: 9px 10px;
  background: var(--fill-card); font-size: var(--fs-ctl); }
.upd b { color: var(--ink); display: block; margin-bottom: 2px; }
.upd span { color: var(--ink-3); font: var(--f-meta); }

/* ── pane caption + status line ─────────────────────────────────────────── */
.pcap { height: var(--h-mh); flex: none; display: flex; align-items: center; gap: 8px;
  padding: 0 var(--pad-mh); border-bottom: var(--hair-mh); font-size: var(--fs-ctl); color: var(--ink-3); }
.main.foc .pcap { color: var(--ink); }
.pcap .pd { font-size: 8px; color: var(--warn); }
.pcap .x { margin-left: auto; color: var(--ink-3); font-size: 11px; }
.main.foc { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
/* The status line describes the run the composer is about to start, so it is
   measured by the same column the transcript and the composer are — not by
   the pane. Padded to the pane instead, it reads as window chrome and the
   usage rings drift to the far edge, a screen away from the text they
   describe. One column: messages, composer, status. */
.stat { flex: none; padding: 0 var(--pad-x-col) 11px; }
.main.q .stat { padding: 0 var(--pad-x-col-q) 9px; }
.statin { max-width: var(--w-col); margin: 0 auto; display: flex; align-items: center;
  gap: 6px; font-size: var(--fs-meta); color: var(--ink-3); flex-wrap: wrap; }
.stat .sc { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px;
  border-radius: var(--r-ctl); color: var(--ink-2); background: var(--fill-card); }
.stat .sc b { color: var(--ink); font-weight: 550; }
.stat .sc.mode { color: var(--warn); }
.stat .sp { flex: 1; }
/* PlanUsageMeter's trigger row: label, then ring, gap-1 inside a slot and
   gap-2 between slots. Each ring is named in front of it — a percentage whose
   window you have to remember by position is one you will misread. */
.meter { display: flex; align-items: center; gap: 8px; flex: none; }
.meter .slot { display: flex; align-items: center; gap: 4px; flex: none; }
.meter .sl { font: 11px var(--mono); color: var(--ink-3); }
.uring { position: relative; width: 24px; height: 24px; flex: none;
  display: inline-flex; align-items: center; justify-content: center; }
.uring svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.uring i { position: relative; font-family: var(--mono); font-style: normal;
  line-height: 1; font-variant-numeric: tabular-nums; }

/* ── composer extras ────────────────────────────────────────────────────── */
.wd { display: inline-flex; align-items: center; gap: 6px; font: var(--f-meta);
  color: var(--ink-3); padding: 0 2px 7px; }
.wd b { color: var(--ink-2); font-weight: 400; }
.att { display: flex; gap: 6px; padding: 8px 10px 0; }
.att .a { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px;
  border: var(--hair); border-radius: var(--r-ctl); font: var(--f-meta); color: var(--ink-2); }
.att .a .x { color: var(--ink-3); }
.queue { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; padding: 8px 11px;
  border: var(--hair); border-radius: var(--r-ctl); background: var(--fill-card);
  font-size: var(--fs-meta); color: var(--ink-2); }
.queue .now { margin-left: auto; color: var(--accent-text); }
.slash { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); border: var(--hair-in);
  border-radius: var(--r-comp); background: var(--float); box-shadow: var(--sh-pop); overflow: hidden; }
.slash .si { display: flex; align-items: center; gap: 9px; padding: 8px 12px; font-size: var(--fs-ctl); color: var(--ink-2); }
.slash .si.on { background: var(--fill-on); color: var(--ink); }
.slash .si .d { margin-left: auto; color: var(--ink-3); font: var(--f-meta); }
.cwrap { position: relative; max-width: var(--w-col); margin: 0 auto; }
.stop { background: var(--err) !important; }

/* ── transcript extras ──────────────────────────────────────────────────── */
.msg { position: relative; }
.hov { position: absolute; top: -6px; right: 0; display: flex; gap: 5px; }
.hb { font: var(--f-meta); color: var(--ink-3); border: var(--hair); border-radius: var(--r-ctl);
  padding: 2px 7px; background: var(--chrome-main); }
.act { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-meta);
  color: var(--ink-3); border: var(--hair); border-radius: var(--r-ctl); padding: 6px 11px; }
.act .tm { color: var(--ink-3); font: var(--f-meta); }
.step.open { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.step .dd { font: var(--f-meta); }
.step .dd .p { color: var(--ok); } .step .dd .m { color: var(--err); margin-left: 4px; }
.fold { border: var(--hair); border-top: 0; border-radius: 0 0 var(--r-card) var(--r-card);
  background: var(--fill-pre); }
.fold .fh { padding: 7px 13px; font: var(--f-meta); color: var(--ink-3); display: flex; gap: 7px; }
.fold .fh .cv { margin-left: auto; }
.chips { display: flex; gap: 7px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 7px; border: var(--hair);
  border-radius: 999px; padding: 4px 11px; font: var(--f-meta); color: var(--ink-2); }
.chip i { width: 6px; height: 6px; border-radius: 50%; display: block; background: var(--line-2); }
.chip i.run { background: var(--tool); } .chip i.done { background: var(--ok); }
.chip .tm { color: var(--ink-3); }
.art { display: flex; align-items: center; gap: 11px; border: var(--hair);
  border-radius: var(--r-card); padding: 11px 13px; background: var(--fill-card); }
.art .ai { color: var(--accent-text); font-size: 15px; }
.art .an { display: flex; flex-direction: column; }
.art .an b { font-size: var(--fs-ctl); color: var(--ink); font-weight: 550; }
.art .an span { font: var(--f-meta); color: var(--ink-3); }
.art .ab { margin-left: auto; height: var(--h-ctl); display: inline-flex; align-items: center;
  padding: 0 12px; border: var(--hair); border-radius: var(--r-ctl); font-size: var(--fs-ctl); color: var(--ink-2); }
.ask .at { display: flex; align-items: center; gap: 8px; }
.ask .ac { color: var(--warn); font-size: 10px; }
.ask .acd { font: var(--f-meta); }
.ask .are { font: var(--f-meta); color: var(--ink-3); border: var(--hair-in);
  border-radius: var(--r-ctl); padding: 8px 11px; background: var(--fill-in); }
.ask .ab2 { display: flex; gap: 6px; flex-wrap: wrap; }
.ask .b .k { font: var(--f-meta); opacity: 0.6; margin-left: 6px; }
.end { display: flex; align-items: center; gap: 10px; font: var(--f-meta); color: var(--ink-3); }
.end::before, .end::after { content: ""; flex: 1; height: 1px; background: var(--line); opacity: 0.5; }
.jump { position: absolute; left: 50%; transform: translateX(-50%); bottom: 10px;
  border: var(--hair-in); border-radius: 999px; padding: 5px 13px; font-size: var(--fs-meta);
  color: var(--ink-2); background: var(--float); box-shadow: var(--sh-pop); }
.thread { position: relative; }
/* the pill floats over the transcript, so the last row has to make room for
   it — otherwise it lands on whatever is at the bottom, which is usually the
   one control the reader needs. */
.thread.jump .col { padding-bottom: 32px; }

/* ── dock ───────────────────────────────────────────────────────────────── */
.dock { width: var(--w-dock); flex: none; display: flex; background: var(--chrome-sb);
  border: var(--hair-sb); border-radius: var(--r-panel); overflow: hidden; }
.dstrip { width: 40px; flex: none; display: flex; flex-direction: column; align-items: center;
  gap: 4px; padding: 6px 0; border-right: var(--hair-mh); }
.dstrip .dt { width: 28px; height: 28px; border-radius: var(--r-ctl); display: grid;
  place-items: center; font-size: 12px; color: var(--ink-3); }
.dstrip .dt.on { background: var(--fill-on); color: var(--ink); }
.dstrip .scope { font: 8.5px var(--mono); color: var(--ink-3); border: var(--hair);
  border-radius: 999px; padding: 2px 5px; margin-bottom: 3px; }
.dstrip .sp { flex: 1; }
.dbody { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dh { height: 30px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 10px;
  border-bottom: var(--hair-mh); font-size: var(--fs-meta); color: var(--ink-3); }
.dh .g { margin-left: auto; color: var(--ok); }
.dh .ob { border: var(--hair); border-radius: 999px; padding: 1px 6px; font: 9px var(--mono); }
.term { flex: 1; background: var(--fill-pre); overflow: hidden; }
.term pre { font: var(--f-pre); padding: 9px 11px; color: var(--ink-2); white-space: pre; }
.term .ok { color: var(--ok); } .term .dim { color: var(--ink-3); }
.term .cur { color: var(--accent-text); }
.tsplit { flex: 1; display: grid; grid-template-rows: 1fr 1fr; }
.tsplit > div { overflow: hidden; border-top: var(--hair-mh); }
.tsplit > div:first-child { border-top: 0; }
.bchrome { height: 32px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 8px;
  border-bottom: var(--hair-mh); }
.bchrome .bi { width: 22px; height: 22px; border-radius: var(--r-ctl); display: grid;
  place-items: center; color: var(--ink-3); font-size: 11px; }
.bchrome .url { flex: 1; height: 22px; border-radius: var(--r-ctl); background: var(--fill-in);
  border: var(--hair-in); display: flex; align-items: center; padding: 0 9px; font: var(--f-meta); color: var(--ink-2); }
.page-stub { flex: 1; background: var(--fill-pre); display: grid; place-items: center;
  color: var(--ink-3); font-size: var(--fs-meta); }
.flist { flex: 1; overflow: hidden; padding: 6px; }
.flist .fi { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--r-ctl);
  font: var(--f-meta); color: var(--ink-2); }
.flist .fi.on { background: var(--fill-on); color: var(--ink); }
.flist .fi .n { margin-left: auto; }
.flist .fi .n .p { color: var(--ok); } .flist .fi .n .m { color: var(--err); margin-left: 4px; }

/* ── overlays ───────────────────────────────────────────────────────────── */
.scrim { position: absolute; inset: 0; background: oklch(0% 0 0 / 0.42); display: grid;
  place-items: center; z-index: 5; }
.pop { background: var(--float); border: var(--hair-in); border-radius: var(--r-comp);
  box-shadow: var(--sh-pop); overflow: hidden; }

/* command palette */
.pal { width: 620px; }
.pal .pi { display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: var(--hair-mh); font-size: 14px; color: var(--ink-3); }
.pal .pl { max-height: 340px; overflow: hidden; padding: 6px; }
.pal .pg { font: var(--f-grp); letter-spacing: var(--tr-grp); text-transform: var(--case-grp);
  color: var(--ink-3); padding: 9px 10px 4px; }
.pal .pr { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: var(--r-ctl); font-size: var(--fs-row); color: var(--ink-2); }
.pal .pr.on { background: var(--fill-on); color: var(--ink); }
.pal .pr .ic { color: var(--ink-3); font-size: 11px; width: 14px; }
.pal .pr .k { margin-left: auto; font: var(--f-meta); color: var(--ink-3); }
.pal .pr.gate { color: var(--ink-3); }
.pal .pr.gate .t { text-decoration: line-through; }
.pal .pr.gate .why { margin-left: auto; font: var(--f-meta); color: var(--warn); text-decoration: none; }

/* run navigator */
.nav { width: 700px; display: flex; flex-direction: column; }
.navcols { display: flex; }
.navcol { flex: 1; border-right: var(--hair-mh); padding: 6px; min-width: 0; }
.navcol:last-child { border-right: 0; }
.navcol .ch { font: var(--f-grp); letter-spacing: var(--tr-grp); text-transform: var(--case-grp);
  color: var(--ink-3); padding: 7px 9px 5px; }
.nr { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: var(--r-ctl);
  font-size: var(--fs-ctl); color: var(--ink-2); }
.nr.on { background: var(--fill-on); color: var(--ink); }
.nr.rec { color: var(--ink); }
.nr .rc { font: 8.5px var(--mono); color: var(--accent-text); border: 1px solid var(--accent-text);
  border-radius: 999px; padding: 1px 5px; }
.nr .pips { margin-left: auto; display: flex; gap: 2px; color: var(--ink-3); font: var(--f-meta); }
.nr .pd { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.nr .pd.warn { background: var(--warn); } .nr .pd.bad { background: var(--err); }
.nr.off { color: var(--ink-3); } .nr.off .t { text-decoration: line-through; }
.nr .why { margin-left: auto; font: var(--f-meta); color: var(--warn); }
.navfoot { border-top: var(--hair-mh); padding: 10px 12px; display: flex; align-items: center; gap: 14px;
  font-size: var(--fs-ctl); color: var(--ink-2); }
.navfoot .sw { width: 30px; height: 17px; border-radius: 999px; background: var(--accent); position: relative; }
.navfoot .sw::after { content: ""; position: absolute; top: 2px; right: 2px; width: 13px; height: 13px;
  border-radius: 50%; background: var(--accent-ink); }
.navfoot .sp { flex: 1; }

/* settings */
.set { width: 1000px; height: 660px; display: flex; }
.setnav { width: 208px; flex: none; border-right: var(--hair-mh); padding: 12px 10px;
  display: flex; flex-direction: column; gap: 3px; }
.setnav .band { font: var(--f-grp); letter-spacing: var(--tr-grp); text-transform: var(--case-grp);
  color: var(--ink-3); padding: 12px 9px 5px; }
.setnav .si { display: flex; align-items: center; gap: 9px; padding: 7px 10px;
  border-radius: var(--r-ctl); font-size: var(--fs-row); color: var(--ink-2); }
.setnav .si.on { background: var(--fill-on); color: var(--ink); }
.setbody { flex: 1; padding: 22px 26px; overflow: hidden; }
.setbody h2 { font-size: 17px; font-weight: 600; margin-bottom: 4px; letter-spacing: -0.01em; }
.setbody .sub { font-size: var(--fs-ctl); color: var(--ink-3); margin-bottom: 20px; }
.sgroup { border: var(--hair); border-radius: var(--r-card); margin-bottom: 14px; overflow: hidden; }
.sgroup .gh { padding: 11px 14px; border-bottom: var(--hair-mh); font-size: var(--fs-ctl);
  color: var(--ink); font-weight: 550; }
.sgroup .gr { display: flex; align-items: center; gap: 12px; padding: 11px 14px; font-size: var(--fs-ctl); color: var(--ink-2); }
.sgroup .gr + .gr { border-top: var(--hair-mh); }
.sgroup .gr .d { color: var(--ink-3); font: var(--f-meta); }
.sgroup .gr .sp { flex: 1; }
.radio { width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--line-2); flex: none; }
.radio.on { border-color: var(--accent); border-width: 4px; }
.seg2 { display: flex; border: var(--hair); border-radius: var(--r-ctl); overflow: hidden; }
.seg2 s { text-decoration: none; padding: 5px 12px; font-size: var(--fs-meta); color: var(--ink-3); }
.seg2 s.on { background: var(--accent); color: var(--accent-ink); }

/* banners */
.banner { display: flex; align-items: center; gap: 11px; padding: 10px 14px;
  border-radius: var(--r-card); font-size: var(--fs-ctl); margin-bottom: var(--gap-body); }
.banner.warn { background: var(--warn-fill); border: 1px solid var(--warn-line); color: var(--ink); }
.banner .bi { color: var(--warn); }
.banner .act2 { margin-left: auto; height: var(--h-ctl); display: inline-flex; align-items: center;
  padding: 0 12px; border-radius: var(--r-ctl); background: var(--warn); color: var(--warn-ink); font-weight: 550; }
.banner .x { color: var(--ink-3); }

/* handoff dialog */
.hand { width: 560px; padding: 20px 22px; }
.hand h2 { font-size: 16px; font-weight: 600; margin-bottom: 5px; }
.hand .sub { font-size: var(--fs-ctl); color: var(--ink-3); margin-bottom: 16px; }
.hand .hr { display: flex; align-items: center; gap: 11px; padding: 11px 12px; border: var(--hair);
  border-radius: var(--r-card); margin-bottom: 7px; font-size: var(--fs-ctl); color: var(--ink-2); }
.hand .hr.off { color: var(--ink-3); }
.hand .hr.off .t { text-decoration: line-through; }
.hand .hr .why { margin-left: auto; font: var(--f-meta); color: var(--warn); }
.hand .hr .pd { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.hand .hr .pd.warn { background: var(--warn); } .hand .hr .pd.bad { background: var(--err); }
.hand .hf { display: flex; gap: 7px; margin-top: 14px; }
.hand .b { height: var(--h-btn); display: inline-flex; align-items: center; padding: 0 13px;
  border: var(--hair); border-radius: var(--r-ctl); font-size: var(--fs-ctl); color: var(--ink-2); }
.hand .b.go { background: var(--accent); border-color: transparent; color: var(--accent-ink); font-weight: 550; }
.hand .sp { flex: 1; }

/* empty state */
.empty { flex: 1; display: grid; place-items: center; }
.ebox { width: 520px; text-align: center; }
.ebox .mark { width: 46px; height: 46px; border-radius: 12px; background: var(--accent);
  color: var(--accent-ink); display: grid; place-items: center; margin: 0 auto 16px; font-size: 20px; }
.ebox h2 { font-size: 19px; font-weight: 600; margin-bottom: 6px; letter-spacing: -0.01em; }
.ebox p { font-size: var(--fs-ctl); color: var(--ink-3); margin-bottom: 20px; }
.legend { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 22px; text-align: left; }
.legend .lr { display: flex; align-items: center; gap: 9px; font-size: var(--fs-meta); color: var(--ink-3); }
.legend .lr b { font: var(--f-meta); color: var(--ink-2); background: var(--fill-card);
  border-radius: 4px; padding: 2px 6px; min-width: 34px; text-align: center; font-weight: 400; }

/* the composer takes the same inset, so its card edge and the status line's
   first chip sit on one vertical rule with the transcript column. */
.comp { padding: 0 var(--pad-x-col) 13px; }
.main.q .comp { padding: 0 var(--pad-x-col-q) 10px; }
.thread { padding-left: var(--pad-x-col); padding-right: var(--pad-x-col); }
.main.q .thread { padding-left: var(--pad-x-col-q); padding-right: var(--pad-x-col-q); }

.wrapb { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.win { position: relative; }
/* ten screens do not fit one row at this page width; wrapping inside the
   control's own border keeps it readable rather than clipping the last two. */
.segs { flex-wrap: wrap; }
"""

# `_seed_build.tokens_css` emits the mockup vocabulary, which has no name for
# the overlay surface — round three's frame never floated anything. The seed
# derives one, so take it from there rather than inventing a value: an
# opaque --float is what keeps a popover from showing the transcript through
# itself.
MORE_TOKENS = f"""
  --w-dock: 336px;
  --float: {S.fmt(DARK['float'])};
  --sh-pop: 0 12px 34px oklch(0% 0 0 / 0.34);
  /* the one horizontal inset the transcript, composer and status line share */
  --pad-x-col: 16px; --pad-x-col-q: 11px;"""

LIGHT_MORE = f"""
  --float: {S.fmt(LIGHT['float'])};
  --sh-pop: 0 12px 34px oklch(0% 0 0 / 0.16);"""


# ───────────────────────────────────────────────────────────────────────────
# Window pieces.
# ───────────────────────────────────────────────────────────────────────────

LIGHTS = '<div class="lights"><i></i><i></i><i></i></div>'

# Line icons rather than glyphs. The glyphs were placeholders and read as
# dingbats at 12px; these are the lucide shapes the app actually uses, drawn
# at the same 24-unit box and stroked in currentColor so every tone rule the
# treatment already has applies to them unchanged.
def _svg(body):
    return ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round">{body}</svg>')


IC_MONITOR = _svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>')
IC_SUN = _svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4'
              'M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>')
IC_MOON = _svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>')
IC_SEARCH = _svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')
IC_SLIDERS = _svg('<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/>'
                  '<circle cx="7" cy="7" r="3"/>')
IC_FOLDER = _svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9'
                 'A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>')
IC_PANEL = _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>')
IC_PLUS = _svg('<path d="M12 5v14M5 12h14"/>')
# The opener is an overflow menu, not an add button: most of what it lists
# reveals something that already exists rather than creating anything.
IC_KEBAB = _svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/>'
                '<circle cx="12" cy="19" r="1"/>')
IC_TERM = _svg('<path d="m4 17 6-6-6-6M12 19h8"/>')
IC_GLOBE = _svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20'
                'a15 15 0 0 1 0-20Z"/>')
IC_FILES = _svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'
                'M14 2v5h5"/>')
IC_LIST = _svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>')
IC_EYE = _svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/>'
              '<circle cx="12" cy="12" r="3"/>')
IC_SPLIT_R = _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>')
IC_SPLIT_D = _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/>')
IC_AGENT = _svg('<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 14h.01M15 14h.01"/>')


# ───────────────────────────────────────────────────────────────────────────
# The task list. Every provider emits one now, and inline in the scrollback it
# is worth very little: it is a statement about the *whole* run, so it scrolls
# away exactly when the run gets long enough for it to matter. Pinned above
# the composer instead, collapsed to the item in flight, expandable to the
# rest — Claude Code keeps its to-do list always visible for the same reason,
# and OpenCode keeps it in the panel that never leaves.
# ───────────────────────────────────────────────────────────────────────────

TASKS = [
    ("done", "Reproduce the escape in a scoped pane"),
    ("done", "Trace scopePath through adoptTab"),
    ("done", "Read the dock's adoption path"),
    ("now", "Re-derive scope at adoption"),
    ("", "Cover the drag path in dock.test.ts"),
    ("", "Check spawnTab takes the same route"),
    ("", "Note the rule in state/dock.ts"),
]
MARK = {"done": "✓", "now": "◐", "": "○"}


def task_list(open_=True):
    done = sum(1 for s, _ in TASKS if s == "done")
    now = next((t for s, t in TASKS if s == "now"), "")
    pct = round(done / len(TASKS) * 100)
    body = ""
    if open_:
        body = '<div class="tbody">' + "".join(
            f'<div class="ti {s}"><span class="m">{MARK[s]}</span>{t}</div>'
            for s, t in TASKS) + "</div>"
    return f"""<div class="tasks">
            <div class="thead"><span class="cv">{"⌄" if open_ else "›"}</span>
              <span class="cur">{now}</span>
              <span class="pg">{done} of {len(TASKS)}</span>
              <span class="pbar"><i style="width:{pct}%"></i></span>
            </div>{body}
          </div>"""


VIEWS_MENU = f"""<div class="menu">
      <div class="mg">Open in the dock</div>
      <div class="mi">{IC_TERM}Terminal<span class="k">⌘J</span></div>
      <div class="mi">{IC_GLOBE}Browser<span class="k">⌘⇧B</span></div>
      <div class="mi">{IC_FOLDER}Working folder</div>
      <div class="mi">{IC_FILES}Changed files</div>
      <div class="mi">{IC_LIST}Delegated work<span class="ct">2</span></div>
      <div class="mi">{IC_AGENT}Subagent output</div>
      <div class="mi">{IC_EYE}Preview</div>
      <div class="mg">Split this conversation</div>
      <div class="mi">{IC_SPLIT_R}Split right<span class="k">⌘\\</span></div>
      <div class="mi off">{IC_SPLIT_D}Split down<span class="why">the grid is full</span></div>
      <div class="mg">New</div>
      <div class="mi">{IC_PLUS}New session<span class="k">⌘N</span></div>
    </div>"""


def theme_seg(active="dark"):
    """The palette control as it really is: one question, three exclusive
    answers, in a segmented track — not a button that cycles through states
    you cannot see. System first, because it is the default and the only one
    that keeps answering after you walk away."""
    opts = [("system", IC_MONITOR), ("light", IC_SUN), ("dark", IC_MOON)]
    return '<span class="seg3">' + "".join(
        f'<s class="{"on" if k == active else ""}">{icon}</s>' for k, icon in opts) + "</span>"


def topbar(title="The sandbox lets a write escape", collapsed=False):
    # Closed, the toggle is the only way back — so it takes the one place that
    # is always mounted, ahead of the name. Open, it lives on the list it
    # closes and the header carries nothing but identity.
    toggle = f'<div class="ico sbt">{IC_PANEL}</div>' if collapsed else ""
    # Three groups, not one row with a spacer: the outer two flex equally so
    # the command bar is centred on the *window* rather than on whatever is
    # left over after the title. A long session name ellipsises instead of
    # shoving it off-centre.
    return f"""<div class="top">
      <div class="tl">{LIGHTS}{toggle}
        <div class="title">artemis<s>/</s>{title}</div>
      </div>
      <div class="tc">
        <div class="cmdbar">{IC_SEARCH}<span>Search sessions and commands</span>
          <span class="k">⌘K</span></div>
      </div>
      <div class="tr">
        <div class="ico open">{IC_KEBAB}</div><div class="ico">{IC_SLIDERS}</div>
        <i class="sep"></i>{theme_seg()}
      </div>
    </div>"""


def rail(active="sessions"):
    return f"""<div class="rail">
        <div class="ri {"on" if active == "sessions" else ""}">☰</div>
        <div class="ri">⌕</div>
        <div class="ri">◷<span class="bg">2</span></div>
        <div class="ri">▤</div>
        <div class="sp"></div>
        <div class="ri">⚙</div>
      </div>"""


def sidebar(update=True):
    upd = ('<div class="upd"><b>↓ 2.1.0 available</b><span>restart to install</span></div>'
           if update else "")
    return f"""<div class="sb">
        <div class="head"><span class="sbt">{IC_PANEL}</span><span class="h">Sessions</span><span class="x">‹</span></div>
        <div class="newb">New session</div>
        <div class="filt">⌕ Filter sessions</div>
        <div class="list">
            {session_list()}
        </div>
        {upd}
      </div>"""


def status_line(waiting=True, slots=None):
    state = "waiting on you" if waiting else "running · 38 turns"
    rings = usage_rings(slots or SLOTS)
    return f"""<div class="stat"><div class="statin">
            <span class="sc"><b>storrence-dev</b><span class="cv">▾</span></span>
            <span class="sc">Opus 5 <b>1M</b><span class="cv">▾</span></span>
            <span class="sc mode">plan<span class="cv">▾</span></span>
            <span class="sc">workspace-write</span>
            <span class="sp"></span>
            <span>{state}</span>
            {rings}
          </div></div>"""


def composer(full=True, quad=False, slash=False, stop=False, tasks=False):
    wd = '<div class="wd">◧ <b>~/Documents/artemis</b> · main</div>' if full else ""
    queue = ('<div class="queue">1 message queued — it will be read after this action'
             '<span class="now">Read it now</span></div>') if full else ""
    att = ('<div class="att"><span class="a">▣ scope-audit.md<span class="x">✕</span></span>'
           '<span class="a">▣ screenshot.png<span class="x">✕</span></span></div>') if full else ""
    menu = ""
    if slash:
        menu = """<div class="slash">
              <div class="si on">/model<span class="d">switch the model for this run</span></div>
              <div class="si">/plan<span class="d">plan before acting</span></div>
              <div class="si">/compact<span class="d">summarise and free context</span></div>
              <div class="si">/fork<span class="d">branch this conversation</span></div>
            </div>"""
    send = ('<div class="send stop">■</div>' if stop else '<div class="send">↑</div>')
    hint = "esc to stop" if stop else "⏎ send · ⇧⏎ newline"
    bar = (f'<div class="cbar"><span class="pill">＋</span><span class="pill">@ files</span>'
           f'<div class="sp"></div><span class="hint">{hint}</span>{send}</div>'
           if not quad else
           f'<div class="cbar"><div class="sp"></div><span class="hint">⏎</span>{send}</div>')
    text = "/mod" if slash else "Re-derive scope at adoption, then cover the drag path…"
    return f"""<div class="comp"><div class="cwrap">{menu}
          {wd}{queue}
          <div class="cin">{att}
            <div class="tx">{text}</div>
            {bar}
          </div>
        </div></div>"""


def pane(thread, title="artemis › sandbox escape", foc=True, quad=False, full=True,
         slash=False, stop=False, jump=False, status=True, slots=None, tasks=False):
    j = '<div class="jump">↓ Jump to latest</div>' if jump else ""
    st = status_line(slots=slots) if status else ""
    # The list belongs to the pane, not to the composer: it describes the run
    # this column is doing, so it sits under the caption that names it and
    # stays put while the transcript moves underneath.
    bar = f'<div class="taskbar">{task_list()}</div>' if tasks else ""
    return f"""<div class="main{" foc" if foc else ""}{" q" if quad else ""}">
          <div class="pcap"><span class="pd">◆</span>{title}<span class="x">✕</span></div>
          {bar}
          <div class="thread{" jump" if jump else ""}"><div class="col">
              {thread}
          </div>{j}</div>
          {composer(full=full, quad=quad, slash=slash, stop=stop, tasks=tasks)}
          {st}
        </div>"""


TERM_BODY = """<div class="term"><pre><span class="dim">$</span> pnpm vitest run state/dock.test.ts
<span class="dim"> ✓ </span>adopts a tab and re-derives its scope <span class="dim">(4)</span>
<span class="dim"> ✓ </span>a dragged tab cannot widen its scope <span class="dim">(2)</span>
<span class="ok"> Test Files  1 passed (1)</span>
<span class="dim">$</span> <span class="cur">▋</span></pre></div>"""

TERM_BODY_2 = """<div class="term"><pre><span class="dim">$</span> pnpm dev
<span class="dim"> › </span>vite v7.1.3 ready in 412 ms
<span class="dim"> › </span>http://localhost:5173
<span class="dim">$</span> <span class="cur">▋</span></pre></div>"""


def dock(tab="terminal", split=False):
    strip = '<div class="scope">pane</div>'
    for ic, kind, _ in DOCK_TABS:
        on = " on" if kind == tab else ""
        strip += f'<div class="dt{on}">{ic}</div>'
    strip += '<div class="sp"></div><div class="dt">⧉</div><div class="dt">+</div>'

    if tab == "browser":
        body = f"""<div class="dbody">
          <div class="bchrome"><span class="bi">‹</span><span class="bi">›</span><span class="bi">⟳</span>
            <span class="url">localhost:5173/design</span><span class="bi">⋯</span></div>
          <div class="page-stub">page renders in a native view</div>
        </div>"""
    elif tab == "files":
        body = """<div class="dbody">
          <div class="dh">Files changed <span class="ob">pane 1</span><span class="g">+69 −3</span></div>
          <div class="flist">
            <div class="fi on">state/dock.ts<span class="n"><span class="p">+7</span><span class="m">−2</span></span></div>
            <div class="fi">lib/scope.ts<span class="n"><span class="p">+24</span><span class="m">−0</span></span></div>
            <div class="fi">state/dock.test.ts<span class="n"><span class="p">+38</span><span class="m">−1</span></span></div>
          </div>
        </div>"""
    elif split:
        body = f"""<div class="dbody">
          <div class="dh">zsh · artemis <span class="ob">pane 1</span><span class="g">2 live</span></div>
          <div class="tsplit"><div>{TERM_BODY}</div><div>{TERM_BODY_2}</div></div>
        </div>"""
    else:
        body = f"""<div class="dbody">
          <div class="dh">zsh · artemis <span class="ob">pane 1</span><span class="g">live</span></div>
          {TERM_BODY}
        </div>"""
    return f'<div class="dock"><div class="dstrip">{strip}</div>{body}</div>'


RATE_BANNER = """<div class="banner warn"><span class="bi">◆</span>
        <span>The <b>storrence-dev</b> weekly limit is reached. Two profiles can carry this run.</span>
        <span class="act2">Continue on rx-ventures</span><span class="x">✕</span></div>"""


# ───────────────────────────────────────────────────────────────────────────
# Screens.
# ───────────────────────────────────────────────────────────────────────────


def sc_work():
    return f"""{topbar()}
    <div class="body">{sidebar()}
      {pane(THREAD_LIVE, tasks=True)}
    </div>"""


def sc_views():
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      {pane(THREAD_LIVE, tasks=True)}
    </div>
    <div class="scrim anchor">{VIEWS_MENU}</div>"""


def sc_collapsed():
    return f"""{topbar(collapsed=True)}
    <div class="body">
      {pane(THREAD_LIVE)}
    </div>"""


def sc_transcript():
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      {pane(THREAD_DONE, full=False, jump=True)}
    </div>"""


def sc_grid():
    return f"""{topbar("4 conversations")}
    <div class="body">{sidebar(update=False)}
      <div class="stack">
        <div class="prow">
          {pane(THREAD_SHORT, "sandbox escape", quad=True, full=False)}
          {pane(THREAD_SHORT, "dock arrangement", foc=False, quad=True, full=False)}
        </div>
        <div class="prow">
          {pane(THREAD_SHORT, "setup wizard", foc=False, quad=True, full=False)}
          {pane(THREAD_SHORT, "capability flags", foc=False, quad=True, full=False)}
        </div>
      </div>
    </div>"""


def sc_dock():
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      {pane(THREAD_DONE, full=False, stop=True)}
      {dock(tab="terminal", split=True)}
    </div>"""


def sc_dockbrowser():
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      {pane(THREAD_DONE, full=False)}
      {dock(tab="browser")}
    </div>"""


def sc_navigator():
    nav = """<div class="pop nav">
        <div class="navcols">
          <div class="navcol">
            <div class="ch">Profile</div>
            <div class="nr rec"><span class="t">rx-ventures</span><span class="rc">rec</span></div>
            <div class="nr on"><span class="t">storrence-dev</span><span class="pd warn"></span></div>
            <div class="nr off"><span class="t">personal-max</span><span class="why">limit reached · 4h</span></div>
            <div class="ch">OpenAI</div>
            <div class="nr"><span class="t">rx-openai</span><span class="pd"></span></div>
            <div class="nr"><span class="t">Manage…</span></div>
          </div>
          <div class="navcol">
            <div class="ch">Model</div>
            <div class="nr rec"><span class="t">Opus 5</span><span class="rc">rec</span></div>
            <div class="nr on"><span class="t">Opus 5 (1M)</span>
              <span class="pips"><span class="pd warn"></span></span></div>
            <div class="nr"><span class="t">Sonnet 5</span><span class="pips"><span class="pd"></span></span></div>
            <div class="nr"><span class="t">Haiku 4.5</span><span class="pips"><span class="pd"></span></span></div>
            <div class="nr off"><span class="t">Fable 5</span><span class="why">not on this plan</span></div>
            <div class="nr"><span class="t">Edit quick access…</span></div>
          </div>
          <div class="navcol">
            <div class="ch">Effort</div>
            <div class="nr"><span class="t">Low</span></div>
            <div class="nr"><span class="t">Medium</span></div>
            <div class="nr on"><span class="t">High</span></div>
            <div class="nr"><span class="t">Extra high</span></div>
            <div class="nr"><span class="t">Ultracode</span></div>
          </div>
        </div>
        <div class="navfoot">
          <span class="sw"></span><span>Fast mode</span>
          <span>Permission <b>plan</b> ▾</span>
          <span class="sp"></span>
          <span>context 78% · 156k</span>
          """ + usage_rings(SLOTS) + """
        </div>
      </div>"""
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      {pane(THREAD_DONE, full=False)}
    </div>
    <div class="scrim">{nav}</div>"""


def sc_palette():
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      {pane(THREAD_DONE, full=False)}
    </div>
    <div class="scrim"><div class="pop pal">
      <div class="pi">⌕ scope</div>
      <div class="pl">
        <div class="pg">Sessions</div>
        <div class="pr on"><span class="ic">◆</span><span class="t">The sandbox lets a write escape</span><span class="k">now</span></div>
        <div class="pr"><span class="ic">·</span><span class="t">Probe the capability flags</span><span class="k">1h</span></div>
        <div class="pg">Session</div>
        <div class="pr"><span class="ic">+</span><span class="t">New session</span><span class="k">⌘N</span></div>
        <div class="pr"><span class="ic">⌘</span><span class="t">Toggle terminal</span><span class="k">⌘J</span></div>
        <div class="pr"><span class="ic">⑂</span><span class="t">Fork from last message</span></div>
        <div class="pr gate"><span class="ic">↺</span><span class="t">Rewind</span><span class="why">nothing to rewind to</span></div>
        <div class="pg">Configure</div>
        <div class="pr"><span class="ic">◐</span><span class="t">Change model…</span></div>
        <div class="pr"><span class="ic">◧</span><span class="t">Working directory…</span></div>
        <div class="pg">Settings</div>
        <div class="pr"><span class="ic">⚙</span><span class="t">Permissions &amp; access</span><span class="k">⌘,</span></div>
      </div>
    </div></div>"""


def sc_settings():
    nav = ""
    for band, items in SETTINGS_NAV:
        nav += f'<div class="band">{band}</div>'
        for it in items:
            on = " on" if it == "Appearance" else ""
            nav += f'<div class="si{on}">{it}</div>'
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      {pane(THREAD_DONE, full=False)}
    </div>
    <div class="scrim"><div class="pop set">
      <div class="setnav">{nav}</div>
      <div class="setbody">
        <h2>Appearance</h2>
        <div class="sub">How Artemis looks on this machine. Nothing here leaves it.</div>
        <div class="sgroup"><div class="gh">Theme</div>
          <div class="gr"><span class="radio on"></span>Follow the system<span class="sp"></span></div>
          <div class="gr"><span class="radio"></span>Dark<span class="sp"></span></div>
          <div class="gr"><span class="radio"></span>Light<span class="sp"></span></div>
        </div>
        <div class="sgroup"><div class="gh">Text</div>
          <div class="gr">Interface size<span class="d">14px</span><span class="sp"></span>
            <span class="seg2"><s>−</s><s class="on">14</s><s>+</s></span></div>
          <div class="gr">Transcript width<span class="sp"></span>
            <span class="seg2"><s class="on">Comfortable</s><s>Wide</s><s>Full</s></span></div>
        </div>
        <div class="sgroup"><div class="gh">Transcript</div>
          <div class="gr">Show thinking<span class="d">expands reasoning rows by default</span><span class="sp"></span>
            <span class="seg2"><s class="on">On</s><s>Off</s></span></div>
          <div class="gr">Run summary<span class="sp"></span>
            <span class="seg2"><s>Always</s><s class="on">On failure</s><s>Never</s></span></div>
        </div>
      </div>
    </div></div>"""


def sc_handoff():
    return f"""{topbar()}
    <div class="body">{sidebar(update=False)}
      <div class="wrapb">
        {RATE_BANNER}
        <div class="prow">{pane(THREAD_DONE, full=False, slots=SLOTS_SPENT)}</div>
      </div>
    </div>
    <div class="scrim"><div class="pop hand">
      <h2>Carry this conversation somewhere else?</h2>
      <div class="sub">The weekly limit on <b>storrence-dev</b> is reached. These profiles can pick it up with the full history.</div>
      <div class="hr"><span class="pd"></span><span class="t">rx-ventures</span> · Opus 5 <span class="why">18% used</span></div>
      <div class="hr"><span class="pd warn"></span><span class="t">rx-openai</span> · GPT-5.3 <span class="why">71% used</span></div>
      <div class="hr off"><span class="pd bad"></span><span class="t">personal-max</span> <span class="why">limit reached · resets in 4h</span></div>
      <div class="hf"><span class="b">Write a continuity note instead</span><span class="sp"></span>
        <span class="b">Keep working here</span><span class="b go">Continue on rx-ventures</span></div>
    </div></div>"""


def sc_empty():
    legend = "".join(f'<div class="lr"><b>{k}</b>{v}</div>' for k, v in SHORTCUTS)
    return f"""{topbar("New session")}
    <div class="body">{sidebar(update=False)}
      <div class="main foc">
        <div class="pcap">artemis › new session<span class="x">✕</span></div>
        <div class="empty"><div class="ebox">
          <div class="mark">◆</div>
          <h2>Start something</h2>
          <p>This pane is scoped to <b>~/Documents/artemis</b> on <b>main</b>. Ask a question, or describe the change you want.</p>
          <div class="legend">{legend}</div>
        </div></div>
        {composer(full=True, slash=True)}
        {status_line(waiting=False)}
      </div>
    </div>"""


SCREENS = [
    ("work", "Work", "a run in flight: thinking, a folded activity burst, a tool step, the plan, and a permission gate — with the composer carrying its working directory, a queued message and two attachments"),
    ("views", "Open…", "the plus in the frame header opens a menu of what to put on screen — dock surfaces, a split, a new session — so a pane is chosen from a list rather than remembered as a chord; and the task list is pinned above the composer, collapsed to the item in flight"),
    ("collapsed", "Closed", "the session list hidden — its toggle has moved to the frame header, ahead of the name, because that is the only place always on screen to bring it back from"),
    ("transcript", "Transcript", "the settled half of the grammar: an expanded tool card with its result fold, delegated work, a diff, an artifact tile, the answer, and the run-end rule"),
    ("grid", "Grid", "four conversations, each with its own status line and run state — the capability round two refused to give up"),
    ("dock", "Dock", "the dock at split terminals, its icon rail, scope chip and owner badges; the composer is showing a run in flight"),
    ("browser", "Browser", "the dock on its browser tab — chrome drawn here, page composited by the OS above it"),
    ("navigator", "Navigator", "the profile and model chips open one navigator: profile → model → effort, with pressure dots and disabled rows that say why — no dollar pips, the plan meters already say what is left"),
    ("palette", "Palette", "⌘K — sessions join the list as soon as anything is typed, and what cannot be used is shown struck through with its reason"),
    ("settings", "Settings", "the dialog in two bands, Appearance open"),
    ("handoff", "Hand-off", "the rate-limit banner grows a door, and the picker names what each profile has left"),
    ("empty", "Empty", "first run in a pane: the shortcut legend, the working directory, and the slash menu open"),
]

BUILDERS = {
    "work": sc_work, "views": sc_views, "collapsed": sc_collapsed, "transcript": sc_transcript,
    "grid": sc_grid, "dock": sc_dock, "browser": sc_dockbrowser,
    "navigator": sc_navigator, "palette": sc_palette, "settings": sc_settings,
    "handoff": sc_handoff, "empty": sc_empty,
}

SWITCH_JS = """
<script>
(function () {
  var root = document.documentElement, keys = {};
  function seg(id, fn) {
    var box = document.getElementById(id);
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      [].forEach.call(box.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
      fn(b.dataset.v); fit();
    });
  }
  function show(v) {
    [].forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('on', s.dataset.screen === v);
    });
    [].forEach.call(document.querySelectorAll('#screens button'), function (b) {
      b.classList.toggle('on', b.dataset.v === v);
    });
    location.hash = v; fit();
  }
  seg('screens', show);
  seg('themes', function (v) { root.classList.toggle('light', v === 'light'); });
  [].forEach.call(document.querySelectorAll('#screens button'), function (b, i) { keys[i + 1] = b.dataset.v; });
  addEventListener('keydown', function (e) {
    if (keys[e.key]) show(keys[e.key]);
    if (e.key.toLowerCase() === 'l') { root.classList.toggle('light');
      [].forEach.call(document.querySelectorAll('#themes button'), function (b) {
        b.classList.toggle('on', b.dataset.v === (root.classList.contains('light') ? 'light' : 'dark')); }); }
  });
  var page = document.querySelector('.page'), W = 1400, H = 1000, one = false;
  function fit() {
    var avail = page.clientWidth || document.documentElement.clientWidth || W;
    var s = one ? 1 : Math.max(0.2, Math.min(1, avail / W));
    [].forEach.call(document.querySelectorAll('.win'), function (win) {
      win.style.transformOrigin = 'top left';
      win.style.transform = 'scale(' + s + ')';
      win.style.marginBottom = (H * s - H + 16) + 'px';
    });
    var note = document.querySelector('.fitnote');
    note.innerHTML = one ? 'showing 1:1 — <b>click the window</b> to fit'
                         : 'scaled to ' + Math.round(s * 100) + '% — <b>click the window</b> for 1:1';
    document.body.style.overflowX = one ? 'auto' : 'hidden';
  }
  document.addEventListener('click', function (e) { if (e.target.closest('.win')) { one = !one; fit(); } });
  addEventListener('resize', fit); addEventListener('visibilitychange', fit);
  // a hash change does not reload the document, so the deep link has to be
  // honoured again on every change or #navigator silently shows #work.
  addEventListener('hashchange', function () {
    var h = location.hash.slice(1); if (BUILT[h]) show(h);
  });
  if (location.hash && BUILT[location.hash.slice(1)]) show(location.hash.slice(1)); else fit();
})();
</script>
"""

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Console — the full pass</title>
<style>
{fonts}
/* ── 7D Console, applied to every Artemis surface.
   The language block is imported from _round7_build.py so the treatment
   cannot drift from the file it was judged in. Colour is round five.
   To change this file: python3 docs/design/_round7d_build.py
   ─────────────────────────────────────────────────────────────────────── */
:root {{
{dark}
{common}
{lang}
{more}
  --sans: 'Archivo', ui-sans-serif, system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  --fs: 13px;
}}
html.light {{
{light}
{lightmore}
}}
{base}
{extra}
</style>
</head>
<body>
<div class="page">
  <a class="back" href="index.html">← the design record</a>
  <div class="kicker" style="margin-top:12px">7D · CONSOLE — THE FULL PASS</div>
  <h1>Console, everywhere</h1>
  <p class="note"><b>The chosen treatment on the whole application.</b> 8px radii, alpha hairlines at 7% (12% on inputs), sans chrome in sentence case, surfaces as computed lifts, a composer that reads as a card — applied not to one conversation but to the nine surfaces the conversion actually has to pay for.</p>
  <p class="note">The arrangement here is <b>Artemis's own</b> — session list, pane grid, dock — not round seven's simplified three-region shape. Round six's arrangement question stays open; this answers what the app <i>looks</i> like, on what ships today.</p>
  <div class="ctl">
    <div class="segs" id="screens"><span class="lab">SCREEN</span>{screenbtns}</div>
    <div class="segs" id="themes"><span class="lab">THEME</span>
      <button class="on" data-v="dark">Dark</button><button data-v="light">Light</button></div>
    <div class="fitnote"></div>
  </div>
  <p class="note" style="font-size:12px;color:var(--ink-3)">Press <b>1–9</b> for screens, <b>L</b> to swap theme. Every screen is linkable: <code>7d-full.html#navigator</code>.</p>
{screens}
</div>
<script>var BUILT = {built};</script>
{js}
</body>
</html>
"""


def build():
    screenbtns = "".join(
        f'<button class="{"on" if i == 0 else ""}" data-v="{k}">{lab}</button>'
        for i, (k, lab, _) in enumerate(SCREENS))
    screens = "\n".join(
        f'  <div class="screen{" on" if i == 0 else ""}" data-screen="{k}">'
        f'<div class="scap"><b>{lab}</b> — {cap}</div>'
        f'<div class="win">{BUILDERS[k]()}</div></div>'
        for i, (k, lab, cap) in enumerate(SCREENS))
    built = "{" + ",".join(f'"{k}":1' for k, _, _ in SCREENS) + "}"
    html = TEMPLATE.format(
        fonts=R7.FONTS,
        dark=S.tokens_css(DARK, "dark"),
        light=S.tokens_css(LIGHT, "light"),
        lightmore=LIGHT_MORE,
        common=R7.COMMON,
        lang=R7.LANG_CONSOLE,
        more=MORE_TOKENS,
        base=R7.BASE,
        extra=EXTRA,
        screenbtns=screenbtns,
        screens=screens,
        built=built,
        js=SWITCH_JS,
    )
    (OUT / "7d-full.html").write_text(html)
    print("wrote 7d-full.html")
    print(f"  {len(SCREENS)} screens: " + ", ".join(k for k, _, _ in SCREENS))


if __name__ == "__main__":
    build()
