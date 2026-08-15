Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.13.0

- **A file the conversation mentioned opens beside it.** The transcript was full
  of paths and none of them did anything: the preview could open five
  extensions, all chosen for being *renderable*, so the `.ts` file the whole
  conversation was about had nowhere to be read. Paths in an answer are now
  links, and clicking one opens the file as text in the dock, next to the
  terminal — numbered lines, and a `:88` in the reference scrolls to line 88 and
  marks it. What may be read is decided by **content, not extension**: a NUL
  byte in the first 8000 bytes means binary, so `Makefile`, `.env` and
  `justfile` open and `logo.png` is declined. A file too large to hold is
  clipped rather than refused — the first part of a log is what someone opening
  a log wants — and the caption says so rather than implying the file ends
  there.

- **A workflow opens into its phases.** A workflow was one opaque row: a name, a
  token total, and no way to tell a run stuck on its third agent from one nearly
  finished. It now opens into the phases the script declared, each with a count
  and a dot per agent, and under them the agents themselves with the model they
  ran on, what they spent, and how long they took. The dots say what `3/3`
  cannot: *which* one failed. A skip draws amber rather than red, because a
  workflow asking and the user declining is an ordinary outcome, not a fault.

- **Code blocks carry the button that copies them.** Getting a SQL query out of
  an answer meant dragging a selection across it and hoping the drag stopped
  where you did. The control appears on hover — and on keyboard focus, which is
  the half that usually gets left out.

- **A delegated row says what kind of thing it is.** A workflow and a
  backgrounded `sleep` used to be the same row with different words in it. Rows
  now name their kind, a workflow leads with its own name, and the tool count —
  carried in the protocol since the pane was written — finally reaches the
  screen.

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
