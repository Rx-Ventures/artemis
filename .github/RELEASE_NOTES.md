Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.6.0

- There is a terminal in the app now. ⌘J opens a shell on the focused
  session's working directory, so running what the agent just wrote no
  longer means leaving Artemis and finding the directory again. The
  right-hand rail became a dock of tabs — the artifact the agent wrote and
  the terminals you asked for, side by side, each closing with its own ✕.
  Also reachable from the header button, the command palette, or the `+` on
  the tab strip.
- A plan arrives as a plan. When the agent finishes planning, its plan is
  laid out to be read and approved rather than shown as a wall of prompt
  text.
- Answering a prompt survives a reload. ⌘R used to replay every permission
  and plan prompt the run had ever raised, and the second answer could not
  land — the question was already settled. Reloading now leaves answered
  prompts answered.
- A thinking block either shows its text or does not appear. Nearly half of
  them were arriving with the text withheld and drew an empty fold you
  could open onto nothing; a burst of real work read as a stack of them.
- The sidebar marks the session each column is showing, so you can tell
  which conversation is in front of you when several are open.
- The recent-folders menu keeps only directories that will still be there.
  Worktrees and temporary checkouts were taking slots in a ten-row menu and
  never giving them back, pushing out real projects with rows pointing at
  places that had been deleted days earlier.
- Updating cleans up after itself. Every update so far has left about 6.5MB
  of the version it replaced sitting in your Applications folder, and
  another copy in a temporary directory — the cleanup ran, deleted almost
  everything, and silently failed on the one file it could not remove.
  Installing this version sweeps away what earlier ones left behind, so
  expect a little disk space back on first launch.

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
