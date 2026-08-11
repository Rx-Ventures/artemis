# Adding a Codex provider to Apollo — feasibility

Research notes, verified against `codex-cli 0.142.3` installed locally. Every protocol
claim below was confirmed by driving the real binary, not read off documentation.

## Verdict

**Very doable — 1.5–3 weeks of focused work, and essentially zero architectural risk.**

The seam in `packages/core/src/adapters/types.ts` was designed against Codex as one of its
three reference transports, and that design holds up under contact with the real protocol.
Codex's app-server turns out to be a *closer* fit to Apollo's model than the Claude Agent
SDK is in a couple of places (plan usage, session listing).

The work is almost entirely **additive**: two new files plus a JSON-RPC client. The
count of pre-existing files needing edits is four, three of them trivial.

## What was verified live

Spawned `codex app-server` and drove it exactly as an adapter would.

| Check | Result |
| --- | --- |
| `initialize` handshake | Works. Returns `codexHome`, `platformFamily`, `platformOs`. |
| `getAuthStatus` | `{ authMethod: "chatgpt", requiresOpenaiAuth: true }` |
| `model/list` | Live catalogue: `gpt-5.5` (default), `gpt-5.4-mini`, … with `supportedReasoningEfforts`, `defaultReasoningEffort`, `isDefault`, `displayName`, `description` |
| `account/rateLimits/read` | `{ primary: { usedPercent, windowDurationMins, resetsAt }, credits, planType: "free" }` |
| `thread/list` | Paginated, with `cwd`, `path`, `gitInfo`, `preview`, `createdAt/updatedAt` |
| `thread/start` → `turn/start` → completion | **Full turn streamed end to end.** |
| Token-level streaming | Confirmed: `item/agentMessage/delta` arrived as `"P"`, `"ONG"`. |
| `CODEX_HOME` isolation | Confirmed: a scratch `CODEX_HOME` reports `Not logged in` independently of `~/.codex`. |

Observed event order for one real turn:

```
thread/started
turn/started
item/started        (userMessage)  → item/completed
item/started        (reasoning)    → item/completed
item/started        (agentMessage)
item/agentMessage/delta  "P"
item/agentMessage/delta  "ONG"
item/completed      (agentMessage)
thread/tokenUsage/updated  { total: { totalTokens: 13853, inputTokens: … } }
account/rateLimits/updated
turn/completed      status=completed
```

That maps onto Apollo's nine-variant `AgentEvent` union with no gaps.

## Transport choice: `app-server`, not `exec --json`

Two candidate transports exist. `codex exec --json` is a one-shot JSONL stream — simple,
but no interactive approvals, no mid-run steering, no session listing. It cannot satisfy
`Capabilities.interactivePermissions`.

`codex app-server` is bidirectional newline-delimited JSON-RPC 2.0 over stdio (note: it
omits the `"jsonrpc":"2.0"` field). It has server-initiated requests, which is exactly the
shape `Run.respondToPermission()` needs. It also supports `--listen unix://` and
`ws://`, though stdio is the right default for a desktop app.

**The protocol types are generated, not hand-written:**

```bash
codex app-server generate-ts --out ./schemas
```

That emitted 921 lines across ~170 type files, including the full `ServerNotification`
(69 notification variants), `ServerRequest` (10 server-initiated request variants), and
`ClientRequest` (~100 methods) unions. Vendoring this removes the single largest source of
tedium and drift. Output is version-specific to the CLI that generated it.

## Event mapping

| Apollo `AgentEvent` | Codex source |
| --- | --- |
| `session.started` | `thread/started` (+ `thread/start` response carries `id`/`sessionId`) |
| `text.delta` | `item/agentMessage/delta` |
| `text.complete` | `item/completed` where `item.type === "agentMessage"` |
| `thinking.delta` | `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` |
| `tool.start` | `item/started` for `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` |
| `tool.end` | `item/completed` for the same |
| `permission.request` | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` |
| `usage` | `thread/tokenUsage/updated` |
| `run.end` | `turn/completed` (`status`: `completed` \| `interrupted` \| `failed`) |

Control surface:

| `Run` method | Codex method |
| --- | --- |
| `send()` | `turn/steer` (requires `expectedTurnId` match) |
| `interrupt()` | `turn/interrupt` |
| `respondToPermission()` | Reply to the pending server request id |
| `dispose()` | Kill child + settle outstanding approval deferreds |

Adapter methods:

| `ProviderAdapter` | Codex method |
| --- | --- |
| `listModels()` | `model/list` — real live catalogue, satisfies the `live: true` contract |
| `listSessions()` | `thread/list` filtered by `cwd` |
| `listAllSessions()` | `thread/list` unfiltered |
| `getSessionMessages()` | `thread/read { includeTurns: true }` or `thread/items/list` |
| `fetchPlanUsage()` | `account/rateLimits/read` |
| `checkAvailability()` | `codex --version` or a bare `initialize` |

Two of these are notably *better* than the Claude equivalents:

- **`fetchPlanUsage()`** — the Claude adapter reaches this through a tolerant lookup of
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` and degrades to
  "unavailable" on rename. Codex has a first-class `account/rateLimits/read`, plus an
  unsolicited `account/rateLimits/updated` notification for free live refresh.
