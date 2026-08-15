Internal build — unsigned, on purpose. Every artifact here is built on the
machine it targets, and boots before it ships.

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
