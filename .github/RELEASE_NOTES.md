Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.6.1

- A bug can be reported from inside the app. The foot of the sidebar has a
  permanent row now — one line, always there, because the moment you want
  it is a moment you did not plan for and will not go menu-hunting during.
  It opens a short form: a summary, what happened, steps if you have them,
  and a checkbox that includes the two facts anyone triaging asks for first
  — your version and your platform, and nothing else. The button says
  *Continue on GitHub* because it does not file anything: it opens GitHub's
  own new-issue form with all of it filled in, so the last read of what is
  about to be public is yours, and the issue comes from an account that can
  be replied to.
- Updating no longer needs a GitHub account. This repository is public, so
  the updater now reaches releases over plain HTTPS with no credential and
  no tooling; your own `gh` stays as a second route for machines where the
  direct one is blocked or proxied. The release archive is streamed to disk
  as it arrives instead of being held whole in memory first — about 200MB
  the app no longer asks of your machine while an update lands. And when a
  check does fail, the app says what is actually likely wrong now: the
  network, rather than a missing GitHub login.

Carried over from 0.6.0, in case you are coming from 0.5.x:

- There is a terminal in the app. ⌘J opens a shell on the focused session's
  working directory, and the right-hand rail became a dock of tabs — the
  artifact the agent wrote and the terminals you asked for, side by side.
- A plan arrives as a plan, laid out to be read and approved rather than
  shown as a wall of prompt text.
- Updating cleans up after itself. Every update before 0.6.0 left about
  6.5MB of the version it replaced behind; installing sweeps away what
  earlier ones left, so expect a little disk space back on first launch.

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
