Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 0.20.0

- **Watch the model think, if that is what you came for.** Thinking folds into
  the activity marker with the calls it was reasoning about, which is right when
  reasoning is context for the answer and wrong when it is the thing you have
  the app open to see — it put the interesting part behind two clicks. There is
  a switch in Appearance now, off by default. On, a burst becomes reasoning in
  the thread with markers between the paragraphs for the work, and the blocks
  render open as muted prose, growing as the model writes them. It applies to
  the conversation already on screen, so you can flip it and look rather than
  flip it and wonder. A single block you would rather not read still collapses
  on its own, and stays that way.

- **A conversation no longer stops dead while you look at something else.** With
  Artemis behind another window — minimised, covered, on another Space — the
  transcript could freeze while the agent carried on working, and then deliver
  everything in one burst when you came back, reloaded, or stopped and started
  the session. The moment you most needed to follow was the moment all of it
  arrived at once.

  Two separate causes, both now fixed. The transcript batched its updates onto
  an animation frame, and a window that is not being drawn is never given one —
  so the batch was never applied and every later update queued behind it. And
  re-attaching after a reload held each conversation's live events while it read
  that conversation's history back, one after another, with no time limit: the
  more sessions you had running, the longer the last of them stayed silent.
  Anyone working across several accounts saw this most, because switching
  between them is what triggers the heavy history reads.

## What's new in 0.19.0

- **A conversation that is still working keeps its column.** Leaving one —
  clicking another session, closing a pane — could throw it away outright: the
  bow went to rest, the workflow tab shut, and the button that reopens it sat
  disabled with nothing to show. The agent never stopped; sending it any
  message brought the whole thing back. The cause was that a window decided
  "finished" from its own delegated rows, and those rows stop arriving the
  moment the launching turn ends — which is exactly when a workflow starts
  outliving it. The main process always knew, and can now be asked, so the
  sidebar keeps marking work that has outlived its turn and a column is set
  aside rather than destroyed. Anyone running several accounts at once hit this
  hardest, because switching between them is all navigation.

- **A window in the background keeps its clocks running.** Timers were being
  throttled to roughly once a minute whenever Artemis was not the front window,
  which stalled the delegated-agent view and the history feed for precisely as
  long as you were looking at something else. Coming back showed a frozen
  indicator over an agent that had been working the whole time.

## What's new in 0.18.0

- **Cerebro waits to be asked.** Having the bank cloned on this machine was
  being read as consent to it: every run start synced it — promoting drafts and
  opening pull requests against a repository the whole team shares — and its
  prompt spent context on every run of every profile. There is a switch now, at
  the top of Settings → Cerebro, and it is **off**. Turning it on wires every
  profile back up and syncs once; turning it off unwires them, so the
  instruction block, the `/cerebro` command and the session-start hook come out
  rather than staying live for a stock Claude Code on the same machine. The
  built-in Cerebro prompt follows the switch instead of carrying one of its own
  — your preference on that row is kept, it simply is not sent while the bank
  is off.

  **If you already had Cerebro working, it goes quiet until you throw the
  switch.** That is the point of the default, not a migration gap.

## What's new in 0.17.1

- **The Delegated pane opens when you ask for it.** Turning off *Open on its
  own* was taking the header's Delegated button with it: with agents working,
  the button lit up and pressing it did nothing at all — and since a subagent's
  transcript is reachable only from those rows, nothing delegated could be
  watched at all while the setting was off. The rows were never lost, only
  undrawable. The delegated tab is the one surface in the dock with two
  origins — it arrives with the work, and it opens on a press — and the strip
  now tells the two apart. Delegated work still opens nothing by itself; a
  press opens it, and its ✕ hands the setting back.

## What's new in 0.17.0

- **The team memory bank starts pulling its weight.** Cerebro's sync now runs
  from Artemis itself at every run start — the SessionStart hook it used to
  rely on lives in settings files Artemis deliberately never loads, so for its
  first three days the bank never synced and no agent ever wrote to it.
  Drafts promote, teammates' memories arrive, and new projects get the bank,
  all without a hook.

- **Agents are actually briefed on the bank.** The built-in Cerebro prompt was
  four bullets naming a command that wasn't on anyone's PATH. It now carries
  what the managed CLAUDE.md block was never able to deliver: maintaining the
  bank is the agent's job, the command resolves (with a fallback path), team
  facts route to the bank rather than personal memory, and repo-specific
  facts are scoped with `--applies-to` so one repo's conventions stop
  spending every other repo's context. Three prose assertions in the test
  suite keep those sentences from silently vanishing.

