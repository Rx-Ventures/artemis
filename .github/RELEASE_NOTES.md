Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.6.2

- The terminal works in an installed copy. ⌘J has been in the app since
  0.6.0 and has never once opened a shell in one: every terminal in an
  install failed with `posix_spawnp failed`, because the single file needed
  to spawn a shell shipped without its execute bit. A development checkout
  has no archive to unpack and so no bit to lose — which is precisely why
  the tests went on passing while every download was broken. The bit is now
  set at package time, repaired at startup if an install somehow arrives
  without it, and checked before a release can publish. Booting never
  revealed this, since nothing touches that file until somebody asks for a
  shell, so the check had to be made against the shipped file itself.
- A worktree's sessions stay with the project they came from. Splitting work
  into a linked worktree used to take those sessions out of the project they
  belonged to: the sidebar filed them under a repository named after the
  branch — one you had never worked in, sitting above the one you had,
  holding the work that had just left it. Groups are keyed on the project
  the work was on now, not the directory it ran in. Sessions started in a
  subdirectory join it the same way, so work in `apps/desktop` files under
  the repository rather than under a heading reading "desktop". What names
  the place you are in is unchanged — the header, the directory chip above
  the composer, and the working directory on the row itself — and a
  worktree's sessions are still told apart by their branch. Expect one
  thing once: a group you had collapsed against a worktree path arrives
  open.

Carried over from 0.6.1 and 0.6.0, in case you are coming from 0.5.x:

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
