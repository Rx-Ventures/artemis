# The ChatGPT desktop app & Codex surfaces — design reference for the Artemis overhaul

Written 2026-08-29. Verified against OpenAI primary sources fetched today: the two
launch posts ([Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/),
2026-02-02, and [Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/),
2026-04-16), the canonical product docs at **learn.chatgpt.com** (observed today:
`developers.openai.com/codex` 308-redirects there; every docs page also serves a
Markdown twin at `<url>.md`), help.openai.com articles (read via browser — the site
403s plain fetches), and the [openai/codex](https://github.com/openai/codex) GitHub
repo (CLI `rust-v0.151.0`, released 2026-08-29; repo docs are now stubs pointing at
the hosted docs). Secondary sources (Simon Willison, devclass, community theming
write-ups, GitHub issues) are **marked inline** wherever they carry a claim the
primary sources don't. Companion docs: [OVERHAUL-PREP.md](OVERHAUL-PREP.md) (the
overhaul this informs), [CODEX-ADAPTER-RESEARCH.md](CODEX-ADAPTER-RESEARCH.md)
(driving `codex app-server` as a provider adapter — different topic, cited here only
where its live-verified protocol facts back a UX claim), and T3-DESIGN-RESEARCH.md
(the other external reference, researched separately — deliberately not covered here).

## Verdict

**"The Codex app on macOS" today means the ChatGPT desktop app.** The standalone
Codex app OpenAI shipped on 2026-02-02 as "a command center for agents" lived five
months under its own name; on **2026-07-09 it became the new ChatGPT desktop app** —
the Codex app updated in place into an app containing three modes (**Chat**, **Work**,
**Codex**), and the old native ChatGPT macOS app was renamed **ChatGPT Classic**
(maintained, but new agent features land only in the new app). The vendor-recommended
path going forward is unambiguous: openai.com/codex is now titled "Codex in ChatGPT"
and its download button installs the ChatGPT desktop app. The other Codex surfaces —
CLI, IDE extension, cloud — keep the Codex name and share account, config, session
history, skills, and rate limits with the app.

Two facts make this reference unusually actionable for Artemis. First, **the app is
Electron** (confirmed by OpenAI's head of developer experience via devclass, and by
the community projects that repack the macOS bundle for Linux/Windows) — every
pattern in it is achievable in our stack by construction. Second, OpenAI's answers to
our overhaul's two hardest features already exist as shipped, named product surfaces:
**"Hand off"** (a chat header control that moves a chat between Local ⇄ Worktree ⇄
another **connected host**, transferring "the chat and Git state") and **Remote
connections** (QR-paired trusted devices over a "secure relay layer", with remote
approval of permission requests as the core interaction). Their vocabulary — hand off,
connected host, follow, approve — is worth adopting wholesale.

The five most adoptable patterns, in one line each (details in §8):
one four-state status vocabulary (**Running / Needs input / Ready / Blocked**) reused
by every surface; **environment (Local/Worktree/Cloud) as a first-class chat property**
with Hand off in the header; a **limit banner that always names your options** (finish
the turn, then: credits / banked reset / upgrade / wait / smaller model); the **model
picker under the composer** with a reasoning-effort ladder and admin-then-local
precedence; and **theming as a portable, validated system** (accent/surface/ink +
semantic diff colors, JSON import/export, live side-by-side preview).

---

## 1. Product landscape: what exists, and what "the Codex app" means now

Timeline, all from OpenAI's own posts and help center:

