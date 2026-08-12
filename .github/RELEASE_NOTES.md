Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.7.0

- A reopened conversation opens. Coming back to a session could instead
  produce "Artemis blocked a response that failed its credential-safety
  check", sitting under a "Could not load earlier messages" warning with an
  empty pane behind it. The transcript was intact on disk the whole time; the
  app was refusing to show it to you. Replaying a session hands back the same
  events a live run pushes, but the replay was being checked as though Artemis
  had authored it — so the agent explaining `export ANTHROPIC_API_KEY=…`, a
  command carrying an `env`, or a tool result quoting a key was enough to take
  the entire history down with it, and a long enough session could fail on its
  length alone. Replayed events are now checked exactly as they were when they
  were live, one at a time. The same mismatch was hiding a reloaded terminal's
  scrollback and refusing to preview any file that documents a key; both open
  now. Nothing loosened structurally — no profile field, secret reference or
  API key may appear in any reply, at any depth.
- The meter under the composer is three rings where it was one bar. `5hr`,
  `Week` and `Fable`, each named, each carrying its own percentage. Before,
  a single bar counted down a single window and a setting in Appearance
  decided which one — but the 5-hour limit is what stops you mid-task, the
  weekly is what you budget across days, and Fable's weekly is what runs out
  first on an account that leans on it. Choosing one meant being blind to two.
  The disc inside each ring takes its arc's colour, so an account going amber
  is noticeable without being looked at; the thresholds are the ones the bar
  used. It is still one control, opening the same popover with every window
  your plan reports. And it is *up to* three rings: a window your plan does
  not report gets none rather than an empty one, since a ring at 0% and a ring
  for a limit you do not have look identical. The **Plan meter** setting is
  gone with the bar — every answer it offered is now on screen.
- Sessions can be pinned, and the session menu answers to four letters. A
  pinned session lifts out to a **Pinned** section above every project — the
  mirror of what archiving already does below — open by default, and present
  only once something is in it. Pinning and archiving are opposite claims
  about a row, so each clears the other. In the right-click menu, `A`
  archives, `D` deletes, `R` renames and `P` pins, each letter shown on the
  item it belongs to: `D` reaches the confirmation and never the deletion, an
  item you are not allowed to use stays inert, and a key aimed at the window
  — ⌘R — still reaches the window. Like archiving, this is Artemis's own
  bookkeeping: nothing on disk changes, and it works against every provider.
- An account can sit out, or leave the picker entirely. Artemis reaches for
  profiles on its own now — it leads the menu with a Recommended row and
  starts a new session on whichever account has the most room — which is the
  wrong default for a client's account, a colleague's, or one whose quota is
  being saved for something that runs overnight. Nothing in a usage reading
  tells those apart, so it is asked rather than inferred. Two switches under
  **Availability** on a profile, both on unless you say otherwise: *Suggest
  automatically* takes an account out of the pool Artemis picks from while
  leaving it one click away in the menu, and *Show in the profile picker*
  takes it out of the list — the thing to reach for instead of deleting a
  profile, when the record is also a config directory, a login and a session
  history. Neither unbinds anything: a session already recorded against a
  hidden account still resumes into it, and the account you are running on
  keeps its row, marked.

Carried over from 0.6.3 and 0.6.2, if you are coming from 0.6.1 or earlier:

- The button that copies a new profile's sign-in command copies it. It never
  had — Chromium gates the clipboard behind a permission Artemis refused, and
  the button gave its tick regardless, so the paste that followed produced
  whatever you had copied beforehand. Writing the clipboard is now allowed to
  Artemis's own window and to nothing else.
- The terminal works in an installed copy. ⌘J has been in the app since 0.6.0
  and had never once opened a shell in one — the single file needed to spawn a
  shell shipped without its execute bit. A development checkout has no archive
  to unpack and so no bit to lose, which is why the tests went on passing while
  every download was broken.
- A worktree's sessions stay with the project they came from, instead of
  appearing under a repository named after the branch. Sessions started in a
  subdirectory group with the project too. Expect one thing once: a group you
  had collapsed against a worktree path arrives open.

And from 0.6.1 and 0.6.0, if you are coming from 0.5.x:

- A bug can be reported from inside the app. A permanent row at the foot of
  the sidebar opens a short form and hands it to GitHub's own new-issue page
  with all of it filled in — the last read of what is about to be public is
  yours.
- Updating needs no GitHub account. This repository is public, so the updater
  reaches releases over plain HTTPS, and streams the archive to disk rather
  than holding about 200MB in memory while it lands.
- A plan arrives as a plan, laid out to be read and approved rather than shown
  as a wall of prompt text.
- Updating cleans up after itself. Every update before 0.6.0 left about 6.5MB
  of the version it replaced behind, so expect a little disk space back on
  first launch.

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
