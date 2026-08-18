#!/usr/bin/env python3
"""Generate the round-three design-language mockups.

Round two settled the layout. These four vary only the *language* laid over it,
so the layout markup and every structural rule live here once and are emitted
byte-identical into all four files. Anything you can see differing between them
is the language block and nothing else.

    python3 docs/design/_build.py

Writes 1-sheet.html, 2-slab.html, 3-ink.html, 4-signal.html next to this file.
"""

import pathlib

OUT = pathlib.Path(__file__).parent

# ───────────────────────────────────────────────────────────────────────────
# Structural CSS. Geometry only — every colour, face, radius and weight comes
# from a variable a direction sets. Nothing here may differ between files.
# ───────────────────────────────────────────────────────────────────────────
BASE = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--void); color: var(--ink); font: var(--fs)/1.55 var(--sans); padding: 26px; -webkit-font-smoothing: antialiased; }
.page { max-width: 1400px; margin: 0 auto; }
h1 { font-size: 21px; font-weight: var(--w-hi); letter-spacing: var(--tr-hi); margin-bottom: 7px; font-family: var(--display); }
.kicker { font: 10.5px var(--mono); letter-spacing: 0.16em; color: var(--ink-3); margin-bottom: 6px; }
.note { color: var(--ink-2); font-size: 13.5px; max-width: 80ch; margin-bottom: 5px; }
.note b { color: var(--ink); font-weight: var(--w-hi); }
a.back { color: var(--accent); text-decoration: none; font: 11px var(--mono); }

/* the specimen strip: the language stated, not just shown */
.spec { display: flex; gap: 22px; flex-wrap: wrap; align-items: flex-start; margin: 16px 0 4px; padding: 13px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.spec .col { display: flex; flex-direction: column; gap: 5px; }
.spec .lab { font: 9.5px var(--mono); letter-spacing: 0.13em; color: var(--ink-3); }
.spec .sw { display: flex; gap: 3px; }
.spec .sw i { width: 26px; height: 15px; display: block; border: 1px solid var(--line); }
.spec .val { font: 10.5px var(--mono); color: var(--ink-2); }
.spec .big { font-family: var(--display); font-size: 20px; font-weight: var(--w-hi); letter-spacing: var(--tr-hi); color: var(--ink); }
.spec .mid { font-size: 13px; color: var(--ink-2); }
.spec .mn { font: 11.5px var(--mono); color: var(--ink-2); }

/* ── the window ─────────────────────────────────────────────────────────── */
.win { margin-top: 18px; width: 1400px; height: 1000px; flex: none; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-win); overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--sh-win); }
.hdr { height: 36px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 11px; background: var(--chrome); border-bottom: 1px solid var(--line); }
.lights { display: flex; gap: 6px; margin-right: 4px; }
.lights i { width: 10px; height: 10px; border-radius: 50%; background: var(--line-2); display: block; }
.icon { width: 22px; height: 22px; border: 1px solid var(--line); border-radius: var(--r-sm); display: grid; place-items: center; color: var(--ink-2); font-size: 11px; }
.crumb { font-size: 12px; color: var(--ink-2); }
.crumb b { color: var(--ink); font-weight: var(--w-hi); }
.crumb span { color: var(--ink-3); margin: 0 5px; }
.hdr .right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.ctx { display: flex; align-items: center; gap: 6px; font: 10.5px var(--mono); color: var(--warn); }
.ctxbar { width: 54px; height: 4px; border-radius: 2px; background: var(--well); overflow: hidden; }
.ctxbar i { display: block; height: 100%; width: 78%; background: var(--warn); }
.body { flex: 1; display: flex; min-height: 0; padding: var(--gap); gap: var(--gap); }

/* ── sidebar ────────────────────────────────────────────────────────────── */
.side { width: 194px; flex: none; display: flex; flex-direction: column; gap: var(--gap); }
.card { background: var(--chrome); border: 1px solid var(--line); border-radius: var(--r); }
.side .top { padding: 8px; display: flex; gap: 6px; }
.newbtn { flex: 1; height: 26px; border-radius: var(--r-sm); background: var(--accent); color: var(--accent-ink); font-size: 11.5px; font-weight: var(--w-hi); display: grid; place-items: center; letter-spacing: var(--tr-ui); }
.proj { font: 10px var(--mono); letter-spacing: 0.11em; color: var(--ink-3); padding: 9px 10px 5px; display: flex; justify-content: space-between; }
.sess { padding: 5px 10px; display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--ink-2); border-left: 2px solid transparent; }
.sess.on { background: var(--well); color: var(--ink); border-left-color: var(--accent); }
.sess .dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: var(--line-2); }
.sess .dot.run { background: var(--tool); }
.sess .dot.gate { background: var(--warn); }
.sess .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .ago { margin-left: auto; font: 9.5px var(--mono); color: var(--ink-3); }
.upd { padding: 9px 10px; }
.upd .a { font-size: 11px; color: var(--ink); }
.upd .b { font: 10px var(--mono); color: var(--ink-3); margin-top: 3px; }

/* ── working area ───────────────────────────────────────────────────────── */
.work { flex: 1; display: flex; gap: var(--gap); min-width: 0; }
.grid { flex: 1; display: flex; gap: var(--gap); min-width: 0; }
.pane { flex: 1; min-width: 0; background: var(--chrome); border: 1px solid var(--line); border-radius: var(--r); display: flex; flex-direction: column; overflow: hidden; }
.pane.focus { border-color: var(--line-2); }
.ph { height: 28px; flex: none; display: flex; align-items: center; gap: 7px; padding: 0 9px; border-bottom: 1px solid var(--line); font-size: 11px; color: var(--ink-2); background: var(--ph-bg); }
.pane.focus .ph { color: var(--ink); }
.ph .x { margin-left: auto; color: var(--ink-3); }
.scroll { flex: 1; overflow: hidden; padding: 11px 12px; display: flex; flex-direction: column; gap: 9px; position: relative; }
.scroll > * { flex: none; }
.scroll.btm { justify-content: flex-end; }
.fade { position: absolute; inset: 0 0 auto; height: 22px; background: linear-gradient(var(--chrome), transparent); z-index: 2; }

