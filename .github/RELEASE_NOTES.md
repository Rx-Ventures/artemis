Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.9.0

- The Advanced pane says what is actually linked, not only what you asked for.
  Sharing one `~/.claude` arrived last release as a switch and a script you run
  yourself, and nothing ever read the result back — so a share that happened and
  one where you read the script and closed the terminal looked exactly the same
  on screen. The case that will actually catch you is worse than either: the
  script covers the profiles that existed when it was generated, so a fifth
  account added next month gets none of the links while the switch stays on and
  the pane goes on listing every directory identically. That account quietly has
  its own `skills/` and its own history, and you find out when a skill you wrote
  once is missing from it. The pane now reads the disk — one line per profile,
  saying how many of the nine entries are symlinked and naming the ones that are
  not, in the same words the script's own output uses: `own` for a folder of its
  own that a share would move aside, `missing` for nothing at all, `foreign` for
  a link into somebody else's arrangement that the undo deliberately refuses to
  touch. The profile that *is* your `~/.claude` reads as **is the root** rather
  than as permanently unlinked, one whose directory has been deleted says so,
  and the `<name>.pre-shared` folders a share run leaves behind — for `projects`
  that is months of transcripts — are named for the first time anywhere in the
  app. Where the two disagree the pane says so in words, in both directions: a
  switch left on over a disk that never got the links, and a switch that is off
  over profiles that are still sharing. Neither reading moves the switch. Where
  some profiles are already linked, the script on offer narrows to the ones that
  are not, so covering a newly added account is a shorter thing to read than
  running the whole thing again — the full script stays one click away. Read when
  the pane opens and behind a refresh button; never polled, because nothing
  changes those paths but a script you run by hand.
- A sidebar row's tooltip stays inside its own bubble, and says more. A working
  directory is one unbroken token, so hovering a row wrote the path straight
  past the border of the box that was supposed to hold it. The dash-joined
  sentence is now a labelled card: the whole title where the row folds it to
  eight words, a `Running now` line while a pane holds the live run, and rows
  for `directory`, `branch`, `profile`, `model`, `messages` and `activity` in the
  run-info dialog's vocabulary. A fact the summary does not have drops its row
  rather than rendering a dash. The project heading above each group gained the
  same treatment, replacing the one hover surface in the sidebar that was still
  OS chrome, and two native tooltips that used to race the styled one — on the
  title and on the profile — are gone, since both facts are rows on the card now.
  Every bare-string tooltip in the app can hold a long token as a result.
- The title bar keeps what only it can offer, and macOS gets a Settings menu
  item. Split-right, split-down and new session are out of the header: each was
  a button for something with a keystroke and a palette entry (`⌘\`, `⌘⇧\`,
  `⌘N`), and the sidebar has its own new-session button. What stays is the
  sidebar toggle — the one control that cannot live inside the thing it hides —
  the title, the terminal and settings. On macOS the application menu grows
  **Settings…** above **Check for Updates…**, deliberately with no `⌘,`
  accelerator: `⌘,` belongs to the app, where it *toggles* the dialog, and a
  menu accelerator would have quietly turned that into open-only.
- Two transcript rows that only repeated themselves are gone. The activity
  marker's `WORK` label named a row that already named itself — an icon cluster
  and then `Ran 36 commands, read 6 files` in the sentence beside it — and a
  failure it used to signal in the gutter still shows as `· N failed` on the
  line, which also still opens itself. And every prompt opened with
  `Session d7ffb873… started in <cwd>`, once per turn rather than once per
  conversation: on a resumed session that landed directly under the replayed
  history, announcing the start of a thread already scrolled off the top of it.
  Session id, model, mode and directory are rows in the run-info dialog, which
  is where a fact that holds for a whole run belongs.

Carried over from 0.8.0, if you are coming from 0.7.0 or earlier:

- Every conversation comes back from a restart, not just the first. Quitting with
  more than one run in flight left each column after the first marked as working
  over an empty transcript, deaf to its own agent — no work was ever lost, the
  provider's session file was intact throughout, and Artemis had put those
  columns nowhere. Three separate reports turned out to be one missing write.
- Profiles can share one `~/.claude`, by a script you run yourself. An
  **Advanced** tab in Settings points `commands`, `skills`, `plugins`, `plans`,
  `todos`, `ide`, `session-env`, `projects` and `CLAUDE.md` at your own
  `~/.claude`, so a skill written once is available to every account. Sign-in is
  deliberately left out of it, and nothing is deleted — whatever occupies a name
  is renamed to `<name>.pre-shared` first, and the undo script puts it back.
- A conversation two accounts can reach is listed once, not once per account.
  Sessions are grouped by the store they actually read, and resuming a shared one
  keeps you on the account you are already working in.
- The transcript gets its vertical space back: the gutter clock stopped holding a
  line nobody was hovering, and the space that bought went into marking what
  matters instead of into every row.

And from 0.7.x, if you are coming from 0.6.x:

- A reopened conversation opens, instead of failing its own credential check and
  taking an intact transcript down with it.
- The meter under the composer is three named rings — `5hr`, `Week`, `Fable` —
  where it was one bar counting down whichever window a setting had picked.
- Sessions can be pinned into their own section, and the right-click menu answers
  to four letters: `A`, `D`, `R`, `P`.
- An account can sit out of automatic suggestion, or leave the picker entirely,
  without being deleted or unbinding anything recorded against it.

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
