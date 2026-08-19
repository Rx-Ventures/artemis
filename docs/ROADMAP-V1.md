# Artemis v1

Written 2026-08-18 against `main` at `3b98b14` (0.20.0). Every number and flag
below was measured, not remembered; where something is unknown this document
says so rather than guessing.

v1 is the release where the central claim stops being a claim. Artemis is built
on a provider seam, and the seam has been tested once — Codex was one line in
the registry plus an options field. A third provider is what turns that from an
encouraging result into a proof, and until it lands the interfaces are still
allowed to move. Everything below is downstream of that.

## What "parity" has to mean

The obvious bar — *every provider answers `true` to every capability* — is the
wrong one, and adopting it would make v1 unreachable. The
[capability descriptor](../packages/protocol/src/provider.ts) exists precisely
because providers differ: ACP has no steering method, so OpenCode cannot support
mid-run steering no matter how much adapter work we do. Codex's only instruction
lever is `baseInstructions`, which *replaces* the coding-agent preset instead of
appending to it. Those are upstream facts, not a backlog.

So the v1 bar is:

> **Every capability flag is either `true`, or `false` for a documented upstream
> reason — and the UI degrades correctly either way.**

That is achievable, and it is testable. It also means a `false` is not
automatically a gap: it is a gap only when Artemis could have done the work and
hasn't. Under this bar the failure mode we are actually chasing is the third
one — a flag that is `false` because nobody has checked, which reads to a user
as a missing feature and to us as a decision we never made.

## Measured position

Declared capabilities, read from
[`claude.ts`](../packages/core/src/adapters/claude.ts),
[`codex.ts`](../packages/core/src/adapters/codex.ts) and the OpenCode adapter on
`worktree-acp-transport-and-the-opencode-adapter`. Anything not explicitly
overridden inherits `false` from `NO_CAPABILITIES`.

| Capability | Claude | Codex | OpenCode |
| --- | :---: | :---: | :---: |
| `interactivePermissions` | ✅ | ✅ | ✅ |
| `partialMessages` | ✅ | ✅ | ✅ |
| `midRunSteering` | ✅ | ✅ | ❌ |
| `forkSession` | ✅ | ✅ | ✅ |
| `listSessions` | ✅ | ✅ | ✅ |
| `resumeSession` | ✅ | ✅ | ✅ |
| `subagents` | ✅ | ❌ | ❌ |
| `subagentTranscripts` | ✅ | ❌ | ❌ |
| `renameSession` | ✅ | ✅ | ❌ |
| `deleteSession` | ✅ | ✅ | ❌ |
| `usageReporting` | ✅ | ✅ | ✅ |
| `costReporting` | ✅ | ❌ | ✅ |
| `planUsageReporting` | ✅ | ✅ | ❌ |
| `systemPromptAppend` | ✅ | ❌ | ❌ |
| `imageInput` | ✅ | ✅ | ✅ |
| `fileInput` | ✅ | ✅ | ❌ |
| `permissionModes` | 6 | 4 | 2 |

Claude answers `true` to all seventeen. Codex is closer than "get Codex working"
suggests — eleven of seventeen, and two of the remaining six are already
documented upstream limits. OpenCode, on a branch that does not yet exist on
`main`, already answers `true` to nine.

Every `false` above sorts into exactly one of three buckets, and the whole plan
is a matter of emptying the third.

**Upstream limits — closed, documented, no work beyond correct degradation:**

- OpenCode `midRunSteering` — ACP models a turn as one `session/prompt` request.
  There is no steering method to call.
- OpenCode `systemPromptAppend` — ACP exposes no append; OpenCode owns its
  instructions.
- OpenCode `planUsageReporting` — metered credits, not a subscription with
  rate-limit windows. The concept does not apply.
- Codex `systemPromptAppend` — `baseInstructions` replaces the preset rather than
  adding to it, and approximating an append with a replace would silently drop
  the coding-agent preset.

**Unknown — resolved 2026-08-18, by driving both CLIs:**

Every one of the eight was interrogated. **Seven turned out to be upstream
limits and one was a real bug** — though not the bug that was expected.

| Flag | What the probe found | Verdict |
| --- | --- | :---: |
| Codex `subagents` / `subagentTranscripts` | an unknown method makes the server enumerate all ~100 valid ones; none concerns delegation, and the experimental surface has none either | limit |
| Codex `costReporting` | `account/usage/read` answers tokens and daily buckets, `account/rateLimits/read` adds plan windows and credits; neither carries a price | limit |
| Codex `auto` / `dontAsk` | `dontAsk` denies where Codex's `never` proceeds — opposites; and `auto` would map to `on-request`, which `acceptEdits` already uses, so it would be two names for one behaviour | limit |
| OpenCode `renameSession` | `session/rename` → *Method not found* | limit |
| OpenCode `deleteSession` | `session/delete` → *Method not found* | limit |
| OpenCode `subagents` | absent from `agentCapabilities`, no method | limit |
| OpenCode `fileInput` | `promptCapabilities.embeddedContext: true` — **advertised**, but a `resource` block hangs the turn | limit, for now |
| OpenCode `imageInput` | declared `true` and **never sent** — `createRun` passed a text block only | **bug, fixed** |