/* ── transcript grammar ─────────────────────────────────────────────────── */
.turn { font: 9.5px var(--mono); color: var(--ink-3); letter-spacing: 0.09em; display: flex; align-items: center; gap: 7px; }
.turn::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.you { color: var(--ink); font-size: 13px; }
.said { color: var(--ink-2); font-size: 13px; font-family: var(--prose); line-height: var(--lh-prose); }
.said b { color: var(--ink); font-weight: var(--w-hi); }
.inline { font: 11.5px var(--mono); color: var(--tool); background: var(--well); padding: 1px 4px; border-radius: 2px; }
.think { font-size: 11.5px; color: var(--think); display: flex; gap: 7px; align-items: baseline; }
.think .chev { font-size: 9px; }
.think .txt { font-style: italic; }

.tool { border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; background: var(--well); }
.tool .bar { display: flex; align-items: center; gap: 8px; padding: 5px 8px; font: 11px var(--mono); background: var(--bar); }
.tool .bar .k { color: var(--tool); }
.tool .bar .a { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool .bar .r { margin-left: auto; font-size: 10px; color: var(--ink-3); flex: none; }
.tool .bar .r.bad { color: var(--err); }
.tool .bar .r.ok { color: var(--ok); }
.tool pre { padding: 7px 9px; font: 10.5px/1.5 var(--mono); color: var(--ink-2); overflow: hidden; white-space: pre; }
.tool pre .em { color: var(--err); }
.tool pre .dim { color: var(--ink-3); }
.tool pre .hit { color: var(--ink); }
.more { padding: 4px 9px; font: 10px var(--mono); color: var(--ink-3); border-top: 1px solid var(--line); }

.diff { border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
.diff .bar { display: flex; align-items: center; gap: 8px; padding: 5px 8px; font: 11px var(--mono); background: var(--bar); }
.diff .bar .f { color: var(--ink); }
.diff .bar .n { margin-left: auto; font-size: 10px; }
.diff .bar .n .p { color: var(--ok); }
.diff .bar .n .m { color: var(--err); margin-left: 6px; }
.diff pre { font: 10.5px/1.55 var(--mono); background: var(--well); overflow: hidden; }
.diff pre span { display: block; padding: 0 9px; white-space: pre; }
.diff .add { background: var(--add-bg); color: var(--ok); }
.diff .del { background: var(--del-bg); color: var(--err); }
.diff .ctxl { color: var(--ink-3); }

.todo { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 7px 9px; background: var(--well); }
.todo .h { font: 10px var(--mono); letter-spacing: 0.11em; color: var(--ink-3); margin-bottom: 5px; }
.todo li { list-style: none; font-size: 11.5px; color: var(--ink-3); display: flex; gap: 7px; padding: 1.5px 0; }
.todo li.done { text-decoration: line-through; }
.todo li.now { color: var(--ink); }
.todo li .m { width: 10px; flex: none; font: 10px var(--mono); }
.todo li.done .m { color: var(--ok); }
.todo li.now .m { color: var(--warn); }

.dele { display: flex; gap: 7px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); border-radius: var(--r-pill); padding: 3px 9px 3px 7px; font: 10.5px var(--mono); color: var(--ink-2); display: flex; align-items: center; gap: 6px; background: var(--well); }
.chip i { width: 5px; height: 5px; border-radius: 50%; background: var(--dele); display: block; }
.chip.done i { background: var(--ok); }

.gate { border: 1px solid var(--warn); border-radius: var(--r-sm); background: var(--gate-bg); overflow: hidden; }
.gate .h { padding: 6px 9px; font: 10px var(--mono); letter-spacing: 0.11em; color: var(--warn); display: flex; gap: 7px; align-items: center; }
.gate .cmd { padding: 0 9px 7px; font: 11.5px var(--mono); color: var(--ink); }
.gate .why { padding: 0 9px 8px; font-size: 11.5px; color: var(--ink-2); }
.gate .why b { color: var(--warn); font-weight: var(--w-hi); }
.gate .row { display: flex; gap: 6px; padding: 0 9px 8px; }
.btn { border: 1px solid var(--line-2); border-radius: var(--r-sm); padding: 4px 10px; font-size: 11px; color: var(--ink-2); }
.btn.go { background: var(--warn); border-color: var(--warn); color: var(--warn-ink); font-weight: var(--w-hi); }
.btn .k { font: 9.5px var(--mono); opacity: 0.65; margin-left: 5px; }

.comp { flex: none; margin: 0 9px 8px; border: 1px solid var(--line-2); border-radius: var(--r-sm); background: var(--well); }
.comp .in { padding: 8px 10px; font-size: 12.5px; color: var(--ink-3); min-height: 42px; }
.status { display: flex; align-items: center; padding: 0 3px 3px; font: 10px var(--mono); color: var(--ink-3); flex-wrap: wrap; }
.status s { text-decoration: none; padding: 2px 6px; border-radius: 2px; }
.status s.hot { color: var(--ink-2); }
.status s.mode { color: var(--warn); }
.status .sep { color: var(--line-2); }
.status .send { margin-left: auto; color: var(--accent); }

/* ── dock ───────────────────────────────────────────────────────────────── */
.dock { width: 320px; flex: none; background: var(--chrome); border: 1px solid var(--line); border-radius: var(--r); display: flex; flex-direction: column; overflow: hidden; }
.dock .tabs { height: 28px; flex: none; display: flex; align-items: stretch; border-bottom: 1px solid var(--line); background: var(--ph-bg); }
.dock .tabs d { display: flex; align-items: center; gap: 6px; padding: 0 10px; font-size: 11px; color: var(--ink-3); border-right: 1px solid var(--line); }
.dock .tabs d.on { color: var(--ink); background: var(--chrome); box-shadow: inset 0 -1px 0 var(--accent); }
.dock .fv { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.dock .fvh { padding: 5px 9px; font: 10px var(--mono); color: var(--ink-3); border-bottom: 1px solid var(--line); display: flex; }
.dock .fvh .g { margin-left: auto; color: var(--ok); }
.dock pre { flex: 1; font: 10.5px/1.6 var(--mono); padding: 6px 0; overflow: hidden; background: var(--well); }
.dock pre span { display: block; padding: 0 9px 0 0; white-space: pre; }
.dock pre .ln { display: inline-block; width: 30px; text-align: right; margin-right: 9px; color: var(--ink-3); opacity: 0.6; font-style: normal; }
.kw { color: var(--syn-kw); } .st { color: var(--syn-st); } .fn { color: var(--syn-fn); }
.cm { color: var(--ink-3); } .nu { color: var(--syn-nu); }

/* ── annotation ─────────────────────────────────────────────────────────── */
.fitnote { font: 10.5px var(--mono); color: var(--ink-3); margin-top: 9px; }
.fitnote b { color: var(--ink-2); font-weight: 400; }
.foot { margin-top: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.box { border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; background: var(--chrome); }
.box h3 { font-size: 12px; margin-bottom: 8px; color: var(--ink); font-weight: var(--w-hi); font-family: var(--display); letter-spacing: var(--tr-ui); }
.box h3.cost { color: var(--warn); }
.box li, .box p { font-size: 13px; color: var(--ink-2); }
.box ul { margin-left: 15px; }
.box li { margin-bottom: 5px; }
.box b { color: var(--ink); font-weight: var(--w-hi); }
"""

# ───────────────────────────────────────────────────────────────────────────
# The window. Identical in all four — this string is emitted verbatim.
# ───────────────────────────────────────────────────────────────────────────
WINDOW = """
  <div class="win">
    <div class="hdr">
      <div class="lights"><i></i><i></i><i></i></div>
      <div class="icon">◧</div>
      <div class="crumb"><b>artemis</b><span>›</span>The sandbox lets a write escape</div>
      <div class="right">
        <div class="ctx">78%<div class="ctxbar"><i></i></div></div>
        <div class="icon">⊞</div><div class="icon">+</div><div class="icon">⚙</div>
      </div>
    </div>
    <div class="body">
      <div class="side">
        <div class="card">
          <div class="top"><div class="newbtn">+ New session</div><div class="icon">◧</div></div>
          <div class="proj"><span>ARTEMIS</span><span>22</span></div>
          <div class="sess on"><i class="dot gate"></i><span class="t">The sandbox lets a write escape</span><span class="ago">now</span></div>
          <div class="sess"><i class="dot run"></i><span class="t">Dock remembers its arrangement</span><span class="ago">4m</span></div>
          <div class="sess"><i class="dot"></i><span class="t">Probe the capability flags</span><span class="ago">1h</span></div>
          <div class="sess"><i class="dot"></i><span class="t">OpenCode model configurator</span><span class="ago">3h</span></div>
          <div class="proj"><span>CEREBRO</span><span>4</span></div>
          <div class="sess"><i class="dot run"></i><span class="t">Setup wizard for any bank</span><span class="ago">now</span></div>
          <div class="sess"><i class="dot"></i><span class="t">Local-only bank, no remote</span><span class="ago">2d</span></div>
        </div>
        <div class="card upd">
          <div class="a">↓ 0.21.0 available</div>
          <div class="b">restart to install</div>
        </div>
      </div>

      <div class="work">
        <div class="grid">
          <div class="pane focus">
            <div class="ph"><span class="pd gate">◆</span> artemis › sandbox escape <span class="x">✕</span></div>
            <div class="scroll btm">
              <div class="fade"></div>
              <div class="turn">TURN 24</div>
              <div class="you">it says the write succeeded — that's the bug, not the test</div>
              <div class="think"><span class="chev">▾</span><span class="txt">Thought for 8s — the check writes to a path under /var/folders, and the profile allows that subpath wholesale…</span></div>
              <div class="tool">
                <div class="bar"><span class="k">shell</span><span class="a">pnpm sandbox:check</span><span class="r bad">exit 1 · 4.2s</span></div>
                <pre> FAIL  src/adapters/local/sandbox.check.ts &gt; escape is refused
<span class="em">AssertionError: expected 'written' to be 'refused'</span>
  ❯ src/adapters/local/sandbox.check.ts:71:5
<span class="dim">     70|
     71|   expect(out.status).toBe('refused')
       |   ^
  ❯ processTicksAndRejections node:internal/…:95:5</span>
       Tests  <span class="em">1 failed</span> | 12 passed (13)</pre>
              </div>
              <div class="said">The profile allows <span class="inline">/private/var/folders</span> as a subpath. macOS puts <b>every</b> per-user temporary directory under there, so the rule makes another application's scratch space writable.</div>
              <div class="tool">
                <div class="bar"><span class="k">search</span><span class="a">rg "var/folders" --type ts</span><span class="r">40 hits</span></div>
                <pre><span class="hit">local/commandSandbox.ts</span><span class="dim">:118</span>  '(allow file-write* (subpath "/private/var/folders"))',
<span class="hit">local/commandSandbox.ts</span><span class="dim">:119</span>  '(allow file-write* (subpath "/private/tmp"))',
<span class="hit">local/sandbox.test.ts</span><span class="dim">:44</span>       const scratch = mkdtempSync(join(tmpdir(), 'a-'))</pre>
                <div class="more">… 37 more · ⌘⏎ to open all in the dock</div>
              </div>
              <div class="turn">TURN 26</div>
              <div class="diff">
                <div class="bar"><span class="f">commandSandbox.ts</span><span class="n"><span class="p">+6</span><span class="m">−3</span></span></div>
                <pre><span class="ctxl">@@ -114,9 +114,12 @@ function profile(writableRoots, scratch) {</span>
<span class="del">-    '(allow file-write* (subpath "/private/tmp"))',</span>
<span class="del">-    '(allow file-write* (subpath "/private/var/folders"))',</span>
<span class="del">-    ...writableRoots.map((r) =&gt; allow(r)),</span>
<span class="add">+    // Exactly the roots handed in, and nothing else. The blanket</span>
<span class="add">+    // /var/folders rule let a command escape the workspace.</span>
<span class="add">+    ...writableRoots.map(</span>
<span class="add">+      (root) =&gt; `(allow file-write* (subpath "${esc(root)}"))`,</span>
<span class="add">+    ),</span>
<span class="ctxl">   ].join('\\n')</span></pre>
              </div>
              <div class="todo">
                <div class="h">TODO · REWRITTEN THIS TURN</div>
                <ul>
                  <li class="done"><span class="m">✓</span>reproduce the escape</li>
                  <li class="done"><span class="m">✓</span>find which rule allows it</li>
                  <li class="now"><span class="m">→</span>narrow the writable roots</li>
                  <li><span class="m">○</span>give each run its own scratch dir</li>
                  <li><span class="m">○</span>re-run sandbox:check on all three backends</li>
                </ul>
              </div>
              <div class="dele">
                <div class="chip"><i></i>bubblewrap probe · 2m14s</div>
                <div class="chip done"><i></i>seatbelt · done</div>
              </div>
              <div class="turn">TURN 28</div>
              <div class="gate">
                <div class="h">⚠ WANTS YOUR PERMISSION</div>
                <div class="cmd">rm -rf /tmp/artemis-sandbox-probe-*</div>
                <div class="why">Runs <b>unconfined</b> — the path is outside every writable root, so no backend can contain it.</div>
                <div class="row">
                  <div class="btn go">Allow once<span class="k">⏎</span></div>
                  <div class="btn">Always here<span class="k">⇧⏎</span></div>
                  <div class="btn">No<span class="k">esc</span></div>
                </div>
              </div>
            </div>
            <div class="comp">
              <div class="in">Reply to artemis…</div>
              <div class="status">
                <s class="hot">claude · opus 5</s><span class="sep">·</span><s>think hard</s><span class="sep">·</span><s class="mode">plan</s><span class="sep">·</span><s>~/artemis</s><span class="sep">·</span><s>seatbelt</s>
                <s class="send">⏎ send</s>
              </div>
            </div>
          </div>

          <div class="pane">
            <div class="ph"><span class="pd run">◆</span> cerebro › setup wizard <span class="x">✕</span></div>
            <div class="scroll">
              <div class="fade"></div>
              <div class="turn">TURN 9</div>
              <div class="you">local-only banks too — no remote at all</div>
              <div class="think"><span class="chev">▾</span><span class="txt">Thinking — init_bank has to fail loudly when git identity is missing, or promote commits nothing and says it worked…</span></div>
              <div class="tool">
                <div class="bar"><span class="k">shell</span><span class="a">git -C ~/bank config user.email</span><span class="r bad">exit 1</span></div>
                <pre><span class="dim">(no output)</span></pre>
              </div>
              <div class="said">That is the bug in CI too — no identity, <span class="inline">git commit</span> fails, and the wrapper swallowed it. It has to refuse and name the fix.</div>
              <div class="tool"><div class="bar"><span class="k">write</span><span class="a">bin/cerebro</span><span class="r ok">+34 −2</span></div></div>
              <div class="tool">
                <div class="bar"><span class="k">shell</span><span class="a">cerebro setup --local ~/bank</span><span class="r ok">exit 0 · 0.9s</span></div>
                <pre>✓ bank initialised at ~/bank
✓ 18 memories installed
<span class="dim">  no remote configured — promote will commit locally</span></pre>
              </div>
              <div class="said">Writing the wizard's second screen now<span style="color:var(--tool)">▌</span></div>
            </div>
            <div class="comp">
              <div class="in">Reply to cerebro…</div>
              <div class="status">
                <s class="hot">claude · sonnet 5</s><span class="sep">·</span><s>normal</s><span class="sep">·</span><s class="mode">accept edits</s><span class="sep">·</span><s>~/cerebro</s>
                <s class="send">⏎ send</s>
              </div>
            </div>
          </div>
        </div>

        <div class="dock">
          <div class="tabs"><d class="on">◫ commandSandbox.ts</d><d>▤ tasks</d><d>&gt;_ zsh</d><d>◱ localhost</d></div>
          <div class="fv">
            <div class="fvh"><span>packages/core/src/adapters/local/</span><span class="g">+6 −3</span></div>
            <pre><span><i class="ln">112</i><span class="kw">function</span> <span class="fn">profile</span>(writableRoots, scratch) {</span>
<span><i class="ln">113</i>  <span class="kw">return</span> [</span>
<span><i class="ln">114</i>    <span class="st">'(version 1)'</span>,</span>
<span><i class="ln">115</i>    <span class="st">'(deny default)'</span>,</span>
<span><i class="ln">116</i>    <span class="cm">// Exactly the roots handed in, and nothing</span></span>
<span><i class="ln">117</i>    <span class="cm">// else. The blanket /var/folders rule made</span></span>
<span><i class="ln">118</i>    <span class="cm">// another app's scratch space writable and</span></span>
<span><i class="ln">119</i>    <span class="cm">// let a command escape the workspace.</span></span>
<span><i class="ln">120</i>    ...writableRoots.<span class="fn">map</span>(</span>
<span><i class="ln">121</i>      (root) =&gt; <span class="st">`(allow file-write* …)`</span>,</span>
<span><i class="ln">122</i>    ),</span>
<span><i class="ln">123</i>    <span class="fn">allow</span>(scratch),</span>
<span><i class="ln">124</i>  ].<span class="fn">join</span>(<span class="st">'\\n'</span>)</span>
<span><i class="ln">125</i>}</span>
<span><i class="ln">126</i></span>
<span><i class="ln">127</i><span class="cm">/** Null when nothing can confine. The caller</span></span>
<span><i class="ln">128</i><span class="cm">    must refuse, never silently downgrade. */</span></span>
<span><i class="ln">129</i><span class="kw">export function</span> <span class="fn">wrapCommand</span>(argv, opts) {</span>
<span><i class="ln">130</i>  <span class="kw">const</span> backend = <span class="fn">detect</span>()</span>
<span><i class="ln">131</i>  <span class="kw">if</span> (backend === <span class="nu">WINDOWS_UNCONFINED</span>)</span></pre>
          </div>
        </div>
      </div>
    </div>
  </div>
"""

FIT = """
<div class="fitnote">scaled to fit — <b>click the window</b> for 1:1</div>
<script>
(function () {
  var win = document.querySelector('.win'), page = document.querySelector('.page');
  var note = document.querySelector('.fitnote'), W = 1400, H = 1000, one = false;
  function fit() {
    var s = one ? 1 : Math.min(1, page.clientWidth / W);
    win.style.transformOrigin = 'top left';
    win.style.transform = 'scale(' + s + ')';
    win.style.marginBottom = (H * s - H + 20) + 'px';
    note.innerHTML = one ? 'showing 1:1 — <b>click the window</b> to fit'
                         : 'scaled to ' + Math.round(s * 100) + '% — <b>click the window</b> for 1:1';
    note.style.display = (s === 1 && !one) ? 'none' : 'block';
    document.body.style.overflowX = one ? 'auto' : 'hidden';
  }
  win.addEventListener('click', function () { one = !one; fit(); });
  addEventListener('resize', fit); fit();
})();
</script>
"""

# ───────────────────────────────────────────────────────────────────────────
# The four languages.
# ───────────────────────────────────────────────────────────────────────────
DIRECTIONS = [
    dict(
        slug="1-sheet",
        kicker="1 · DEPTH: NONE",
        title="Sheet",
        fonts="@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');",
        lede=[
            "<b>Elevation is deleted.</b> Not reduced from six steps to three — removed. There is one ground and one well for machine text, and every boundary in the application is a hairline. Nothing is lighter because it is nearer.",
            "What is left to carry hierarchy is type and space, so both do more work: a real weight ramp, wide tracking on small caps labels, and radius zero on anything the machine produced. Colour appears roughly eight times on this screen and every appearance is load-bearing.",
        ],
        spec=[("GROUND", "sw", ["var(--void)", "var(--bg)", "var(--well)"]),
              ("HAIRLINES", "sw", ["var(--line)", "var(--line-2)"]),
              ("SEMANTIC", "sw", ["var(--accent)", "var(--tool)", "var(--ok)", "var(--warn)", "var(--err)"]),
              ("DISPLAY", "big", "Archivo 600"),
              ("MONO", "mn", "JetBrains Mono 400"),
              ("RADIUS", "val", "0px machine · 3px human")],
        tokens="""
  --void: oklch(8% 0.002 250); --bg: oklch(13% 0.003 250);
  --chrome: oklch(13% 0.003 250); --well: oklch(10.5% 0.003 250);
  --bar: oklch(13% 0.003 250); --ph-bg: oklch(13% 0.003 250);
  --line: oklch(27% 0.004 250); --line-2: oklch(42% 0.006 250);
  --ink: oklch(97% 0.002 250); --ink-2: oklch(76% 0.004 250); --ink-3: oklch(58% 0.005 250);
  --accent: oklch(86% 0.17 192); --accent-ink: oklch(16% 0.04 192);
  --tool: oklch(82% 0.10 192); --think: oklch(66% 0.03 210); --dele: oklch(74% 0.09 192);
  --ok: oklch(86% 0.17 145); --warn: oklch(85% 0.16 85); --warn-ink: oklch(18% 0.04 85);
  --err: oklch(72% 0.19 22);
  --add-bg: transparent; --del-bg: transparent; --gate-bg: transparent;
  --syn-kw: oklch(82% 0.10 192); --syn-st: oklch(86% 0.17 145); --syn-fn: oklch(97% 0.002 250); --syn-nu: oklch(85% 0.16 85);
  --sans: 'Archivo', ui-sans-serif, system-ui, sans-serif; --display: var(--sans); --prose: var(--sans);
  --mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  --fs: 13px; --lh-prose: 1.55; --w-hi: 600; --tr-hi: -0.012em; --tr-ui: 0.01em;
  --r: 0px; --r-sm: 0px; --r-win: 4px; --r-pill: 0px; --gap: 9px;
  --sh-win: none;""",
        css="""
/* One plane. The only fill in the whole application is the code well, and it
   is 2.5% darker rather than a step on a ladder. Everything else is a rule. */
.card, .pane, .dock, .comp { box-shadow: none; }
.newbtn { border-radius: 0; letter-spacing: 0.02em; }
.tool .bar, .diff .bar { border-bottom: 1px solid var(--line); }
/* Severity is a rule in the margin, never a wash behind text. */
.diff .add { border-left: 2px solid var(--ok); }
.diff .del { border-left: 2px solid var(--err); }
.diff pre span { padding-left: 7px; border-left: 2px solid transparent; }
.gate { border: 0; border-left: 2px solid var(--warn); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.you { border-left: 2px solid var(--accent); padding-left: 9px; }
.sess.on { background: transparent; }
.turn { letter-spacing: 0.16em; }
.box h3 { text-transform: uppercase; letter-spacing: 0.09em; font-size: 10.5px; }
.btn.go { color: var(--warn-ink); }""",
        wins=[
            "<b>Two fills instead of six.</b> Every surface decision collapses to \"is this machine text or not\", which is a question with an obvious answer — no more picking between <code>panel</code> and <code>raised</code> for things that are neither.",
            "<b>It cannot look like a shadcn app</b>, because the thing that makes those look alike is stacked greys with soft radii, and neither survives here.",
            "<b>Colour recovers its force.</b> There are eight coloured marks on this screen and each one means something; today amber and cyan appear so often they have stopped being signals.",
            "<b>Square machine surfaces, soft human ones</b> — radius carries meaning instead of being a global constant nobody chose.",
        ],
        costs=[
            "<b>Hairlines are fragile.</b> On a cheap panel or at 100% scaling a 1px 27% rule can disappear, and this language has nothing behind it — no fill difference to fall back on. It needs a real check on a bad monitor before it is committed to.",
            "<b>Nothing can be emphasised by lifting it.</b> Popovers, menus, tooltips and dialogs all float above content and today say so with <code>--float</code>. Here they need a border and a shadow, which is the one place the language has to break its own rule.",
            "<b>Weight does the work type at 11px cannot always do.</b> Archivo at 600 and 400 is a clear ramp at 13px and a much subtler one at the 10px chrome labels use.",
            "<b>Least warm of the four.</b> It reads as an instrument, which is right for a debugger and colder than some people want to sit in for six hours.",
        ],
    ),
    dict(
        slug="2-slab",
        kicker="2 · DEPTH: WEIGHT",
        title="Slab",
        fonts="@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');",
        lede=[
            "Depth expressed as <b>weight rather than lightness</b>. Two fills, but the boundaries are heavy: 1px hairlines for detail and a hard 2px edge wherever something is a distinct object. Hi-vis yellow-green on graphite, which is a machine-shop palette rather than a software one.",
            "The type ramp is the loudest of the four — 700 for structure, uppercase mono for every label — and radius is 3px, small enough to read as a milled edge rather than a card.",
        ],
        spec=[("GROUND", "sw", ["var(--void)", "var(--bg)", "var(--well)"]),
              ("EDGES", "sw", ["var(--line)", "var(--line-2)"]),
              ("SEMANTIC", "sw", ["var(--accent)", "var(--tool)", "var(--ok)", "var(--warn)", "var(--err)"]),
              ("DISPLAY", "big", "Instrument Sans 700"),
              ("MONO", "mn", "IBM Plex Mono 500"),
              ("RADIUS", "val", "3px · edges 2px")],
        tokens="""
  --void: oklch(9% 0.004 95); --bg: oklch(14% 0.005 95);
  --chrome: oklch(17.5% 0.006 95); --well: oklch(11% 0.005 95);
  --bar: oklch(21% 0.007 95); --ph-bg: oklch(21% 0.007 95);
  --line: oklch(30% 0.008 95); --line-2: oklch(48% 0.012 95);
  --ink: oklch(96% 0.005 95); --ink-2: oklch(79% 0.008 95); --ink-3: oklch(62% 0.010 95);
  --accent: oklch(88% 0.20 122); --accent-ink: oklch(18% 0.06 122);
  --tool: oklch(80% 0.09 200); --think: oklch(66% 0.04 160); --dele: oklch(78% 0.12 122);
  --ok: oklch(84% 0.17 140); --warn: oklch(84% 0.16 70); --warn-ink: oklch(19% 0.05 70);
  --err: oklch(70% 0.20 25);
  --add-bg: oklch(84% 0.17 140 / 0.11); --del-bg: oklch(70% 0.20 25 / 0.11); --gate-bg: oklch(84% 0.16 70 / 0.08);
  --syn-kw: oklch(88% 0.20 122); --syn-st: oklch(80% 0.09 200); --syn-fn: oklch(96% 0.005 95); --syn-nu: oklch(84% 0.16 70);
  --sans: 'Instrument Sans', ui-sans-serif, system-ui, sans-serif; --display: var(--sans); --prose: var(--sans);
  --mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
  --fs: 13px; --lh-prose: 1.5; --w-hi: 700; --tr-hi: -0.02em; --tr-ui: 0.005em;
  --r: 3px; --r-sm: 2px; --r-win: 5px; --r-pill: 2px; --gap: 8px;
  --sh-win: 0 20px 60px oklch(0% 0 0 / 0.55);""",
        css="""
/* Objects are heavy-edged; detail inside them is hairline. The distinction is
   the whole language: a 2px edge means "this is a thing", 1px means "this is
   a division inside a thing". */
.pane, .dock, .card { border-width: 2px; }
.pane.focus { border-color: var(--accent); }
.ph { border-bottom-width: 2px; font-weight: 600; }
.dock .tabs { border-bottom-width: 2px; }
.comp { border-width: 2px; }
.turn { font-weight: 600; letter-spacing: 0.14em; }
.tool, .diff, .todo { border-width: 1px; }
.tool .bar, .diff .bar { font-weight: 500; border-bottom: 1px solid var(--line); }
.gate { border-width: 2px; }
.gate .h { font-weight: 600; background: oklch(84% 0.16 70 / 0.12); }
.you { border-left: 3px solid var(--accent); padding-left: 9px; font-weight: 500; }
.newbtn { font-weight: 700; }
.box h3 { text-transform: uppercase; letter-spacing: 0.08em; font-size: 10.5px; }
.proj, .todo .h, .more { font-weight: 500; }
.sess.on { border-left-width: 3px; }""",
        wins=[
            "<b>Object boundaries are unmistakable.</b> In a 4×4 grid the question \"where does this pane end\" is answered by a 2px edge, not by two greys 4% apart — this is the language that scales best to a full grid.",
            "<b>The focused pane is obvious</b> without a glow or a shadow: its edge goes accent. Today focus is a border 10% lighter, which is invisible in peripheral vision.",
            "<b>Hi-vis on graphite is nobody else's palette.</b> Yellow-green at chroma 0.20 is a hazard colour, not a brand colour, and it is as far from the current AI-tool violet as the wheel allows.",
            "<b>Heavy labels survive at 10px.</b> Uppercase mono at 500–600 stays legible where a 400-weight sans label goes mushy.",
        ],
        costs=[
            "<b>2px edges eat 4px per pane per axis.</b> Across a 4×4 grid with gaps that is real estate, and it is spent on borders.",
            "<b>It is loud.</b> Everything shouts a little: heavy edges, heavy labels, a hazard accent. Six hours in this may be tiring in a way Sheet is not.",
            "<b>Yellow-green is close to the success green.</b> They are 18° apart and both high chroma, so \"the accent\" and \"it worked\" can be confused at a glance — the accent may need to move to ~135 or the success colour to a blue-green.",
            "<b>Warm greys fight the cool semantic colours.</b> Hue 95 graphite under a 200-hue tool colour is a deliberate tension, and on a poorly calibrated display it just reads as muddy.",
        ],
    ),
    dict(
        slug="3-ink",
        kicker="3 · HIERARCHY: TYPE",
        title="Ink",
        fonts="@import url('https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Inter+Tight:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');",
        lede=[
            "The one thing the agent produces that is genuinely <i>prose</i> is set as prose: <b>Newsreader at 14.5px with real leading</b>, in a measured column. Everything else — chrome, labels, status, code — stays mechanical, in Inter Tight and IBM Plex Mono.",
            "The bet is that a harness is mostly a <b>reading</b> surface and today it treats agent explanation as UI text at the same size as a button label. Surfaces recede almost to nothing so the reading has somewhere to happen.",
        ],
        spec=[("GROUND", "sw", ["var(--void)", "var(--bg)", "var(--well)"]),
              ("RULES", "sw", ["var(--line)", "var(--line-2)"]),
              ("SEMANTIC", "sw", ["var(--accent)", "var(--tool)", "var(--ok)", "var(--warn)", "var(--err)"]),
              ("PROSE", "big", "Newsreader 400"),
              ("UI · MONO", "mn", "Inter Tight · IBM Plex Mono"),
              ("RADIUS", "val", "2px")],
        tokens="""
  --void: oklch(9.5% 0.005 70); --bg: oklch(14.5% 0.006 70);
  --chrome: oklch(16.5% 0.006 70); --well: oklch(12% 0.005 70);
  --bar: oklch(19.5% 0.007 70); --ph-bg: oklch(16.5% 0.006 70);
  --line: oklch(28% 0.007 70); --line-2: oklch(41% 0.009 70);
  --ink: oklch(93% 0.010 70); --ink-2: oklch(80% 0.010 70); --ink-3: oklch(61% 0.009 70);
  --accent: oklch(74% 0.15 252); --accent-ink: oklch(17% 0.04 252);
  --tool: oklch(74% 0.08 252); --think: oklch(66% 0.04 300); --dele: oklch(72% 0.10 252);
  --ok: oklch(78% 0.13 150); --warn: oklch(80% 0.13 65); --warn-ink: oklch(19% 0.04 65);
  --err: oklch(69% 0.17 20);
  --add-bg: oklch(78% 0.13 150 / 0.08); --del-bg: oklch(69% 0.17 20 / 0.08); --gate-bg: oklch(80% 0.13 65 / 0.06);
  --syn-kw: oklch(74% 0.15 252); --syn-st: oklch(78% 0.13 150); --syn-fn: oklch(93% 0.010 70); --syn-nu: oklch(80% 0.13 65);
  --sans: 'Inter Tight', ui-sans-serif, system-ui, sans-serif; --display: 'Newsreader', Georgia, serif;
  --prose: 'Newsreader', Georgia, serif;
  --mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
  --fs: 12.5px; --lh-prose: 1.62; --w-hi: 600; --tr-hi: -0.005em; --tr-ui: 0.002em;
  --r: 2px; --r-sm: 2px; --r-win: 6px; --r-pill: 999px; --gap: 9px;
  --sh-win: 0 18px 50px oklch(0% 0 0 / 0.5);""",
        css="""
/* Prose is the only thing allowed to be large. Everything mechanical stays at
   UI scale, so the size difference itself tells you what kind of text it is. */
.said { font-size: 14.5px; max-width: 62ch; letter-spacing: 0.002em; }
.you { font-family: var(--prose); font-size: 14.5px; font-style: italic; color: var(--ink);
       border-left: 2px solid var(--accent); padding-left: 10px; }
.think { font-family: var(--prose); font-size: 13px; }
.gate .why { font-family: var(--prose); font-size: 12.5px; }
h1 { font-weight: 500; }
.box h3 { font-family: var(--sans); text-transform: uppercase; letter-spacing: 0.09em; font-size: 10px; }
.box p, .box li { font-family: var(--prose); font-size: 13.5px; line-height: 1.6; }
/* Chrome recedes: no fill on the pane header, rule only. */
.ph { background: transparent; }
.dock .tabs { background: transparent; }
.tool .bar, .diff .bar { background: var(--bar); }
.turn { letter-spacing: 0.15em; }
.sess.on { background: transparent; }""",
        wins=[
            "<b>The agent's explanation stops being chrome.</b> At 14.5px with 1.62 leading a paragraph is something you read; at today's 13px UI text it is something you skim and lose.",
            "<b>Size tells you what kind of text it is</b> before you read a word: large and serif is someone talking, small and mechanical is the machine. No colour needed to make that distinction.",
            "<b>It is the calmest of the four</b> by a distance, and a harness is a thing you sit in all day.",
            "<b>Measured column at 62ch</b> — today a wide pane sets prose at 120 characters, which is past the point where your eye reliably finds the next line.",
        ],
        costs=[
            "<b>A serif in a developer tool is a real risk.</b> It is the most likely of the four to be wrong, and it is the choice most likely to divide people on sight. It is also the closest thing here to round one's Ledger, which was rejected.",
            "<b>Three faces to load and maintain</b> against today's two, with an optical-size axis on the serif that has to be set correctly or it looks wrong at small sizes.",
            "<b>Mixed baselines.</b> Serif prose next to mono output means two different x-heights in one column, and the rhythm needs tuning that a single-family system gets for free.",
            "<b>Big prose costs vertical space</b> — the thing every other bet in round two was trying to recover.",
        ],
    ),
    dict(
        slug="4-signal",
        kicker="4 · COLOUR: ACTOR",
        title="Signal",
        fonts="@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');",
        lede=[
            "The rule that colour is <b>semantic only</b> is the one this overturns. Here colour says <b>who</b>: you are blue, the agent is plain ink, the machine is green, a delegated agent is violet. Severity rides on top as amber and rose, and is the only thing allowed to fill a surface.",
            "The claim is that in a transcript the first question is not \"how bad is this\" but \"who did this\" — and today that is carried by indentation and a small label, which is the weakest signal on screen.",
        ],
        spec=[("GROUND", "sw", ["var(--void)", "var(--bg)", "var(--well)"]),
              ("ACTORS", "sw", ["var(--accent)", "var(--ink)", "var(--tool)", "var(--dele)"]),
              ("SEVERITY", "sw", ["var(--ok)", "var(--warn)", "var(--err)"]),
              ("DISPLAY", "big", "Space Grotesk 600"),
              ("MONO", "mn", "JetBrains Mono 400"),
              ("RADIUS", "val", "5px · pills 999px")],
        tokens="""
  --void: oklch(9% 0.010 265); --bg: oklch(13.5% 0.014 265);
  --chrome: oklch(17% 0.016 265); --well: oklch(11% 0.012 265);
  --bar: oklch(20.5% 0.020 265); --ph-bg: oklch(20.5% 0.020 265);
  --line: oklch(31% 0.020 265); --line-2: oklch(45% 0.026 265);
  --ink: oklch(96% 0.006 265); --ink-2: oklch(78% 0.012 265); --ink-3: oklch(62% 0.016 265);
  --accent: oklch(80% 0.16 250); --accent-ink: oklch(17% 0.05 250);
  --tool: oklch(84% 0.16 165); --think: oklch(70% 0.07 300); --dele: oklch(78% 0.17 310);
  --ok: oklch(84% 0.16 165); --warn: oklch(84% 0.16 78); --warn-ink: oklch(19% 0.05 78);
  --err: oklch(72% 0.19 15);
  --add-bg: oklch(84% 0.16 165 / 0.12); --del-bg: oklch(72% 0.19 15 / 0.12); --gate-bg: oklch(84% 0.16 78 / 0.10);
  --syn-kw: oklch(78% 0.17 310); --syn-st: oklch(84% 0.16 165); --syn-fn: oklch(80% 0.16 250); --syn-nu: oklch(84% 0.16 78);
  --sans: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif; --display: var(--sans); --prose: var(--sans);
  --mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  --fs: 13px; --lh-prose: 1.55; --w-hi: 600; --tr-hi: -0.02em; --tr-ui: 0.01em;
  --r: 6px; --r-sm: 5px; --r-win: 10px; --r-pill: 999px; --gap: 9px;
  --sh-win: 0 22px 64px oklch(0% 0 0 / 0.55);""",
        css="""
/* Every block is tinted by its actor. The tint is 6–8% — enough to sort a
   scrolling column at a glance, not enough to read as a coloured box. */
.you { border-left: 3px solid var(--accent); padding-left: 10px;
       background: linear-gradient(90deg, oklch(80% 0.16 250 / 0.10), transparent 62%); padding-top: 3px; padding-bottom: 3px; }
.tool { border-left: 3px solid var(--tool); }
.tool .bar { background: linear-gradient(90deg, oklch(84% 0.16 165 / 0.13), var(--bar) 55%); }
.diff { border-left: 3px solid var(--tool); }
.chip { border-left: 3px solid var(--dele); background: linear-gradient(90deg, oklch(78% 0.17 310 / 0.12), var(--well) 70%); }
.chip.done { border-left-color: var(--ok); }
.think { border-left: 3px solid var(--think); padding-left: 9px; }
.said { border-left: 3px solid transparent; padding-left: 10px; }
/* Severity is the only thing that fills. */
.gate { border-left: 3px solid var(--warn); }
.gate .h { background: oklch(84% 0.16 78 / 0.14); }
.pane.focus { border-color: var(--accent); box-shadow: inset 0 0 0 1px oklch(80% 0.16 250 / 0.28); }
.ph .pd.gate { color: var(--warn); }
.ph .pd.run { color: var(--tool); }
.sess .dot.run { box-shadow: 0 0 0 3px oklch(84% 0.16 165 / 0.18); }
.sess .dot.gate { box-shadow: 0 0 0 3px oklch(84% 0.16 78 / 0.18); }
.box h3 { letter-spacing: 0.005em; }""",
        wins=[
            "<b>Who did what is answerable without reading.</b> Scrolling fast through 28 turns, the blue marks are you, the green are the machine, the violet are delegated work — today all three are the same grey column.",
            "<b>Delegated agents finally have an identity.</b> They are the newest thing in the app and the thing most easily lost in a transcript; a violet edge makes their output distinguishable from the parent's.",
            "<b>Severity keeps its force by being the only filler.</b> Nothing else in the language is allowed a background wash, so a filled block always means something went wrong or something is waiting.",
            "<b>Space Grotesk has a face.</b> It is the only one of the four with real personality in the letterforms, which matters if the app should look like it came from somewhere.",
        ],
        costs=[
            "<b>It breaks the best rule the current system has.</b> \"Colour is semantic, never decorative\" is why today's app never looks like a toy, and actor-tinting spends that discipline. If it is applied loosely it degrades into decoration fast.",
            "<b>Four actor hues plus three severity hues is seven meanings in colour</b>, which is past what most people reliably distinguish — especially the ~8% of men with a red-green deficiency, for whom the machine green and the error rose are the two that collapse.",
            "<b>Tints are hard to keep honest across themes.</b> A 12% wash over a dark ground is invisible over a light one, so the light theme needs its own scale rather than an inversion.",
            "<b>Busiest of the four.</b> Every block having an edge means the transcript has a coloured left margin all the way down, and that is a lot of structure for a quiet conversation.",
        ],
    ),
]


def spec_html(spec):
    out = []
    for label, kind, val in spec:
        if kind == "sw":
            inner = '<div class="sw">' + "".join(
                f'<i style="background:{v}"></i>' for v in val) + "</div>"
        elif kind == "big":
            inner = f'<div class="big">{val}</div>'
        elif kind == "mn":
            inner = f'<div class="mn">{val}</div>'
        else:
            inner = f'<div class="val">{val}</div>'
        out.append(f'    <div class="col"><div class="lab">{label}</div>{inner}</div>')
    return "\n".join(out)


TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title} — a design language for the layout we have</title>
<style>
{fonts}
/* ── {title}: the language. Everything below the token block is structural
   and is emitted identically into all four files by _build.py. ─────────── */
:root {{{tokens}
}}
{base}
{css}
</style>
</head>
<body>
<div class="page">
  <a class="back" href="index.html">← all four</a>
  <div class="kicker" style="margin-top:12px">{kicker}</div>
  <h1>{title}</h1>
{lede}
  <div class="spec">
{spec}
  </div>
{window}
  <div class="foot">
    <div class="box">
      <h3>What this language buys</h3>
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


def build():
    for d in DIRECTIONS:
        html = TEMPLATE.format(
            title=d["title"],
            kicker=d["kicker"],
            fonts=d["fonts"],
            tokens=d["tokens"],
            base=BASE,
            css=d["css"],
            lede="\n".join(f'  <p class="note">{p}</p>' for p in d["lede"]),
            spec=spec_html(d["spec"]),
            window=WINDOW,
            wins="\n".join(f"        <li>{w}</li>" for w in d["wins"]),
            costs="\n".join(f"        <li>{c}</li>" for c in d["costs"]),
            fit=FIT,
        )
        (OUT / f'{d["slug"]}.html').write_text(html)
        print(f'wrote {d["slug"]}.html')


if __name__ == "__main__":
    build()
