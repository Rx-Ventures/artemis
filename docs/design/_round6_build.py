#!/usr/bin/env python3
"""Generate the round-six arrangement mockups.

Round five settled the palette from a seed pair. Round six decides the other
half of the overhaul: the *arrangement* — where the controls live, what owns
the window's edges, and how work under review reaches the eye.

Five files. Each renders the same Artemis session, on the same shipped tokens
(5b dark / 5e light, derived here by importing `_seed_build.py` rather than
copying its numbers), in the same type and radii. Anything you can see
differing between them is the layout and nothing else.

    python3 docs/design/_round6_build.py

Writes 6a-control.html … 6e-cockpit.html next to this file.

Each file carries four screens — work, grid, review, focus — and a live
dark/light toggle, so a direction is judged on more than its best angle.
"""

import pathlib

import _build  # round three: page frame + the transcript/tool/diff grammar
import _seed_build as S  # round five: the seed derivation and token emitter

OUT = pathlib.Path(__file__).parent

DARK, _ = S.derive_dark(S.SEED_CANVAS, S.SEED_ACCENT)
LIGHT, _ = S.derive_light(S.SEED_ACCENT)

# ───────────────────────────────────────────────────────────────────────────
# Held constant. Type is the shipped pair, radii are the shipped values, and
# the colour is round five's verdict. This round's only variable is where
# things are.
# ───────────────────────────────────────────────────────────────────────────

HELD = """
  --sans: 'Archivo', ui-sans-serif, system-ui, sans-serif; --display: var(--sans); --prose: var(--sans);
  --mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  --fs: 13px; --lh-prose: 1.55; --w-hi: 600; --tr-hi: -0.01em; --tr-ui: 0.01em;
  --r: 3px; --r-sm: 3px; --r-win: 6px; --r-pill: 999px; --gap: 9px;
  --sh-win: none;"""

FONTS = (
    "@import url('https://fonts.googleapis.com/css2?"
    "family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');"
)

# ───────────────────────────────────────────────────────────────────────────
# The session, written once. Every variant renders these same blocks; only
# the containers around them move.
# ───────────────────────────────────────────────────────────────────────────

TR_USER = """<div class="turn">YOU · 14:22</div>
              <div class="you">The sandbox lets a write escape — the browser tab reached <span class="inline">~/.config</span> while the pane was scoped to the repo. Find where the scope is dropped.</div>"""

TR_THINK = """<div class="think"><span class="chev">▾</span><span class="txt">Scope is attached when a tab spawns — but the dock can adopt a tab from another pane, and that path may never re-derive it.</span></div>"""

TR_GREP = """<div class="tool"><div class="bar"><span class="k">grep</span><span class="a">scopePath — 14 files</span><span class="r ok">0.4s</span></div>
                <pre><span class="dim">state/dock.ts</span>   <span class="hit">adoptTab(tab, pane)</span>
<span class="dim">state/dock.ts</span>   <span class="hit">spawnTab(kind, pane)</span>
<span class="dim">lib/scope.ts</span>    <span class="hit">scopeFor(session)</span></pre>
                <div class="more">+ 11 more</div></div>"""

TR_DIFF = """<div class="diff"><div class="bar"><span class="f">state/dock.ts</span><span class="n"><span class="p">+7</span><span class="m">−2</span></span></div>
                <pre><span class="ctxl">  function adoptTab(tab, pane) {</span>
<span class="del">-   return { ...tab, paneId: pane.id }</span>
<span class="add">+   // a tab that changes hands re-derives its scope; the one it</span>
<span class="add">+   // arrived with belonged to the pane it left.</span>
<span class="add">+   return { ...tab, paneId: pane.id, scopePath: scopeFor(pane.session) }</span>
<span class="ctxl">  }</span></pre></div>"""

TR_GATE = """<div class="gate"><div class="h">◆ PERMISSION — WRITE OUTSIDE THE REPO</div>
                <div class="cmd">Write ~/.config/artemis/settings.json</div>
                <div class="why">This pane is scoped to <b>artemis</b>. The path is outside it.</div>
                <div class="row"><div class="btn">Deny<span class="k">esc</span></div><div class="btn">Allow for session</div><div class="btn go">Approve once<span class="k">⌘↵</span></div></div></div>"""

TR_SAID = """<div class="turn">ARTEMIS · OPUS 5</div>
              <div class="said"><b>adoptTab</b> carries the old pane's <span class="inline">scopePath</span> across. A tab dragged out of a repo-scoped pane keeps the permissive scope, and the browser inherits it. The fix re-derives scope at adoption; the test covers the drag path.</div>"""

TR_TODO = """<div class="todo"><div class="h">PLAN</div><ul>
                <li class="done"><span class="m">✓</span>Reproduce the escape in a scoped pane</li>
                <li class="done"><span class="m">✓</span>Trace scopePath through adoptTab</li>
                <li class="now"><span class="m">▸</span>Re-derive scope at adoption</li>
                <li><span class="m">·</span>Cover the drag path in dock.test.ts</li></ul></div>"""

TR_DELE = """<div class="dele"><div class="chip"><i></i>explore · scope call sites</div><div class="chip done"><i></i>read · dock.ts</div></div>"""

# The long transcript, and the short one small panes get.
TRANSCRIPT = "\n              ".join(
    [TR_USER, TR_THINK, TR_GREP, TR_TODO, TR_DIFF, TR_DELE, TR_GATE]
)
TRANSCRIPT_SHORT = "\n              ".join([TR_USER, TR_THINK, TR_GREP])
TRANSCRIPT_SAID = "\n              ".join([TR_USER, TR_THINK, TR_GREP, TR_DIFF, TR_SAID])

# Sessions. (title, state, age, project, where)
SESSIONS = [
    ("The sandbox lets a write escape", "gate", "now", "ARTEMIS", "local"),
    ("Dock remembers its arrangement", "run", "4m", "ARTEMIS", "worktree"),
    ("Probe the capability flags", "", "1h", "ARTEMIS", "local"),
    ("OpenCode model configurator", "done", "3h", "ARTEMIS", "remote"),
    ("Setup wizard for any bank", "run", "now", "CEREBRO", "local"),
    ("Local-only bank, no remote", "", "2d", "CEREBRO", "local"),
]

# The working tree under review. (file, +, −, hunks, read)
CHANGED = [
    ("state/dock.ts", 7, 2, 2, True),
    ("lib/scope.ts", 24, 0, 1, False),
    ("state/dock.test.ts", 38, 1, 3, False),
]

WHERE_MARK = {"local": "◧", "worktree": "⑂", "remote": "☁"}


def sess_rows(flags=False, indent=False):
    """The session list. `flags` shows local/worktree/remote; `indent` nests
    the rows under their project the way a tree does."""
    out, project = [], None
    pad = ' style="padding-left:18px"' if indent else ""
    for title, state, age, proj, where in SESSIONS:
        if proj != project:
            project = proj
            count = sum(1 for s in SESSIONS if s[3] == proj)
            chev = '<span class="chev">▾</span>' if indent else ""
            out.append(
                f'<div class="proj">{chev}<span>{proj}</span><span>{count}</span></div>'
            )
        on = " on" if title == SESSIONS[0][0] else ""
        dot = f'<i class="dot {state}"></i>' if state else '<i class="dot"></i>'
        mark = (
            f'<span class="where">{WHERE_MARK[where]}</span>' if flags else ""
        )
        out.append(
            f'<div class="sess{on}"{pad}>{dot}{mark}<span class="t">{title}</span>'
            f'<span class="ago">{age}</span></div>'
        )
    return "\n          ".join(out)