- **Memories enter through agents, and only agents.** The Cerebro pane's
  draft form is gone, along with its whole IPC channel: a human-facing form
  was a second authoring path that knew none of the house style agents are
  prompted to apply. State the fact to an agent instead — cheaper, and it
  lands scoped and styled. The pane keeps what a window should have: setup,
  sync, the memory list, and retire.

## What's new in 0.16.2

- **The hunt has a quarry, and it rides with the text.** The bow scene moves
  inside the conversation itself — at the bottom of the text, pushed down by
  each line as it streams in, scrolling with the transcript, spanning exactly
  the width of the prose. And the bow finally shoots at something: a stingray
  idles at the far side, swimming in place while the run works, flinching in
  the exact frames the arrow lands, frozen mid-swim while a permission waits
  on you, and dimming with the bow when the run ends — plainly never struck,
  because the hunt is the run and the run always comes back for another pass.

## What's new in 0.16.1

- **The bow answers its first day of feedback.** The hairline sweep above the
  input is back — trading it away in 0.16.0 was a misread — and the bow moves
  to its own strip directly under the transcript, where it now stands
  *constant*: at rest before the first run and after the last answer, firing
  in between, holding at full draw while a run waits on you. And it draws in
  moonlight rather than machine-cyan — `lunar` is the accent named for
  Artemis' own light, and it is the colour the runbar already sweeps in, so
  the two indicators finally read as one system.

- **The side pane can be told to wait.** A new Appearance option, on by
  default: the dock opens itself when the agent produces something to look at
  — the first artifact of a conversation, delegated work, a page the agent is
  browsing. Turn it off and none of that appears without a click. An artifact
  waits behind its tile's Open button, anything that arrived unseen is
  revealed by turning the option back on, and nothing you opened yourself —
  shells, pages, previews — is ever touched.

## What's new in 0.16.0

- **Artemis draws her bow.** The hairline that swept the seam between the
  transcript and the composer is now a bow — the app's namesake, on screen at
  last. It fires for as long as a run is going: draw, hold, loose, a cyan arrow
  flying the width of the pane. A run parked on a permission holds at full draw
  — aimed, dead still, waiting on you — and a finished run rests it: string
  straight, arrow gone, dimmed to faint. The animation stopping rather than
  vanishing is the point; a resting bow under an answer is what a completed run
  looks like now. A pane that has never run shows nothing at all,
  `prefers-reduced-motion` gets a still nocked bow instead of the loop, and
  none of it goes near the per-token path — three poses driven by the run's own
  status, four CSS animations sharing one 2.4-second clock.

## What's new in 0.15.1

The rest of 0.15.0's account work. That release stopped new sessions piling onto
one account; this one closes the gap right after a run ends, and makes the two
places you would go to check any of it tell the truth.

- **A finished run re-reads the account it just spent.** While a run is live,
  0.15.0's reservation covers it — the ranking knows work is committed to that
  account even though the polled reading does not show it yet. The moment it ends
  that cover is withdrawn, correctly, and the account falls back to a reading
  taken *before any of the work happened*. So it read emptiest at exactly the
  moment it had just been drained, and won the next session. One targeted read,
  four seconds after the end, closes it — collapsed to one read per account when
  a burst of work settles at once.

- **The usage rings follow the poll.** They rendered a copy of the reading loaded
  when the meter mounted, and never saw the readings the background poll had been
  collecting since. Sit on one account through a long job and the 5-hour ring
  would not move, though the true figure was already in memory. Reloading the
  window fixed it — which is what "sometimes I have to refresh" turned out to
  mean. They now take whichever reading is newer, so the manual refresh button
  under them still wins when it is.

- **Account rows show their plan again.** The tier was hidden unless a sign-in
  probe had confirmed the account, and nothing ran that probe until you opened
  Settings → Profiles — so on a fresh launch every row in the picker came up
  unlabelled, despite the plan poll already knowing. The tier now hides only for
  an account actually checked and found signed out, and the account you are about
  to run on gets its sign-in state read at the three moments it can change.

## What's new in 0.15.0

A release about running several accounts at once. Every item below was reported
by someone working across eight profiles, and all four turned out to be the same
thing seen from different sides: the app knew which accounts existed and not
which ones were *in use*.

