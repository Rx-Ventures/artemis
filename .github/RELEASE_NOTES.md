Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.6.3

- The button that copies a new profile's sign-in command copies it. It never
  has. Chromium gates the clipboard behind a permission, Artemis refused every
  permission it could be asked for, and the button gave its tick regardless —
  so the paste that followed produced whatever you had copied beforehand, far
  enough from the click that the button was never the obvious suspect. The
  same call is what a bug report too long for a URL falls back to, and it
  failed there too, in the one place where the alternative is retyping several
  paragraphs. Writing the clipboard is now allowed to Artemis's own window and
  to nothing else: reading it stays refused along with the camera and the
  microphone, and a page the agent wrote still cannot reach it. A copy that
  does fail now says so rather than claiming it worked.

Carried over from 0.6.2, which was published twenty minutes earlier:

- The terminal works in an installed copy. ⌘J has been in the app since 0.6.0
  and had never once opened a shell in one — every terminal in an install
  failed with `posix_spawnp failed`, because the single file needed to spawn a
  shell shipped without its execute bit. A development checkout has no archive
  to unpack and so no bit to lose, which is why the tests went on passing
  while every download was broken.
- A worktree's sessions stay with the project they came from, instead of
  appearing under a repository named after the branch — one you had never
  worked in, holding the work that had just left the one you had. Sessions
  started in a subdirectory group with the project too. Expect one thing
  once: a group you had collapsed against a worktree path arrives open.

And from 0.6.1 and 0.6.0, if you are coming from 0.5.x:

- A bug can be reported from inside the app. A permanent row at the foot of
  the sidebar opens a short form and hands it to GitHub's own new-issue
  page with all of it filled in — the last read of what is about to be
  public is yours.
- Updating needs no GitHub account. This repository is public, so the
  updater reaches releases over plain HTTPS with no credential and no
  tooling, and streams the archive to disk rather than holding about 200MB
  in memory while it lands.
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