def changed_rows(hunks=False):
    out = []
    for f, plus, minus, n, read in CHANGED:
        cls = " read" if read else ""
        mark = "✓" if read else "•"
        extra = f'<span class="hk">{n} hunks</span>' if hunks else ""
        out.append(
            f'<div class="fch{cls}"><span class="rd">{mark}</span>'
            f'<span class="f">{f}</span>{extra}'
            f'<span class="n"><span class="p">+{plus}</span>'
            f'<span class="m">−{minus}</span></span></div>'
        )
    return "\n            ".join(out)


LIGHTS = '<div class="lights"><i></i><i></i><i></i></div>'

TERMINAL = """<div class="term"><pre><span class="dim">$</span> pnpm vitest run state/dock.test.ts
<span class="dim"> ✓ </span>adopts a tab and re-derives its scope <span class="dim">(4)</span>
<span class="dim"> ✓ </span>a dragged tab cannot widen its scope <span class="dim">(2)</span>
<span class="okl"> Test Files  1 passed (1)</span>
<span class="dim">$</span> <span class="cursor">▋</span></pre></div>"""


# ───────────────────────────────────────────────────────────────────────────
# The round-six layout layer. Appended after _build.BASE, so the transcript,
# tool, diff, gate and todo grammar is inherited byte-identical and only the
# containers are new.
# ───────────────────────────────────────────────────────────────────────────

