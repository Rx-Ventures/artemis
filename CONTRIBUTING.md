# Contributing

**Artemis is not accepting pull requests yet. Issues are open, and they are
read.**

## Why the door is closed

Artemis is built on one claim: that the provider seam is real — that registering
a provider is one line in `packages/core/src/adapters/registry.ts`, and that the
UI degrades from a capability descriptor rather than assuming every provider can
do everything.

That claim has been tested once. Adding Codex was that array plus an options
field, with nothing changed elsewhere in the app. Once is an encouraging result,
not a proof. OpenCode is declared in the protocol and renders in the UI as
unavailable; its adapter does not exist yet. Until it does, the seam is a
hypothesis with a sample size of two, and the interfaces a contribution would
build on — the eleven-variant event union, the capability descriptor, the
credential spec — are still allowed to move.

So a pull request written against them today could be invalidated by the very
change that proves them. The review would cost us both something and teach us
nothing. Holding the door is cheaper than that, and more honest than merging
work we would then break.

This is a statement about the roadmap, not about contributors. **When the third
adapter lands and the seam stops moving, this file changes.**

## What is welcome right now

- **Bug reports.** Artemis is working end to end for Claude and Codex, which
  means it is now failing in ways only other people's machines will find. These
  are the most useful thing you can send.
- **Ideas and design disagreement.** Open an issue. Nothing about the roadmap is
  secret, and an argument against a decision is worth more before the third
  adapter lands than after.
- **Security reports** — privately, and not as a public issue. See
  [SECURITY.md](SECURITY.md).
- **Forks for your own use.** The license permits it. Read the
  [NOTICE](NOTICE) first if you intend to distribute a build to other people;
  there is a constraint there that is not obvious.

## If you have already opened a pull request

It will be closed with a link to this file. That is not a judgement of the work
or an invitation to stop paying attention — it is the pause doing what it says.
If the change is a bug fix, please open an issue describing the bug; the fix
will land, with credit, through the normal roadmap.

## Conventions

These hold now, for anyone reading the codebase, and they will still hold when
the door opens.

### The boundaries are enforced, not advised

Three of Artemis's architectural rules are enforced by the type system rather
than by review, and a change that violates one will fail the build rather than
attract a comment:

- `@rx-artemis/protocol` compiles with `"types": []` — no ambient Node, so it
  cannot reach for a filesystem.
- `@rx-artemis/core` has no dependency on `electron` and must never gain one.
  `packages/core/src/no-electron.test.ts` fails the build if that changes.
- `apps/desktop/renderer` compiles without `@types/node`, so `fs`, `process` and
  `electron` do not typecheck there.

Two more rules are conventions the reviewer holds, because no type can express
them: the preload exposes a fixed set of channels and never wraps `ipcRenderer`,
and **no channel name is ever built from renderer input**. A change that makes
the reachable IPC surface depend on runtime strings will be rejected on that
ground alone.

### Naming

Artemis is an independent project. Contributions must not introduce another
product's branding, visual identity, or ASCII art. See the Naming section of the
[README](README.md#naming).

### Commit subjects are sentences

The log reads as prose, in the present tense, from the reader's side of the
change:

```
The stream stops stalling when nobody is looking at it
The reasoning joins the thread when you ask to watch it
Check the machine before offering setup: cerebro preflight
```

No type prefix, no ticket number, no `feat:`. Say what is different now, not
which files moved.

### Before anything is proposed

```bash
pnpm typecheck   # build the project graph and typecheck every package
pnpm test        # vitest across the workspace
pnpm build       # production bundles
pnpm smoke       # headless end-to-end run, no Electron
```

`pnpm smoke` runs against the config directory your CLI is already signed in to,
**and the run is billed to that account.** It is the fastest way to tell an
Electron plumbing fault from a core one.