- **`listAllSessions()`** — the seam warns that Claude's project-directory names are a
  lossy path encoding and that `cwd` must come from session data. `thread/list` returns
  `cwd` as a real field, so that hazard just doesn't exist.

## Capabilities Codex declares

As implemented in [codex.ts](packages/core/src/adapters/codex.ts):

```ts
export const CODEX_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true,   // server-initiated approval requests
  partialMessages: true,          // verified: agentMessage deltas
  midRunSteering: true,           // turn/steer
  forkSession: true,              // thread/fork
  listSessions: true,             // thread/list
  resumeSession: true,            // thread/resume
  usageReporting: true,           // thread/tokenUsage/updated
  planUsageReporting: true,       // account/rateLimits/read
  subagents: false,               // collab agents exist, but items aren't mapped
  costReporting: false,           // tokens yes, dollars no
  permissionModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
};
```

## The one real impedance mismatch

Apollo's `PermissionMode` is a single axis (`plan | default | acceptEdits | auto |
dontAsk | bypassPermissions`) borrowed from the Claude SDK. Codex has **two independent
axes**:

- `AskForApproval`: `untrusted | on-failure | on-request | granular{…} | never`
- `SandboxPolicy`: `dangerFullAccess | readOnly{networkAccess} | externalSandbox |
  workspaceWrite{writableRoots, networkAccess, …}`

So every Apollo mode picks a *pair*:

| Apollo mode | `approvalPolicy` | `sandboxPolicy` |
| --- | --- | --- |
| `plan` | `never` | `readOnly` |
| `default` | `untrusted` | `workspaceWrite` |
| `acceptEdits` | `on-request` | `workspaceWrite` |
| `bypassPermissions` | `never` | `dangerFullAccess` |

**Two modes are deliberately not advertised.** My initial reading was that `dontAsk`
could map onto Codex's `never`; implementing it showed that is wrong. Apollo documents
`dontAsk` as "never prompt; **denies** instead of asking", while Codex's `never` never
prompts and **proceeds** within the sandbox. Those are opposites at exactly the moment
they matter, so mapping one to the other would make Apollo silently more permissive than
the user asked for — the specific failure `createRun` is required to reject rather than
degrade into. `auto` (a provider-side risk classifier) has no Codex equivalent at all.

Both are rejected by `validateCodexRunInput` with a message naming the supported modes,
rather than being quietly substituted.

This stayed a **mapping decision inside the adapter**, which is where the seam wants it —
`Capabilities.permissionModes` exists so providers can advertise a subset. It would only
become a protocol change if you wanted the sandbox axis exposed in the UI, which needs a
new capability field plus a descriptor entry. Deferred.

## Usage scope: settled empirically

`thread/tokenUsage/updated` carries `total` (thread-scoped) and `last` (one model
request). Which to report was the one genuinely ambiguous design question, so I measured
it: a turn containing two shell commands produced **three** usage notifications — one per
model request — whose `last` values summed exactly to the final `total`:

```
13563 + 13673 + 13724 = 40960
```

So `last` is a true delta and `total` is thread-scoped. The adapter emits `scope: 'delta'`
from `last` and accumulates its own run total for the `final` snapshot on `run.end`. Using
`total` as `cumulative` would have been wrong on any resumed session, where it opens at
whatever previous turns already spent.

## What has to change outside the new adapter

Genuinely small. Almost every `claude`/`anthropic` mention elsewhere in the tree is
explanatory prose in doc comments, not coupling.

1. **`packages/core/src/adapters/registry.ts`** — one line, already stubbed:
   ```ts
   // createCodexAdapter(options?.codex),
   ```
   Plus a `codex?: CodexAdapterOptions` field on `DefaultProviderRegistryOptions`.

2. **`packages/core/src/adapters/signIn.ts`** — *the only shared module that is actually
   Claude-shaped.* `parseAuthStatus()` hardcodes JSON field names (`loggedIn`,
   `authMethod`, `email`, `orgName`, `subscriptionType`), but `codex login status` prints
   plain text (`Logged in using ChatGPT` / `Not logged in`) and has **no `--json` flag**.

   Two options: add an optional `parseStatus` hook to `ProviderSignInSpec` (~30 lines,
   keeps one polling path), or have the Codex adapter answer auth from the app-server's
   `getAuthStatus` instead. The hook is cleaner — the profile screen polls
   `checkAuthStatus` directly and shouldn't grow a per-provider branch.

3. **`apps/desktop/renderer/src/components/ProfilesScreen.tsx`** — user-facing copy is
   hardcoded to Claude: "Each profile is a Claude account…", the `~/.claude` path
   placeholder, and `claude auth login` in the sign-in explainer. `signInHowTo` already
   comes from the descriptor; the surrounding prose and placeholder need to follow.

4. **`packages/protocol/src/profile.ts`** — `CREDENTIAL_ROUTING_ENV_KEYS` already includes
   `OPENAI_BASE_URL`. Worth adding `OPENAI_API_KEY` / `CODEX_API_KEY` to the *secret* key
   list and `CODEX_HOME` to the managed set, so a profile can't be redirected via
   `publicEnv`.

Not a code change but a real behavioural difference: **Codex refuses to start if
`CODEX_HOME` does not exist** (`Error loading configuration: CODEX_HOME points to "…",
but that path does not exist`). Apollo must `mkdir -p` the profile directory before first
use rather than relying on the CLI to create it.

## What has to be written

| Piece | Est. | Notes |
| --- | --- | --- |
| JSON-RPC stdio client | ~250–350 lines | Framing, id correlation, server-request dispatch, lifecycle. **Genuinely new** — the Claude adapter gets all of this free from the SDK. |
| `codex.ts` (adapter + `CodexRun`) | ~700–900 lines | Mirrors `claude.ts` (1662 lines) |
| `codexMapper.ts` | ~600–900 lines | Mirrors `mapper.ts` (1658 lines) |
| Vendored protocol types | ~0 | `generate-ts`, then a version-pinning decision |
| Tests | ~400–600 lines | Mapper tests are pure functions, same as the Claude ones |

Reused unchanged: `types.ts` (987), `stream.ts` (`AsyncQueue` + `createDeferred` — the
header already anticipates "a subprocess adapter would use one per direction too"),
`env.ts` (`composeProviderEnv` takes `scrubKeys`, so Codex just supplies its own list),
the whole IPC layer, and the entire renderer minus the profile-screen copy.

Not reusable: `mapper.ts`, `planUsage.ts`, `history.ts` are Claude-shaped by design — each
gets a Codex counterpart, and the Codex versions are simpler.

## Risks

- **Protocol churn.** `codex app-server` is marked `[experimental]` in `--help`, and much
  of the surface sits behind a `capabilities.experimentalApi` gate. Mitigations: stay on
  the stable subset (everything in the mapping table above is stable), pin vendored types
  to a known CLI version, and treat unknown notification methods as explicit drops — the
  same discipline `mapSdkMessage` already uses for the SDK's ~38 variants.
- **Version skew.** Generated types match the CLI that produced them. A user on a
  different `codex` build than the vendored schema is the normal case. `checkAvailability()`
  should compare versions and degrade with a clear reason.
- **Approval-response shapes vary per request type.** `ExecCommandApprovalResponse`,
  `FileChangeApprovalDecision` and `PermissionsRequestApprovalParams` are three different
  decision vocabularies (`accept` / `acceptForSession` / `decline` / `cancel`, plus
  structured `acceptWithExecpolicyAmendment`). Apollo's `PermissionDecision` is one type,
  so the adapter needs a small per-request-kind translation table. Contained, but it's the
  fiddliest part of the mapper.
- **`text_elements` is required** on text input items — an easy shape to get wrong (it
  cost one failed `turn/start` during this research, error: `missing field 'type'`).

## Suggested order

1. Vendor generated types + write the JSON-RPC stdio client with unit tests.
2. `checkAvailability()` + `listModels()` — proves the transport with no run machinery.
3. `createRun()` happy path: `thread/start` → `turn/start` → deltas → `turn/completed`.
4. Approvals, `interrupt`, `steer`, `dispose`.
5. `listSessions` / `listAllSessions` / `getSessionMessages`.
6. `fetchPlanUsage`.
7. `signIn` hook + profile-screen copy.

Steps 1–3 are roughly half the total effort and de-risk everything after them.

---

# Implementation status

Steps 1–6 are built and verified against the real CLI. What landed:

| File | Lines | What |
| --- | --- | --- |
| [jsonrpc.ts](packages/core/src/adapters/jsonrpc.ts) | 630 | The codec (framing, id correlation, server-request dispatch) split from the subprocess, so the logic is testable without spawning |
| [codexProtocol.ts](packages/core/src/adapters/codexProtocol.ts) | 517 | The slice of the wire protocol Apollo speaks, transcribed from `generate-ts` |
| [codexMapper.ts](packages/core/src/adapters/codexMapper.ts) | 921 | Pure notification → `AgentEvent` translation |
| [codex.ts](packages/core/src/adapters/codex.ts) | 1661 | The adapter: process, threads, turns, approvals, disposal |
| Tests | 1470 | 30 jsonrpc + 50 mapper + 38 adapter, plus 5 new registry tests |
| [smoke-codex.ts](scripts/smoke-codex.ts) | 208 | End-to-end runner that *checks* the event contract, not just prints it |

That is 3729 lines of implementation against the 1600–2200 I estimated. The gap is
almost entirely comment density — matching the surrounding files' habit of explaining
*why* — plus a protocol module the estimate folded into "free, generated".

`createDefaultProviderRegistry` now returns `['claude', 'codex']`. Nothing else in the
app changed — the one-line registration point held.

## Verified end to end

Driving the real adapter against the real binary via `scripts/smoke-codex.ts`:

```
  0 session.started    session 019fee8c-… in /var/folders/…/apollo-codex-smoke-RIV8zF
  1 text.delta         "P"
  2 text.delta         "ONG"
  3 text.complete      [assistant] PONG
  4 usage              delta in=13093 out=27
  5 run.end            completed