LAYOUT_CSS = """
/* ── round six: the judging frame ───────────────────────────────────────── */
.ctl { display: flex; gap: 18px; align-items: center; margin: 14px 0 2px; flex-wrap: wrap; }
.segs { display: flex; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
.segs button { font: 10.5px var(--mono); letter-spacing: 0.1em; text-transform: uppercase;
  background: var(--chrome); color: var(--ink-3); border: 0; border-right: 1px solid var(--line);
  padding: 5px 11px; cursor: pointer; }
.segs button:last-child { border-right: 0; }
.segs button.on { background: var(--accent); color: var(--accent-ink); }
.segs .lab { font: 9.5px var(--mono); color: var(--ink-3); padding: 5px 9px; letter-spacing: 0.13em; }
.vnav { display: flex; gap: 6px; align-items: center; margin-bottom: 2px; flex-wrap: wrap; }
.vnav a { font: 10.5px var(--mono); color: var(--ink-3); text-decoration: none;
  border: 1px solid var(--line); border-radius: var(--r-pill); padding: 3px 10px; }
.vnav a.on { color: var(--accent-text); border-color: var(--accent-text); }
.screen { display: none; }
.screen.on { display: block; }
.screen .win { margin-top: 14px; }
.scap { font: 10.5px var(--mono); color: var(--ink-3); margin-top: 12px; }
.scap b { color: var(--ink-2); font-weight: 400; }

/* ── shared arrangement primitives ──────────────────────────────────────── */
.rail { width: 46px; flex: none; background: var(--chrome); border: 1px solid var(--line);
  border-radius: var(--r); display: flex; flex-direction: column; align-items: center;
  gap: 7px; padding: 8px 0; }
.rail .ri { width: 28px; height: 28px; border-radius: var(--r-sm); display: grid;
  place-items: center; color: var(--ink-3); font-size: 13px; position: relative; }
.rail .ri.on { background: var(--accent); color: var(--accent-ink); }
.rail .ri.badge::after { content: "2"; position: absolute; top: -1px; right: -1px;
  font: 8px var(--mono); background: var(--warn); color: var(--warn-ink);
  border-radius: 999px; padding: 0 3px; }
.rail .sp { flex: 1; }

.side .cap { display: flex; align-items: center; padding: 7px 9px 5px; font: 10px var(--mono);
  letter-spacing: 0.13em; color: var(--ink-3); }
.side .cap .x { margin-left: auto; }
.sess .where { font: 9px var(--mono); color: var(--ink-3); flex: none; }
.proj .chev { font-size: 8px; margin-right: 5px; color: var(--ink-3); }
.dot.done { background: var(--ok); }

/* filter + group chips (6d) */
.filters { display: flex; gap: 4px; padding: 0 8px 7px; flex-wrap: wrap; }
.filters s { text-decoration: none; font: 9.5px var(--mono); color: var(--ink-3);
  border: 1px solid var(--line); border-radius: var(--r-pill); padding: 2px 7px; }
.filters s.on { color: var(--accent-text); border-color: var(--accent-text); }

/* sidebar section items (6c) */
.navitem { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11.5px;
  color: var(--ink-2); }
.navitem .m { font-size: 11px; color: var(--ink-3); width: 12px; }
.navitem .ct { margin-left: auto; font: 9.5px var(--mono); color: var(--ink-3); }
.navitem.on { background: var(--well); color: var(--ink); }

/* ── the toolbar (6b) ───────────────────────────────────────────────────── */
.toolbar { height: 34px; flex: none; display: flex; align-items: center; gap: 7px;
  padding: 0 10px; background: var(--bar); border-bottom: 1px solid var(--line); }
.tchip { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px;
  border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 11px; color: var(--ink-2);
  background: var(--chrome); }
.tchip b { color: var(--ink); font-weight: var(--w-hi); }
.tchip .cv { color: var(--ink-3); font-size: 9px; }
.tchip.mode { color: var(--warn); border-color: var(--warn); }
.tchip.act { color: var(--accent-text); border-color: var(--accent-text); }
.toolbar .sp { flex: 1; }
.tgl { display: flex; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
.tgl s { text-decoration: none; padding: 0 9px; height: 22px; display: grid; place-items: center;
  font-size: 11px; color: var(--ink-3); border-right: 1px solid var(--line); }
.tgl s:last-child { border-right: 0; }
.tgl s.on { background: var(--accent); color: var(--accent-ink); }

/* ── window-chrome session tabs (6e) ────────────────────────────────────── */
.wtabs { height: 30px; flex: none; display: flex; align-items: stretch;
  background: var(--bg); border-bottom: 1px solid var(--line); padding: 0 8px; gap: 0; }
.wtabs t { display: flex; align-items: center; gap: 7px; padding: 0 12px; font-size: 11.5px;
  color: var(--ink-3); border-right: 1px solid var(--line); max-width: 210px; }
.wtabs t.on { background: var(--chrome); color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
.wtabs t .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtabs t .dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: var(--line-2); }
.wtabs t .dot.run { background: var(--tool); }
.wtabs t .dot.gate { background: var(--warn); }
.wtabs .plus { display: grid; place-items: center; padding: 0 11px; color: var(--ink-3); font-size: 13px; }

/* ── review panel (6c) ──────────────────────────────────────────────────── */
.review { width: 348px; flex: none; background: var(--chrome); border: 1px solid var(--line);
  border-radius: var(--r); display: flex; flex-direction: column; overflow: hidden; }
.review .rh { height: 28px; flex: none; display: flex; align-items: center; gap: 8px;
  padding: 0 9px; border-bottom: 1px solid var(--line); background: var(--ph-bg); font-size: 11px; color: var(--ink); }
.review .rh .n { margin-left: auto; font: 10px var(--mono); }
.review .rh .n .p { color: var(--ok); } .review .rh .n .m { color: var(--err); margin-left: 5px; }
.fch { display: flex; align-items: center; gap: 8px; padding: 5px 9px; font: 11px var(--mono);
  color: var(--ink-2); border-bottom: 1px solid var(--line); }
.fch .rd { color: var(--ink-3); font-size: 9px; width: 8px; }
.fch.read { color: var(--ink-3); } .fch.read .rd { color: var(--ok); }
.fch .f { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fch .hk { font-size: 9.5px; color: var(--ink-3); }
.fch .n { margin-left: auto; font-size: 10px; flex: none; }
.fch .n .p { color: var(--ok); } .fch .n .m { color: var(--err); margin-left: 5px; }
.hunk { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.hunk .hh { padding: 4px 9px; font: 9.5px var(--mono); letter-spacing: 0.1em; color: var(--ink-3);
  background: var(--bar); border-bottom: 1px solid var(--line); display: flex; gap: 8px; }
.hunk .hh .k { margin-left: auto; }
.review .rfoot { flex: none; display: flex; gap: 6px; padding: 8px 9px; border-top: 1px solid var(--line); }
.review .rfoot .btn { flex: 1; text-align: center; }
.btn.pri { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: var(--w-hi); }

/* ── bottom drawer (6c) ─────────────────────────────────────────────────── */
.drawer { flex: none; height: 178px; background: var(--chrome); border: 1px solid var(--line);
  border-radius: var(--r); display: flex; flex-direction: column; overflow: hidden; margin-top: var(--gap); }
.drawer .dh { height: 26px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 9px;
  border-bottom: 1px solid var(--line); background: var(--ph-bg); font: 10.5px var(--mono); color: var(--ink-3); }
.drawer .dh d { color: var(--ink-3); padding: 0 7px; }
.drawer .dh d.on { color: var(--ink); box-shadow: inset 0 -1px 0 var(--accent); }
.drawer .dh .k { margin-left: auto; }
.term { flex: 1; overflow: hidden; background: var(--well); }
.term pre { font: 10.5px/1.6 var(--mono); padding: 7px 10px; color: var(--ink-2); white-space: pre; }
.term .okl { color: var(--ok); } .term .dim { color: var(--ink-3); }
.term .cursor { color: var(--accent-text); }

/* ── context panel (6e) ─────────────────────────────────────────────────── */
.ctxp { width: 268px; flex: none; background: var(--chrome); border: 1px solid var(--line);
  border-radius: var(--r); display: flex; flex-direction: column; overflow: hidden; }
.ctxp .sec { border-bottom: 1px solid var(--line); padding: 8px 10px; }
.ctxp .sh { font: 9.5px var(--mono); letter-spacing: 0.13em; color: var(--ink-3);
  margin-bottom: 6px; display: flex; }
.ctxp .sh .v { margin-left: auto; color: var(--ink-2); letter-spacing: 0; }
.ctxp .todo { border: 0; padding: 0; background: transparent; }
.ctxp .todo .h { display: none; }
.ctxp .fch { border: 0; padding: 3px 0; }
.meter { height: 4px; border-radius: 2px; background: var(--well); overflow: hidden; margin-top: 6px; }
.meter i { display: block; height: 100%; background: var(--warn); }
.meter.calm i { background: var(--accent); }
.kv { display: flex; font-size: 11px; color: var(--ink-2); padding: 2px 0; }
.kv .v { margin-left: auto; font: 10.5px var(--mono); color: var(--ink); }
.kv .v.ok { color: var(--ok); }

/* ── the window spine (6e) ──────────────────────────────────────────────── */
.spine { height: 26px; flex: none; display: flex; align-items: center; gap: 9px; padding: 0 11px;
  background: var(--chrome); border-top: 1px solid var(--line); font: 10.5px var(--mono); color: var(--ink-3); }
.spine s { text-decoration: none; }
.spine s.hot { color: var(--ink-2); }
.spine s.mode { color: var(--warn); }
.spine .sp { flex: 1; }
.spine .lead { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 1px 6px; color: var(--ink-3); }

/* ── deck panes (6d) ────────────────────────────────────────────────────── */
.deck { flex: 1; display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
.deck .row { flex: 1; display: flex; gap: var(--gap); min-height: 0; }
.pane .ph .grab { color: var(--ink-3); font-size: 10px; margin-right: 2px; cursor: grab; }
.pane .ph .dial { margin-left: auto; display: flex; border: 1px solid var(--line);
  border-radius: var(--r-sm); overflow: hidden; }
.pane .ph .dial s { text-decoration: none; font: 9px var(--mono); padding: 1px 6px; color: var(--ink-3);
  border-right: 1px solid var(--line); }
.pane .ph .dial s:last-child { border-right: 0; }
.pane .ph .dial s.on { background: var(--accent); color: var(--accent-ink); }
.pane .ph .stat { margin-left: auto; font: 9.5px var(--mono); color: var(--ink-3); }
.pane .ph .stat .p { color: var(--ok); } .pane .ph .stat .m { color: var(--err); margin-left: 4px; }

/* composer control clusters */
.cluster { display: flex; align-items: center; gap: 6px; padding: 6px 8px 0; flex-wrap: wrap; }
.pill { display: flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px;
  border: 1px solid var(--line); border-radius: var(--r-pill); font-size: 10.5px; color: var(--ink-2); }
.pill b { color: var(--ink); font-weight: var(--w-hi); }
.pill.mode { color: var(--warn); border-color: var(--warn); }
.ring { margin-left: auto; display: flex; align-items: center; gap: 6px; font: 9.5px var(--mono); color: var(--ink-3); }
.ring .r { width: 14px; height: 14px; border-radius: 50%; flex: none;
  background: conic-gradient(var(--warn) 0 78%, var(--well) 78% 100%); }
.grid.two { flex-direction: column; }
.grid .row { flex: 1; display: flex; gap: var(--gap); min-height: 0; min-width: 0; }
.work.col { flex-direction: column; }
"""

# The screens each file carries, and the one-line caption under each.
SCREENS = [
    ("work", "Work", "one conversation, the arrangement at rest"),
    ("grid", "Grid", "four panes — the capability nothing may take away"),
    ("review", "Review", "changed code reaching the eye"),
    ("focus", "Focus", "session list away, one pane, nothing else"),
]


# ───────────────────────────────────────────────────────────────────────────
# Shared window furniture.
# ───────────────────────────────────────────────────────────────────────────


