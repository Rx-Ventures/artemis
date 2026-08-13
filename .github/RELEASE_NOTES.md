Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.10.0

- Work that outlives a turn stops being killed at the end of it. A subagent
  launched with the `Agent` tool backgrounds by default, `Workflow` is always
  async, and `CronCreate`, `/loop` and `ScheduleWakeup` register jobs that fire
  while the agent is idle — and every one of those was being destroyed the
  instant the turn that started it finished, because the turn ending closed the
  provider process and took everything it was holding with it. Scheduled work
  never fired at all: the jobs live inside the process and fire when it is idle,
  and in Artemis "idle" meant "no process exists". The process now stays for as
  long as it still holds live work or a registered schedule, and your next
  message joins the process already serving the conversation instead of starting
  a second one against the same transcript — so a long session also stops
  re-reading its own history on every message. When background work finishes the
  agent has something to say about it, unprompted, and that answer now appears in
  the conversation rather than only in the file on disk; a subagent that outlives
  its turn can still ask for a tool, and you can still answer. A message typed a
  moment too late — accepted, queued, and annotated "waits for the next one" —
  now genuinely runs, where before there was no next turn for it to wait for.
  The cost is memory, stated plainly: a conversation holding background work
  holds a provider process at roughly 400 MB, until the work settles, you drop
  the conversation, or you quit. A conversation that has registered a schedule
  keeps its process for the same reasons and until the same points, because
  nothing can be asked what schedules it still holds.
- A conversation that opened with an image comes back to the sidebar. Some
  sessions were vanishing from the list entirely — indistinguishable from ones
  that had been deleted, with their transcripts sitting intact on disk the whole
  time. Every affected conversation had the same shape: the first message
  carried an attachment, so the provider's own summary pass came back with no
  working directory for it, and a session with no directory cannot be grouped
  under a project or resumed — so the row was dropped rather than shown as
  something that does nothing. The directory is in the transcript regardless, on
  the record the summary skipped, and Artemis now reads it back from there. The
  recovered row is a real one: it groups under its project and resumes, rather
  than appearing greyed out.
- A session belongs to the account it started on, the way it already belongs to
  its directory. Switching profiles mid-conversation used to change nothing but
  the label: the next message ran under the new account's credentials while
  resuming a transcript that lives in the *previous* account's store. Where the
  stores are separate that surfaced as the provider rejecting a session id you
  never saw, seconds after you sent a prompt. Where profiles share one
  `~/.claude`, it succeeded — and billed the wrong account for the continuation
  of a conversation it never had. Changing accounts now behaves exactly as
  changing the working directory already did: refused while a run is live, and
  otherwise it starts a new session and says so in the transcript, naming the
  account it moved to. What that costs is worth knowing before you hit it:
  running into a plan limit halfway through means starting a fresh session on the
  other account rather than continuing this one there. Continuing "there" was
  never actually happening.
- A work section you closed stays closed when you come back to it. Collapsing an
  activity marker held only until the transcript was rebuilt — switching sessions
  and switching back reopened every one — and a marker holding a failure reopened
  *every single time*, because "open this if something failed" was a rule that
  re-ran on each redraw and quietly overruled the person who had just closed it.
  The fold you set now lasts for the life of the app run. It is a reading
  position rather than a preference, so it is deliberately not saved to disk:
  restoring a fold as you left it three days and one launch ago is not obviously
  what anyone wants.

Carried over from 0.9.0, if you are coming from 0.8.0 or earlier:

- The Advanced pane reads the disk and says what is actually linked — per
  profile, naming the entries that are not — rather than only reflecting the
  switch you set. An account added after a share was generated is no longer
  quietly on its own.
- A sidebar row's tooltip is a labelled card that keeps a long path inside its
  own bubble, with rows for directory, branch, profile, model, messages and
  activity.
- The title bar keeps only what has nowhere else to live, and macOS gains a
  **Settings…** item in the application menu.
- Two transcript rows that only repeated themselves are gone: the activity
  marker's `WORK` label, and the `Session … started` line that landed under
  every prompt.

And from 0.8.x, if you are coming from 0.7.x:

- Every conversation comes back from a restart, not just the first.
- Profiles can share one `~/.claude` through a script you run yourself, so a
  skill written once is available to every account.
- A conversation two accounts can reach is listed once, not once per account.
- The transcript gets its vertical space back, and the gutter clock stops
  holding a line nobody is hovering.

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
