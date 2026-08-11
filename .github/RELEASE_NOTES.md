Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.2.0

- A page the agent writes is something you can look at: HTML it produces
  opens in a preview pane beside the transcript.
- Markdown the agent writes is read, not diffed — prose renders as prose.
- A question from the agent is answered, not approved: multiple-choice asks
  render as choices inline in the transcript.
- A run outlives the column that started it. Navigating away no longer
  abandons work in flight.
- The composer offers the one action that would work — Send becomes Stop
  while a run is going.
- A stretch of work collapses to one row, thinking included.

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

Artemis checks this repository for newer releases (using your own `gh` CLI
login) and shows a banner when one exists. Installing parks at "restart when
you're ready" — nothing restarts on its own.

Feedback: open an issue in this repo.