def pane(title, body, focus=True, head_extra="", compose=None, mark="gate"):
    """One conversation pane: header, transcript, composer."""
    f = " focus" if focus else ""
    comp = compose if compose is not None else composer_classic()
    return f"""<div class="pane{f}">
            <div class="ph"><span class="pd">◆</span> {title}{head_extra}</div>
            <div class="scroll btm"><div class="fade"></div>
              {body}
            </div>
            {comp}
          </div>"""


def composer_classic(status=True):
    st = (
        """<div class="status"><s class="hot">storrence-dev</s><span class="sep">·</span>"""
        """<s class="hot">Opus 5 1M</s><span class="sep">·</span><s class="mode">plan</s>"""
        """<span class="sep">·</span><s>workspace-write</s><span class="sep">·</span>"""
        """<s>waiting</s><span class="send">↑ send</span></div>"""
        if status
        else ""
    )
    return f"""<div class="comp">
              <div class="in">Re-derive scope at adoption, then cover the drag path…</div>
              {st}
            </div>"""


def composer_bare():
    """6b: the chips moved to the toolbar, so only run state stays."""
    return """<div class="comp">
              <div class="in">Re-derive scope at adoption, then cover the drag path…</div>
              <div class="status"><s>waiting on you</s><span class="send">↑ send</span></div>
            </div>"""


def composer_cluster():
    """6d: run controls cluster around the composer, with a usage ring."""
    return """<div class="comp">
              <div class="cluster"><span class="pill"><b>storrence-dev</b></span>
                <span class="pill">Opus 5 <b>1M</b></span><span class="pill mode">plan</span>
                <span class="pill">local ⌄</span>
                <span class="ring"><span class="r"></span>78%</span></div>
              <div class="in">Re-derive scope at adoption, then cover the drag path…</div>
              <div class="status"><s>waiting on you</s><span class="send">↑ send</span></div>
            </div>"""


def composer_spine():
    """6e: everything true of the window lives on the spine below."""
    return """<div class="comp">
              <div class="in">Re-derive scope at adoption, then cover the drag path…</div>
            </div>"""


def update_card():
    return """<div class="card upd"><div class="a">↓ 2.1.0 available</div>
          <div class="b">restart to install</div></div>"""


def review_panel(hunks=True):
    return f"""<div class="review">
          <div class="rh">Review <span class="n"><span class="p">+69</span><span class="m">−3</span></span></div>
          <div>
            {changed_rows(hunks=hunks)}
          </div>
          <div class="hunk">
            <div class="hh"><span>state/dock.ts</span><span>hunk 1 of 2</span><span class="k">j / k</span></div>
            <div class="diff" style="border:0;border-radius:0">
              <pre><span class="ctxl">  function adoptTab(tab, pane) {{</span>
<span class="del">-   return {{ ...tab, paneId: pane.id }}</span>
<span class="add">+   // a tab that changes hands re-derives its scope; the</span>
<span class="add">+   // one it arrived with belonged to the pane it left.</span>
<span class="add">+   return {{ ...tab, paneId: pane.id,</span>
<span class="add">+     scopePath: scopeFor(pane.session) }}</span>
<span class="ctxl">  }}</span></pre>
            </div>
            <div class="hh"><span>lib/scope.ts</span><span>hunk 1 of 1</span><span class="k">unread</span></div>
            <div class="diff" style="border:0;border-radius:0">
              <pre><span class="add">+ export function scopeFor(session) {{</span>
<span class="add">+   // a session without a repo is scoped to nothing, not to</span>
<span class="add">+   // everything — the escape this fixes read it the other way.</span>
<span class="add">+   if (!session.repoRoot) return null</span>
<span class="add">+   return session.worktreeRoot ?? session.repoRoot</span>
<span class="add">+ }}</span></pre>
            </div>
          </div>
          <div class="rfoot"><div class="btn">Revert hunk</div><div class="btn">Stage</div><div class="btn pri">Commit</div></div>
        </div>"""


def context_panel():
    return f"""<div class="ctxp">
          <div class="sec"><div class="sh">SESSION<span class="v">14:22 · 38 turns</span></div>
            <div class="kv">context<span class="v">78% · 156k</span></div>
            <div class="meter"><i style="width:78%"></i></div>
            <div class="kv" style="margin-top:6px">cost<span class="v">$1.24</span></div>
          </div>
          <div class="sec"><div class="sh">PLAN<span class="v">2 of 4</span></div>{TR_TODO}</div>
          <div class="sec"><div class="sh">CHANGED<span class="v">+69 −3</span></div>
            {changed_rows()}
          </div>
          <div class="sec"><div class="sh">DELEGATED<span class="v">2</span></div>{TR_DELE}</div>
          <div class="sec" style="border:0"><div class="sh">SERVERS</div>
            <div class="kv">mcp · artemisBrowser<span class="v ok">ready</span></div>
            <div class="kv">terminal · zsh<span class="v ok">2 live</span></div>
          </div>
        </div>"""


def dock_classic(tab="browser"):
    """Today's dock: a 34px vertical icon rail plus one body."""
    return """<div class="dock" style="width:330px;display:flex;flex-direction:row">
          <div style="width:34px;flex:none;border-right:1px solid var(--line);display:flex;
            flex-direction:column;align-items:center;gap:6px;padding:7px 0;background:var(--ph-bg)">
            <div class="ri" style="width:26px;height:26px;display:grid;place-items:center;
              font-size:11px;color:var(--ink-3);border-radius:var(--r-sm)">◧</div>
            <div class="ri" style="width:26px;height:26px;display:grid;place-items:center;
              font-size:11px;background:var(--accent);color:var(--accent-ink);border-radius:var(--r-sm)">⌘</div>
            <div class="ri" style="width:26px;height:26px;display:grid;place-items:center;
              font-size:11px;color:var(--ink-3);border-radius:var(--r-sm)">▤</div>
            <div class="ri" style="width:26px;height:26px;display:grid;place-items:center;
              font-size:11px;color:var(--ink-3);border-radius:var(--r-sm)">☰</div>
            <div style="flex:1"></div>
            <div style="font:8.5px var(--mono);color:var(--ink-3)">pane</div>
          </div>
          <div class="fv">
            <div class="fvh"><span>zsh · artemis</span><span class="g">live</span></div>
            """ + TERMINAL + """
          </div>
        </div>"""


def win(inner, cls=""):
    return f'<div class="win{cls}">{inner}</div>'


# ───────────────────────────────────────────────────────────────────────────
# 6a — Control. Today's arrangement, on this round's paper.
# ───────────────────────────────────────────────────────────────────────────