event contract: OK
```

And the approval path, with a real park-and-answer round trip:

```
 18 tool.start         Shell /bin/zsh -lc "printf 'hello ' > note.txt"
 19 permission.request Shell: Codex wants to run: /bin/zsh -lc "printf 'hello
      → deny
 20 tool.end           Shell → denied (2ms)
```

The contract check is programmatic: `session.started` first, one `run.end` last, dense
`seq`, every `tool.start` paired, and deltas that reconstruct `text.complete` exactly.

## One bug the smoke test caught

`CommandExecutionStatus` and `PatchApplyStatus` both have a `declined` variant that a
refused approval comes back as. My first mapper missed it: `declined` carries no exit
code, so a command the user had **just refused** fell through to `status: 'ok'` and
rendered in the transcript as one that ran and succeeded. Unit tests did not catch it —
the fixtures were written from the same wrong assumption. The end-to-end run did.

Both now map to `ToolEndStatus: 'denied'`, with regression tests.

## The setup path

Three things stood between "the adapter works" and "you can set one up", all now closed.

**`signIn.ts` parser hook.** `ProviderSignInSpec` gained an optional `parseStatus`, and
Codex supplies one. Claude's JSON reader remains the default, so nothing about that
provider changed. Two bugs surfaced while wiring it, both only findable against the real
CLI:

- **`codex login status` writes to `stderr`, not `stdout`.** `codex login status 2>&1`
  hides this completely — which is exactly how the first parser shipped reading only
  stdout and reported a signed-in account as an error.
- **The exit code is not the signal.** Signed-out exits `1`, and so does a real failure.
  Only the text distinguishes them.

Verified against all three states:

```
real ~/.codex      {"loggedIn":true,"authMethod":"chatgpt"}
fresh empty dir    {"loggedIn":false,"authMethod":"none"}
nonexistent dir    {"loggedIn":false,"error":"This profile's Codex directory does not exist yet."}
claude (regression) unchanged
```

**`CODEX_HOME` creation** turned out to be handled already — `resolveEnv` does
`mkdir(configDir, { recursive: true })` for every provider. My research note was wrong to
list it as work.

**Profile-screen copy** is now provider-neutral, with the config-directory placeholder and
hint driven by a per-provider table (`~/.claude` vs `~/.codex`) rather than hard-coded.

## How to set one up

1. Command palette → **Providers** → **Codex**.
2. Profiles → new profile. The generated command is
   `CODEX_HOME=<profile dir> codex login`.
3. Run it; the screen polls and flips to signed in on its own.

## Still open

- **`getSessionMessages` is untested against real stored threads.** Written and
  typechecked; `thread/list` is verified live, `thread/read` with `includeTurns` is not.
- **Not exercised live:** `turn/steer`, `interrupt`, fork, and resume. All implemented with
  the correct methods, but only the happy path, approvals and tool calls have been run
  against the real server.
- **`subagents` is off.** Codex has collab agents; their items are not mapped, so
  advertising nesting the transcript cannot render would be a lie.
