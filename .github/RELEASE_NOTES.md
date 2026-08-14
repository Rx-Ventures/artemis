Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.11.2

- The sidebar floats clear of the header. The session card had an even gutter on
  three sides and none on the fourth — a leftover from when it became a floating
  card, invisible for as long as the header and the page below it were one
  unbroken field. 0.11.1 drew a rule under the header, and that left the card's
  two top corners rounding into a border they sat directly on, reading as bolted
  to the chrome rather than floating below it. The gap above the card is now the
  same gap you can already see below **Report a bug** at the other end of the
  same column.

Carried over from 0.11.1, if you are coming from 0.11.0 or earlier:

- The delegated-work tab can be put away, and brought back. **Closing it closes a
  view, and nothing else** — every row stays, every subagent carries on, and the
  ⏹ on a row goes on working whether or not anything is drawing it. It comes back
  by itself the next time something is delegated, and a **Delegated work** button
  beside the terminal button in the header opens it whenever you want it.
- A window you reload shows the prompt it asked, not just the answer. Nothing was
  ever lost — the message reached the model — but the line saying what had been
  asked was drawn by the window that is now gone, and nothing rebuilt it.
  Reopened windows replay it, including a steering message sent mid-run.
- Shared Claude config links every directory, not just the first. The setup
  script is pasted into a shell that is already running, which on macOS is zsh,
  and zsh did not split its list the way the script assumed — so it linked one
  directory named after all eight and left the rest untouched.
- A rule under the app header, so the window's own chrome stops running into the
  conversation underneath it.

And from 0.11.0, if you are coming from 0.10.x:

- Delegated work has somewhere to be watched: a tab in the right-hand rail, one
  per conversation, listing every subagent, workflow and backgrounded command it
  has going — what each was asked to do, what it is using, how long it has been
  at it and what it has spent. **A row can be stopped**, one at a time, without
  touching the run or the others.
- The sidebar's projects hold still, and only their rows move. Headings are
  ordered by name rather than by whichever held the most recent session, so a
  prompt anywhere no longer rewrites the list under the pointer.

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