The last row is the one worth the reading. The flag most likely to be wrong was
not one of the `false` ones — it was a `true` that had never been exercised. An
attached image was dropped in silence and the model answered about a picture it
had never seen, which is the failure the adapter's own header warns about,
sitting inside the adapter that warns about it.

`fileInput` is the other lesson. The handshake advertises `embeddedContext`, the
block was built, and sending it produced nothing for seven minutes while the
same prompt without it finished in seconds. It was nearly shipped as `true` on
the strength of the advertisement alone. It stays `false` with the evidence
written down, and files are named in the prompt as unattachable so the model can
say so rather than the user waiting on a run that never returns.

**Real gaps: one, found and closed.** The rest of the matrix is upstream limits
with the UI degrading correctly, which is the v1 bar met for both providers.

## Workstreams

### A. Land the ACP transport and OpenCode adapter

`worktree-acp-transport-and-the-opencode-adapter` is 5,307 insertions across 15
files: an ACP client and protocol, the OpenCode adapter and mapper, three test
files totalling ~1,500 lines, an `acp-probe` script and an `opencode-smoke`
script. It is 21 commits behind `main` and **merges with zero conflicts**.

This is the unblocker, and it should go first because nothing else about
OpenCode can be assessed while it sits on a branch. Merge `main` in, run the
full suite plus `opencode-smoke`, open a PR.

It also carries `docs/research/OPENROUTER-GAP-ANALYSIS.md` (504 lines), which
should be read before the probe pass rather than after.

### B. The probe pass

Turn every "unknown" above into either a closable gap or a documented upstream
limit. This is deliberately its own workstream and not folded into B and C,
because its output is what makes the rest of the plan estimable — right now
"bring Codex to parity" could mean two days or three weeks, and the difference
is entirely in whether Codex has subagents.

The house rule from the OpenCode adapter applies: *a capability declared from an
advertisement is an affordance that fails in the user's hands.* Verify against a
running CLI, not documentation.

### C. Codex to the v1 bar

Close what the probe finds. Document what it cannot. The likely shape is
`costReporting` and the two missing permission modes as real work, and subagents
as an upstream limit — but that ordering is a guess until B runs.

### D. OpenCode to the v1 bar

Same, after A. `renameSession`, `deleteSession` and `fileInput` are the probable
gaps; `fileInput` is genuine adapter work (staging files somewhere the agent can
reach and naming them in the prompt) rather than a flag flip.

### E. Cerebro: any bank, including local-only