def build_6a(screen):
    header = f"""<div class="hdr">
      {LIGHTS}
      <div class="icon">◧</div>
      <div class="crumb"><b>artemis</b><span>›</span>The sandbox lets a write escape</div>
      <div class="right"><div class="ctx">78%<div class="ctxbar"><i></i></div></div>
        <div class="icon">⊞</div><div class="icon">+</div><div class="icon">⚙</div></div>
    </div>"""

    rail = """<div class="rail">
        <div class="ri on">☰</div><div class="ri">⌕</div><div class="ri badge">◷</div>
        <div class="sp"></div><div class="ri">⚙</div>
      </div>"""

    side = f"""<div class="side">
        <div class="card" style="flex:1;overflow:hidden">
          <div class="cap"><span>SESSIONS</span><span class="x">‹</span></div>
          <div class="top"><div class="newbtn">+ New session</div><div class="icon">◧</div></div>
          {sess_rows()}
        </div>
        {update_card()}
      </div>"""

    if screen == "grid":
        body = f"""<div class="body">{rail}{side}
      <div class="work"><div class="grid two">
        <div class="row">
          {pane('artemis › sandbox escape', TRANSCRIPT_SHORT)}
          {pane('artemis › dock arrangement', TRANSCRIPT_SHORT, focus=False)}
        </div>
        <div class="row">
          {pane('cerebro › setup wizard', TRANSCRIPT_SHORT, focus=False)}
          {pane('artemis › capability flags', TRANSCRIPT_SHORT, focus=False)}
        </div>
      </div>{dock_classic()}</div>
    </div>"""
    elif screen == "review":
        body = f"""<div class="body">{rail}{side}
      <div class="work"><div class="grid">
        {pane('artemis › sandbox escape', TRANSCRIPT)}
      </div>{dock_classic()}</div>
    </div>"""
    elif screen == "focus":
        body = f"""<div class="body">{rail}
      <div class="work"><div class="grid">
        {pane('artemis › sandbox escape', TRANSCRIPT_SAID)}
      </div></div>
    </div>"""
    else:
        body = f"""<div class="body">{rail}{side}
      <div class="work"><div class="grid">
        {pane('artemis › sandbox escape', TRANSCRIPT)}
      </div>{dock_classic()}</div>
    </div>"""
    return win(header + body)


# ───────────────────────────────────────────────────────────────────────────
# 6b — Toolbar. The window owns the controls (T3 Code posture).
# ───────────────────────────────────────────────────────────────────────────


def build_6b(screen):
    diff_on = " on" if screen == "review" else ""
    header = f"""<div class="hdr">
      {LIGHTS}
      <div class="icon">◧</div>
      <div class="crumb"><b>artemis</b><span>›</span>The sandbox lets a write escape</div>
      <div class="right"><div class="ctx">78%<div class="ctxbar"><i></i></div></div>
        <div class="icon">⚙</div></div>
    </div>
    <div class="toolbar">
      <span class="tchip"><b>storrence-dev</b><span class="cv">▾</span></span>
      <span class="tchip">Opus 5 <b>1M</b><span class="cv">▾</span></span>
      <span class="tchip mode">plan<span class="cv">▾</span></span>
      <span class="tchip">workspace-write<span class="cv">▾</span></span>
      <div class="sp"></div>
      <div class="tgl"><s class="{diff_on.strip()}">⑂ diff</s><s>⌘ terminal</s><s>◧ browser</s></div>
      <span class="tchip act">commit</span><span class="tchip">PR</span>
    </div>"""

    side = f"""<div class="side tree" style="width:216px">
        <div class="card" style="flex:1;overflow:hidden">
          <div class="top"><div class="newbtn">+ New thread</div><div class="icon">⌕</div></div>
          {sess_rows(indent=True)}
        </div>
        {update_card()}
      </div>"""

    comp = composer_bare()

    if screen == "grid":
        body = f"""<div class="body">{side}
      <div class="work"><div class="grid two">
        <div class="row">
          {pane('sandbox escape', TRANSCRIPT_SHORT, compose=comp)}
          {pane('dock arrangement', TRANSCRIPT_SHORT, focus=False, compose=comp)}
        </div>
        <div class="row">
          {pane('setup wizard', TRANSCRIPT_SHORT, focus=False, compose=comp)}
          {pane('capability flags', TRANSCRIPT_SHORT, focus=False, compose=comp)}
        </div>
      </div></div>
    </div>"""
    elif screen == "review":
        body = f"""<div class="body">{side}
      <div class="work"><div class="grid">
        {pane('sandbox escape', TRANSCRIPT, compose=comp)}
      </div>{review_panel(hunks=False)}</div>
    </div>"""
    elif screen == "focus":
        body = f"""<div class="body">
      <div class="work"><div class="grid">
        {pane('sandbox escape', TRANSCRIPT_SAID, compose=comp)}
      </div></div>
    </div>"""
    else:
        body = f"""<div class="body">{side}
      <div class="work"><div class="grid">
        {pane('sandbox escape', TRANSCRIPT, compose=comp)}
      </div></div>
    </div>"""
    return win(header + body)


# ───────────────────────────────────────────────────────────────────────────
# 6c — Control room. Review-first (Codex posture).
# ───────────────────────────────────────────────────────────────────────────


def build_6c(screen):
    header = f"""<div class="hdr">
      {LIGHTS}
      <div class="icon">◧</div>
      <div class="crumb"><b>artemis</b><span>›</span>The sandbox lets a write escape<span>›</span>⑂ worktree</div>
      <div class="right"><div class="ctx">78%<div class="ctxbar"><i></i></div></div>
        <div class="icon">⌘</div><div class="icon">⚙</div></div>
    </div>"""

    rail = """<div class="rail">
        <div class="ri on">☰</div><div class="ri">⌕</div><div class="ri badge">◷</div>
        <div class="ri">◈</div><div class="sp"></div><div class="ri">⚙</div>
      </div>"""

    side = f"""<div class="side" style="width:208px">
        <div class="card">
          <div class="navitem on"><span class="m">☰</span>Sessions<span class="ct">6</span></div>
          <div class="navitem"><span class="m">◷</span>Review queue<span class="ct">3</span></div>
          <div class="navitem"><span class="m">⟳</span>Routines<span class="ct">2</span></div>
          <div class="navitem"><span class="m">◈</span>Delegated<span class="ct">2</span></div>
        </div>
        <div class="card" style="flex:1;overflow:hidden">
          <div class="top"><div class="newbtn">+ New session</div><div class="icon">◧</div></div>
          {sess_rows(flags=True)}
        </div>
      </div>"""

    drawer = f"""<div class="drawer">
          <div class="dh"><d class="on">zsh · artemis</d><d>vitest</d><d>+</d>
            <span class="k">⌘J</span></div>
          {TERMINAL}
        </div>"""

    if screen == "grid":
        body = f"""<div class="body">{rail}{side}
      <div class="work col">
        <div class="grid two" style="flex:1">
          <div class="row">
            {pane('sandbox escape', TRANSCRIPT_SHORT)}
            {pane('dock arrangement', TRANSCRIPT_SHORT, focus=False)}
          </div>
          <div class="row">
            {pane('setup wizard', TRANSCRIPT_SHORT, focus=False)}
            {pane('capability flags', TRANSCRIPT_SHORT, focus=False)}
          </div>
        </div>
      </div>{review_panel()}
    </div>"""
    elif screen == "review":
        body = f"""<div class="body">{rail}{side}
      <div class="work col">
        <div class="grid" style="flex:1">{pane('sandbox escape', TRANSCRIPT_SAID)}</div>
        {drawer}
      </div>{review_panel()}
    </div>"""
    elif screen == "focus":
        body = f"""<div class="body">{rail}
      <div class="work col"><div class="grid" style="flex:1">
        {pane('sandbox escape', TRANSCRIPT_SAID)}
      </div></div>
    </div>"""
    else:
        body = f"""<div class="body">{rail}{side}
      <div class="work col"><div class="grid" style="flex:1">
        {pane('sandbox escape', TRANSCRIPT)}
      </div></div>{review_panel()}
    </div>"""
    return win(header + body)


