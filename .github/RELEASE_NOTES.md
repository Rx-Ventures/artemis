Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.11.1

- The delegated-work tab can be put away, and brought back. 0.11.0 shipped it
  without a close button and said so on this page, deliberately: every other tab
  in that strip holds something you can get back, and this one holds the only
  record of work you did not start. That is a good reason to make the ✕ *safe*.
  It was not a reason to make the pane permanent, which is what it amounted to.
  **Closing it closes a view, and nothing else.** Every row stays where it was,
  every subagent carries on, and the ⏹ on a row goes on working whether or not
  anything is drawing it — the tab never owned any of that. It stays shut while
  the work it was showing continues, comes back by itself the next time something
  is delegated, and a **Delegated work** button next to the terminal button in the
  header opens it whenever you want it.
- A window you reload shows the prompt it asked, not just the answer. ⌘R on a
  conversation that had only just started brought the agent back working away
  under no question at all. Nothing was ever lost — the message reached the model
  and the provider had it written down — but the line on screen saying what had
  been asked was drawn by the window that is now gone, and nothing rebuilt it.
  Reopened windows replay the prompt along with the rest of the turn, including a
  steering message sent mid-run, which had it worse: no file to fall back on at
  all.
- Shared Claude config links every directory, not just the first. The setup
  script the Advanced pane hands you is pasted into a shell that is already
  running, which on macOS is zsh — and zsh does not split a list into words the
  way the script assumed. So it made a single directory whose name was all eight
  names run together, linked that, and left the other eight untouched. The status
  pane then reported "1 linked, 8 not", which reads as half-finished rather than
  as broken. The names are written out literally now, leaving no shell anything to
  disagree about.
- A rule under the app header, so the window's own chrome stops running into the
  conversation underneath it.

Carried over from 0.11.0, if you are coming from 0.10.0 or earlier:

- Delegated work has somewhere to be watched. A turn that hands three agents a job
  used to draw as one folded line reading "delegated to 3 agents" — past tense,
  while they worked, and nothing that ever came back. There is now a tab in the
  right-hand rail, one per conversation, listing every subagent, workflow and
  backgrounded command it has going: what each was asked to do, what it is using
  right now, how long it has been at it and what it has spent. **A row can be
  stopped**, one at a time, without touching the run or the others. Finished work
  stays on the list, with what it said and where it wrote its output. The tab
  appears by itself when the first task starts.
- The sidebar's projects hold still, and only their rows move. Headings were
  ordered by whichever held the most recent session, so every prompt anywhere
  rewrote the whole list under the pointer. They are ordered by name now and stay
  put. The sessions *inside* one are unchanged: newest first, held in place while
  their agent is working.

And from 0.10.x, if you are coming from 0.9.x:

- Work that outlives a turn is no longer killed at the end of it. A conversation
  holding background work holds a provider process, at roughly 400 MB, until the
  work settles or you quit.
- A conversation that opened with an image comes back to the sidebar.
- A session belongs to the account it started on, rather than billing the wrong
  one for a continuation.
- A work section you closed stays closed when you come back to it.

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
