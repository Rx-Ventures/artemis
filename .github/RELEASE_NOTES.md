Internal build — unsigned, on purpose. macOS on Apple Silicon only for now;
Intel and Windows builds return when there is someone to run them.

## Install

Download `Artemis-<version>-arm64-mac.dmg`, open it, drag Artemis into
Applications. If macOS blocks the first launch, allow it under System
Settings → Privacy & Security → "Open Anyway", or clear the quarantine flag:

```
xattr -dr com.apple.quarantine /Applications/Artemis.app
```

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