# ───────────────────────────────────────────────────────────────────────────
# 6d — Deck. Everything is a pane (Claude Code posture).
# ───────────────────────────────────────────────────────────────────────────

DIAL = """<span class="dial"><s>brief</s><s class="on">normal</s><s>full</s></span>"""


def deck_pane(title, body, kind="", focus=False, stat=""):
    f = " focus" if focus else ""
    right = stat or ""
    return f"""<div class="pane{f}">
            <div class="ph"><span class="grab">⠿</span>{title}{right}<span class="x">✕</span></div>
            {body}
          </div>"""


def build_6d(screen):
    header = f"""<div class="hdr">
      {LIGHTS}
      <div class="icon">◧</div>
      <div class="crumb"><b>artemis</b><span>›</span>The sandbox lets a write escape</div>
      <div class="right"><span class="tchip">Views <span class="cv">▾</span></span>
        <div class="icon">+</div><div class="icon">⚙</div></div>
    </div>"""

    side = f"""<div class="side" style="width:210px">
        <div class="card" style="flex:1;overflow:hidden">
          <div class="cap"><span>SESSIONS</span><span class="x">‹</span></div>
          <div class="top"><div class="newbtn">+ New session</div><div class="icon">◧</div></div>
          <div class="filters"><s class="on">all</s><s>working</s><s>waiting</s><s>done</s></div>
          {sess_rows()}
        </div>
        {update_card()}
      </div>"""

    convo = pane(
        "sandbox escape",
        TRANSCRIPT,
        head_extra=DIAL,
        compose=composer_cluster(),
    )
    convo_short = pane(
        "sandbox escape",
        TRANSCRIPT_SHORT,
        head_extra=DIAL,
        compose=composer_cluster(),
    )

    diff_pane = deck_pane(
        "diff · 3 files",
        f"""<div class="scroll" style="padding:0">
              {changed_rows()}
              <div style="padding:9px">{TR_DIFF}</div>
            </div>""",
        stat='<span class="stat"><span class="p">+69</span><span class="m">−3</span></span>',
    )
    term_pane = deck_pane(
        "terminal · zsh",
        f'<div class="scroll" style="padding:0">{TERMINAL}</div>',
    )
    tasks_pane = deck_pane(
        "tasks · 2 running",
        f'<div class="scroll" style="padding:9px">{TR_TODO}{TR_DELE}</div>',
    )

    if screen == "grid":
        body = f"""<div class="body">{side}
      <div class="deck">
        <div class="row">{convo_short}{deck_pane('dock arrangement', f'<div class="scroll btm">{TRANSCRIPT_SHORT}</div>' + composer_cluster())}</div>
        <div class="row">{diff_pane}{term_pane}</div>
      </div>
    </div>"""
    elif screen == "review":
        body = f"""<div class="body">{side}
      <div class="deck">
        <div class="row">{convo}{diff_pane}</div>
        <div class="row" style="flex:0 0 200px">{term_pane}{tasks_pane}</div>
      </div>
    </div>"""
    elif screen == "focus":
        body = f"""<div class="body">
      <div class="deck"><div class="row">{pane('sandbox escape', TRANSCRIPT_SAID, head_extra=DIAL, compose=composer_cluster())}</div></div>
    </div>"""
    else:
        body = f"""<div class="body">{side}
      <div class="deck"><div class="row">{convo}{diff_pane}</div></div>
    </div>"""
    return win(header + body)


# ───────────────────────────────────────────────────────────────────────────
# 6e — Cockpit. Tabs above, context beside, spine below (OpenCode posture).
# ───────────────────────────────────────────────────────────────────────────


def build_6e(screen):
    header = f"""<div class="hdr">
      {LIGHTS}
      <div class="icon">◧</div>
      <div class="crumb"><b>artemis</b></div>
      <div class="right"><div class="icon">⌕</div><div class="icon">+</div><div class="icon">⚙</div></div>
    </div>
    <div class="wtabs">
      <t class="on"><span class="dot gate"></span><span class="t">sandbox escape</span></t>
      <t><span class="dot run"></span><span class="t">dock arrangement</span></t>
      <t><span class="dot"></span><span class="t">capability flags</span></t>
      <t><span class="dot run"></span><span class="t">setup wizard</span></t>
      <span class="plus">+</span>
    </div>"""

    spine = """<div class="spine">
      <s class="hot">storrence-dev</s><span>·</span><s class="hot">Opus 5 1M</s><span>·</span>
      <s class="mode">plan</s><span>·</span><s>workspace-write</s><span>·</span><s>waiting on you</s>
      <div class="sp"></div>
      <s>78% · 156k</s><span>·</span><s>$1.24</s><span class="lead">⌃x</span>
    </div>"""

    side = f"""<div class="side" style="width:190px">
        <div class="card" style="flex:1;overflow:hidden">
          <div class="cap"><span>SESSIONS</span><span class="x">‹</span></div>
          {sess_rows()}
        </div>
      </div>"""

    rail = """<div class="rail">
        <div class="ri on">☰</div><div class="ri">⌕</div><div class="ri badge">◷</div>
        <div class="sp"></div><div class="ri">⚙</div>
      </div>"""

    comp = composer_spine()

    if screen == "grid":
        body = f"""<div class="body">{rail}{side}
      <div class="work"><div class="grid two">
        <div class="row">
          {pane('sandbox escape', TRANSCRIPT_SHORT, compose=comp)}
          {pane('dock arrangement', TRANSCRIPT_SHORT, focus=False, compose=comp)}
        </div>
        <div class="row">
          {pane('setup wizard', TRANSCRIPT_SHORT, focus=False, compose=comp)}
          {pane('capability flags', TRANSCRIPT_SHORT, focus=False, compose=comp)}
        </div>
      </div>{context_panel()}</div>
    </div>"""
    elif screen == "review":
        body = f"""<div class="body">{rail}{side}
      <div class="work"><div class="grid">
        {pane('sandbox escape', TRANSCRIPT_SAID, compose=comp)}
      </div>{review_panel(hunks=False)}</div>
    </div>"""
    elif screen == "focus":
        body = f"""<div class="body">{rail}
      <div class="work"><div class="grid">
        {pane('sandbox escape', TRANSCRIPT_SAID, compose=comp)}
      </div>{context_panel()}</div>
    </div>"""
    else:
        body = f"""<div class="body">{rail}{side}
      <div class="work"><div class="grid">
        {pane('sandbox escape', TRANSCRIPT, compose=comp)}
      </div>{context_panel()}</div>
    </div>"""
    return win(header + body + spine)


# ───────────────────────────────────────────────────────────────────────────
# The five directions.
# ───────────────────────────────────────────────────────────────────────────

