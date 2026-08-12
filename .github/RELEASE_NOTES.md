Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.5.0

- The Artemis menu can check for updates. `Check for Updates…` sits under
  About Artemis and answers either way: an update appears as the usual card
  at the foot of the sidebar, and "nothing newer", "could not reach the
  releases" and "already installing" each say so rather than leaving you
  wondering whether the click landed. Asking also un-dismisses — a version
  you declined by accident can be reached again.
- The app grew a real menu bar in the process: Edit, View and Window with
  the standard items. The shortcuts they carry (⌘C, ⌘V, ⌘Z, ⌘W, ⌘Q) worked
  before and still do.

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
