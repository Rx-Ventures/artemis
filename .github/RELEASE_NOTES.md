Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.12.0

- **Light mode, with a system/light/dark toggle in the header.** Artemis was
  dark-only by construction, and the Appearance pane said so in as many words.
  It supports a theme now, and the control sits beside Settings in the window
  rather than inside it — the theme is the one preference whose whole effect is
  the window you are looking at, and putting it behind a modal means covering it
  up to reach it. **System** keeps answering after the machine changes its mind
  at sunset. The choice is resolved before the first frame, so choosing light on
  a dark machine no longer means watching the wrong palette flash on every
  launch. The values are measured rather than picked: every hue holds fixed
  between the two palettes, so a diff is the same green in both.

- **Standing instructions every run carries: Settings → Agents.** The
  conventions that hold for every session — "run the typechecker before saying
  it's done", "this repo uses pnpm" — had nowhere to live except the first
  message of each conversation, retyped. Now they are a library of named
  prompts, each with a Markdown body and its own profile scoping, appended to
  the provider's system prompt on every run. **It appends and never replaces**,
  so the provider's own description of its tools stays intact. Artemis ships one
  prompt of its own, for Cerebro, read-only so that it improves when Artemis
  updates rather than freezing at whatever you first saw.

- **A delegated agent's conversation opens in a tab.** The delegated list could
  say what a subagent was costing, but not what it was *doing* — a subagent
  writes its own transcript beside its parent's, and the delegating turn keeps
  only the final report. On one real session, a single agent's file held **41
  tool calls** that appear nowhere in the thread that launched it. Clicking a row
  opens that conversation, with every tool card, diff and fold the main
  transcript has.

- **A conversation with live delegated work is no longer treated as idle.**
  Backgrounded agents routinely outlive the turn that launched them, and
  navigating away used to retire the pane outright — destroying the rows, the tab
  they feed, and the only place the finish could land.

- **A reopened session no longer replays task notifications as things you said.**
  The CLI writes them into the transcript marked as user turns; **106** of them
  had accumulated across recent local sessions.

- **Cerebro, the team memory bank, has a settings pane** — onboarding, sync, and
  drafting or retiring memories. It checks the machine before offering setup,
  rather than proposing a step that cannot work from here.

- **The sidebar names the account that ran a session**, or names none at all
  rather than guessing at one.

- Fixes: an empty rename title comes back as a bad request instead of reading as
  a broken engine; the sign-in step polls the profile it just made, so a lost
  event no longer wedges a column; a live process is not offered as attachable
  mid-turn, and a run cleans up after itself; the terminal cap counts the starts
  already in flight, and an update that stalls lets go.

## Install

**macOS** — download `Artemis-<version>-arm64-mac.dmg` (Apple Silicon) or
`Artemis-<version>-x64-mac.dmg` (Intel), open it, drag Artemis into
Applications. If macOS blocks the first launch, allow it under System
Settings → Privacy & Security → "Open Anyway", or clear the quarantine flag:

```
xattr -dr com.apple.quarantine /Applications/Artemis.app
```

**Windows** — download and run `Artemis-<version>-x64-setup.exe`. SmartScreen
will warn about an unrecognized publisher; "More info" → "Run anyway".

## First run

1. You need Anthropic's `claude` CLI installed, and a Claude subscription.
2. In Artemis, open **Profiles** (⌘, / Ctrl+,) and create a profile.
3. Run the sign-in command Artemis shows you in your own terminal and finish
   in the browser — Artemis watches the profile directory and continues on its
   own. No credential ever passes through Artemis.
4. Set a working directory, send a prompt.

Runs are billed to the Claude account each profile is signed into.

## Updates

Artemis checks this repository for newer releases — public, so no account or
GitHub CLI is needed — and puts a card at the foot of the sidebar when one
exists, or a strip under the header if the sidebar is hidden. Installing
parks at "restart when you're ready" — nothing restarts on its own.

Feedback: **Report a bug** at the foot of the sidebar, or open an issue in
this repo.