Today `CEREBRO_REPO_URL` is hardcoded to `Rx-Ventures/cerebro` at
[`bin/cerebro:38`](https://github.com/Rx-Ventures/cerebro), and there is no
`setup` command — the closest are `doctor` (checks the machine) and
`enable`/`disable` (toggles the profile pointer). Local-only already half works:
three call sites guard on `run_git(repo, "remote")`, and `promote --help`
already says "commit (no remote) or open an auto-merging PR". So the mode exists
as an implicit fallback rather than as something a user can choose.

v1 makes it a choice:

- The bank location becomes configuration, not a constant.
- **Local-only is first-class** — a bank with no remote, no PR gate, no
  auto-merge, committing straight to the working branch. The validate/secret/
  injection gates still run; they are the part that must not be optional.
- A `cerebro setup` wizard walks a user from nothing to a working bank: pick
  local-only or a remote, name the location, run `doctor`, install.
- **Off by default.** Nothing happens until someone completes setup. Artemis's
  existing `CerebroSection` becomes the onboarding surface for it.

This workstream is independent of the provider work and can run alongside it.

### F. The dock

`DockPane` (22k) hosts six tab kinds — `preview`, `file`, `terminal`, `browser`,
`tasks`, `agent` — with `TasksPane` at 29k the heaviest single component in the
renderer. It grew a tab at a time, and it shows.

Placed after the provider work on purpose: the delegation and subagent surfaces
are exactly what the probe pass will settle, and redesigning the agent and tasks
tabs before knowing whether two of three providers can even delegate would mean
designing for a shape we are about to learn.

### G. The UI overhaul

43 components, ~43k lines of renderer. Last, deliberately: it should cover three
providers, the reworked dock, and the scope as it actually ended up rather than
as it was when the current design was drawn. Doing it earlier guarantees doing
it twice.

## Where this ended up

Written 2026-08-17, closed 2026-08-19. Recorded here rather than deleted,
because the interesting part of a roadmap is where it was wrong.

| | Workstream | Outcome |
| --- | --- | --- |
| A | ACP transport and OpenCode adapter | **Done.** |
| B | The probe pass | **Done.** Eight flags resolved: seven upstream limits, one real bug — and the bug was a `true`, not a `false`. |
| C | Codex to the v1 bar | **Done.** |
| D | OpenCode to the v1 bar | **Done.** |
| E | Cerebro: any bank, including local-only | **Done for v1.** See below. |
| F | The dock | **Partly.** Surfaces and shared chrome done; delegation not rethought. Deferred past v1 deliberately. |
| G | The UI overhaul | **Done.** |

### Where the plan was wrong

**F was framed as "redesign or rewrite", and the framing was the error.** The
question cited `TasksPane` at 29k as "the question in miniature". Measured, that
is 375 lines of code across 20 small components plus 260 lines of comment;
`DockPane` is 369 across 11; `state/dock.ts` is 68% comment. The bytes were
mostly the documentation that makes this codebase good. Sizing a rewrite
decision by file weight in a repo that comments this heavily reads the wrong
signal.

What the dock actually needed was smaller and more specific than either option:
two panes had drifted to different header heights, one class named a token that
never existed, and one colour reached past the design system into Tailwind's
palette. None of that is visible from a line count.

**E was written as product work and had mostly become infrastructure by the
time it was read.** The wizard, off-by-default, any-bank and local-only all
landed on `v1` during the provider work. One gap remains — `v1` can retire a
memory but cannot draft one — and the answer for v1 is that the CLI is enough,
because that is the path every memory has actually been written through.
`origin/cerebro-settings` carries a drafting UI, predates `v1`'s Cerebro work by
three days, and conflicts in five files; it is not v1's problem.

**The v1 bar held.** "True, or false for a documented reason" was proposed as
the softer alternative to universal parity and was worth confirming rather than
assuming. It survived contact: the probe pass produced seven documented
`false`s, and the one place the softer bar would have let something slide — a
capability declared and not delivered — is exactly where it caught a bug
instead.

## Sequence

```
A  land ACP branch
└─ B  probe pass ──┬─ C  Codex to the bar ──┐
                   └─ D  OpenCode to the bar ┴─ F  dock ── G  UI overhaul

E  cerebro ─────────────────────────────────────  (independent, any time)
```

The one hard ordering constraint is A before B before C/D. F after C/D is a
judgement call, not a dependency — it can start earlier if the probe pass shows
delegation is settled. G last is the user's call and a sound one.

## Open questions

1. **Is the v1 bar the right bar?** This document assumes "true, or false for a
   documented reason". The alternative — hold v1 until all three providers
   answer `true` to everything — is not reachable, because ACP has no steering
   method. Worth confirming that the softer bar is accepted rather than assumed.
2. **Does v1 gate on a Cerebro that ships to other people?** E is written as
   product work. If Cerebro stays an internal tool, its wizard does not have to
   be finished for Artemis v1 and can drop out of the release entirely.

   **Measured, 2026-08-19.** Most of E has landed on `v1` already: the bank can
   live anywhere, private is a decision, and a bank that cannot commit says so
   rather than looking finished. `v1` carries eight Cerebro IPC channels —
   status, list, preflight, setup, sync, retire, setEnabled — so the wizard and
   the off-by-default rule are done.

   One gap, and it is a specific one: **`v1` can retire a memory but cannot
   draft one.** `cerebroDraft` exists only on `origin/cerebro-settings`, whose
   last commit predates `v1`'s Cerebro work by three days and which now
   conflicts in five files. That branch is not obsolete — it carries a real
   drafting UI — but rebasing it is work that only pays off if drafting from
   inside Artemis is in scope.

   So the question narrows usefully: **does v1 need to draft memories from the
   app, or is the CLI enough?** If the CLI is enough, E is done and
   `cerebro-settings` should be deleted rather than left looking pending. If it
   is not, the branch needs a rebase onto the newer `cerebro.ts`, not a merge.
3. **What is the v1 bar for the dock — a redesign or a rewrite?** `TasksPane` at
   29k is the question in miniature.
4. ~~**Version skew:**~~ **Answered.** The root, `core` and `protocol` manifests
   are private, unpublished, and linked by `workspace:*`, which resolves by name
   — nothing read their versions, which is why they had drifted to `0.16.2` and
   `0.14.2` while the app was at `0.20.0`. Syncing them would only recreate the
   drift at the next release, since releases bump the app alone, so the field is
   gone from all three. `apps/desktop` keeps it: the release workflow checks the
   tag against it, and it is now `1.0.0`.