VARIANTS = [
    dict(
        slug="6a-control",
        kicker="6A · CONTROL — THE ARRANGEMENT TODAY",
        title="Control",
        claim="the incumbent, on this round's paper",
        build=build_6a,
        spec=[
            ("CONTROLS", "val", "status line, under each pane"),
            ("REVIEW", "val", "diffs inside tool cards"),
            ("SIDE SURFACE", "val", "dock · 34px icon rail"),
            ("WINDOW EDGE", "val", "header ›  rail · list · panes · dock"),
        ],
        lede=[
            "What ships today, re-rendered here so the four proposals have something to beat. Rail and session list on the left, a grid of conversations in the middle, the dock on the right behind its own vertical icon rail. Every run control — profile, model, mode, sandbox, run state — lives on a status line under each pane, because in a 2×2 each pane's next run is genuinely different.",
            "Round four designed this and it is only partly landed. Judge it as a real option: it is the only one of the five that costs nothing to keep.",
        ],
        wins=[
            "<b>The per-pane truth is already right.</b> Four panes can hold four models, four modes and four sandboxes; the status line is the only design here that never lies about which pane it describes.",
            "<b>The dock's icon rail is width-cheap.</b> 34px of vertical tabs in exchange for browser, terminal, files, tasks and preview — no horizontal tab strip eating the narrowest column on screen.",
            "<b>Nothing to migrate.</b> Every capability, keybinding and persisted layout key keeps working.",
        ],
        costs=[
            "<b>Changed code has no home.</b> Diffs live inside tool cards in the scrollback: to see what this session did to the tree you scroll and reassemble it yourself. All four references answer this with a dedicated surface; the control is alone in not answering it.",
            "<b>The status line repeats.</b> Five segments per pane is twenty segments in a 2×2, most of them identical — round four wrote this down and the elision it prescribed never shipped.",
            "<b>Session status is a coloured dot.</b> No filter, no grouping beyond project, no worktree or remote flag — the list does not say which sessions want you.",
        ],
    ),
    dict(
        slug="6b-toolbar",
        kicker="6B · THE WINDOW OWNS THE CONTROLS",
        title="Toolbar",
        claim="T3 Code posture — one bar, above everything",
        build=build_6b,
        spec=[
            ("CONTROLS", "val", "toolbar, top of window"),
            ("REVIEW", "val", "diff panel, right, on toggle"),
            ("SIDE SURFACE", "val", "toggles in the toolbar"),
            ("WINDOW EDGE", "val", "header · toolbar ›  tree · panes"),
        ],
        lede=[
            "<b>T3 Code's arrangement, read straight.</b> A real toolbar under the title bar carries the focused pane's profile, model, mode and sandbox as chips, then the surface toggles — diff, terminal, browser — and the git actions. The session list deepens into a project → thread tree. The status line shrinks to the one thing that is not in the toolbar: whether this pane is waiting on you.",
            "The claim is discoverability. Every control is visible at rest, in one row, in the place every other application on the machine puts its controls — and the composer gets its space back.",
        ],
        wins=[
            "<b>One place to look.</b> Model, mode and sandbox stop being per-pane furniture and become window furniture; a new user finds them without being told.",
            "<b>Git gets a home.</b> Commit and PR are affordances rather than something you type into a terminal — the single biggest thing all four references have that Artemis does not.",
            "<b>The composer stops carrying chrome.</b> The bottom of a pane becomes input and run state, nothing else.",
        ],
        costs=[
            "<b>It has to answer «which pane?» every time.</b> The toolbar describes the focused pane, so in a 2×2 three of the four panes are being described by a bar that is not about them. The control's status line never had this problem. Mitigation is a focus ring loud enough to carry the whole bar — which is a real cost on a grey palette.",
            "<b>Vertical budget.</b> A 34px toolbar under a 44px header is 78px of chrome before any work appears.",
            "<b>Chips at the top, work at the bottom.</b> The eye travels the full height of the window between «what model is this» and «what am I typing».",
        ],
    ),
    dict(
        slug="6c-controlroom",
        kicker="6C · REVIEW IS THE POINT",
        title="Control room",
        claim="Codex posture — a persistent review panel",
        build=build_6c,
        spec=[
            ("CONTROLS", "val", "status line, under each pane"),
            ("REVIEW", "val", "panel, right, always"),
            ("SIDE SURFACE", "val", "terminal drawer, bottom"),
            ("WINDOW EDGE", "val", "header ›  rail · list · panes · review"),
        ],
        lede=[
            "<b>Codex's control room.</b> The right edge stops being a dock of artifacts and becomes a review panel: the session's working tree, file by file, hunk by hunk, with read/unread marks you walk with <code>j</code> and <code>k</code>, and stage / revert / commit at the foot. The terminal moves to a bottom drawer where output is wide. The sidebar grows a review queue, routines and delegated work above the session list, and sessions carry a local / worktree / remote flag.",
            "The claim is that an agent harness is a review tool. The transcript is how the work was done; the diff is the work. Codex, Claude Code and T3 Code all reached the same conclusion from different directions.",
        ],
        wins=[
            "<b>The work is always on screen.</b> No scrolling back through tool cards to reassemble what changed — the panel is the answer to «what did this session do to my repo».",
            "<b>Hunk-level read/unread</b> is the one review affordance almost nobody has, and it is what makes a 400-line diff finishable.",
            "<b>The terminal gets width.</b> A bottom drawer fits 120 columns; a 330px right dock does not, and today's terminal is in the narrow one.",
            "<b>The sidebar admits what else is running.</b> Routines and delegated work stop hiding behind a badge on a rail icon.",
        ],
        costs=[
            "<b>It spends the most horizontal space of the five.</b> Rail + list + panes + a 348px review panel: in a 2×2 the panes get roughly 380px each, close to the 360px split minimum. On a laptop screen something has to be collapsed, and the round-two verdict says it cannot be the panes.",
            "<b>Review is per-session, panes are many.</b> The panel needs the same scope answer the dock needed — this pane's tree, or every pane's — and worktree sessions make that answer load-bearing rather than cosmetic.",
            "<b>Two homes for one truth.</b> A file appears both in the transcript's tool card and in the panel; keeping them from disagreeing is real work.",
        ],
    ),
    dict(
        slug="6d-deck",
        kicker="6D · EVERYTHING IS A PANE",
        title="Deck",
        claim="Claude Code posture — the dock dissolves into the grid",
        build=build_6d,
        spec=[
            ("CONTROLS", "val", "clustered around the composer"),
            ("REVIEW", "val", "a diff pane, like any other"),
            ("SIDE SURFACE", "val", "none — surfaces are panes"),
            ("WINDOW EDGE", "val", "header ›  list · deck"),
        ],
        lede=[
            "<b>Claude Code's desktop, taken literally.</b> There is no dock. Diff, terminal, tasks and browser are panes with headers and grab handles, sitting in the same grid as conversations and arranged by dragging. The session list grows status filters. Run controls cluster around the composer where the typing is, with a usage ring beside them, and each conversation pane header carries a detail dial — brief / normal / full — so a pane you are only watching can be quieter than the one you are working in.",
            "The claim is one spatial model instead of two. Today a user learns the pane grid and then learns the dock; here there is only the grid.",
        ],
        wins=[
            "<b>One arrangement model.</b> Everything splits, resizes, closes and restores the same way — <code>state/pane.ts</code> grows rather than <code>state/dock.ts</code> existing beside it.",
            "<b>Controls sit where the hands are.</b> Model and mode next to the composer is the shortest distance between «change this» and «send this», and the usage ring is visible at rest rather than on hover.",
            "<b>The detail dial is per-pane.</b> Watching four sessions is only survivable if three of them can be summaries — no reference except Claude Code offers this, and none offers it per-pane.",
        ],
        costs=[
            "<b>Artifacts stop belonging to conversations.</b> ADR 0002 says surfaces belong to the conversation that made them; a free-floating diff pane in a shared grid has to re-earn that ownership, and per-session restore gets harder, not easier.",
            "<b>Pane pressure.</b> The grid already caps at eight; if terminals and diffs compete for those slots, four conversations plus their artifacts is over budget.",
            "<b>Every pane pays for a header.</b> Eight headers at 28px is 224px of chrome that the dock's single 34px rail was avoiding.",
        ],
    ),
    dict(
        slug="6e-cockpit",
        kicker="6E · AMBIENT CONTEXT, ALWAYS",
        title="Cockpit",
        claim="OpenCode posture — tabs above, context beside, spine below",
        build=build_6e,
        spec=[
            ("CONTROLS", "val", "spine, bottom of window"),
            ("REVIEW", "val", "changed files in the context panel"),
            ("SIDE SURFACE", "val", "context panel, right, always"),
            ("WINDOW EDGE", "val", "header · tabs ›  rail · list · panes · context ›  spine"),
        ],
        lede=[
            "<b>OpenCode's cockpit.</b> Sessions become tabs in the window chrome. The right edge is a context panel that never goes away: context percentage and cost, the live plan, the files this session has changed with their counts, delegated work, and whether the servers are up. The bottom of the window is a single spine carrying what is true of the focused pane — the arrangement OpenCode's users say they miss most when they leave it.",
            "The claim is ambient awareness. Nothing here is a click away; the cost of that is the width and the height it takes to keep it all visible.",
        ],
        wins=[
            "<b>Nothing is hidden behind a hover.</b> Context pressure, spend, plan progress and changed files are all readable without moving the mouse — the thing reviewers single out about OpenCode and complain about losing elsewhere.",
            "<b>One status line for the window.</b> The spine replaces the per-pane repetition round four called out: five segments once instead of twenty in a 2×2.",
            "<b>Tabs make session switching muscle memory</b> and cost no vertical space in the panes themselves.",
        ],
        costs=[
            "<b>The spine and the tabs both lie in a 2×2.</b> One spine describes one focused pane, and a tab strip implies one session at a time — this is the variant most in tension with the capability round two refused to give up. It is shown here in a grid so that tension is visible rather than argued about.",
            "<b>Two horizontal bands and a panel.</b> 30px of tabs plus 26px of spine plus 268px of context is the most chrome of the five; the transcript column ends up narrowest here.",
            "<b>Duplication with the sidebar.</b> Tabs and the session list are two views of the same set, and the list is the one that scales past six.",
        ],
    ),
]


