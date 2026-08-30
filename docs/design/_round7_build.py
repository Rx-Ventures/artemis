#!/usr/bin/env python3
"""Generate the round-seven surface-language mockups.

Round six varied the arrangement and held the surface language constant — and
that was the wrong thing to hold. Artemis's chrome is an instrument panel:
3px radii, a solid hairline around everything, 11px uppercase mono labels,
26px bars. Rearranging that furniture cannot produce a modern-looking app,
because the look is the treatment, not the layout.

So this round varies the treatment and holds the arrangement. Every file is
the same three-region shape T3 Code actually uses — threads left, one
conversation centred on a narrow column, an optional panel right, one topbar
across the top — and what differs is radius, border, density, type and depth.

The numbers in 7B are not invented. They are read from T3 Code's own
index.css via docs/research/T3-DESIGN-RESEARCH.md §1.2: radius 0.625rem,
control radius 0.5rem, alpha borders at 6% (inputs 8%), a 52px topbar, a
768px transcript column, surfaces as computed lifts rather than picked greys.

    python3 docs/design/_round7_build.py

Writes 7a-instrument.html … 7d-console.html next to this file.
"""

import pathlib

import _seed_build as S

OUT = pathlib.Path(__file__).parent

DARK, _ = S.derive_dark(S.SEED_CANVAS, S.SEED_ACCENT)
LIGHT, _ = S.derive_light(S.SEED_ACCENT)

# ───────────────────────────────────────────────────────────────────────────
# The session — the same one round six rendered, so the two rounds can be
# read against each other. Words identical; only the markup around them is
# allowed to modernise.
# ───────────────────────────────────────────────────────────────────────────

USER_TEXT = (
    "The sandbox lets a write escape — the browser tab reached "
    "<code>~/.config</code> while the pane was scoped to the repo. Find where "
    "the scope is dropped."
)
SAID_TEXT = (
    "<b>adoptTab</b> carries the old pane's <code>scopePath</code> across. A tab "
    "dragged out of a repo-scoped pane keeps the permissive scope, and the "
    "browser inherits it. The fix re-derives scope at adoption; the test covers "
    "the drag path."
)
THINK_TEXT = (
    "Scope is attached when a tab spawns — but the dock can adopt a tab from "
    "another pane, and that path may never re-derive it."
)

SESSIONS = [
    ("Today", [
        ("The sandbox lets a write escape", "gate", True),
        ("Dock remembers its arrangement", "run", False),
    ]),
    ("Yesterday", [
        ("Probe the capability flags", "", False),
        ("OpenCode model configurator", "done", False),
    ]),
    ("Last 7 days", [
        ("Setup wizard for any bank", "", False),
        ("Local-only bank, no remote", "", False),
    ]),
]

CHANGED = [("state/dock.ts", 7, 2), ("lib/scope.ts", 24, 0), ("state/dock.test.ts", 38, 1)]


def sidebar_rows():
    out = []
    for group, rows in SESSIONS:
        out.append(f'<div class="grp">{group}</div>')
        for title, state, on in rows:
            cls = " on" if on else ""
            dot = f'<i class="dot {state}"></i>' if state else '<i class="dot"></i>'
            out.append(f'<div class="row{cls}">{dot}<span class="t">{title}</span></div>')
    return "\n            ".join(out)


def changed_rows():
    return "\n            ".join(
        f'<div class="fr"><span class="f">{f}</span>'
        f'<span class="n"><span class="p">+{p}</span><span class="m">−{m}</span></span></div>'
        for f, p, m in CHANGED
    )


MSG_USER = f'<div class="msg u"><div class="bub">{USER_TEXT}</div></div>'

MSG_THINK = f"""<div class="msg a"><div class="think"><span class="cv">▾</span>Thought for 4s</div>
              <div class="thinkbody">{THINK_TEXT}</div></div>"""

MSG_TOOL = """<div class="msg a"><div class="step">
                <span class="ic">⌕</span><span class="nm">Searched</span>
                <span class="ar"><code>scopePath</code> · 14 files</span><span class="tm">0.4s</span>
                <span class="cv">›</span></div></div>"""

MSG_PLAN = """<div class="msg a"><div class="plan">
                <div class="pl done"><span class="m">✓</span>Reproduce the escape in a scoped pane</div>
                <div class="pl done"><span class="m">✓</span>Trace scopePath through adoptTab</div>
                <div class="pl now"><span class="m">◐</span>Re-derive scope at adoption</div>
                <div class="pl"><span class="m">○</span>Cover the drag path in dock.test.ts</div>
              </div></div>"""

MSG_DIFF = """<div class="msg a"><div class="patch">
                <div class="ph"><span class="f">state/dock.ts</span>
                  <span class="n"><span class="p">+7</span><span class="m">−2</span></span>
                  <span class="cv">›</span></div>
                <pre><span class="c">  function adoptTab(tab, pane) {</span>
<span class="d">-   return { ...tab, paneId: pane.id }</span>
<span class="a">+   // a tab that changes hands re-derives its scope; the</span>
<span class="a">+   // one it arrived with belonged to the pane it left.</span>
<span class="a">+   return { ...tab, paneId: pane.id,</span>
<span class="a">+     scopePath: scopeFor(pane.session) }</span>
<span class="c">  }</span></pre></div></div>"""

MSG_GATE = """<div class="msg a"><div class="ask">
                <div class="at">Write outside the repo?</div>
                <div class="ac"><code>~/.config/artemis/settings.json</code></div>
                <div class="aw">This pane is scoped to <b>artemis</b>. The path is outside it.</div>
                <div class="ab"><span class="b">Deny</span><span class="b">Allow for session</span>
                  <span class="b go">Approve</span></div>
              </div></div>"""

MSG_SAID = f'<div class="msg a"><div class="prose">{SAID_TEXT}</div></div>'

