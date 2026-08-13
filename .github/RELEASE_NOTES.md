Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.8.0

- Every conversation comes back from a restart, not just the first. Reload or
  quit with more than one run in flight and each column after the first
  returned marked as working with an empty transcript behind it: it never
  printed anything, Stop did nothing, and the next prompt failed with
  `Run "run_…" has already ended` while the agent was plainly still going. No
  work was ever lost — the provider's own session file was intact the whole
  time, which is why quitting and starting again showed all of it. Artemis had
  put those columns nowhere. A replayed event is routed to its pane by run id,
  the pane had not been registered by the time the replay arrived, and every
  event addressed to it was dropped without a word. The run *state* took a
  different path and landed anyway, so the column looked alive while being
  deaf — and nothing repaired it, because the function that adopts live runs
  runs once, at boot. That one missing registration is also why Stop was inert
  and why the sidebar light never came on. A pane is now registered, with its
  run already on it, before its transcript is replayed. Three separate reports
  turned out to be this single write.
- The transcript gets its vertical space back. The gutter clock used to sit
  below the avatar in normal flow, invisible until you hovered — but holding
  its line in every row whether anyone hovered or not, so a collapsed work
  marker was 35px of row around 16px of content and a one-line answer carried
  29px of nothing beneath it. The clock now cross-fades with the avatar in the
  same spot instead of being given a line of its own, so a row is exactly as
  tall as what is in it. That is what pays for the rest: the gap between turns
  drops from 6px to 2px, with air bought back only where it marks something —
  above a user turn, above an assistant turn, and around the end of a run. The
  word "agent" is gone from the gutter, since the mark beside it already means
  that and on a one-line answer the label stood taller than the answer; the
  mark gained a disc so that standing alone it reads as a mark rather than as
  decoration. `subagent` keeps its word, because there the mark shows the
  provider and both look the same.
- Profiles can share one `~/.claude`. A profile's config directory isolates the
  account and, as a side effect nobody asked for, everything else with it — a
  skill written once has to be written again for every account you have.
  Settings gains an **Advanced** tab that closes that gap, pointing the
  shareable parts of each Claude profile at your own `~/.claude`: `commands`,
  `skills`, `plugins`, `plans`, `todos`, `ide`, `session-env`, `projects` and
  `CLAUDE.md`. Deliberately not shared are `.claude.json`, `settings.json`,
  `sessions/` and the credential — those are what make two accounts two
  accounts, and linking the whole directory is the obvious thing to reach for
  and the one thing that cannot work, because every profile ends up signed into
  whichever account logged in last. Artemis does not run any of this: it writes
  the shell script and you read it and run it yourself. That is a refusal
  rather than an unfinished feature — the operation moves directories holding
  months of transcripts, across accounts, along paths read out of a JSON file
  you can edit by hand. A button would make that one click with nothing to read
  beforehand and no record afterwards, where a script can be reviewed, kept,
  re-run, and run at the point when Artemis itself is the thing that is broken.
  Nothing is deleted either: whatever already occupies a name is renamed to
  `<name>.pre-shared` before the link is made, the undo script puts it back,
  and it removes only the links still pointing where it put them.
- A conversation two accounts can reach is listed once. History was read per
  profile, on the reasoning that a profile's config directory is its own store
  — so where a session was found *is* its account, and no bookkeeping is needed
  anywhere. That holds until two profiles resolve to one store, and then it
  fails in the most visible way available: every conversation comes back once
  per profile and the sidebar renders it that many times under that many
  account labels, so three accounts sharing a store tripled the list. Two ways
  in, neither exotic — two profiles are allowed to name the same directory, and
  symlinking `projects/` is how history gets shared across accounts, which is
  exactly what the Advanced tab above now does on purpose. Sessions are grouped
  by the store they actually read rather than by the profile that read it, and
  each store is read once, which is also less work than before. Resuming
  changed with it: opening a shared conversation keeps you on the account you
  are already working in, when that account can reach the transcript, rather
  than switching you to whichever profile happened to sort first. Which one
  that is is insertion order — and moving the account your next prompt bills to
  was never something to do on the strength of an ordering.

Carried over from 0.7.0, if you are coming from 0.6.3 or earlier:

- A reopened conversation opens. Coming back to a session could instead produce
  "Artemis blocked a response that failed its credential-safety check" over an
  empty pane, with the transcript intact on disk the whole time — a replay was
  being credential-checked as though Artemis had authored it, so an agent that
  had merely explained `export ANTHROPIC_API_KEY=…` took its own history down.
  Replayed events are now checked exactly as they were when they were live.
- The meter under the composer is three rings where it was one bar. `5hr`,
  `Week` and `Fable`, each named and each carrying its own percentage, instead
  of one bar counting down whichever single window a setting in Appearance had
  picked. The **Plan meter** setting is gone with the bar — every answer it
  offered is now on screen.
- Sessions can be pinned, and the session menu answers to four letters. A
  pinned session lifts out to a **Pinned** section above every project, the
  mirror of what archiving already does below; in the right-click menu `A`
  archives, `D` deletes, `R` renames and `P` pins.
- An account can sit out, or leave the picker entirely. Two switches under
  **Availability** on a profile: *Suggest automatically* takes an account out
  of the pool Artemis picks from while leaving it one click away, and *Show in
  the profile picker* takes it out of the list — the thing to reach for instead
  of deleting a profile. Neither unbinds anything already recorded against it.

And from 0.6.x, if you are coming from 0.5.x:

- The button that copies a new profile's sign-in command copies it — Chromium
  gated the clipboard behind a permission Artemis refused, and the button gave
  its tick regardless.
- The terminal works in an installed copy. ⌘J had never once opened a shell in
  one: the file needed to spawn it shipped without its execute bit.
- A worktree's sessions stay with the project they came from, instead of
  appearing under a repository named after the branch.
- A bug can be reported from inside the app, updating needs no GitHub account
  and cleans up after itself, and a plan arrives laid out to be read and
  approved rather than as a wall of prompt text.

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