# ───────────────────────────────────────────────────────────────────────────
# Emission.
# ───────────────────────────────────────────────────────────────────────────

SWITCH_JS = """
<script>
(function () {
  var root = document.documentElement;
  function seg(id, fn) {
    var box = document.getElementById(id);
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      [].forEach.call(box.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
      fn(b.dataset.v); fit();
    });
  }
  seg('screens', function (v) {
    [].forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('on', s.dataset.screen === v);
    });
  });
  seg('themes', function (v) { root.classList.toggle('light', v === 'light'); });
  var page = document.querySelector('.page'), W = 1400, H = 1000, one = false;
  function fit() {
    // a hidden tab reports clientWidth 0; scale(0) would blank the window.
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
  document.addEventListener('click', function (e) {
    if (e.target.closest('.win')) { one = !one; fit(); }
  });
  addEventListener("resize", fit); addEventListener("visibilitychange", fit); fit();
})();
</script>
"""

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title} — round six, the arrangement</title>
<style>
{fonts}
/* ── {title}. Round six: where things are.
   claim: {claim}
   The palette is round five's verdict (5b dark / 5e light), derived here by
   importing _seed_build.py. The type, radii and the whole transcript grammar
   come from _build.py. Every file in this round renders the same session.
   Anything differing between the five is the arrangement.
   To change this file: python3 docs/design/_round6_build.py
   ─────────────────────────────────────────────────────────────────────── */
:root {{
{dark}
{held}
}}
html.light {{
{light}
}}
{base}
{layout}
</style>
</head>
<body>
<div class="page">
  <a class="back" href="index.html">← the design record</a>
  <div class="vnav" style="margin-top:12px">{vnav}</div>
  <div class="kicker" style="margin-top:10px">{kicker}</div>
  <h1>{title}</h1>
{lede}
  <div class="spec">
{spec}
  </div>
  <div class="ctl">
    <div class="segs" id="screens"><span class="lab">SCREEN</span>{screenbtns}</div>
    <div class="segs" id="themes"><span class="lab">THEME</span>
      <button class="on" data-v="dark">Dark</button><button data-v="light">Light</button></div>
    <div class="fitnote" style="margin:0"></div>
  </div>
{screens}
  <div class="foot">
    <div class="box">
      <h3>What this arrangement buys</h3>
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
{js}
</body>
</html>
"""


def build():
    for v in VARIANTS:
        vnav = " ".join(
            f'<a class="{"on" if o["slug"] == v["slug"] else ""}" href="{o["slug"]}.html">'
            f'{o["slug"][:2].upper()} · {o["title"]}</a>'
            for o in VARIANTS
        )
        screenbtns = "".join(
            f'<button class="{"on" if i == 0 else ""}" data-v="{key}">{label}</button>'
            for i, (key, label, _) in enumerate(SCREENS)
        )
        screens = "\n".join(
            f'  <div class="screen{" on" if i == 0 else ""}" data-screen="{key}">'
            f'<div class="scap"><b>{label}</b> — {cap}</div>{v["build"](key)}</div>'
            for i, (key, label, cap) in enumerate(SCREENS)
        )
        html = TEMPLATE.format(
            title=v["title"],
            claim=v["claim"],
            kicker=v["kicker"],
            fonts=FONTS,
            dark=S.tokens_css(DARK, "dark"),
            light=S.tokens_css(LIGHT, "light"),
            held=HELD,
            base=_build.BASE,
            layout=LAYOUT_CSS,
            vnav=vnav,
            lede="\n".join(f'  <p class="note">{p}</p>' for p in v["lede"]),
            spec=_build.spec_html(v["spec"]),
            screenbtns=screenbtns,
            screens=screens,
            wins="\n".join(f"        <li>{w}</li>" for w in v["wins"]),
            costs="\n".join(f"        <li>{c}</li>" for c in v["costs"]),
            js=SWITCH_JS,
        )
        (OUT / f'{v["slug"]}.html').write_text(html)
        print(f'wrote {v["slug"]}.html')


if __name__ == "__main__":
    build()