| Date | Event |
|---|---|
| 2024-08-06 | ChatGPT macOS app (native) gains the **companion window** (⌥Space, stays in front) ([release notes](https://help.openai.com/en/articles/9703738-desktop-app-release-notes)) |
| 2024-11-14 | **Work with Apps** beta — ChatGPT reads content from coding apps ([release notes](https://help.openai.com/en/articles/9703738-desktop-app-release-notes)) |
| 2025-04 | Codex launches (CLI first) ([launch post](https://openai.com/index/introducing-the-codex-app/): "Since we launched Codex in April 2025") |
| 2025-12 (mid) | GPT-5.2-Codex ships; "overall Codex usage has doubled" since ([launch post](https://openai.com/index/introducing-the-codex-app/)) |
| 2026-02-02 | **Codex app for macOS** — "a command center for agents" ([launch post](https://openai.com/index/introducing-the-codex-app/)) |
| 2026-03-04 | Codex app on Windows ([launch post update](https://openai.com/index/introducing-the-codex-app/)) |
| 2026-04-16 | Computer use, in-app browser, image gen, memory, 90+ plugins, SSH devboxes ([update post](https://openai.com/index/codex-for-almost-everything/)) |
| 2026-07-09 | **Codex app becomes the ChatGPT desktop app** (Chat + Work + Codex); old app renamed **ChatGPT Classic** ([migration article](https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app), [macOS release notes](https://help.openai.com/en/articles/9703738-desktop-app-release-notes)) |
| 2026-07 | GPT-5.6 family: **Sol / Terra / Luna** ([What's new](https://learn.chatgpt.com/docs/whats-new)) |
| 2026-08 | Linux desktop preview (.deb/.rpm); **Import from Claude Code, Claude Cowork, and Cursor** ([What's new](https://learn.chatgpt.com/docs/whats-new)) |

The surfaces as the docs name them today ([glossary](https://learn.chatgpt.com/docs/glossary)):

- **ChatGPT desktop app** — "Desktop app with ChatGPT and Codex, including Chat and
  Work, projects, file previews, scheduled tasks, and developer tools." macOS,
  Windows, Linux preview. *This is the design reference.*
- **Codex CLI** — "Terminal client for running Codex interactively or in scripts."
  Open source, Rust, ~120k stars, releasing near-daily (0.151.0 on 2026-08-29).
- **Codex IDE extension** — VS Code, JetBrains, Cursor, Windsurf.
- **Codex cloud** — "Run tasks in isolated cloud environments … start work from the
  web, GitHub, GitLab, Linear, or Slack" ([cloud docs](https://learn.chatgpt.com/docs/cloud)).
- **Codex app-server** — "Local JSON-RPC server for embedding Codex threads, turns,
  approvals, history, and streamed events in custom clients" — the seam
  [CODEX-ADAPTER-RESEARCH.md](CODEX-ADAPTER-RESEARCH.md) drove live.
- **ChatGPT Work** — the non-coding sibling agent ("research, analysis, and creating
  documents"); same app, same shared usage pool. Out of scope here except where it
  shares UX machinery with Codex.

Migration mechanics worth noting for our own future rebrands: Codex-app users just
updated ("After the update, it becomes the new ChatGPT desktop app"); ChatGPT-app
users were prompted to install the new app alongside, and Classic keeps receiving
model updates and fixes ([migration article](https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app)).
The rename drew visible friction (Daring Fireball's ["Can someone explain to me how
to get ChatGPT Classic?"](https://daringfireball.net/linked/2026/07/11/can-someone-explain-to-me-how-to-get-chatgpt-classic),
[Michael Tsai's roundup](https://mjtsai.com/blog/2026/07/10/chatgpt-work-and-chatgpt-classic/)
— both secondary) — a caution about renaming an app out from under non-developer users.

Simon Willison's launch-day framing (secondary, but the sharpest one-liner in the
record): "Like Claude Code, Codex is really a general agent harness disguised as a
tool for programmers" ([post](https://simonwillison.net/2026/Feb/2/introducing-the-codex-app/)).
The July merge is OpenAI acting on exactly that.

## 2. Visual design

There is no published design spec; what follows is assembled from the docs'
Appearance settings, the theme wire format, and marked secondary descriptions.

**Not a single-palette app.** The strongest visual-design fact about this reference
is structural: since a late-March 2026 update, appearance is a **user-owned theming
system**, not one opinionated palette. [Settings → Appearance](https://learn.chatgpt.com/docs/reference/settings)
contains: base theme (Light / Dark / System), **accent, background, and foreground
color adjusters**, contrast, a **UI font and a separate code font**, and **custom
theme sharing**. The portable wire format (documented by the community
[Codex Knowledge Base](https://codex.danielvaughan.com/2026/03/30/codex-app-theming-customisation/),
secondary but concrete) is `codex-theme-v1:{JSON}` with keys including
`theme.accent`, `theme.surface`, `theme.ink`, `theme.contrast`,
`theme.opaqueWindows` (false ⇒ **translucent sidebars** — the one macOS-material cue
in an otherwise cross-platform Electron app), `theme.fonts.ui` / `theme.fonts.code`,
and `theme.semanticColors.diffAdded` / `.diffRemoved` / `.skill`. Built-in presets
include Catppuccin, Monokai, Solarized; there are **partner themes** (Linear, Notion);
a **live side-by-side preview** compares the edit against current. The CLI mirrors
this with `/theme` (live-preview picker), `tui.theme` in config.toml, and drop-in
`.tmTheme` files in `~/.codex/themes/`.

**Default look** (secondary/inferred, flagged accordingly): Willison describes the
launch app as "a dark sidebar and light main content area" — a split-tone default
rather than uniform dark. GitHub issues corroborate the sidebar being treated as a
distinct surface ([#21841](https://github.com/openai/codex/issues/21841) asks for
theme colors to reach the left sidebar background;
[#25323](https://github.com/openai/codex/issues/25323) reports auto light/dark
switching breaking sidebar contrast) — i.e. even OpenAI is living with the
chrome-vs-content two-surface problem Artemis's `--panel`/`--abyss` ramp solves in
tokens. I could not verify exact default hex values from any primary source; treat
specific greys as unknown.

**Semantic color, not decorative color.** The only colors the theme format names
semantically are diff-added, diff-removed, and skill callouts. Status colors appear
in the hardware companion instead: Codex Micro's per-chat agent keys light "white
for idle, blue for thinking, green for complete, amber for input needed, red for
error" ([Codex Micro docs](https://learn.chatgpt.com/docs/features/codex-micro)) —
OpenAI's status hue mapping in its plainest form.

**Density and chrome.** The commands reference shows a chrome-light,
keyboard-forward app (⌘K command menu, ⌘B sidebar, Ctrl+` terminal — §4). The old
ChatGPT Classic app carried the native-macOS affordances (menu-bar icon, ⌥Space
companion window, vibrancy); the new app's descendant of the companion window is a
settings group called **"Keep a chat near your work"** — a pop-out chat window with
an always-on-top toggle ([settings](https://learn.chatgpt.com/docs/reference/settings)) —
plus a **Quick chat** entry point next to New chat ([quickstart](https://learn.chatgpt.com/docs/quickstart)).
No global ⌥Space launcher is documented for the new app.

**Personality as a design axis.** Tone is settings-level: `/personality` chooses
"Friendly, Pragmatic, or None … without any change in capabilities"
([launch post](https://openai.com/index/introducing-the-codex-app/),
[settings](https://learn.chatgpt.com/docs/reference/settings)). Mode changes the
*rendering*, too: "the desktop app changes the interface and how the agent presents
its work" between Work and Codex — same engine, different information density per
audience ([Use ChatGPT](https://learn.chatgpt.com/docs/use-chatgpt)).

## 3. Panes, terminals, and work surfaces

The app's model: **chat thread as spine, specialist panes around it.** "Agents run
in separate threads organized by projects, so you can seamlessly switch between
tasks without losing context. The app lets you review the agent's changes in the
thread, comment on the diff, and even open it in your editor"
([launch post](https://openai.com/index/introducing-the-codex-app/)).

- **Review pane** ("Desktop app view for inspecting diffs, comments, and Git
  changes" — [glossary](https://learn.chatgpt.com/docs/glossary)). Diff scopes:
  **"Unstaged," "Staged," "Commit," "Branch," or "Last turn"** — note "Last turn" as
  a first-class scope: *what did the agent just do* is a query the UI can answer.
  It shows "changes made by Codex, changes you made yourself, and any other
  uncommitted changes." Hover a line, press **+**, and the inline comment becomes an
  instruction the agent can act on "more precisely than with a general instruction."
  Stage/revert works per-diff, per-file, and **per hunk**. A **repository selector**
  in the header serves multi-repo projects. With `gh` auth, PR "context and feedback
  from reviewers" appear alongside the diff ([code review docs](https://learn.chatgpt.com/docs/code-review)).
- **Integrated terminal** — Ctrl+` or the header icon; "each chat includes a
  terminal scoped to its current project or worktree"; crucially **"ChatGPT can read
  the current terminal output, so it can check a running development server or refer
  to a failed build"** ([terminal docs](https://learn.chatgpt.com/docs/integrated-terminal)).
  Multiple terminal tabs since April 2026 ([update post](https://openai.com/index/codex-for-almost-everything/)).
  In the CLI, background terminals get `/ps` (list + recent output "to gauge
  progress") and `/stop` ([CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
- **Summary pane / chat sidebar** — "surface the agent's plan, sources, generated
  files, and chat summary so you can steer the work" while a task runs
  ([files docs](https://learn.chatgpt.com/docs/artifacts-viewer)); introduced as "a
  new summary pane to track agent plans, sources, and artifacts"
  ([update post](https://openai.com/index/codex-for-almost-everything/)).
- **Files/artifacts viewer** — rich previews for PDFs, spreadsheets, slides, docs,
  HTML (rendered ⇄ source toggle), with an **annotation tool**: "point to a specific
  part of a file and tell ChatGPT what to change" ([files docs](https://learn.chatgpt.com/docs/artifacts-viewer)).
  File tree ⌘⇧E, file search ⌘P ([commands](https://learn.chatgpt.com/docs/reference/commands)).
- **In-app browser** — ⌘T; "comment directly on pages to provide precise
  instructions to the agent"; optional Chrome DevTools Protocol access behind
  Settings → Browser → Developer mode with explicit per-use approval
  ([update post](https://openai.com/index/codex-for-almost-everything/),
  [help article](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).

**Concurrency surfaces.** Worktrees are the isolation primitive: "Each agent works
on an isolated copy of your code … check out changes locally or let it continue
making progress without touching your local git state"
([launch post](https://openai.com/index/introducing-the-codex-app/)). Two tiers —
**Codex-managed** ("lightweight and disposable", one per chat, most-recent-15 kept,
deleted when the chat is archived, *never* deleted while pinned or in progress) and
**permanent** (long-lived, multiple chats) ([worktrees docs](https://learn.chatgpt.com/docs/environments/git-worktrees)).
Switching between concurrent agents is cheap and redundant by design: sidebar
projects with pinning ("Pinning doesn't add context … It only changes where the
project or chat appears" — [projects docs](https://learn.chatgpt.com/docs/projects)),
an **Activity view** of chats that are "unread, running, or waiting for your
response" ([notifications docs](https://learn.chatgpt.com/docs/notifications)),
⌘⌥←/→ chat cycling, `/agent` to switch into a subagent's thread, and two ambient
tiers: **Pets** (a floating always-on-top companion that "prioritizes chats that
need input, followed by blocked, ready, and running" —
[pets docs](https://learn.chatgpt.com/docs/pets)) and the **Codex Micro** hardware
keyboard (six agent keys, one chat each, status by LED color —
[docs](https://learn.chatgpt.com/docs/features/codex-micro)).

**Long output and long work.** Condensation vocabulary: **Compaction** —
"summarizing older context so long-running work can continue"
([glossary](https://learn.chatgpt.com/docs/glossary)); `/compact` on demand; CLI
`/raw` toggles raw scrollback when you want the uncondensed stream. For
hours-to-weeks work there is **Goal mode**: `/goal` text "becomes both the first
prompt and the completion criteria," and "the goal progress row appears above the
composer" with pause/resume/edit/clear ([long-running work](https://learn.chatgpt.com/docs/long-running-work)).
**Automations** run scheduled background work whose results "land in a review
queue"; since April they can reuse existing threads, and "Codex can now schedule
future work for itself and wake up automatically" ([launch post](https://openai.com/index/introducing-the-codex-app/),
[update post](https://openai.com/index/codex-for-almost-everything/)).

## 4. Settings and information architecture

**Desktop app settings** (⌘,) — thirteen sections, ordered as documented
([settings reference](https://learn.chatgpt.com/docs/reference/settings)): General
(multiline-enter, **prevent sleep while running**, follow-up behavior) · Profile
(activity insights, token metrics, referrals) · Keyboard shortcuts (searchable by
command *and by keystroke*, rebindable, reset) · Notifications · Appearance (§2) ·
Pets · Browser (plugins, extension, site allow/block) · Computer use · Personalization
(personality default, custom instructions) · Suggested prompts · Memories · Archived
chats · Keep a chat near your work. The axis is **user intent, not subsystem** —
there is no "Advanced"; even sandboxing hides behind the permissions control rather
than a settings pane. Approval-mode *enablement* lives in Settings → General, while
mode *selection* sits "below the composer" in the run surface
([permissions](https://learn.chatgpt.com/docs/permission-modes)) — the
what-the-next-prompt-does controls live on the composer, exactly the split Artemis's
status line already makes.

**Developer config is layered files, not UI.** `~/.codex/config.toml` (user) plus
trusted per-project `.codex/config.toml`; **profiles** are "named configuration
layers" selected by `--profile` / `profile`, stored as sibling
`profile-name.config.toml` files; admin **`requirements.toml`** sits above
everything ("managed requirements.toml requirements override workspace starting
defaults, and workspace starting defaults override a member's local starting
choice" — [help article](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).
Notable tables: `permissions` (named least-privilege profiles), `hooks` (lifecycle:
PreToolUse/PostToolUse/SessionStart/SessionEnd), `notify` (external program on
events), and a whole `tui.*` namespace — `tui.theme`, `tui.animations`,
`tui.keymap.<context>.<action>`, `tui.status_line` (ordered footer items),
`tui.terminal_title` ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
The CLI exposes the same knobs interactively: `/statusline` "configure TUI
status-line fields interactively," `/keymap`, `/title`, `/debug-config` ("print
config layer precedence") ([CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).

**Command-bar affordances.** One command menu (⌘K / ⌘⇧P) plus per-mode composer
slash commands; ~60 CLI slash commands are the completest catalog
([commands reference](https://learn.chatgpt.com/docs/reference/commands),
[CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
Standouts beyond those already cited: `/fork` (clone chat, fresh id, transcript
preserved), `/side` / `/btw` (ephemeral side-chat without disturbing the main
transcript), `/plan` (plan mode), `/review`, `/import` (Claude Code / Cursor
migration), `/init` (AGENTS.md scaffold). **Deep links**: a `codex://` URL scheme —
`codex://threads/new?prompt=<text>&path=<dir>`, `codex://settings`,
`codex://skills` — OS-level automation into the app.

## 5. Model picker

Current lineup ([models docs](https://learn.chatgpt.com/docs/models)): the
**GPT-5.6 family** — **Sol** ("flagship … strongest capability for complex coding,
computer use, research, and cybersecurity"; the default, at medium reasoning; the
docs' guidance is a single sentence: "If you are unsure, start with Sol"),
**Terra** ("balanced … competitive with GPT-5.5 at a lower cost"), **Luna** ("fast
and affordable … lowest cost in the family"). Terra and Luna are *not available on
Codex cloud* — surface availability differs per model. **GPT-5.3 Codex Spark** is a
research preview gated to **Pro, desktop + CLI only** — plan *and* surface gating in
one row. Deprecation is done with dates and named replacements: "GPT-5.4 and
GPT-5.4 mini retire from Codex on August 31, 2026" → Terra / Luna respectively, with
explicit instructions to update workspace defaults and automations
([help article](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).

Presentation: **picker beneath the composer** in app/web/IDE (⌃⇧M), `/model` in the
CLI — which "choose[s] the active model **(and reasoning effort, when available)**"
in one control. Reasoning effort is a ladder — Light/Low, Medium, High, Extra High,
plus **Max** and **Ultra** ("leverages subagents for parallel work division") — and
each model advertises which efforts it supports. The app-server protocol confirms
the picker's data shape: `model/list` returns `supportedReasoningEfforts`,
`defaultReasoningEffort`, `isDefault`, `displayName`, `description` per model
([CODEX-ADAPTER-RESEARCH.md](CODEX-ADAPTER-RESEARCH.md), verified live). Orthogonal
to model choice: **Fast mode** — "speed setting that makes supported models respond
faster at a higher credit cost" (`/fast`, default-on, admin-controllable) — speed is
priced, not modeled ([glossary](https://learn.chatgpt.com/docs/glossary),
[help article](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).

Defaults are governance-aware end to end: workspace admins set "the starting model,
reasoning level, speed, Fast Mode availability, and new-chat behavior," and "members
can switch away from a starting default only when the model remains available to
them and no enforced requirement prevents the change" ([help article](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).

## 6. Usage limits and plan UX

Structure ([pricing docs](https://learn.chatgpt.com/docs/pricing),
[help article](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)):

- **Windows:** a **5-hour window** on all plans, plus weekly limits ("Additional
  weekly limits may apply"). Limits are communicated as *message-range estimates per
  model per plan* (e.g. Sol on Plus "10–100" messages per window vs Luna "250–2,000")
  — honest ranges, not false precision.
- **Credits** overlay the windows: a per-model rate card (Sol input 100 credits/M
  tokens vs Luna 5), purchasable by Plus/Pro without a plan change; one **shared
  pool across Codex, ChatGPT Work, Excel, and Workspace Agents**. Fast mode burns
  credits faster; image generation "3–5x faster on average"; cloud chats run Sol
  "and may use more of your allowance than local messages."
- **Meters:** Settings → Usage and the dashboard at `chatgpt.com/codex/settings/usage`;
  CLI `/status` (model, permissions, remaining context, **remaining limits**) and
  `/usage` ("view account token usage or use a rate-limit reset" — daily / weekly /
  cumulative). Where enabled, the desktop app shows **per-chat credit usage**, with
  dollar estimates only if the workspace turns on member cost visibility. Over
  app-server, `account/rateLimits/read` returns
  `{ primary: { usedPercent, windowDurationMins, resetsAt }, credits, planType }` with
  an **unsolicited `account/rateLimits/updated` push**
  ([CODEX-ADAPTER-RESEARCH.md](CODEX-ADAPTER-RESEARCH.md), verified live).
- **Hitting the wall:** graceful, then optioned. "If you reach a usage limit during
  an active turn, Codex can continue working on that turn, subject to fair-use
  limits" — the run is never beheaded mid-turn. Then a **limit banner/notice names
  the options for your account**: add credits, apply an available reset, upgrade, or
  wait for the shown reset time — plus the doc-level suggestion to "switch to a
  smaller model to make your usage limits last longer."
- **Banked resets:** referral promotions grant stored rate-limit resets; "Using a
  full banked reset refreshes your 5-hour and weekly Codex usage windows and changes
  your weekly reset date," redeemed from the profile menu's usage summary ("1 reset
  available"). A *bankable* limit-relief currency is a genuinely novel plan-UX idea.
- **Accounts:** one ChatGPT login shared across app/CLI/IDE/cloud (CLI and extension
  share cached credentials; `~/.codex/auth.json` or OS keyring). Workspace is chosen
  at sign-in and enforceable via `forced_chatgpt_workspace_id`. **No documented
  multi-account switcher or cross-account handoff exists on any surface** — when
  credits look missing the help article's first advice is "check that you're in the
  correct account or workspace." Artemis's multi-profile rotation remains a
  differentiator; OpenAI solves exhaustion with money (credits) and time (resets),
  not with account plurality.

## 7. Cloud/local task handoff and remote work

OpenAI splits what Artemis's §5/§6 call "remote" into three distinct, named
mechanisms — the distinctions are worth stealing as much as the mechanics:

**a) Environment handoff (same machine): Local ⇄ Worktree.** Every Codex chat has an
environment — **Local** ("work directly in your current project directory"),
**Worktree** ("isolate changes in a Git worktree"), or **Cloud** — chosen at chat
creation ([modes docs](https://learn.chatgpt.com/docs/environments/modes)).
**Handoff** is the glossary term: "Moving a chat and its work between Local and
Worktree." The UI is a **"Hand off" button in the chat header**; Codex "handles the
Git operations required to move the chat safely," and a chat remembers its worktree
("if you hand the chat back to a worktree later, Codex returns it to that same
background environment") ([worktrees docs](https://learn.chatgpt.com/docs/environments/git-worktrees)).

**b) Delegate to cloud, pull back locally.** Cloud chats run in OpenAI-managed
containers configured per repo (setup scripts, secrets stripped before the agent
phase, container cache); started from web, GitHub, GitLab, Linear, Slack — or from
the terminal: **`codex cloud`** lets you "browse active and completed chats, submit
work to a configured environment, and **apply the result to your local repository**
from the terminal" ([CLI docs](https://learn.chatgpt.com/docs/codex/cli),
[cloud docs](https://learn.chatgpt.com/docs/cloud)). On completion you "review the
summary and diff, request a follow-up, or open a pull request." Steering mid-flight
is by follow-up message; a hard *interrupt* verb for a running cloud task is **not
documented** on the current pages (unverified — likely exists in UI as stop/cancel,
but I found no primary text).

**c) Remote connections (cross-device): connected hosts.** The direct analogue of
Artemis's remote-work ask ([remote connections](https://learn.chatgpt.com/docs/remote-connections),
[Codex Remote](https://learn.chatgpt.com/docs/remote)):

- Vocabulary: a **connected host** is "a computer or development environment that
  provides files, tools, and shell access"; "remote access uses the connected host's
  projects, chats, files, credentials, permissions, plugins, Computer Use, browser
  setup, and local tools." The mobile surface is called simply **Remote**.
- Pairing: the desktop app displays a **QR code**; scanning "pairs that phone with
  that host"; "approve remote access and complete any requested verification"; a
  "**secure relay layer** keeps trusted machines reachable across your authorized
  ChatGPT devices." Same account/workspace required on both ends.
- The phone loop is **start / follow / approve / steer**: "choose your connected
  computer and project, describe the task"; "send new instructions without returning
  to your desk"; and the heart of it — "**review commands and requested actions
  before Codex continues working**": remote permission answering, precisely the
  phase-2 core [OVERHAUL-PREP.md](OVERHAUL-PREP.md) §6 identified for Artemis.
- **Desktop-to-desktop** is symmetric: "continue work from another supported device
  running the ChatGPT desktop app," and one device can "allow remote access and
  control another device at the same time." SSH devbox targets are in alpha.
- **Cross-host chat handoff** exists and reuses the §a machinery: pick the
  destination in the chat footer, confirm the branch, and "Codex creates or reuses a
  worktree on the destination host, **transfers the chat and Git state, and switches
  the chat to that host**." That is Artemis's cross-machine pickup, shipped, with a
  three-word UX (Hand off → destination → confirm).
- Liveness is the user's problem, stated plainly: keep the host "awake, online, and
  signed in" (lid-open + power on Mac laptops); the app offers "Prevent sleep while
  running" and Windows "Remote Control" respects per-device "discovery and control"
  settings.

**Notifications** close the loop: desktop turn-completion alerts fire "never, only
while ChatGPT is in the background, or always," with separate toggles for
permission-request and question notifications; web adds push/email/SMS channels; the
CLI can "run external programs on turn completion" via `notify`
([notifications docs](https://learn.chatgpt.com/docs/notifications)).

## 8. Translation to Artemis

Numbered for adoption debate; each names its overhaul section in
[OVERHAUL-PREP.md](OVERHAUL-PREP.md). Where the two external references pull in
different directions, the divergence is flagged for T3-DESIGN-RESEARCH.md to settle
— judged per the house rule against each vendor's forward-looking path.

1. **One four-state status vocabulary, many renderers (§7, §3).** Running / Needs
   input / Ready / Blocked is rendered identically by the Activity view, the
   floating pet, notification triggers, and hardware LEDs — and prioritized
   consistently (needs-input first, then blocked, ready, running). Artemis's
   sidebar rows, dock tabs, and tasks surfaces should agree on exactly one such enum
   and one priority order. Cheap, high-leverage, additive.
2. **Environment as a chat property; "Hand off" as the verb (§5, §6).** Codex makes
   *where work runs* (Local/Worktree/Cloud/host) a visible property of every chat
   with one header control to move it, and the move "transfers the chat and Git
   state." Artemis's cross-profile pickup should present the same way: the account a
   session runs under is a property with a one-action move ("Continue on <profile>"),
   not a buried recovery flow. Adopt the vocabulary — hand off, destination,
   transfer — and the memory ("hand the chat back … returns it to that same
   environment").
3. **The limit wall is a menu, not a wall (§4, §5).** Finish the active turn
   (fair-use), then a banner that names the exhausted allowance, the reset time, and
   *every* available action: credits / banked reset / upgrade / wait / smaller
   model. Artemis's phase-1 "banner grows a door" should match this shape — and
   Artemis has a door OpenAI structurally lacks: **another account**. Nothing in
   OpenAI's surface handles multi-account; our rotation is differentiation, and the
   OVERHAUL-PREP recommendation-row plan already exceeds this reference.
4. **Model picker = capability + cost + governance in one control (§4).** Ladder of
   reasoning efforts per model (the SDK equivalent of Sol-medium defaults), plan and
   surface gating shown inline (Spark's "Pro, desktop+CLI only" row proves
   present-but-gated beats hidden — same as our palette's GatedItem precedent),
   deprecations with dates and named successors, and a one-line default ("If you are
   unsure, start with Sol"). Also: **speed as an orthogonal, priced toggle** (Fast
   mode) rather than a model variant — relevant to the §4 open question on burn-rate
   words vs numbers; OpenAI answers "words in the picker, numbers in the meter."
5. **Theming as a validated, portable system (§1, §2).** Accent/surface/ink +
   contrast + two fonts + *semantic* diff colors, serialized (`codex-theme-v1`
   JSON), shareable, live side-by-side preview against a control render. Artemis
   already owns the hard part — `palette.test.ts` re-deriving AA contrast and hue
   spacing — which is precisely the validator a theme format needs. **Divergence to
   settle:** this reference ships a theming *system*; T3 (per §7/§8 of OVERHAUL-PREP)
   ships an opinionated palette. Middle path worth considering: opinionated default,
   token-file escape hatch, test as gatekeeper. Also note the split-tone default
   (dark sidebar / light content, secondary-sourced) is a *third* option distinct
   from both our uniform-dark ramp and T3's.
6. **"Last turn" as a diff scope; comments as steering (§7).** The review pane's
   scopes (Unstaged/Staged/Commit/Branch/**Last turn**) and the pattern that inline
   comments on diffs, files, and browser pages all become precise agent
   instructions. For the dock overhaul: every work surface should answer "what did
   the agent just change" in one click, and every surface that renders output should
   accept positioned feedback.
7. **Agent-readable, chat-scoped terminals (§7).** "ChatGPT can read the current
   terminal output" — the terminal is shared context, not just a shell; plus `/ps`
   for background terminals with recent-output peek. Artemis's terminal overhaul
   should treat agent-visibility of terminal state as a capability flag per pane.
8. **Remote = observe + approve first (§6).** OpenAI's remote surface leads with
   following progress and answering approval requests, exactly matching
   OVERHAUL-PREP §6's phase 2 ("remote permission answering *is* controlling what
   it's working on"). Their trust framing is adoptable verbatim: explicit pairing
   ceremony (QR + approval), "only connect devices you own and trust," relay keeps
   hosts reachable, liveness stated as a user responsibility with a
   "prevent sleep while running" assist.
9. **Settings by intent; run-controls on the composer (§3).** Thirteen
   intent-named sections, no "Advanced," approval-mode enablement in Settings but
   selection below the composer, keyboard shortcuts searchable by keystroke, and
   `codex://` deep links into specific panes (Artemis's deep-link ids are already
   load-bearing — a custom URL scheme is the natural next step). Their
   subsystem-shaped config (`config.toml` + profiles + `requirements.toml`) stays in
   files for developers — supporting OVERHAUL-PREP §3's "Infrastructure divider,
   intent-shaped head" split, and the precedence chain (managed > workspace > local)
   is a ready-made model for Artemis shared-config vs profile settings.
10. **Compaction + goal row for long work (§7, §5).** Long output condenses by
    summarization with an escape hatch to raw scrollback; long *work* gets a
    persistent goal ("both the first prompt and the completion criteria") rendered
    as a progress row above the composer with pause/resume/edit/clear. Both are
    directly portable to Artemis's transcript and auto-handoff surfaces (a handoff
    document is, in this vocabulary, a goal that survives the move).

**What this reference does *not* offer** (so the overhaul doesn't look for it here):
no multi-account model (§3 above); no visible-by-default cost numbers (credits are
meters, dollar estimates admin-gated); no published palette spec (the design system
is user-tunable precisely because OpenAI declined to pick one grey); and the
February-era "command center" branding is already gone — the durable ideas are the
mechanisms (threads, worktrees, hand off, review queue), not the name.
