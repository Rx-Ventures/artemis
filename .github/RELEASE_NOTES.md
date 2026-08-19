Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

## What's new in 1.0.0

Version one. Three providers at a stated bar, a design language that is the
app's own, and both of those enforced by tests rather than described in
comments.

### Three providers, honestly labelled

Claude, Codex and OpenCode are all supported, and every capability is either
`true` or `false` **for a documented upstream reason**. That is the bar, and it
is deliberately not "everything works everywhere" — ACP has no steering method,
so flag-for-flag parity is unreachable and pretending otherwise would just move
the lie into the UI.

Which means the interface degrades from what a provider actually does rather
than from what it advertises. A control that cannot work is disabled and says
why. Driving each capability rather than trusting the handshake found eight
answers and one real bug: `imageInput` was declared and the attachments were
silently dropped.

Local models are first class alongside them: **LM Studio, Ollama and llama.cpp**,
no account and no network.

### Tools run confined, or they do not run

Commands execute inside an OS sandbox — Seatbelt on macOS, bubblewrap on Linux
— across two axes copied from Codex: what the OS permits, and when a human is
asked. Where nothing can confine a command, Artemis **refuses rather than
silently downgrading**.

The check that proves this works caught the sandbox failing: a blanket
`/private/var/folders` rule made every other application's scratch directory
writable, and a command escaped the workspace. The profile now allows exactly
the roots it was handed and nothing else.

### It looks like itself now

The old palette was six steps of elevation, Vercel's typeface and the violet
every tool of this generation uses — each decision defensible alone, and
together somebody else's identity.

Now: one plane and a hairline. Depth is deleted rather than reduced, so
boundaries are rules instead of stacked greys. Archivo and JetBrains Mono.
A teal accent. Radius carries meaning — square for what the machine produced,
soft for what you operate. A new mark: a square frame around a half-lit moon,
which is that same rule drawn at 512.

**Waiting looks different from working.** A run is starting, running, waiting on
you, failed or settled — five named states where several used to be the same
grey dot — and each says *why*. A queued permission outranks a running status,
because a provider that has asked for something is, to you, waiting. Elapsed
time sits beside it, because "is it stuck" is the real question and a spinner
cannot answer it.

### The conversation reads as a conversation

The transcript used to interleave everything as it happened: a paragraph, a
`Ran 3 commands` bar, the rest of the paragraph. Now the calls sink to one
marker at the foot of the exchange — growing as the run works, folding open in
order — and the boundary is the *break*, when the model stops and waits.
Interrupting a run to redirect it does not split the account in two; steering
one request is still one request.

Reasoning is a message, not machinery. It stands where the model wrote it, as
muted prose beside a sage rule, on by default — the Appearance switch now only
decides whether a block arrives expanded. And the provider avatar is gone from
the gutter: which model wrote a turn is a fact that does not change per row,
and the status line already says it once.

While a run is live, the border above the composer is the indicator: an
ordinary hairline at rest, it grows to carry the shuttle while work happens,
amber while something waits on your answer, signal when a run fails. The words
— which state, why, for how long — stay at the foot of the conversation.

### The dock grows a file browser, and files stop evicting each other

The working directory sits in the dock: the column's own folder, icons by
kind, `..` at the top of every listing, click a file to read it. The reader is
the same one the transcript's links open — same channel, same gates, syntax
highlighting included — and every file now gets a tab of its own. Following a
second link used to replace the first, which made the thing reading code is
mostly made of impossible. Tabs keep their own scroll positions, a path opened
twice is one tab brought forward, and a restart reopens what was open.

The strip that holds it all runs down the dock's side instead of across its
top, so tabs cost height in a column that scrolls rather than width the
composer needed.

### The command bar searches what it says it searches

Typing a session's title into ⌘K used to return "Nothing matches that" — the
sessions were a page down, behind a row named "Resume a past session…".
Matching sessions now join the results as you type, found by title, opening
prompt, branch, project or profile. An empty bar still shows commands, so it
opens as a menu and behaves as a search.

### What the tests now enforce

Four checks that read the source and fail the build, added because prose does
not fail a build:

- every palette value falls inside sRGB, clears WCAG AA on both grounds, and
  keeps 40° of hue separation
- nothing in the normal flow lifts off the plane
- small caps are spelled one way
- every colour class names a token that exists

Writing them found bugs that judgement had not, including one that shipped in
two previous releases: `--line-strong` had never met WCAG 1.4.11 in dark mode.
It draws scrollbar thumbs and radio borders, which are owed 3:1, and it measured
1.97.

### A beta channel, off by default

Settings → Advanced has a switch that widens what the updater will offer this
installation to include prereleases. It is off unless you turn it on, and it
changes nothing else: a beta is the same build as the release that follows it,
tagged earlier, and the version you are offered still lands on the stable one.
Turning it back off uninstalls nothing.

Building it fixed a bug that had been there the whole time — the update
comparator returned false for any version carrying a suffix, so a beta build
could never have updated itself, not even to the release it was a rehearsal for.

### The work gets handed on before the account runs out

Running out of plan mid-conversation loses the expensive part — not the turn,
but everything the agent had worked out: which files matter, what it had already
tried, what it was about to do next. On, Artemis stops just short of the limit
and spends the last of the budget asking for a briefing the next session can
start from, written into `.artemis/` and shown as an artifact.

It stops at **90% of the 5-hour window, 98% of the weekly, 95% of Fable** —
different margins because the 5-hour window refills within the day and the
weekly one does not. It interrupts a run in flight to do this, so it is **off
unless you turn it on**, in Appearance → Handing over, and every conversation it
stops offers a button to carry on regardless.

Plan usage is now read every two minutes rather than every five, and between
those sweeps only the accounts with a run on them are read — so an idle machine
polls no harder than it used to.

### Escape asks first

Escape closes the palette, closes a dialog, denies a permission the agent is
waiting on, and stops the run. Only the last of those is destructive, and it
shares a key with three reflexes that are not: reaching for Escape to dismiss
something that has already gone stopped the work instead. There is a switch in
Appearance → Keyboard now. Off, Escape still does the other three; the Stop
button is untouched.

### A message no longer disappears into a run that just ended

Sending a prompt as a turn finished could produce *"Run … has already ended"* —
a red banner over a dimmed message, with nothing to do but type it again. The
window and the main process simply disagreed for a few milliseconds about
whether the run was still live. The prompt now starts a fresh turn instead,
which is what it would have done had the two agreed.

### Also

- `pnpm package` works from a clean checkout. It used to depend on `typecheck`
  having run first to build the workspace libraries, which was true in CI by
  accident of ordering and false on a new machine.
- The slowest test in the suite was not flaky, it was queueing on a real 600ms
  debounce five times over. 2.91s to 542ms.
- Private vulnerability reporting is enabled, so `SECURITY.md`'s link resolves.

### Known

- The light theme's accent is muted and cannot be otherwise: teal is the
  narrowest useful hue in sRGB at mid lightness. Documented rather than nudged.
- The tasks and agent panes have the new surface treatment but not a rethought
  one. Delegation is still presented as a list.
- Unsigned, as before. Every artifact is built on the machine it targets and
  boots before it ships.

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
