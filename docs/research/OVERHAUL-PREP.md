# Overhaul prep — the next design + capability push

Written 2026-08-29 against `main` at `02d4a30` (1.16.0). Synthesized from five parallel
code surveys of this tree plus the design record in [`docs/design/`](../design/index.html);
every file:line claim below was read from the current tree, not remembered. Companion
document: [T3-DESIGN-RESEARCH.md](T3-DESIGN-RESEARCH.md) (external influence research,
in progress — see §7).

The ask, in the user's words: grey instead of black; an accent that is easier to use;
the **settings menus** reorganized based on what they really are; a model picker that
actually understands what each profile is doing; a first-class way to pick up another
profile's work when it runs out of usage; remote work — connecting to an Artemis running
on a different computer and controlling what it is working on; and a full overhaul of
the dock pane (terminals and the other work surfaces), taking heavy influence from T3.
Alongside: three live run-lifecycle bugs (sessions detaching, Codex refusing
follow-ups, phantom "done") to be diagnosed and fixed as part of the same push (§9).

## Verdict

**Eight workstreams plus a stability gate, none starting from zero.**
Grey-instead-of-black is a five-token edit plus three known escape hatches, guarded by
an existing unit test — and both external references confirm the direction (nobody
ships pure black). The accent swap is two lines — but the palette test proves the
current teal sits in the *only* hue window the current status colours permit, so a
genuinely new accent means moving status hues with it (§2 has a worked example that
clears the test; §8 flags the clone-problem tension in borrowing T3's pink). The
settings reorganization is bounded and largely pre-argued: the row-by-row survey (§3)
shows the real seams (storage boundary, row scope) and the design record already
sketched the two-band nav. The model picker needs no new plumbing at all — every fact
it should know (per-model exhaustion, plan headroom, burn rate) already exists one
selector away and is simply never read by the picker; both references converge on the
same picker shape (§4, §8). Cross-profile pickup's historical blocker is already gone
— transcripts are machine-shared and account-free, the ownership ledger honours
re-attribution, the auto-handoff machinery implements the trigger and stop — and the
ChatGPT app hands us the interaction vocabulary ("Hand off", the limit wall as a
menu); what's missing is the last mile (§5). Remote work is model routing today, not
control; the seams were cut for control deliberately, and a `remote` bridge mode makes
the existing UI the remote UI (§6). The dock overhaul has its central question
answered by T3 Code's open source: surfaces belong to the *thread* (§7, §8). And
underneath all of it, three reported run-lifecycle bugs (§9) are being diagnosed
loop-first — they gate the overhaul, because several workstreams build on exactly the
machinery that's misbehaving.

The design record's own rules govern all of it: **additive only, one variable at a time,
every bet states its cost, always include a control, judge against the hard session.**

## 0. Ground rules inherited from the design record

The overhaul does not start with mockups — four rounds already exist under
[`docs/design/`](../design/index.html), and round three's **Sheet** language shipped
(the current `index.css` implements it: elevation by fill, square-machine/soft-human
radii, semantic-only colour). The standing recommendation of record is *Sheet's surface
model, Ink's treatment of prose, Slab's focus edge*, with Signal's actor-colour idea
reserved for delegated agents only.

Explicitly undecided there, and therefore where this overhaul begins rather than
re-litigating: light-mode tuning, motion/streaming, focus rings, empty states, and
formalizing the token layer before converting components.

Process rules to keep:

- **Additive only.** A design may merge chrome; it may not remove information or add a
  step. Every duplicated entry point in §3 was defended in a comment; keep the doors.
- **One variable at a time.** Surface ramp, accent, and menu regrouping are three
  separate changes with three separate reviews, even if they land in one release.
- **Every mockup states its cost in-file; always include a control.** Recut (the
  no-layout-change control) *won* round two. Any new palette gets an a-recut-style
  control render first.
- **Judge against the hard session** in [`_session.md`](../design/_session.md), not an
  empty window.

## 1. Grey instead of black

**Current state.** The entire design system is one file:
[`index.css`](../../apps/desktop/renderer/src/index.css) (1215 lines, Tailwind v4
CSS-first, no tailwind.config.js anywhere). Zero hardcoded colours in 257 renderer
files outside six known-legitimate spots. The "black" is the dark surface ramp:

| Token | Now | Role |
|---|---|---|
| `--abyss` | `oklch(9% 0.003 250)` | window ground, pane gaps |
| `--inset` | `oklch(10.5% 0.003 250)` | code wells, terminals |
| `--panel` | `oklch(13% 0.003 250)` | all chrome |
| `--raised` | `oklch(16% 0.004 250)` | hover/pressed |
| `--float` | `oklch(18.5% 0.005 250)` | overlays |

**The change is those five lightness values** (plus `--line`/`--line-strong` re-tuning
so hairlines survive the brighter ground). Constraints that hold automatically:
[`palette.test.ts`](../../apps/desktop/renderer/src/lib/palette.test.ts) re-derives AA
contrast for every ink/status token against both grounds on every run, so a ramp raised
too far fails CI rather than shipping muddy text.

Escape hatches that must move with the ramp (all catalogued, none discovered late):

1. [`main/index.ts:257`](../../apps/desktop/main/index.ts) — pre-paint window background
   `#0a0a0c` / `#f4f4f6`, read by Chromium before any stylesheet exists.
2. [`build/icon.svg`](../../apps/desktop/build/icon.svg) — baked `#0c0d0f`/`#020203`
   substrates (and `#31eee8` accent); `icon-build.sh` re-rasterises `.png`/`.icns`.
3. [`terminalSessions.ts:83-91,118`](../../apps/desktop/renderer/src/lib/terminalSessions.ts)
   — xterm canvas fallbacks, **still carrying the pre-teal lavender palette** (`#b9a9f0`,
   `#0d0b10`). Latent bug today; fix it in the same commit.

**A decision this unlocks:** current neutrals sit at hue 250 with chroma ≤ 0.008 —
near-neutral cool grey, *decoupled* from the teal accent. (The old system tinted greys
toward the accent hue; the shipped one does not.) Whether the new grey stays cold-neutral
or takes a whisper of the new accent's hue is a fresh choice, and it is **one token edit
per surface** either way.

Light mode already exists end-to-end (three-way system/light/dark, flash-free boot
script, CSP-hash test) — the grey work is a dark-ramp retune, not a theme build.

## 2. A friendlier accent

**Current state.** The accent is `--beam` — teal, `oklch(86% 0.14 192)` dark /
`oklch(52% 0.088 192)` light. Because `--primary`, `--ring`, `--sidebar-primary` and
`--chart-2` all resolve to `var(--beam)`, **the swap itself is editing two lines**
(index.css:230 dark, :436 light) plus `--beam-dim`/`--beam-ink` beside them. 53 files
consume it via utilities; none name a colour.

**The real constraint is the hue geometry.** `palette.test.ts:79-83` asserts every pair
of meaningful hues — accent plus the five status colours (error 25, warning 85, success
150, tools 250, thinking 310) — is ≥ 40° apart, in both themes. Under the current status
placement, the only legal accent window is **[190°, 210°]** — i.e. the teal we have.
Every other hue family requires moving status hues too. That is not a blocker; it is the
test doing its job. One worked example that clears the rule, if the direction is a warm
pink/magenta (the hue family T3 owns — see §7):

```
error 25 · warning 85 · success 150 · tools 250→210 · thinking 310→270 · beam →330
gaps: 60 / 65 / 60 / 60 / 60 / 55 — all ≥ 40°
```

Tools shift from blue toward teal-cyan; thinking from lavender toward violet-blue; the
accent lands at magenta-pink 330. Chroma ceilings are then re-derived per hue —
index.css:63-91 documents the sRGB gamut method (current teal ceilings: C 0.148 dark,
C 0.089 light; a more saturated light-mode accent is a display-p3 *policy decision*, not
a tuning knob).

Blast radius beyond the two lines, all enumerated: `::selection`, global focus ring,
markdown links, both carets, the shuttle animation, five hljs syntax roles, the
alpha-modified uses (`ring-ring/50` etc. — re-check legibility after any hue move), the
`oklch(from …)` derived tints in `bubble.tsx`, the icon SVG's `#31eee8`, and the stale
xterm fallbacks. `palette.test.ts` adjudicates the rest.

## 3. Settings menus reorganized by what they really are

**Current state.** Ten sections, ~90 rows, one
[`SettingsDialog`](../../apps/desktop/renderer/src/components/settings/SettingsDialog.tsx)
frame (single scroller, only the visible pane mounted — deliberate, so half-typed
credentials don't survive in the background). The nav's head is intent-shaped —
Profiles → Models → Appearance → Browser → Permissions → Agents → Memory banks,
ordered "in the order the panes were designed to be met" — and the tail is
implementation-shaped: Server, Routines, and Advanced each got a row because each is a
subsystem with its own IPC namespace, not because a user would name them. The
section-ordering comments (:92-179) are each an argument; the axis is contested in the
code's own voice.

**Two structural findings from the row-by-row survey that should drive the redesign:**

1. **The storage boundary is a cleaner seam than the current nav.** Everything in
   Appearance / Browser / the Models flags / the Permissions mode is one `prefs.json`
   field — instant, local toggles. Everything in Agents / Memory banks / Server /
   Routines is a separate main-process-owned file with its own lifecycle, error state,
   and receipts — management surfaces with async actions. The dialog interleaves the
   two kinds; users feel the difference without being told why.
2. **Row scope is inconsistent and invisible.** Permission mode and model are
   per-column (persisted for the focused column); the model shortlist is per-profile;
   auto-handoff is per-installation; the memory-bank gate is per-machine outside prefs.
   Nothing on screen says which is which — and the handoff copy uses "window" to mean
   *rate-limit window* one paragraph after using it to mean *app window*.

**The misfiled rows** (worst first — each independently fixable):

- **Auto-handoff lives in Appearance** (AppearanceSection.tsx:591-640) — a spend/limit
  policy that interrupts runs in flight and writes files to `.artemis/`, filed under
  "how it looks." The single worst placement in the dialog.
- **Beta update channel lives in Advanced** — whose own pane contract is "arrangements
  Artemis hands to the user to perform rather than settings it applies"; the update
  channel is something Artemis performs. It contradicts the pane's stated rule.
- **"Escape stops the run"** is a keybinding filed under Appearance; **"Recent
  folders"** is a machine-local *record* (the file says so itself) filed under
  Appearance; **dock auto-open** writes behaviour (`reconcileDock()`), not looks.
- **Fast mode / Ultracode** sit in the Models catalogue pane but are per-pane run
  defaults, beside a shortlist that is per-profile — two scopes in one pane.
- **Permissions is ~40% placeholder** — the three tool-policy textareas store nothing
  (the protocol carries policy per run; the CLI's config owns it).
- **Routines' Model field is free text** while the same choice is a validated catalogue
  picker everywhere else.
- **Theme lives outside the dialog entirely** (window header) — defended in-file, but
  Appearance doesn't contain the most-looked-for appearance setting.
- The `cerebro`-id/"Memory banks"-label mismatch is three layers deep (nav, palette,
  `cerebro.json`/`LEGACY_SLUG`) — survivable, but don't mint more.

**Proposed target nav** — the design record already sketched the shape: round four's
[`app.html`](../design/app.html) settings screen uses a **two-band nav** (SETTINGS /
WORKSPACE). Extending that with the survey's intent groups:

*Band 1 — you and your work:*

1. **Profiles** — as today (identity, sign-in, plan facts, availability).
2. **Models** — catalogue + per-profile quick access, nothing else.
3. **Runs** *(new)* — everything that changes what the next run does or costs:
   default permission mode, fast mode / ultracode, run summary, and **auto-handoff +
   thresholds** (rehomed from Appearance). Scope chips on every row (this column /
   this profile / this machine) fix finding 2.
4. **Instructions** *(merge)* — Agents + Memory banks. The nav comment at
   SettingsDialog.tsx:135-136 already apologizes for this split ("the general case of
   what their pane is one instance of"); merging is what the apology asks for.
5. **Permissions & access** — permission mode's home if not in Runs, the Browser
   switches (stated in-file to be permission questions), and the tool-policy group
   once it stores something real.
6. **Appearance** — what remains is genuinely appearance: text size, width, thinking,
   word fade, sidebar, plus a theme row (or a pointer to the header toggle).

*Band 2 — this machine:*

7. **Server** — as today (it is a coherent management surface; its account-allowance
   tree deliberately duplicates Profiles per the ordering rationale — keep, but
   cross-link).
8. **Routines** — as today, with the model field becoming the real picker.
9. **This machine** *(rename of Advanced)* — update channel, shared `~/.claude`
   intent-switch + on-disk reading, recent-folders record.

**Mechanics to fix regardless of grouping** (all found missing): scroll position does
not reset on section change (no `key` on the `ScrollArea`, no `scrollIntoView`
anywhere); `openSettings` can aim at a section but not a row (no anchors); there is no
cross-section settings search — the palette is the de-facto search and indexes only
seven of ten sections (`server`, `routines`, `advanced` are unreachable from it);
fold state is wiped on restart except one hand-remembered fold.

**Constraints to respect** (all deliberate, all documented in-file): deep-link ids are
frozen addresses; only the visible pane mounts; one scroll container (two existing
violations noted for cleanup); disabled options keep their place with a reason
attached (`ChoiceList`); the Server's start-always-confirms dialog is never remembered
— by design, each start is a fresh decision.

### Secondary: the app's other menu surfaces

**Current state.** The native macOS menu is deliberately minimal — it exists to add
`Settings…` and `Check for Updates…` without destroying Electron's clipboard roles
([`menu.ts:1-47`](../../apps/desktop/main/menu.ts)); every real capability lives in the
renderer. The app's true menus: the ⌘K palette (5 pages), five status-line popovers,
the 10-section settings dialog, the session context menu, the sidebar rail, the header
cluster, the dock tab strip.

**The diagnosis the survey confirmed:** grouping is split between two axes, and the
code's own comments argue about it. By *implementation ownership*: the palette files
"Open a terminal here" under **Session** (because a terminal is pane-scoped) and the
sidebar toggle under **Configure** (beside things that change what the next prompt
costs); **Inspect** mixes a read-only dialog with two cache-invalidation actions; the
settings nav's tail (Server / Routines / Advanced) is one row per subsystem-with-its-own-
IPC-namespace rather than anything a user would name. By *user intent*: the status line
("everything that decides what the next prompt does, and nothing that does not"), the
settings nav's head, and the palette's Settings group (one destination deliberately
exploded into seven searchable rows). The reorganization is finishing the second axis's
victory.

Concrete inconsistencies found, each independently fixable:

- **Files-pane button:** two contradictory rationales — `Sidebar.tsx:322-326` argues it
  belongs on the rail *instead of* the header; `AppHeader.tsx:347-355` keeps it in the
  header anyway. Decide once.
- **Tasks/delegated-work:** two surfaces with opposite empty-state policies (header
  disables-with-reason; rail hides entirely). Pick one policy.
- **Fork-on-resume:** the toggle was removed from the composer and survives only in the
  palette, with invisible state — `Composer.tsx:431-438` records the problem itself.
- **Settings § Advanced** is three unrelated things in one pane: shared-config script,
  beta update channel, "scripts you run yourself."
- **`cerebro` section id vs "Memory banks" label** — kept for deep-link compat; fine,
  but the reorganization should not mint new mismatches.

Proposed regrouping (palette first, since it is pure relabeling/refiling — additive by
construction):

- **Conversation** — new, resume, fork, unfork, rewind.
- **Run** (what the next prompt does) — model, thinking ladder, fast mode, provider,
  working directory, permission mode.
- **View** (window & panes) — sidebar, terminal, browser, files, tasks, splits.
- **Maintenance** — reload history, re-probe providers.
- **Settings** — unchanged (already intent-shaped).

Settings nav: keep the head (Profiles → Models → Appearance → Browser → Permissions →
Agents → Memory banks), group the tail under a labelled "Infrastructure" divider
(Server, Routines, Advanced-split-sensibly). Deep-link ids must not change
(palette rows and `openSettings()` callers depend on them).

Two open questions, both with documented constraints: whether the macOS menu bar should
mirror app actions (menu.ts:29-34 explains why accelerators must stay with `useHotkeys`;
mirror items would have to be accelerator-free), and whether the dock tab strip's
kind-dispatch should become user-nameable groupings (DockPane.tsx:19-28 records why
Radix Tabs was rejected — keep the hand-rolled tablist).

## 4. A model picker that understands profiles

**Current state — the split.** The *data* path is already profile-aware: the catalogue
is live-fetched per account via the SDK's `supportedModels()` with the profile's env
([`claude.ts:450`](../../packages/core/src/adapters/claude.ts)), cached per
`(providerId, profileId)`, quick-access pins are per-profile, and the request type
documents *why* it names a profile (two accounts on one provider can see different
lineups — [`ipc.ts:807`](../../packages/protocol/src/ipc.ts)). The *decision* path is
profile-blind: [`ModelSegment`](../../apps/desktop/renderer/src/components/StatusLine.tsx)
subscribes to no `planUsageByProfile`, no `PlanUsage`, no recommendation — so it offers
Fable identically whether that account's Fable weekly window is untouched or `rejected`.

**Everything needed is already computed.** Per-model exhaustion:
`focusedWindow(usage, 'model')` and `isModelScoped`
([`usage.ts:288-320`](../../packages/protocol/src/usage.ts)). Plan headroom with
rejected-window override: `planHeadroom` (usage.ts:409). Relative burn rate:
`MODEL_LOAD` — haiku 0.25 / sonnet 1 / opus 4 / fable 8
([`planLoad.ts:97`](../../packages/protocol/src/planLoad.ts)). The usage rings already
render on the same status-line row. This is join work, not plumbing work.

**The unified navigator (user spec, 2026-08-29 — supersedes the separate-popover
shape below; the per-row facts still apply inside it).** The profile and model
chips open ONE popover: a Finder-column navigator, columns revealed left to
right as picks land — **Profile → Model → Effort** — with a footer of toggles
that exist only when the picked combination supports them: fast mode (gated by
model + effort) and the permission level. The status-line chips themselves stay
(model + permission remain the always-visible pair per the elision rule); their
menus unify. Column details: the profile column carries the usage-aware rows
(live meters, resets, signed-out badges, Recommended on top) and is
disabled-with-reason mid-run; the model column keeps per-profile pins first,
catalogue behind search, `$`-pips and exhaustion inline, the "Edit quick
access…" door; the effort column is the thinking ladder including ultracode
(still mutually exclusive with fast mode); context readout and plan meters stay
in the footer. This is also the row vocabulary the §5 hand-off picker reuses.

Per-row facts (each row of the navigator knows three new facts):

1. **Exhaustion state** — a model whose `model_scoped` weekly bucket is `rejected`
   renders present-but-disabled *with the reason and the reset time inline*, following
   the palette's existing `GatedItem` precedent (struck-through with reason, never
   hidden — CommandPalette.tsx:599-617).
2. **Pressure state** — `warning`-status windows tint the row's meter dot; the binding
   window's utilization is the number, matching `PlanUsageMeter` semantics (a rejected
   window draws full regardless of percentage).
3. **Cost posture** — `MODEL_LOAD` renders as a relative burn-rate hint per row
   (T3-style capability/cost communication — §7), so "fable = 8× sonnet against your
   plan" is visible at selection time, not discovered at the weekly wall.

Plus one steering affordance: a **Recommended** row at the top when another
pinned model has materially more headroom for this profile — the exact analogue of
`RecommendedProfile` in the profile popover, reusing `recommendProfile`'s
freshness/candidate rules. The same three facts feed the palette's models page and
Settings § Models so the three surfaces stay one system.

Cross-catalogue identity is already solved (`modelIdentity`/`isSameModel`,
provider.ts:433-451) — usage windows name models like `Fable`, catalogues like
`claude-fable-5[1m]`; the join must go through those helpers, not string equality.

## 5. First-class cross-profile pickup

**Current state.** Three escalating behaviours exist today: (1) *auto-handoff* (off by
default): at thresholds (5-hour 90% / weekly 98% / Fable 95%, or any `rejected` window)
the run is interrupted, settled ≤ 10 s, and the agent writes
`.artemis/handoff-<stamp>.md`; the composer then blocks with "continue on another
account" guidance ([`autoHandoff.ts`](../../apps/desktop/renderer/src/state/autoHandoff.ts),
[`handoff.ts`](../../packages/protocol/src/handoff.ts)). (2) The profile popover's
**Recommended** row steers new work to the best-headroom account, load-discounted so
sessions don't herd. (3) If neither fired, the run dies with a generic banner — no reset
time, no offer, no retry (`store.ts:10141`; `describeError` renders
"code rate_limit · HTTP 429 · retryable" and `retryable` is used for nothing but a
display suffix).

**The blocker is gone; the invariant outlived its reason.** "A session cannot switch
accounts" dates from per-profile transcript stores. Since 2026-08-14, `projects/` is
symlinked machine-wide: transcripts are plain JSONL recording *no account*
([`owners.ts:12-19`](../../packages/core/src/sessions/owners.ts)); profile B can
already read and resume profile A's session; `canReachSession` (store.ts:2175) is the
reachability primitive; and the ownership ledger **already honours re-attribution when a
session resumes under a different account** (owners.ts:254) — the bookkeeping
anticipated this feature.

**The shape** (from the survey's blueprint — reuse, don't rebuild):

- *When:* `handoffTrigger` as-is.
- *Stop:* `requestHandoff`'s interrupt-and-settle, as-is, including the 10 s bound and
  the abandon path.
- *Move:* a third latch outcome beside `asked`/`dismissed`: if
  `canReachSession(session, target)` and `planRecommendation` names a target — apply the
  target profile to the pane **without** `newSession`, keeping `resumeSessionId` (the
  one thing `setProfile` deliberately refuses today), then let the next prompt resume
  under the new account. Record the move via `SessionOwners`; write the transcript note
  `resumeSession` already writes.
- *Fallback:* whenever reachability, auth, reading freshness (6-min staleness bar), or
  candidate count says no — today's document handoff, unchanged.

**The obstacles that must be engineered around, not waved at** (survey found fourteen;
these six bite hardest):

1. **`run.end` ordering** — store.ts:10115-10119 only promotes `endedSessionId` into
   `resumeSessionId` when the pane's profile still matches the run's; move the profile
   too early and the conversation is silently dropped.
2. **One transcript, two CLIs** — a cross-profile resume deliberately misses the
   process pool (`canServe` checks config dir, claude.ts:2733) and spawns a second CLI;
   the source process must be `release()`d first (claude.ts:2676; the rewind path at
   claude.ts:1136-1149 is the precedent) or two processes append to one JSONL.
3. **The config-dir mutex** — every SDK call mutates `process.env.CLAUDE_CONFIG_DIR`
   behind `configDirLock` (claude.ts:4037-4066); read-under-A-then-resume-under-B must
   go through it, not around it.
4. **Catalogue/commands/auth re-resolution** — the move must go through `applyProfile`
   (store.ts:6216) or account A's model list and slash commands linger over account B's
   session; and the recalled model choice may name a model B doesn't have.
5. **Target fitness ≠ ranking answer** — `bindingWindow` is workload-blind (a full
   Opus bucket sinks an account for Fable work);
   [`ACCOUNT-ROTATION-ALGORITHM.md`](ACCOUNT-ROTATION-ALGORITHM.md)'s `drain-v1` fixes
   this and is still unimplemented. Handing off to an account that immediately stalls is
   the failure mode to design against.
6. **Signed-out targets** — nothing pre-checks; `checkAuthStatus` (signIn.ts:198) is
   cheap enough to gate on.

Also: the tests encoding the old invariant (`profileLock.test.ts`,
`sharedStoreResume.test.ts`) must be *changed for the right reasons* — a new narrower
door through `setProfile`'s gate, not a relaxation of it.

**Phasing (each shippable alone):**

1. **Rate-limit banner grows a door.** When a run dies `rate_limit`, the banner names
   the binding window, its reset time, and — when a reachable, signed-in, fresh-reading
   target exists — a "Continue on <profile>" action that does the move manually. No
   trigger changes, no latch changes; the smallest honest version of the feature.
2. **The hand-off picker.** (Settled 2026-08-29, ADR 0003 — replaces the earlier
   "auto third outcome" idea.) The threshold trigger opens an informed picker:
   which window tripped and when it resets, every candidate profile with its live
   plan meters, and the user chooses the target. The document path (continuity
   note) remains the fallback when no candidate is reachable. Session rows and the
   transcript note make the attribution change visible. Nothing ever moves
   unchosen.
3. **`drain-v1` lands** so the *target* is chosen by workload fit, and the picker/§4
   surfaces agree with the handoff about which account absorbs what.

## 6. Remote work

**Current state — remote already half-exists, but as *model routing*, not *control*.**
Both ends of a machine-to-machine link ship today: [`apps/server`](../../apps/server)
is a headless Artemis (plain `node:http`, Dockerized, with a Tailscale runbook written
into [`docker-compose.yml`](../../docker/docker-compose.yml)'s header), and the
`artemis` **provider adapter**
([`adapter.ts`](../../packages/core/src/adapters/artemis/adapter.ts)) lets a desktop
Artemis be a *client* of a remote one — 1.9.0's release notes call it "Point Artemis at
another Artemis." Turns run over there, sessions persist server-side and are reachable
from every machine holding the token. Auth is connection tokens (32-byte, constant-time
compared, per-token workspace pin + profile/model allowlist); the ledger's *pin* rule
already models "one person, several machines, one shared history."

What the link cannot do is the thing the ask names: **see or steer what a remote
Artemis is working on.** The gaps are precise:

- **No observation channel.** SSE exists only *inside* one chat-completion response.
  There is no run-list route, no event-stream endpoint, no attach-to-existing-run —
  `AgentEvent`, the desktop's entire live feed, never crosses the wire. This is the
  single biggest gap.
- **No control verbs.** Interrupt is only "hang up the socket you opened yourself";
  permission prompts are *structurally* auto-denied (`RunSource.respondToPermission` is
  type-narrowed to `{ behavior: 'deny' }` — completions.ts:85-89); no mid-run steering,
  no session mutation, no profile management over HTTP.
- **Transport posture.** No TLS (confidentiality is delegated to the tunnel — fine
  behind Tailscale, stated as the design); no token expiry; the *desktop*-hosted server
  is hardcoded loopback-only (`SERVER_HOST`, protocol/server.ts:96, with a comment
  anticipating exactly this feature: "If this ever becomes a setting it should arrive
  with its own warning surface, not as a text field"); the renderer's own CSP
  (`connect-src 'self'`) would block a remote client.

**Why this is nonetheless very buildable:** the seams were cut for it, deliberately.
`packages/core` is *test-enforced* Electron-free (`no-electron.test.ts` — written "one
day under a CLI or a server"); `ArtemisEngine` never imports Electron and every method
speaks renderer-safe protocol types; `IpcRequestMap`/`IpcResponseMap`/`IpcResult` are
already a serializable RPC schema with handlers that never reject, and `IpcPushMap` is
a ready-made server→client event schema needing only a transport that isn't
`webContents.send`. Best of all, the renderer's transport is already abstracted:
[`bridge.ts:29-41`](../../apps/desktop/renderer/src/lib/bridge.ts) resolves one of
three modes (`preload` / `mock` / `unavailable`), and the 2400-line mock bridge proves
the whole interface is implementable without Electron. **A fourth mode — `remote`,
backed by HTTP + an event stream — is a drop-in**, and with it the entire existing UI
becomes the remote-control UI.

**Proposed phasing:**

1. **Observe.** New server routes: run list (`engine.listRuns` exists, unrouted) and an
   event-stream endpoint carrying `IpcPushMap` payloads; a read-only "remote machine"
   view in the client. Terminals/browser/files render absent-with-reason — the v1
   capability-flag discipline ("degrades correctly either way") already covers this.
2. **Control.** Interrupt, `respondToPermission` (widen the deny-only type, route it,
   and deliver the prompt outward over the event stream), mid-run steering, and
   starting new runs with the user's own settings. Remote permission answering *is*
   "controlling what it's working on" — it is the heart of this phase.
3. **First-class remote session UX.** The remote machine's sessions in the sidebar
   (the `artemis` adapter already lists/resumes them), attribution of which token did
   what (today's traffic is counters-only by design — remote control wants a record),
   token expiry, and the warned setting for binding the desktop server beyond loopback
   — or the documented posture: headless server + tunnel only.

Also inherited free: interrupt-on-disconnect is already deliberate server behaviour
(a vanished client stops the run rather than burning the plan), and the
`@rx-ventures/artemis-sdk` package models how third parties read the catalogue.

## 7. Dock & terminal overhaul

**Current architecture, in one paragraph.** The dock is a single window-level rail to
the right of the entire pane grid — never per-pane. Seven tab kinds (preview · file ·
files · terminal · browser · tasks · agent) in a fixed, never-reordering strip; one
reconciler ([`reconcileDock`](../../apps/desktop/renderer/src/state/store.ts)) is the
sole writer of the visible strip. Snapshots (preview/file) are destroyed when their
owner leaves the screen; live surfaces (terminal/browser/agent) are hidden, never
dropped. Terminals are real PTYs owned by the main process (allowlisted shells, no
command channel by design, 256 KiB replay buffer), with live xterm instances parked in
an off-screen lot rather than unmounted. Restart persists an *arrangement, not a
session* — browsers as URLs, terminals as a count of fresh shells.

**The unresolved question the overhaul must answer** — named in
[`e-catch`](../design/e-catch.html): *whose dock is it?* Today the app does a third
thing neither option chose: it shows **every visible pane's tabs at once, unlabelled**.
In a 2×2 split, four terminals from four panes are four identical icons distinguishable
only by tooltip; the `+` opens a shell in the *focused* pane's cwd even while you look
at another pane's terminal; preview is a window singleton, so previewing in pane B
silently replaces pane A's preview; and restart keeps only the focused pane's dock.
The scope-chip fix prescribed in [`_layout.md`](../design/_layout.md) was implemented
for the tasks pane only, not the dock. This is the heart of the redesign — and the T3
research (§8) was pointed at exactly this question in T3 Code's pane design.

**Bugs found during the survey** (fixable now, independent of any redesign):

1. **⌘J can kill a running shell.** `toggleTerminal` closes — i.e. SIGHUPs — the
   terminal when it is already active (store.ts:3443-3460), contradicting the
   documented rule that *only the ✕ ends the process* (dock.ts:49-51,
   protocol/terminal.ts:143-145). No test covers `toggleTerminal`. ⌘J twice on a
   front terminal kills a `pnpm dev`.
2. **`DOCK_TAB_KINDS` omits `'files'`** (dock.ts:592), so a captured
   `activeKind: 'files'` is rejected at restore and comes back `null`.
3. **Closing a pane orphans its live surfaces.** `retirePane` closes agent tabs but
   not the pane's terminals/browsers — shells and pages keep running with no route
   back short of a window reload.
4. Stale comment: `MAX_TERMINALS = 16` claims to match a pane ceiling of sixteen;
   `MAX_PANES` is 8.
5. The dock `+` button lives *inside* the scrolling tab column, so enough tabs scroll
   it out of view. (Plus the stale xterm theme fallbacks already noted in §1.)
6. Found while fixing 1–5 (PR #271): **⌘⇧B has the same shape as the ⌘J bug** —
   `toggleBrowser` destroys the page on a second press. Left as-is there to keep
   scope; the dock rebuild's browser surface must fix it (toggle = focus, only ✕
   destroys).

**Recorded pain points** (from `_layout.md`, `e-catch`, and in-code comments): tabs eat
horizontal space in the narrowest panel on screen; nothing caps `file` tabs
("forty tabs across a long session" — e-catch proposes transient-vs-pinned tabs);
terminals open at a hardcoded 80×24 guess before the first fit; a terminal never
follows the conversation's cwd after start (tooltip shows the start directory
forever); exited terminals are distinguishable only by dimmed opacity; the dock floors
at 360px so it cannot be made narrow.

**Load-bearing constraints an overhaul must respect** — the survey catalogued twenty,
defended by comments and tests; the ones that shape any redesign: only the ✕ kills a
shell (tab visibility and process lifetime are separate axes); xterm elements are
moved, never unmounted, and output never passes through React state; the strip never
reorders itself; focus is requested by intent, never stolen on mount; main owns shell
choice, ids, and lifetime, and strips `CLAUDE_CONFIG_DIR`/`CODEX_HOME` so a terminal
can't silently bill another profile's account; a browser hides by telling main, not by
CSS (`WebContentsView` composites above the document); `dockAutoOpen: false` must keep
suppressing agent-opened surfaces while letting user-requested ones through; restart
must keep storing an arrangement, not a session.

**Overhaul direction:** T3 Code answers e-catch's question — its work surfaces are
**thread-scoped**: typed tabs owned by and persisted with the conversation, shown for
the focused thread, collapsing to a sheet on narrow widths (§8, pattern 1). Translated
to Artemis: the dock scopes to the focused pane by default with an explicit all-panes
toggle (generalizing the tasks pane's `ScopeChip`), tabs carry their owner visibly,
dock actions act on the scope in view rather than silently on the focused pane,
preview stops being a window singleton, `retirePane` reclaims or re-homes live
surfaces, and transient-vs-pinned tab semantics cap the skim-debris problem.
Thread-scoped persistence would also fix the restart story (today: focused pane's
arrangement only) — but it must respect constraint 10 (an arrangement, not a session)
and the fact that pane ids are minted fresh per launch, so scope keys on *session id*,
not pane id. T3's terminal-to-chat bridges (selection → context chip, URL → preview)
are the additive-only kind of idea the house rules favor.

## 8. External influence: T3 Code and the ChatGPT/Codex macOS app

Full research: [T3-DESIGN-RESEARCH.md](T3-DESIGN-RESEARCH.md) (658 lines, ~70
primary-source citations). Second reference in progress:
[CODEX-CHATGPT-APP-RESEARCH.md](CODEX-CHATGPT-APP-RESEARCH.md).

**The T3 landscape, verified:** T3 Chat (Jan 2025, closed, $8/mo) is the consumer
multi-model chat app. **T3 Code (launched 2026-03-07) is an MIT-licensed, open-source
"agent harness control surface"** — Electron desktop + web + mobile, driving Claude
Code, Codex, Cursor, Grok, and OpenCode CLIs. It is Artemis's exact product category,
and because the source is public (`github.com/pingdotgg/t3code`, read at a pinned
commit), the research verified its design at implementation depth. T3 Chat's palette
was pulled verbatim from its shipped production CSS.

**Palette facts that anchor §1 and §2:**

- T3 Chat pink dark: background `#21141e` (a *plum* near-black — chromatic, not
  neutral), primary `#a3004c` on `#fbd0e8`; light background `#f2e1f4`.
- Even T3's "boring" grey theme avoids pure black: `#151515` / `#1f1f1f` / `#131313`.
- T3 Code dark: `neutral-950` canvas with surfaces as computed `color-mix` white-lifts
  (3–6%) and white-alpha borders; primary blue-violet `oklch(0.488 0.217 264)`.
- Both products derive full palettes from **`{canvas, accent}` seeds** via semantic
  role tokens — T3 Code even ships a built-in "T3 Chat pink" theme as just another
  seed pair.

**One tension to decide deliberately:** §2's worked example shows a T3-style pink at
hue 330 clears the palette test — but pink *is T3's brand*, and the design record's
round three exists precisely because the old violet was "the default accent of this
generation of AI tools." Adopting T3's *system* (seeded themes, role tokens, tinted
near-black) without adopting their *hue* is the clone-problem-aware reading; adopting
the hue too is a taste call the mockup round should settle with a control.

**The five most adoptable patterns** (each mapped to its Artemis section):

1. **Thread-scoped tabbed surface model** → §7. T3 Code's right panel is typed
   surfaces (terminal / diff / file / browser / agents), singleton-vs-keyed tabs,
   **persisted per thread**, close-others/close-right, collapsing to a sheet under
   980px. Terminals are Ghostty-rendered with splits (max 4 per group) and *bridge
   back to the chat* — a selection becomes a context chip, a URL becomes a preview
   pane. This directly answers e-catch's "whose dock is it": **the conversation's.**
2. **Seeded themes + semantic role tokens** → §1/§2. Full palette from two seeds;
   Artemis's token layer is already close (one file, semantic layer over raw tokens) —
   the delta is deriving surfaces by computed lift instead of five hand-picked
   lightnesses, which would make "grey instead of black" a *seed* change.
3. **Collapse-to-receipt transcripts** → transcript density work: one visible work-log
   entry per group, one-line receipts for old file changes, a timeline minimap, and a
   40px autoscroll re-arm band.
4. **Base/Overage usage bar with reserve-then-settle** → §4/§5. T3 Chat's documented
   4-hour-refill + monthly-overage buckets are designed against "fear of running out"
   — the same emotional problem our plan meters + handoff thresholds address; the
   reserve-then-settle accounting pairs directly with `drain-v1`.
5. **Provider-instance model picker** → §4. A rail of *instances* (not providers) with
   favorites, per-row stars, `mod+1..9` jumps, scored multi-field search with a
   favorite boost, disabled-with-reason gating, cost-tier `$` pips, and NEW-by-date
   badges. Artemis's per-profile quick-access pins are the favorites half; the
   `$`-pips are `MODEL_LOAD` rendered honestly; disabled-with-reason is already the
   house pattern (`GatedItem`, `ChoiceList`).

**The second reference:** [CODEX-CHATGPT-APP-RESEARCH.md](CODEX-CHATGPT-APP-RESEARCH.md).
Landscape verdict: "the Codex app on macOS" now means the **ChatGPT desktop app** —
the standalone Codex app (2026-02-02, "a command center for agents") updated in place
into it on 2026-07-09, with three modes (Chat / Work / Codex). Critically, **that app
is Electron** — every pattern in it is achievable in our stack. Its five most
adoptable patterns:

1. **One four-state status vocabulary** — Running / Needs input / Ready / Blocked —
   rendered identically everywhere (activity view, floating indicator, notifications),
   needs-input always first. Artemis's sidebar/status/waiting-badge surfaces should
   converge on one such vocabulary (§3, §7).
2. **Environment as a first-class chat property, with "Hand off" in the chat header**
   — Local ⇄ Worktree ⇄ another connected host, "transfers the chat and Git state,
   and switches the chat to that host," including QR-paired hosts whose remote loop
   is start / follow / **approve actions** / steer. This is ready-made vocabulary and
   interaction shape for §5 (profile pickup = handing off *who runs it*) and §6
   (remote = handing off *where it runs*) — the two features are one UI concept.
3. **The limit wall is a menu, not a wall** — finish the active turn on grace, then a
   banner naming the exhausted window, its reset time, and every option. Artemis's
   §5 phase-1 banner door is exactly this, and the multi-account option is the one
   move OpenAI structurally lacks — our differentiator.
4. **Model picker under the composer combining capability + cost + governance** —
   effort ladder per model, plan gating shown inline (present-but-gated, never
   hidden), dated deprecations with successors. Converges with T3's picker and §4's
   proposal from a second direction — strong signal the §4 shape is right.
5. **Theming as a portable validated system** — a shareable theme-JSON format with
   live preview; `palette.test.ts` is already the validator such a format needs.
   This is the main deliberate divergence from T3 (seeded single-opinion palettes vs
   user-portable themes); §1/§2 should pick one posture.

## 9. Stability: the run-lifecycle bugs

Three reported symptoms: **sessions detaching**, **Codex sessions refusing follow-up
messages**, and **a session reporting "done" while its run keeps executing**.
Diagnosed loop-first under the diagnosing-bugs discipline; status per symptom:

**Detach + rival runs (A, and the store-level half of C) — root-caused and FIXED.**
On-disk forensics found the real incidents: same-project session pairs whose newer
file plainly continues the older conversation (one first message reads "you were in
the middle of /code-review when I ran out of usage"), an hour-long run that flushed
its end-state into a brand-new empty session file 35 s after an app restart, and a
session created *inside* another's live run which then kept executing 24.7 minutes
past the newer one's finish. Mechanism, confirmed by a red test loop
([`lostPromotion.test.ts`](../../apps/desktop/renderer/src/state/lostPromotion.test.ts),
813 ms): the `run.end` handler promotes the session id into `resumeSessionId`, and
**every** split-brain repair keyed off that one field — so any *lost* promotion (app
restart mid-run, dropped `run.end`, guard refusal) left follow-ups blind: they
started a rival run against a still-working session, or opened a brand-new provider
session under a transcript the provider never had. Fix (in `submitPrompt`): the
pre-start registry check now consults every session id the pane knows
(`sessionIdsOf`, which includes the ended run's own id), and the continuation falls
back to the ended run's session id under exactly the promotion's own conditions —
same profile, same directory — so the account-invariant is preserved. Three
regression tests; 417 renderer state tests green.

**Codex follow-ups (B) — root-caused and FIXED (PR #272).** The real bug, found by
a live probe and reproduced deterministically: **codex-cli 0.147 answers
`thread/resume` with the thread object and emits no `thread/started` notification —
and the adapter only announced sessions from that notification.** A resumed run
therefore had no `session.started`, no recorded session id, and `send()` had no
thread to name: the literal "cannot send follow-up messages," even for sessions
whose rollout exists. Fixed by treating the resume/fork *response* as the
announcement (deduplicated if a server ever sends both), plus a mapper guard
holding events until `session.started`, plus dropping replayed usage from turns
this run didn't start (it was double-counting the prior turn's tokens into
`run.end`). Rider fix: the missing-rollout server error (`-32600 no rollout
found`) now routes through `isMissingRollout` into an actionable
`invalid_request` message instead of an opaque transport failure. The forensic
missing-rollout mystery resolved benignly: 0.147 **persists rollouts correctly**
when adapter-driven (probe verdict: PERSISTED under an isolated `CODEX_HOME`),
and no env leak exists in the adapter — the historical 25-of-32 gap is most
likely an older CLI build; the "two homes" evidence was user-run `codex` in
terminals (which deliberately strip `CODEX_HOME`) plus read-only version checks.
Adapter-level resume coverage went from zero to 64 tests; `codex:smoke` is now a
root script with a two-turn resume mode.

**Phantom done, upstream half (C) — bounded, not yet closed.** The store-level fix
above stops the *consequences* (rival runs), but the upstream loss of `run.end`
across an app restart/crash, and adoption of runs whose CLI outlived the app, remain
open. Compounding it: **Artemis writes no logs whatsoever** — every forensic finding
had to be reconstructed from side-effects. The overhaul should add a session-lifecycle
log (run started/ended/adopted/released, with session + profile ids) as its own small
workstream.

Adjacent confirmed bugs listed in §7 (⌘J kills a live shell; pane close orphans
terminals/browsers; `DOCK_TAB_KINDS` missing `'files'`) remain to fix. A hygiene
finding from the forensics, outside the code: three shared-store transcripts contain
live third-party tokens pasted in chat (Supabase, Asana, one host token) — rotate
them; transcripts are machine-shared plaintext.

## Sequencing

One release (2.0.0, big bang — settled 2026-08-29), but the *work* stays ordered by
risk isolation, honouring one-variable-at-a-time; PRs merge to main continuously and
the release is cut when the set below is whole. Stability (§9) is not a phase — its
fixes land first or alongside everything, since several later phases (picker joins,
handoff, remote) build directly on the machinery being debugged.

1. **§9 lifecycle fixes + §7's confirmed small bugs** — correctness before paint.
2. **Surface ramp (grey)** — seed/token edits + three escape hatches; control render
   first; palette test guards. Smallest, most visible. Decide T3-style seeded themes
   vs ChatGPT-style portable themes here (§8 pattern 5) — it changes *how* the ramp
   is expressed, not what it looks like.
3. **Accent (+ status hues if the family moves)** — separate change, own review, own
   control; icon re-rasterise rides along; fix the stale xterm fallbacks.
4. **Settings reorganization (§3)** — two-band nav, rehome the misfiled rows, scroll
   reset + row anchors, palette indexes all sections; deep-link ids frozen.
5. **Model picker join (§4)** — three facts per row + recommended row + T3/Codex
   picker patterns; no new plumbing.
6. **Dock & terminal overhaul (§7)** — thread-scoped ownership, the T3 surface model,
   preview de-singleton, transient-vs-pinned tabs; respects the twenty constraints.
7. **Cross-profile pickup (§5), phase 1 → 3** — the banner door first ("the limit
   wall is a menu"); it validates every precondition primitive the auto path reuses.
   Adopt the "Hand off" vocabulary from §8.
8. **Remote work (§6), in full** — observe, control, and remote terminals (ADR
   0004); same "Hand off" concept as §5, different axis, shared UI language.

The palette regroup and macOS-menu question ride with (4) but can trail.

## Settled decisions — 2026-08-29 grilling session

Vocabulary is recorded in [`CONTEXT.md`](../../CONTEXT.md); the four
architecture-grade decisions are ADRs 0001–0004 in [`docs/adr/`](../adr/).

- **Release shape: big bang.** PRs merge to main continuously (the detach fix is
  [#268](https://github.com/Rx-Ventures/artemis/pull/268)); everything ships as one
  release, versioned **2.0.0**, still just "Artemis."
- **Theming: seeded** (`{canvas, accent}` derivation; ADR 0001). Portable theme
  JSON deferred.
- **Accent: deep-fill blue-violet ~264°** (T3 Code's depth posture — ~L50 fills
  with light text — chosen because the teal's brightness is what made it hard on
  the eyes). Tools-cyan moves 250→~210; thinking stays 310 (46° clear). The
  clone-adjacency of 264 was flagged and accepted knowingly. Mockup round still
  renders a teal control per house rules.
- **Ground: bare neutral grey**, T3-boring lift (~15-16% L), no accent tint.
- **Light mode: full pass**, same seeds, with a split-tone variant (dark
  rail/light content) rendered and judged in the light round.
- **Settings: the full two-band nav** from §3, including the Agents+Memory-banks
  merge into *Instructions* and the new *Runs* section.
- **Model picker: `$`-pip cost posture** with exact multipliers in the row detail;
  exhausted models present-but-disabled with reset times.
- **Hand off: always a chosen act** (ADR 0003). The limit surface opens an
  informed picker — what happened, which profiles can take the work, live usage
  per candidate — and the user picks the target. No standing auto-move setting.
- **Remote: the whole thing** (ADR 0004) — observe + control + remote terminals,
  as a `remote` bridge mode, Tailscale-only reachability, manual address+token.
- **Dock: full rebuild** (ADR 0002) — conversation-owned surfaces, per-session
  persistence, sheet mode, terminal splits, and the terminal↔chat bridges as
  must-haves; xterm stays.

Still open (deliberately, for the mockup rounds to answer): exact seed values,
display-p3 vs sRGB ceilings in light mode, and the macOS-menu-mirroring question
from §3 — none block the start of work.