- **A new session stops piling onto the account the last one is draining.** The
  chooser ranked accounts on a polled reading, and the poll lags its own
  consequences — start a session, it takes the emptiest account and begins
  draining it; start another a minute later and nothing has re-polled, so the
  same account still reads emptiest and wins again. Four or five sessions landed
  on one profile while the rest sat idle. It got *worse* the more accounts you
  had, because the poll walks them one at a time and a longer cycle is a longer
  blind window. The ranking now subtracts what the runs already on an account
  are committed to spending, weighted by model and effort — a Fable ultracode
  session counts several times what an Opus max one does, because ultracode
  multiplies how many turns there are rather than how long one takes.

- **A session resumes on the account it last ran on.** With `projects/` shared
  across profiles, clicking a row labelled "Claude 5x" while working on "Claude
  3x" left the status line saying 3x, billed 3x, and then quietly relabelled the
  row 3x on the next listing — a conversation that appeared to wander between
  accounts on its own. The row, the status line and the account billed now
  agree. The odds of hitting this fell to nothing with two accounts and to
  almost certain with ten, which is why it went unnoticed for so long.

- **Every account in the picker shows how full it is.** The menu answered "which
  accounts do I have" and the rings answered "how full is the one I'm in".
  Neither answered the question that arrives with a fistful of accounts. Each row
  now carries the window that will actually stop that account first — the
  tightest one, not an average — in the same colours the rings use, read straight
  off the poll so opening the menu starts no work.

- **A GitHub PR link says where it stands.** Hover one in a transcript for its
  state, whether checks are green, and the size of the diff. The reading comes
  from your own `gh`; Artemis stores no GitHub token and has nowhere to put one,
  so with no CLI or no login the link stays exactly the link it was.

## What's new in 0.14.2

- **Delegated work splits live from finished.** The pane answers one question —
  is it still going — and a flat list answered it worst exactly when it mattered
  most: a workflow that had settled thirty agents pushed the two still running
  off the bottom. Running work is now on top and always visible; finished work
  is under a heading that says how much of it there is and starts shut. Closing
  it sticks, so a task settling does not make the pane jump.

- **Each item is a card.** The pane holds a one-line `Bash` next to a workflow
  with four phases and twenty agents folded underneath, and run flat the phase
  tree of one item read as though it belonged to the next. Settled cards are
  recessed rather than raised.

## What's new in 0.14.1

- **The browser has a button, next to the terminal's.** 0.14.0 hid it behind a
  menu on the dock's `+`, which was worse than the button it replaced: `+` on a
  tab strip already means "another of these", and putting two one-line choices
  behind a click cost everyone a step to reach what used to be direct. `+` opens
  a terminal again, and the browser sits in the header beside the terminal —
  which is where you look for "open a thing" — on **⌘⇧B**.

  One limit worth knowing: the shortcut cannot fire while the *page itself* has
  focus, because the page is a separate renderer and the app never sees the
  keystroke. It works from the address bar and anywhere in the app's own chrome.

## What's new in 0.14.0

- **A browser in the dock, and the agent can drive it.** The rail held a file
  and a shell; it now holds a page. Open one from the `+` menu, type an address,
  and it renders beside the conversation — a dev server on `localhost:5173`, a
  vendor's documentation, a staging environment you have signed into, since the
  session persists across restarts. The agent gets tools for the *same* page, so
  when it navigates or fills a form you watch it happen rather than reading
  about it afterwards; a browser it opens appears as a tab without stealing the
  one you were looking at. Every tool call goes through the ordinary permission
  prompt, because an MCP tool is a tool.

  A page runs with **no preload script**, on its own session, as a sibling of
  the app rather than a frame inside it — so there is no `window.artemis` to
  find and nothing for it to call. Only `http` and `https` load: `javascript:`
  is code, `data:` is a page with no origin, and `file:` is your disk. There is
  no search box, deliberately — an address bar in a coding tool sees internal
  hostnames and the occasional mis-pasted token, and a typo should not become a
  request to somebody else's server.

- **A path is a link only where there is a file.** Last release made every path
  in an answer clickable, and it was too eager: the rule for spotting one only
  ever had a string to look at, so `e.g` became a link and so did the file an
  agent had merely *said* it would write. Clicking either opened a pane saying
  there was nothing there. Artemis now asks first, in one batched question per
  answer, and a fragment stays plain text until the answer comes back. A *yes*
  is remembered; a *no* is re-asked when the next answer arrives, so the file
  the agent promised in one turn is a link by the next — and a window nobody is
  typing into does no work at all.

- **A file full of secrets opens.** Reading a `.env`, a README documenting an
  `sk-ant-…`, or a checked-in PEM fixture failed outright with a
  credential-safety error: the channel that reads a file as text was never given
  the policy its sibling has, so Artemis refused to show you a file already on
  your disk. Both now share one policy, named for what it is.

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
