Internal build — unsigned on every platform, on purpose.

## Which file

| Your machine | Download |
| --- | --- |
| Mac, Apple Silicon | `Artemis-<version>-arm64-mac.dmg` |
| Mac, Intel | `Artemis-<version>-x64-mac.dmg` |
| Windows | `Artemis-<version>-x64-setup.exe` |

## Install

**macOS** — open the dmg, drag Artemis into Applications. If macOS blocks the
first launch, allow it under System Settings → Privacy & Security → "Open
Anyway", or clear the quarantine flag:

```
xattr -dr com.apple.quarantine /Applications/Artemis.app
```

**Windows** — run the installer. SmartScreen will warn about an unrecognised
app: More info → Run anyway.

## First run

1. You need Anthropic's `claude` CLI installed, and a Claude subscription.
2. In Artemis, open **Profiles** (⌘, / Ctrl+,) and create a profile.
3. Run the sign-in command Artemis shows you in your own terminal and finish
   in the browser — Artemis watches the profile directory and continues on its
   own. No credential ever passes through Artemis.
4. Set a working directory, send a prompt.

Runs are billed to the Claude account each profile is signed into.

## Updates

On macOS, Artemis checks this repository for newer releases (using your own
`gh` CLI login) and shows a banner when one exists. Installing parks at
"restart when you're ready" — nothing restarts on its own. On Windows,
updates are manual for now: download the new installer from this page.

Feedback: open an issue in this repo.
