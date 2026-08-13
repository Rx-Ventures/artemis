Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.11.0

- Delegated work has somewhere to be watched. A turn that hands three agents a
  job used to draw as one folded line reading "delegated to 3 agents" — past
  tense, no count, nothing that ever came back — while the agents were still
  working. That line was the whole of what Artemis knew how to say about it: the
  `Agent` tool backgrounds by default and `Workflow` is always async, so both
  close their tool call the instant the work starts, and everything after that
  happened outside any turn and off the screen. There is now a tab in the
  right-hand rail for it, one per conversation, listing every subagent, workflow
  and backgrounded command that conversation has going: what each was asked to
  do, whether it is a subagent or a workflow and which kind, the tool it is using
  right now, how long it has been at it, and what it has spent. **A row can be
  stopped**, one at a time, without touching the run or the others. Work that has
  finished stays on the list rather than vanishing — marked, with what it said
  and where it wrote its output, which is the moment that result is worth reading
  — and the oldest are dropped once there are more than a handful. The tab
  appears by itself when the first task starts, because nobody opens this one,
  and it sits at the end of the strip so its arrival mid-turn does not shift the
  tabs beside it out from under a pointer. It has no close button, deliberately:
  every other tab holds something you can get back, and this one holds the only
  record of work you did not start.
- The sidebar's projects hold still, and only their rows move. Project headings
  were ordered by whichever held the most recent session, so every prompt in any
  project rewrote the order of the whole list — the heading you were reaching for
  slid out from under the pointer, and a project you work in twice a week was
  somewhere different every time you looked for it. Headings are now ordered by
  name and stay where they are, moving only when a project is added or goes away.
  The sessions *inside* one are unchanged: still newest first, still held in place
  while their agent is working. The two levels answer different questions —
  finding a project is navigation and wants furniture, finding a session inside it
  is nearly always "the one I touched last" — and sorting both by recency was the
  assumption that they were one question. Sorted by the name on the heading rather
  than by the path underneath it, so the list reads in the order it looks like it
  is in.

Carried over from 0.10.0, if you are coming from 0.9.0 or earlier:

- Work that outlives a turn is no longer killed at the end of it. Backgrounded
  subagents, async workflows and scheduled jobs survive, your next message joins
  the process already serving the conversation instead of starting a second one,
  and a message typed a moment too late genuinely runs. A conversation holding
  background work holds a provider process, at roughly 400 MB, until the work
  settles or you quit.
- A conversation that opened with an image comes back to the sidebar, instead of
  vanishing from the list with its transcript intact on disk.
- A session belongs to the account it started on. Switching profiles
  mid-conversation is refused while a run is live and otherwise starts a new
  session, rather than billing the wrong account for the continuation of a
  conversation it never had.
- A work section you closed stays closed when you come back to it.

And from 0.9.x, if you are coming from 0.8.x:

- The Advanced pane reads the disk and says what is actually linked, per profile,
  rather than only reflecting the switch you set.
- A sidebar row's tooltip is a labelled card that keeps a long path inside its
  own bubble.
- The title bar keeps only what has nowhere else to live, and macOS gains a
  **Settings…** item in the application menu.
- Two transcript rows that only repeated themselves are gone.

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
