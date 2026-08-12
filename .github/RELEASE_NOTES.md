Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.4.0

- A page the agent wrote opens instead of being blocked. The preview frame
  was refused by the renderer's own content policy, so an HTML artifact
  showed nothing; it renders now. The tile also sits in its own transcript
  row rather than folded inside "edited 5 files", so the deliverable is not
  hidden behind the machinery that produced it.
- Clicking a session that is already on screen goes to it. It used to push
  that run into the background and replay a half-written transcript into a
  blank column, while the agent carried on working out of sight.
- Rows hold still while agents work. The list stopped reshuffling under the
  pointer every few seconds as running sessions took turns being the most
  recently written, which is what made you open the wrong one.
- An update waits at the foot of the sidebar as its own small card, instead
  of a full-window strip pushing the header, both transcripts and every
  composer down. The strip remains for when the sidebar is collapsed.
- The conversation is set in Geist, not Geist Mono. 0.3.0 split the faces by
  pane, which put answers, prompts and the composer in monospace and made a
  conversation read as terminal output. Mono is now for text whose
  characters are the content — code, diffs, paths, tool arguments — and the
  app's own 11px labels.
- `Start somewhere else` is gone from the sidebar. Every project is in the
  list above it, a row click does the whole switch, and the folder chip
  above the composer starts a fresh session anywhere — including somewhere
  with no history at all.

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
login) and puts a card at the foot of the sidebar when one exists — or a
strip under the header, if the sidebar is hidden. Installing parks at
"restart when you're ready" — nothing restarts on its own.

Feedback: open an issue in this repo.
