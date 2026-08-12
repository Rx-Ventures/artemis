Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.3.0

- A page the agent makes shows itself. An HTML artifact takes its own
  transcript row instead of a diff, opens the preview pane on the first one
  of a conversation, and closes when that conversation leaves the screen.
- A user row is what a person said. Prompts the harness injects — the body
  of a skill a tool call just loaded, a continuation, a system reminder —
  no longer arrive looking like something you typed.
- The folder chip lists where you have been. Ten directories, alphabetical,
  with "Add folder…" still there for one the app has never seen; Appearance
  prunes the list.
- An answer arrives a word at a time, each fading in as it lands, and never
  pacing slower than the model actually answered. Appearance carries a
  switch to turn it off.
- The app is set in Geist and Geist Mono, packaged with it — correct on
  first launch with no network.
- Text size is the reader's to choose: 11px to 20px in Appearance, scaling
  the boxes along with the text.

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