THREAD_FULL = "\n              ".join(
    [MSG_USER, MSG_THINK, MSG_TOOL, MSG_PLAN, MSG_DIFF, MSG_GATE]
)
THREAD_SHORT = "\n              ".join([MSG_USER, MSG_TOOL, MSG_SAID])
THREAD_SAID = "\n              ".join([MSG_USER, MSG_THINK, MSG_TOOL, MSG_DIFF, MSG_SAID])


# ───────────────────────────────────────────────────────────────────────────
# Structure. Geometry only — every radius, hairline, pad and face is a
# variable a language sets. Nothing here may differ between files.
# ───────────────────────────────────────────────────────────────────────────

BASE = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--void); color: var(--ink); font: var(--fs)/1.6 var(--sans);
  padding: 26px; -webkit-font-smoothing: antialiased; }
.page { max-width: 1400px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 7px; }
.kicker { font: 10.5px var(--mono); letter-spacing: 0.16em; color: var(--ink-3); margin-bottom: 6px; }
.note { color: var(--ink-2); font-size: 13.5px; max-width: 82ch; margin-bottom: 6px; }
.note b { color: var(--ink); font-weight: 600; }
a.back { color: var(--accent-text); text-decoration: none; font: 11px var(--mono); }
.vnav { display: flex; gap: 6px; align-items: center; margin: 12px 0 2px; flex-wrap: wrap; }
.vnav a { font: 10.5px var(--mono); color: var(--ink-3); text-decoration: none;
  border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; }
.vnav a.on { color: var(--accent-text); border-color: var(--accent-text); }
.spec { display: flex; gap: 22px; flex-wrap: wrap; margin: 14px 0 4px; padding: 12px 0;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.spec .col { display: flex; flex-direction: column; gap: 4px; }
.spec .lab { font: 9.5px var(--mono); letter-spacing: 0.13em; color: var(--ink-3); }
.spec .val { font: 11px var(--mono); color: var(--ink-2); }
.ctl { display: flex; gap: 16px; align-items: center; margin: 13px 0 2px; flex-wrap: wrap; }
.segs { display: flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.segs button { font: 10.5px var(--mono); letter-spacing: 0.1em; text-transform: uppercase;
  background: transparent; color: var(--ink-3); border: 0; border-right: 1px solid var(--line);
  padding: 5px 11px; cursor: pointer; }
.segs button:last-child { border-right: 0; }
.segs button.on { background: var(--accent); color: var(--accent-ink); }
.segs .lab { font: 9.5px var(--mono); color: var(--ink-3); padding: 5px 9px; letter-spacing: 0.13em; }
.screen { display: none; } .screen.on { display: block; }
.scap { font: 10.5px var(--mono); color: var(--ink-3); margin-top: 12px; }
.scap b { color: var(--ink-2); font-weight: 400; }
.fitnote { font: 10.5px var(--mono); color: var(--ink-3); }
.fitnote b { color: var(--ink-2); font-weight: 400; }
.foot { margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.box { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; background: var(--chrome); }
.box h3 { font-size: 12.5px; margin-bottom: 8px; color: var(--ink); font-weight: 600; }
.box h3.cost { color: var(--warn); }
.box li { font-size: 13px; color: var(--ink-2); margin-bottom: 5px; }
.box ul { margin-left: 15px; }
.box b { color: var(--ink); font-weight: 600; }

/* ── the window ─────────────────────────────────────────────────────────── */
.win { margin-top: 14px; width: 1400px; height: 1000px; flex: none; background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--r-win); overflow: hidden;
  display: flex; flex-direction: column; box-shadow: var(--sh-win); }

/* topbar — one bar, height set by the language */
.top { height: var(--h-top); flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 var(--pad-top); border-bottom: var(--hair-top); background: var(--chrome-top); }
.lights { display: flex; gap: 7px; margin-right: 5px; }
.lights i { width: 11px; height: 11px; border-radius: 50%; background: var(--line-2); display: block; opacity: 0.55; }
.title { font-size: var(--fs-title); font-weight: var(--w-title); color: var(--ink); letter-spacing: -0.01em; }
.title s { text-decoration: none; color: var(--ink-3); font-weight: 400; margin: 0 7px; }
.top .sp { flex: 1; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: var(--h-ctl);
  padding: 0 var(--pad-ctl); border: var(--hair); border-radius: var(--r-ctl);
  font-size: var(--fs-ctl); color: var(--ink-2); background: var(--fill-ctl); }
.pill b { color: var(--ink); font-weight: 550; }
.pill .cv { color: var(--ink-3); font-size: 9px; }
.pill.mode { color: var(--warn); border-color: var(--warn-line); background: var(--warn-fill); }
.pill.go { background: var(--accent); border-color: transparent; color: var(--accent-ink); font-weight: 550; }
.ico { width: var(--h-ctl); height: var(--h-ctl); border-radius: var(--r-ctl); display: grid;
  place-items: center; color: var(--ink-3); font-size: 13px; border: var(--hair-ico); background: var(--fill-ico); }

.body { flex: 1; display: flex; min-height: 0; gap: var(--gap-body); padding: var(--pad-body); }

/* ── sidebar ────────────────────────────────────────────────────────────── */
.sb { width: var(--w-sb); flex: none; display: flex; flex-direction: column; gap: 8px;
  background: var(--chrome-sb); border: var(--hair-sb); border-radius: var(--r-panel);
  padding: var(--pad-sb); overflow: hidden; }
.newb { height: var(--h-btn); border-radius: var(--r-ctl); background: var(--accent);
  color: var(--accent-ink); font-size: var(--fs-ctl); font-weight: 550; display: grid;
  place-items: center; letter-spacing: 0.01em; }
.srch { height: var(--h-btn); border-radius: var(--r-ctl); border: var(--hair-in);
  background: var(--fill-in); display: flex; align-items: center; gap: 7px;
  padding: 0 10px; font-size: var(--fs-ctl); color: var(--ink-3); }
.sb .list { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 1px; }
.grp { font: var(--f-grp); color: var(--ink-3); letter-spacing: var(--tr-grp);
  text-transform: var(--case-grp); padding: var(--pad-grp); }
.row { display: flex; align-items: center; gap: 8px; padding: var(--pad-row);
  border-radius: var(--r-ctl); font-size: var(--fs-row); color: var(--ink-2); }
.row.on { background: var(--fill-on); color: var(--ink); }
.row .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: transparent;
  border: 1px solid var(--line-2); }
.row .dot.run { background: var(--tool); border-color: var(--tool); }
.row .dot.gate { background: var(--warn); border-color: var(--warn); }
.row .dot.done { background: var(--ok); border-color: var(--ok); }
.row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb .me { display: flex; align-items: center; gap: 8px; padding: var(--pad-row); font-size: var(--fs-ctl); color: var(--ink-3); }
.sb .me i { width: 20px; height: 20px; border-radius: 50%; background: var(--accent); display: block; }

/* ── main column ────────────────────────────────────────────────────────── */
.main { flex: 1; min-width: 0; display: flex; flex-direction: column;
  background: var(--chrome-main); border: var(--hair-main); border-radius: var(--r-panel); overflow: hidden; }
.mh { height: var(--h-mh); flex: none; display: flex; align-items: center; gap: 8px;
  padding: 0 var(--pad-mh); border-bottom: var(--hair-mh); font-size: var(--fs-ctl); color: var(--ink-2); }
.mh .sp { flex: 1; }
.mh .st { font: var(--f-meta); color: var(--ink-3); }
.mh .st .p { color: var(--ok); } .mh .st .m { color: var(--err); margin-left: 5px; }
.thread { flex: 1; overflow: hidden; padding: var(--pad-thread); display: flex;
  flex-direction: column; justify-content: flex-end; gap: var(--gap-msg); }
.col { width: 100%; max-width: var(--w-col); margin: 0 auto; display: flex;
  flex-direction: column; gap: var(--gap-msg); }
.msg { display: flex; flex-direction: column; gap: 7px; }
.msg.u { align-items: flex-end; }
.bub { background: var(--fill-user); border: var(--hair-user); border-radius: var(--r-bub);
  padding: var(--pad-bub); font-size: var(--fs-msg); color: var(--ink); max-width: 86%; }
.prose { font-size: var(--fs-msg); color: var(--ink-2); line-height: 1.65; }
.prose b { color: var(--ink); font-weight: 600; }
code { font: var(--f-code); color: var(--accent-text); background: var(--fill-code);
  padding: var(--pad-code); border-radius: var(--r-code); }

.think { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-meta);
  color: var(--ink-3); }
.think .cv { font-size: 9px; }
.thinkbody { font-size: var(--fs-meta); color: var(--ink-3); font-style: italic;
  border-left: 2px solid var(--line); padding-left: 11px; line-height: 1.6; }

.step { display: flex; align-items: center; gap: 9px; padding: var(--pad-step);
  border: var(--hair); border-radius: var(--r-card); background: var(--fill-card); font-size: var(--fs-meta); }
.step .ic { color: var(--tool); font-size: 12px; }
.step .nm { color: var(--ink); font-weight: 550; }
.step .ar { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step .tm { margin-left: auto; color: var(--ink-3); font: var(--f-meta); }
.step .cv { color: var(--ink-3); font-size: 11px; }

.plan { border: var(--hair); border-radius: var(--r-card); background: var(--fill-card);
  padding: var(--pad-card); display: flex; flex-direction: column; gap: 4px; }
.pl { display: flex; gap: 9px; font-size: var(--fs-meta); color: var(--ink-3); }
.pl .m { width: 11px; flex: none; }
.pl.done { text-decoration: line-through; }
.pl.done .m { color: var(--ok); }
.pl.now { color: var(--ink); } .pl.now .m { color: var(--warn); }

.patch { border: var(--hair); border-radius: var(--r-card); overflow: hidden; background: var(--fill-card); }
.patch .ph { display: flex; align-items: center; gap: 9px; padding: var(--pad-step); font: var(--f-meta); }
.patch .ph .f { color: var(--ink); font-weight: 550; }
.patch .ph .n { margin-left: auto; }
.patch .ph .n .p { color: var(--ok); } .patch .ph .n .m { color: var(--err); margin-left: 5px; }
.patch .ph .cv { color: var(--ink-3); }
.patch pre { font: var(--f-pre); background: var(--fill-pre); padding: 7px 0; white-space: normal; }
.patch pre > span { display: block; padding: 0 var(--pad-mh); white-space: pre; }
.patch .a { background: var(--add-bg); color: var(--ok); }
.patch .d { background: var(--del-bg); color: var(--err); }
.patch .c { color: var(--ink-3); }

.ask { border: 1px solid var(--warn-line); border-radius: var(--r-card); background: var(--warn-fill);
  padding: var(--pad-card); display: flex; flex-direction: column; gap: 7px; }
.ask .at { font-size: var(--fs-msg); color: var(--ink); font-weight: 600; }
.ask .ac { font: var(--f-meta); }
.ask .aw { font-size: var(--fs-meta); color: var(--ink-2); }
.ask .ab { display: flex; gap: 7px; margin-top: 2px; }
.ask .b { height: var(--h-ctl); display: inline-flex; align-items: center; padding: 0 var(--pad-ctl);
  border: var(--hair); border-radius: var(--r-ctl); font-size: var(--fs-ctl); color: var(--ink-2); }
.ask .b.go { background: var(--warn); border-color: var(--warn); color: var(--warn-ink); font-weight: 600; }

/* ── composer ───────────────────────────────────────────────────────────── */
.comp { flex: none; padding: var(--pad-comp); }
.cin { max-width: var(--w-col); margin: 0 auto; border: var(--hair-in); border-radius: var(--r-comp);
  background: var(--fill-in); box-shadow: var(--sh-comp); overflow: hidden; }
.cin .tx { padding: var(--pad-tx); font-size: var(--fs-msg); color: var(--ink-3); min-height: var(--h-tx); }
.cbar { display: flex; align-items: center; gap: 6px; padding: var(--pad-cbar); }
.cbar .sp { flex: 1; }
.send { width: var(--h-ctl); height: var(--h-ctl); border-radius: var(--r-send); background: var(--accent);
  color: var(--accent-ink); display: grid; place-items: center; font-size: 12px; }
.hint { font: var(--f-meta); color: var(--ink-3); }

/* ── right panel ────────────────────────────────────────────────────────── */
.rp { width: var(--w-rp); flex: none; background: var(--chrome-sb); border: var(--hair-sb);
  border-radius: var(--r-panel); padding: var(--pad-sb); display: flex; flex-direction: column; gap: 9px; overflow: hidden; }
.rp .rh { display: flex; align-items: center; font-size: var(--fs-ctl); color: var(--ink); font-weight: 550; }
.rp .rh .n { margin-left: auto; font: var(--f-meta); }
.rp .rh .n .p { color: var(--ok); } .rp .rh .n .m { color: var(--err); margin-left: 5px; }
.fr { display: flex; align-items: center; gap: 8px; padding: var(--pad-row); border-radius: var(--r-ctl);
  font: var(--f-meta); color: var(--ink-2); }
.fr .f { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr .n { margin-left: auto; flex: none; }
.fr .n .p { color: var(--ok); } .fr .n .m { color: var(--err); margin-left: 5px; }
.rp .sub { font: var(--f-grp); letter-spacing: var(--tr-grp); text-transform: var(--case-grp);
  color: var(--ink-3); padding: var(--pad-grp); }
.rp pre { font: var(--f-pre); background: var(--fill-pre); border-radius: var(--r-card);
  padding: 8px 0; white-space: normal; overflow: hidden; }
.rp pre > span { display: block; padding: 0 10px; white-space: pre; }
.rp .a { background: var(--add-bg); color: var(--ok); }
.rp .d { background: var(--del-bg); color: var(--err); }
.rp .c { color: var(--ink-3); }
.rp .foot2 { margin-top: auto; display: flex; gap: 6px; }
.rp .foot2 .b { flex: 1; height: var(--h-btn); border: var(--hair); border-radius: var(--r-ctl);
  display: grid; place-items: center; font-size: var(--fs-ctl); color: var(--ink-2); }
.rp .foot2 .b.go { background: var(--accent); border-color: transparent; color: var(--accent-ink); font-weight: 550; }

/* ── grid of panes ──────────────────────────────────────────────────────── */
.stack { flex: 1; display: flex; flex-direction: column; gap: var(--gap-body); min-width: 0; }
.prow { flex: 1; display: flex; gap: var(--gap-body); min-height: 0; min-width: 0; }
.main.q .thread { padding: var(--pad-thread-q); }
.main.q .comp { padding: var(--pad-comp-q); }
.main.q { min-width: 0; }
.main.dim { opacity: 0.72; }
"""

# ───────────────────────────────────────────────────────────────────────────
# The four languages. This block IS the round — everything else is identical.
# ───────────────────────────────────────────────────────────────────────────

LANG_INSTRUMENT = """
  /* today's treatment: 3px, solid hairlines, mono chrome, no depth */
  --r-win: 6px; --r-panel: 3px; --r-ctl: 3px; --r-card: 3px; --r-bub: 3px;
  --r-comp: 3px; --r-code: 2px; --r-send: 3px;
  --hair: 1px solid var(--line); --hair-top: 1px solid var(--line);
  --hair-sb: 1px solid var(--line); --hair-main: 1px solid var(--line);
  --hair-mh: 1px solid var(--line); --hair-in: 1px solid var(--line-2);
  --hair-ico: 1px solid var(--line); --hair-user: 1px solid var(--line);
  --h-top: 44px; --h-mh: 28px; --h-ctl: 22px; --h-btn: 26px; --h-tx: 42px;
  --pad-top: 11px; --pad-body: 9px; --gap-body: 9px; --pad-sb: 0px; --pad-mh: 9px;
  --pad-thread: 11px 12px; --pad-thread-q: 10px; --pad-comp: 0 9px 8px; --pad-comp-q: 0 8px 7px;
  --pad-tx: 8px 10px; --pad-cbar: 3px 4px 4px; --pad-bub: 6px 9px; --pad-card: 7px 9px;
  --pad-step: 5px 8px; --pad-row: 5px 10px; --pad-grp: 9px 10px 5px; --pad-ctl: 9px; --pad-code: 1px 4px;
  --gap-msg: 9px; --w-sb: 194px; --w-col: 100%; --w-rp: 320px;
  --fs-msg: 13px; --fs-ctl: 11px; --fs-meta: 11px; --fs-row: 11.5px; --fs-title: 12px; --w-title: 600;
  --f-grp: 10px var(--mono); --tr-grp: 0.11em; --case-grp: uppercase;
  --f-meta: 10.5px var(--mono); --f-code: 11.5px var(--mono); --f-pre: 10.5px/1.55 var(--mono);
  --fill-ctl: transparent; --fill-ico: transparent; --fill-in: var(--well); --fill-on: var(--well);
  --fill-card: var(--well); --fill-pre: var(--well); --fill-user: var(--well); --fill-code: var(--well);
  --chrome-top: var(--chrome); --chrome-sb: var(--chrome); --chrome-main: var(--chrome);
  --sh-win: none; --sh-comp: none;"""

LANG_MEASURED = """
  /* T3 Code's own numbers: radius .625rem, controls .5rem, alpha hairlines
     at 6% (inputs 8%), a 52px topbar, a 768px column, computed lifts */
  --r-win: 10px; --r-panel: 10px; --r-ctl: 8px; --r-card: 10px; --r-bub: 10px;
  --r-comp: 12px; --r-code: 5px; --r-send: 8px;
  --hair: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  --hair-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  --hair-sb: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  --hair-main: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  --hair-mh: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  --hair-in: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  --hair-ico: 1px solid transparent; --hair-user: 1px solid transparent;
  --h-top: 52px; --h-mh: 40px; --h-ctl: 30px; --h-btn: 34px; --h-tx: 52px;
  --pad-top: 14px; --pad-body: 8px; --gap-body: 8px; --pad-sb: 8px; --pad-mh: 14px;
  --pad-thread: 20px 22px; --pad-thread-q: 14px; --pad-comp: 0 22px 18px; --pad-comp-q: 0 14px 12px;
  --pad-tx: 13px 15px; --pad-cbar: 0 9px 9px; --pad-bub: 11px 15px; --pad-card: 12px 14px;
  --pad-step: 10px 13px; --pad-row: 7px 10px; --pad-grp: 12px 10px 5px; --pad-ctl: 11px; --pad-code: 2px 5px;
  --gap-msg: 16px; --w-sb: 252px; --w-col: 768px; --w-rp: 328px;
  --fs-msg: 14px; --fs-ctl: 12.5px; --fs-meta: 12.5px; --fs-row: 13px; --fs-title: 13.5px; --w-title: 550;
  --f-grp: 11px var(--sans); --tr-grp: 0.01em; --case-grp: none;
  --f-meta: 12px var(--mono); --f-code: 12.5px var(--mono); --f-pre: 11.5px/1.6 var(--mono);
  --fill-ctl: transparent; --fill-ico: transparent;
  --fill-in: color-mix(in srgb, var(--ink) 4%, var(--chrome));
  --fill-on: color-mix(in srgb, var(--ink) 7%, transparent);
  --fill-card: color-mix(in srgb, var(--ink) 3%, transparent);
  --fill-pre: color-mix(in srgb, var(--ink) 3%, transparent);
  --fill-user: color-mix(in srgb, var(--accent) 22%, transparent);
  --fill-code: color-mix(in srgb, var(--ink) 7%, transparent);
  --chrome-top: var(--bg); --chrome-sb: var(--chrome); --chrome-main: var(--chrome);
  --sh-win: none; --sh-comp: 0 1px 2px oklch(0% 0 0 / 0.20);"""

LANG_AIR = """
  /* further: 16px radii, no hairline between regions at all — surfaces are
     separated by fill and space only — 15px prose, a floating composer */
  --r-win: 12px; --r-panel: 16px; --r-ctl: 10px; --r-card: 14px; --r-bub: 16px;
  --r-comp: 18px; --r-code: 6px; --r-send: 999px;
  --hair: 1px solid transparent; --hair-top: 0px solid transparent;
  --hair-sb: 1px solid transparent; --hair-main: 1px solid transparent;
  --hair-mh: 0px solid transparent; --hair-in: 1px solid transparent;
  --hair-ico: 1px solid transparent; --hair-user: 1px solid transparent;
  --h-top: 58px; --h-mh: 44px; --h-ctl: 32px; --h-btn: 38px; --h-tx: 58px;
  --pad-top: 18px; --pad-body: 12px; --gap-body: 12px; --pad-sb: 12px; --pad-mh: 18px;
  --pad-thread: 26px 26px; --pad-thread-q: 16px; --pad-comp: 0 26px 22px; --pad-comp-q: 0 16px 14px;
  --pad-tx: 15px 18px; --pad-cbar: 0 11px 11px; --pad-bub: 13px 18px; --pad-card: 15px 17px;
  --pad-step: 12px 15px; --pad-row: 9px 12px; --pad-grp: 14px 12px 6px; --pad-ctl: 13px; --pad-code: 2px 6px;
  --gap-msg: 22px; --w-sb: 268px; --w-col: 720px; --w-rp: 336px;
  --fs-msg: 15px; --fs-ctl: 13px; --fs-meta: 13px; --fs-row: 13.5px; --fs-title: 14px; --w-title: 550;
  --f-grp: 11.5px var(--sans); --tr-grp: 0.01em; --case-grp: none;
  --f-meta: 12.5px var(--mono); --f-code: 13px var(--mono); --f-pre: 12px/1.65 var(--mono);
  --fill-ctl: color-mix(in srgb, var(--ink) 6%, transparent);
  --fill-ico: color-mix(in srgb, var(--ink) 6%, transparent);
  --fill-in: var(--chrome); --fill-on: color-mix(in srgb, var(--ink) 9%, transparent);
  --fill-card: color-mix(in srgb, var(--ink) 4%, transparent);
  --fill-pre: color-mix(in srgb, var(--ink) 4%, transparent);
  --fill-user: color-mix(in srgb, var(--accent) 26%, transparent);
  --fill-code: color-mix(in srgb, var(--ink) 8%, transparent);
  --chrome-top: var(--bg); --chrome-sb: color-mix(in srgb, var(--ink) 3%, var(--bg)); --chrome-main: var(--chrome);
  --sh-win: none; --sh-comp: 0 6px 22px oklch(0% 0 0 / 0.26);"""

LANG_CONSOLE = """
  /* modern treatment kept dense enough for four panes: 8px radii, alpha
     hairlines, 13px prose, tight pads — the rounded-but-working middle */
  --r-win: 8px; --r-panel: 8px; --r-ctl: 6px; --r-card: 8px; --r-bub: 8px;
  --r-comp: 10px; --r-code: 4px; --r-send: 6px;
  --hair: 1px solid color-mix(in srgb, var(--ink) 9%, transparent);
  --hair-top: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  --hair-sb: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  --hair-main: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  --hair-mh: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  --hair-in: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  --hair-ico: 1px solid transparent; --hair-user: 1px solid transparent;
  --h-top: 44px; --h-mh: 32px; --h-ctl: 26px; --h-btn: 30px; --h-tx: 44px;
  --pad-top: 12px; --pad-body: 7px; --gap-body: 7px; --pad-sb: 7px; --pad-mh: 11px;
  --pad-thread: 14px 16px; --pad-thread-q: 11px; --pad-comp: 0 16px 13px; --pad-comp-q: 0 11px 10px;
  --pad-tx: 10px 12px; --pad-cbar: 0 7px 7px; --pad-bub: 8px 12px; --pad-card: 9px 11px;
  --pad-step: 7px 11px; --pad-row: 6px 9px; --pad-grp: 10px 9px 4px; --pad-ctl: 9px; --pad-code: 1px 5px;
  --gap-msg: 12px; --w-sb: 224px; --w-col: 920px; --w-rp: 300px;
  --fs-msg: 13px; --fs-ctl: 12px; --fs-meta: 11.5px; --fs-row: 12.5px; --fs-title: 12.5px; --w-title: 550;
  --f-grp: 10.5px var(--sans); --tr-grp: 0.01em; --case-grp: none;
  --f-meta: 11px var(--mono); --f-code: 11.5px var(--mono); --f-pre: 11px/1.55 var(--mono);
  --fill-ctl: transparent; --fill-ico: transparent;
  --fill-in: color-mix(in srgb, var(--ink) 4%, var(--chrome));
  --fill-on: color-mix(in srgb, var(--ink) 8%, transparent);
  --fill-card: color-mix(in srgb, var(--ink) 3.5%, transparent);
  --fill-pre: color-mix(in srgb, var(--ink) 3.5%, transparent);
  --fill-user: color-mix(in srgb, var(--accent) 24%, transparent);
  --fill-code: color-mix(in srgb, var(--ink) 8%, transparent);
  --chrome-top: var(--bg); --chrome-sb: var(--chrome); --chrome-main: var(--chrome);
  --sh-win: none; --sh-comp: 0 1px 3px oklch(0% 0 0 / 0.18);"""

# Extra roles the languages share — warn tints for the permission card.
COMMON = """
  --warn-line: color-mix(in srgb, var(--warn) 45%, transparent);
  --warn-fill: var(--gate-bg);"""


# ───────────────────────────────────────────────────────────────────────────
# Window builders. Arrangement is identical across the four files.
# ───────────────────────────────────────────────────────────────────────────

LIGHTS = '<div class="lights"><i></i><i></i><i></i></div>'


def topbar(quad=False):
    title = (
        '<div class="title">artemis<s>/</s>4 conversations</div>'
        if quad
        else '<div class="title">artemis<s>/</s>The sandbox lets a write escape</div>'
    )
    return f"""<div class="top">
      {LIGHTS}
      {title}
      <div class="sp"></div>
      <span class="pill"><b>Opus 5</b> 1M<span class="cv">▾</span></span>
      <span class="pill mode">Plan<span class="cv">▾</span></span>
      <span class="pill">storrence-dev<span class="cv">▾</span></span>
      <div class="ico">⌕</div><div class="ico">⚙</div>
    </div>"""


def sidebar():
    return f"""<div class="sb">
        <div class="newb">New conversation</div>
        <div class="srch">⌕ Search conversations</div>
        <div class="list">
            {sidebar_rows()}
        </div>
        <div class="me"><i></i>storrence-dev · 78% left</div>
      </div>"""


def composer(quad=False):
    bar = (
        '<div class="cbar"><span class="hint">⏎ send</span><div class="sp"></div>'
        '<div class="send">↑</div></div>'
        if quad
        else '<div class="cbar"><span class="pill">＋</span><span class="pill">@ files</span>'
        '<div class="sp"></div><span class="hint">⏎ send · ⇧⏎ newline</span>'
        '<div class="send">↑</div></div>'
    )
    return f"""<div class="comp"><div class="cin">
          <div class="tx">Re-derive scope at adoption, then cover the drag path…</div>
          {bar}
        </div></div>"""


def main_pane(thread, title=None, quad=False, dim=False, stat=True):
    q = " q" if quad else ""
    d = " dim" if dim else ""
    head = ""
    if title:
        st = (
            '<span class="st"><span class="p">+69</span><span class="m">−3</span></span>'
            if stat
            else ""
        )
        head = f'<div class="mh">{title}<div class="sp"></div>{st}</div>'
    return f"""<div class="main{q}{d}">
          {head}
          <div class="thread"><div class="col">
              {thread}
          </div></div>
          {composer(quad=quad)}
        </div>"""


def right_panel():
    return f"""<div class="rp">
          <div class="rh">Changes<span class="n"><span class="p">+69</span><span class="m">−3</span></span></div>
          <div>
            {changed_rows()}
          </div>
          <div class="sub">state/dock.ts</div>
          <pre><span class="c">  function adoptTab(tab, pane) {{</span>
<span class="d">-   return {{ ...tab, paneId: pane.id }}</span>
<span class="a">+   // a tab that changes hands re-derives</span>
<span class="a">+   // its scope; the one it arrived with</span>
<span class="a">+   // belonged to the pane it left.</span>
<span class="a">+   return {{ ...tab, paneId: pane.id,</span>
<span class="a">+     scopePath: scopeFor(pane.session) }}</span>
<span class="c">  }}</span></pre>
          <div class="foot2"><div class="b">Revert</div><div class="b go">Commit</div></div>
        </div>"""


def build_window(screen):
    if screen == "grid":
        return f"""<div class="win">{topbar(quad=True)}
    <div class="body">{sidebar()}
      <div class="stack">
        <div class="prow">
          {main_pane(THREAD_SHORT, title="sandbox escape", quad=True)}
          {main_pane(THREAD_SHORT, title="dock arrangement", quad=True, dim=True, stat=False)}
        </div>
        <div class="prow">
          {main_pane(THREAD_SHORT, title="setup wizard", quad=True, dim=True, stat=False)}
          {main_pane(THREAD_SHORT, title="capability flags", quad=True, dim=True, stat=False)}
        </div>
      </div>
    </div></div>"""
    if screen == "review":
        return f"""<div class="win">{topbar()}
    <div class="body">{sidebar()}
      {main_pane(THREAD_SAID, title="sandbox escape")}
      {right_panel()}
    </div></div>"""
    if screen == "focus":
        return f"""<div class="win">{topbar()}
    <div class="body">
      {main_pane(THREAD_SAID)}
    </div></div>"""
    return f"""<div class="win">{topbar()}
    <div class="body">{sidebar()}
      {main_pane(THREAD_FULL)}
    </div></div>"""


SCREENS = [
    ("work", "Work", "one conversation — the treatment at rest"),
    ("grid", "Grid", "four panes — does the treatment survive the capability"),
    ("review", "Review", "changed code beside the conversation"),
    ("focus", "Focus", "sidebar away, one column, nothing else"),
]

VARIANTS = [
    dict(
        slug="7a-instrument",
        kicker="7A · CONTROL — THE TREATMENT TODAY",
        title="Instrument",
        lang=LANG_INSTRUMENT,
        spec=[
            ("RADIUS", "val", "3px"),
            ("HAIRLINE", "val", "solid, everywhere"),
            ("TOP CHROME", "val", "44px + 28px"),
            ("PROSE", "val", "13px · column 100%"),
            ("CHROME LABELS", "val", "mono, uppercase"),
        ],
        lede=[
            "The treatment that ships today, applied to this round's arrangement so the variable really is the treatment. 3px radii, a solid hairline around every region, 11px uppercase mono for anything that is not prose, 22px controls, and depth deliberately deleted.",
            "It is an <b>instrument panel</b>, and it is a coherent one — round three chose it on purpose. The question this round asks is whether it is what Artemis should look like now.",
        ],
        wins=[
            "<b>Density.</b> Nothing on screen is bigger than it needs to be, which is why four panes fit without apology.",
            "<b>The hairline grid is honest.</b> Every region has a visible edge; nothing is ambiguous about where a surface starts.",
            "<b>It ships.</b> Zero conversion.",
        ],
        costs=[
            "<b>It reads as a tool from 2015.</b> The 3px radius plus solid hairlines plus uppercase mono chrome is the terminal-emulator idiom; against T3 Code, Codex or Claude Code it looks like a different generation of software.",
            "<b>The mono chrome shouts.</b> Uppercase 11px monospace at 0.14em is a strong voice used for ordinary labels — a lot of visual weight spent on words nobody reads twice.",
            "<b>No breathing room in the transcript.</b> 9px between messages and a full-width column means prose runs to whatever width the pane happens to be.",
        ],
    ),
    dict(
        slug="7b-measured",
        kicker="7B · T3 CODE, BY THE NUMBERS",
        title="Measured",
        lang=LANG_MEASURED,
        spec=[
            ("RADIUS", "val", "10px · controls 8px"),
            ("HAIRLINE", "val", "alpha 6% · inputs 10%"),
            ("TOP CHROME", "val", "52px, one bar"),
            ("PROSE", "val", "14px · column 768px"),
            ("CHROME LABELS", "val", "sans, sentence case"),
        ],
        lede=[
            "<b>T3 Code's own numbers, not an impression of them.</b> Radius <code>0.625rem</code> with controls at <code>0.5rem</code>; hairlines as alpha rather than a grey step — 6% of the ink colour, 10% on inputs; one 52px topbar instead of a 44px header plus a 28px pane bar; the transcript on a 768px column; surfaces as computed lifts of the canvas. Read from their <code>index.css</code> via <code>docs/research/T3-DESIGN-RESEARCH.md</code> §1.2.",
            "Chrome stops being mono. Group headings, control labels and hints are sans in sentence case; monospace is kept for what is actually code. That single change removes most of what reads as «terminal app».",
        ],
        wins=[
            "<b>It is the ask, measured.</b> Nothing here is a guess about what modern looks like — it is the reference's geometry with our palette in it.",
            "<b>Alpha hairlines stop the boxes shouting.</b> A 6% edge separates surfaces without drawing a grid over the whole window; regions read as areas, not cells.",
            "<b>A 768px column makes prose readable</b> and gives the transcript a shape at any window width — today it is whatever the pane is.",
            "<b>One 52px bar replaces two.</b> Fewer horizontal rules, more room, and the title finally has somewhere to live at a real size.",
        ],
        costs=[
            "<b>It costs vertical and horizontal budget.</b> 30px controls, 16px between messages and 20px thread padding is a lot of space to spend when four panes are on screen — see the grid screen before judging.",
            "<b>Alpha borders are weaker in light mode.</b> 6% of a dark ink on paper is close to invisible; the light pass leans on fill differences that the dark pass gets for free.",
            "<b>A 768px column wastes a wide pane.</b> On a 1400px window in single-pane, roughly half the width is margin — deliberate in a chat app, arguable in a work tool.",
        ],
    ),
    dict(
        slug="7c-air",
        kicker="7C · BRACKET, FURTHER",
        title="Air",
        lang=LANG_AIR,
        spec=[
            ("RADIUS", "val", "16px · pill send"),
            ("HAIRLINE", "val", "none — fill only"),
            ("TOP CHROME", "val", "58px, borderless"),
            ("PROSE", "val", "15px · column 720px"),
            ("CHROME LABELS", "val", "sans, sentence case"),
        ],
        lede=[
            "The same direction taken one notch past T3 Code, so the judging picks a point on a line instead of approving the only point shown. 16px radii, <b>no hairline anywhere</b> — regions are separated by fill and space alone — 15px prose, 22px between messages, and a composer that floats on a real shadow.",
            "This is the consumer-app end of the range: closer to T3 Chat than to T3 Code. If 7B still reads as too tight, this is where it goes; if this reads as a toy, 7B is vindicated.",
        ],
        wins=[
            "<b>The calmest of the four.</b> With no borders at all, the eye has nothing to do except read the conversation.",
            "<b>Big hit targets.</b> 32–38px controls are comfortable with a trackpad and forgiving on a laptop.",
            "<b>It brackets 7B from the roomy side</b>, which is the only way to know whether 7B is the right amount of modern rather than merely more than today.",
        ],
        costs=[
            "<b>Four panes stop working.</b> At 22px message gaps and 26px padding a quarter-window pane shows perhaps two messages — this is the variant the grid screen is most likely to disqualify.",
            "<b>Removing every hairline removes the pane boundary too.</b> With no edges, two adjacent conversations are told apart only by a fill step, and which one is focused becomes genuinely hard to say.",
            "<b>Depth comes back.</b> The floating composer needs a shadow to read, which reopens a decision round three closed deliberately.",
        ],
    ),
    dict(
        slug="7d-console",
        kicker="7D · MODERN, AT WORKING DENSITY",
        title="Console",
        lang=LANG_CONSOLE,
        spec=[
            ("RADIUS", "val", "8px · controls 6px"),
            ("HAIRLINE", "val", "alpha 7% · inputs 12%"),
            ("TOP CHROME", "val", "44px + 32px"),
            ("PROSE", "val", "13px · column 920px"),
            ("CHROME LABELS", "val", "sans, sentence case"),
        ],
        lede=[
            "<b>The middle, and probably the honest answer.</b> Every modern move from 7B — rounded corners, alpha hairlines, sans chrome in sentence case, computed surface lifts, a real composer card — at a density that still fits four conversations on a laptop. 8px radii instead of 10, 26px controls instead of 30, 12px message gaps instead of 16, a 920px column instead of 768.",
            "The claim: what makes today's app look dated is the 3px radius, the solid grid of hairlines and the uppercase mono — not the density. Fix the treatment, keep the compactness, and Artemis is a modern tool that is still a multi-pane harness.",
        ],
        wins=[
            "<b>It survives the grid screen</b>, which is the test 7C fails and 7B strains against. Compare the grid screens across all four before deciding.",
            "<b>It gets the whole modern vocabulary</b> — rounded surfaces, soft alpha edges, sans chrome, a composer that reads as a card — without spending the space that vocabulary usually costs.",
            "<b>Least risky conversion.</b> Radius, border, fill and label case are token-level changes; the pane geometry and every fixed height barely move.",
        ],
        costs=[
            "<b>It is a compromise, and compromises can read as unresolved.</b> Beside 7B it will look slightly tight; beside 7A slightly loose. Nobody's favourite, possibly everybody's second choice.",
            "<b>920px is not a considered column, it is a bigger one.</b> If the reading measure matters it should be argued, and 7B argues it.",
            "<b>Still two bars.</b> Keeping a 44px topbar plus a 32px pane header preserves the thing 7B's single 52px bar removes.",
        ],
    ),
]

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
<title>{title} — round seven, the surface</title>
<style>
{fonts}
/* ── {title}. Round seven: the surface treatment.
   Round six varied the arrangement and held the treatment — the wrong way
   round, because the treatment is what makes an app look modern. Here the
   arrangement is identical in all four files and the language block below
   is the only thing that differs.
   Colour is round five's verdict, imported from _seed_build.py.
   To change this file: python3 docs/design/_round7_build.py
   ─────────────────────────────────────────────────────────────────────── */
:root {{
{dark}
{common}
{lang}
  --sans: 'Archivo', ui-sans-serif, system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  --fs: 13px;
}}
html.light {{
{light}
}}
{base}
</style>
</head>
<body>
<div class="page">
  <a class="back" href="index.html">← the design record</a>
  <div class="vnav">{vnav}</div>
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
    <div class="fitnote"></div>
  </div>
{screens}
  <div class="foot">
    <div class="box"><h3>What this treatment buys</h3><ul>
{wins}
    </ul></div>
    <div class="box"><h3 class="cost">What it costs</h3><ul>
{costs}
    </ul></div>
  </div>
</div>
{js}
</body>
</html>
"""

FONTS = (
    "@import url('https://fonts.googleapis.com/css2?"
    "family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');"
)


def spec_html(spec):
    return "\n".join(
        f'    <div class="col"><div class="lab">{label}</div><div class="val">{val}</div></div>'
        for label, _, val in spec
    )


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
            f'<div class="scap"><b>{label}</b> — {cap}</div>{build_window(key)}</div>'
            for i, (key, label, cap) in enumerate(SCREENS)
        )
        html = TEMPLATE.format(
            title=v["title"],
            kicker=v["kicker"],
            fonts=FONTS,
            dark=S.tokens_css(DARK, "dark"),
            light=S.tokens_css(LIGHT, "light"),
            common=COMMON,
            lang=v["lang"],
            base=BASE,
            vnav=vnav,
            lede="\n".join(f'  <p class="note">{p}</p>' for p in v["lede"]),
            spec=spec_html(v["spec"]),
            screenbtns=screenbtns,
            screens=screens,
            wins="\n".join(f"      <li>{w}</li>" for w in v["wins"]),
            costs="\n".join(f"      <li>{c}</li>" for c in v["costs"]),
            js=SWITCH_JS,
        )
        (OUT / f'{v["slug"]}.html').write_text(html)
        print(f'wrote {v["slug"]}.html')


if __name__ == "__main__":
    build()
