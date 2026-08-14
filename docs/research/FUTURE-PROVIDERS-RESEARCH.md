# Future providers for Artemis — Kimi, Grok, and the field

Research notes, 2026-08-14. Companion to [CODEX-ADAPTER-RESEARCH.md](CODEX-ADAPTER-RESEARCH.md),
and held to the same discipline: the Kimi claims below were verified by driving real
binaries — both generations of Moonshot's CLI (`kimi-cli` 1.49.0 via uvx, `kimi-code`
0.36.0 via npx) — plus the vendors' own docs. Grok, ACP and field claims come from web
research against primary sources, marked as such. One framing rule, set explicitly for
this round: for every provider we record not just what integration surfaces *exist* but
which one the vendor *recommends going forward*. This round supplied its own proof of why
that axis matters twice over — Cursor's new SDK became the flagship programmatic path it
now points integrators to, and the first Kimi transport verified live here (Wire) turned
out to belong to a CLI the vendor is winding down.

## Verdict

**Kimi: yes — via ACP on the successor CLI, not the one PyPI installs.** Moonshot is
mid-handoff from the Python `kimi-cli` (whose Wire protocol looked, and was verified live
to be, a second `codex app-server`) to the TypeScript **Kimi Code CLI**
(`@moonshot-ai/kimi-code`), which drops Wire entirely. On the successor the vendor-blessed
machine surface is **ACP** (`kimi acp`), verified live here: full initialize handshake,
session list/resume/fork/delete capabilities, permission requests, and a clean
`authRequired (-32000)` signal that answers the signed-in question. `KIMI_CODE_HOME`
relocates the whole profile. Subscription OAuth (`kimi login`, device-code flow) fits
Artemis's CLI-owned-auth model exactly. One small seam extension is needed (a
transport-based auth probe — the status question is answered over JSON-RPC, not by a
one-shot command).

**Grok: yes — xAI shipped the CLI we needed in May 2026.** "Grok Build" (`grok`) is a
first-party Rust coding agent with the full profile kit: `GROK_HOME` relocates all state,
`grok login` does subscription OAuth (SuperGrok / X Premium+) with a device-code fallback,
sessions live on disk with list/search/resume/fork, and the vendor-stated embedding
surface is an **ACP (JSON-RPC 2.0) server mode** over stdio or WebSocket. It maps onto the
Codex adapter pattern nearly move for move — including, less happily, the same gap: no
documented one-shot auth-status command. Everything below is verified against xAI's docs
and repo (not yet driven live on this machine; that is the first build step).

**The strategic read: build one ACP client module and spend it twice.** The
recommended-path question has a different answer at nearly every vendor — SDKs at Cursor,
GitHub and Sourcegraph; own-protocol at OpenAI and Factory; ACP at xAI and Moonshot;
churn at Google — so ACP is *not* a universal answer. But it is the vendor-blessed path
for exactly the two providers this round targets, its v1 covers Artemis's event union
well (schema-verified below), and both of Artemis's existing adapters turn out to already
sit on their vendors' recommended surfaces. Plan: declare `kimi` and `grok` provider ids
now, build one shared ACP protocol module on the existing `jsonrpc.ts` codec, ship Kimi
first (verified live end to end here), Grok second behind a live smoke test, and treat
the ACP long tail (Cursor, Copilot, Qwen, Vibe, Droid, Kiro, Qoder…) as options the same
module makes cheap later.

---

## What the seam demands of any new provider

Distilled from `packages/core/src/adapters/types.ts` and the Codex build-out. A candidate
provider is scored against eight requirements:

| # | Requirement | Where it bites |
| --- | --- | --- |
| R1 | A **local agent runtime** — the provider's own CLI/daemon runs the turn and the tools; Artemis renders it. Raw chat APIs do not qualify on their own. | `ProviderAdapter.createRun` |
| R2 | A **machine-drivable transport** with streamed events — text/thinking deltas, tool lifecycle, and ideally *server-initiated* permission requests, interrupt, mid-turn steering. | the nine-variant `AgentEvent` union; `Capabilities.interactivePermissions` |
| R3 | **Config-directory isolation via one env var** — the `CLAUDE_CONFIG_DIR` / `CODEX_HOME` equivalent. One profile = one directory = one account *and* one history. No var, no profiles. | `ProviderCredentialSpec.configDirVar`, `resolveEnv` |
| R4 | **CLI-owned auth**: a login command the user runs themselves, a cheap side-effect-free status probe Artemis can poll, a logout. Artemis stores nothing. | `ProviderSignInSpec` (`loginArgs` / `statusArgs` / `logoutArgs` / `parseStatus`) |
| R5 | An **enumerable credential-env surface** to strip, so an exported key in the user's shell can never outrank the profile's login. | `credentialEnvKeys`, `composeProviderEnv(scrubKeys)` |
| R6 | **Session history**: list, resume, and read stored transcripts — with the cwd recovered from session *data*, never decoded from storage layout. | `listSessions` / `listAllSessions` / `getSessionMessages` |
| R7 | **Usage reporting** that costs no tokens to read; plan/rate-limit reporting if the account model has one. | `usage` events, `fetchPlanUsage` |
| R8 | A **model catalogue**, ideally live-enumerable over a control channel. | `listModels`, `ModelCatalogue.live` |

R1–R4 are existential; R5–R8 degrade gracefully behind capability flags.

### What registering a provider actually touches

The README's "one-line registration" held for Codex — but Codex (like OpenCode) was
*pre-declared*. `ProviderId` is a closed union in `packages/protocol/src/provider.ts`
(`'claude' | 'codex' | 'opencode'`), and `PROVIDER_LABELS` in `registry.ts` maps every
member. A genuinely new provider therefore touches:

1. `packages/protocol/src/provider.ts` — extend `ProviderId` and `PROVIDER_IDS`.
2. `packages/core/src/adapters/registry.ts` — a label and the one-line registration.
3. The adapter files themselves (all new code).
4. `ProviderSignInSpec` needs nothing shared changed since the `parseStatus` hook landed —
   with one exception Kimi has now surfaced (a transport-based status probe; see the Kimi
   section).

Recommendation that falls out: **declare `kimi` and `grok` in the union early**, the way
`opencode` was. Declared-but-unregistered providers render greyed out with "not supported
in this build yet" for free — the UI communicates roadmap, and the eventual adapter lands
as the advertised one-line change.

### The endpoint-override route is closed, on purpose

The popular community way to run Kimi (and several other models) is to point a
Claude-Code-compatible tool at an Anthropic-compatible endpoint — and Moonshot now
*officially supports* this: the Kimi subscription exposes
`https://api.kimi.com/coding/` (Anthropic-compatible) with first-party setup guides for
Claude Code, OpenCode and even Codex. **Artemis structurally refuses the env-var version
of this**: `CREDENTIAL_ROUTING_ENV_KEYS` in `packages/protocol/src/profile.ts` rejects
`ANTHROPIC_BASE_URL` (and `OPENAI_BASE_URL`, proxies, TLS-trust and `NODE_OPTIONS`) in
`publicEnv`, at the IPC boundary and again in the profile store. That is the right call
and this research does not propose relaxing it — a renderer-writable endpoint override is
an exfiltration primitive aimed at whatever credential the CLI holds.

If we ever want "Claude Code pointed at vendor X" as a product feature, the sanctioned
shape is a **first-class provider id whose adapter owns the endpoint**: the base URL is a
constant inside the adapter (never user input), the profile directory is that adapter's
own, its credential-env list is scrubbed like any other provider's, and the profile screen
says whose account is being billed. That is a deliberate product decision with a distinct
billing identity — not a config knob. Two facts to weigh when it comes up: Moonshot
supports the pattern officially (above), while xAI has **deprecated** its
Anthropic-compatible endpoint — endpoint-compat is a per-vendor bet with real churn risk,
which is exactly why it belongs inside an adapter that can absorb the change. Parked
unless a vendor's CLI story turns out to be weaker than their endpoint story; for both
Kimi and Grok the CLI story is strong, so neither needs it.

---

## Kimi — feasible via ACP on Kimi Code CLI *(both generations driven live)*

Moonshot is mid-generational-handoff, and the fork is the whole story:

- **Legacy: `kimi-cli`** (Python, PyPI, [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)).
  Last release 1.49.0 on 2026-07-16; the README now says it "will be gradually wound
  down" in favour of the successor. This is still what `uv tool install kimi-cli` gets.
- **Successor: Kimi Code CLI** (TypeScript, npm `@moonshot-ai/kimi-code`,
  [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), docs at
  [kimi.com/code/docs](https://www.kimi.com/code/docs/en/)). 0.36.0 as of 2026-08-13,
  releasing roughly weekly; `curl` installer bundles its own runtime. `kimi migrate`
  imports legacy config and sessions; **credentials do not migrate**.

A cautionary tale this document should preserve: the legacy CLI's **Wire** protocol was
verified live here first — JSON-RPC 2.0 over stdio with `steer`, `cancel`, `replay` and
server-initiated `ApprovalRequest`, structurally a second `codex app-server`, docs
positioning it for "building web, desktop, or mobile frontends". It looked like the
obvious adapter transport. It is also **absent from the successor entirely** (surviving
only as an internal session-log format, `agents/main/wire.jsonl`). Checking what the
vendor recommends *going forward* — not what exists and works today — is the difference
between this doc recommending a transport and recommending a dead end.

### What was verified live (successor, `kimi-code` 0.36.0 via `npx @moonshot-ai/kimi-code`)

| Check | Result |
| --- | --- |
| `--version` | `0.36.0` — current (released the day before this research) |
| **ACP `initialize` handshake** over `kimi acp` | Well-formed result: `protocolVersion: 1`, `agentInfo` (name/version), `loadSession: true`, `promptCapabilities` (image ✓, embeddedContext ✓, audio ✗), `mcpCapabilities` (http, sse) |
| Session capabilities advertised | **`list`, `resume`, `close`, `delete`, `fork`, `additionalDirectories`** — richer than the docs' method table; fork and delete are protocol-level |
| Auth over the protocol | `authMethods` in the initialize result carries a terminal auth method with **the exact login argv and env** (`kimi login` with `KIMI_CODE_HOME=<profile dir>`), plus an `auth.logout` capability. The protocol literally hands Artemis its sign-in command |
| **Signed-in probe** | Unauthenticated `session/new` → clean JSON-RPC error **`-32000 "Authentication required"`**. Deterministic, cheap, and it created no session state |
| `KIMI_CODE_HOME` isolation | Set to a scratch dir: caches, logs, migration marker all landed inside it; nothing touched `~` |
| Framing discipline | stdout carried nothing but JSON-RPC; logs went to stderr and `logs/` — the stdio channel is kept clean by design |

Legacy `kimi-cli` 1.49.0 was driven live too (Wire 1.10 handshake, `KIMI_SHARE_DIR`
isolation, session store at `sessions/<md5(cwd)>/…`, print-mode exit codes 0/1/75). Those
findings informed this section but are deliberately not the basis of anything below.

### Transport: `kimi acp`

Moonshot's docs call `kimi acp` "the subprocess entry point for IDEs" — JSON-RPC over
stdio, no banner, waits for `initialize`. The ACP reference tracks coverage method by
method: stable agent-side `initialize`, `authenticate`, `session/new`, `session/load`,
`session/resume`, `session/prompt` (text, image, resource blocks), `session/cancel`,
`session/list`, `session/set_mode`, `session/set_config_option`; client-side
`session/update` (streamed agent messages and tool calls), `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file`. Two alternative surfaces exist and are not the
recommendation: **print mode** (`-p --output-format stream-json`) has no interactive
approvals, and the **local server** (`kimi web`: REST + WebSocket with sessions,
approvals, deltas, abort) is explicitly experimental — "endpoints, fields, and event
types may change in any release". The server matters anyway for one thing: it is where
`GET /api/v1/oauth/usage` (plan usage and limits) lives.

Event mapping (generic-ACP details in the ACP section; Kimi specifics):

| Artemis `AgentEvent` | ACP source |
| --- | --- |
| `session.started` | `session/new` / `session/load` response (session id) |
| `text.delta` / `thinking.delta` | `session/update` message chunks (agent message / agent thought) |
| `tool.start` / `tool.end` | `session/update` tool_call / tool_call_update lifecycle |
| `permission.request` | `session/request_permission` (server-initiated request with option set) |
| `run.end` | `session/prompt` response's stop reason |
| `usage` | ACP v1 defines `usage_update` (tokens + optional cost), but it is **absent from Kimi's documented implemented subset** — check the live agent at build time |

Control mapping: `interrupt()` → `session/cancel`; resume → `session/load` /
`session/resume`; permission answer → respond to the pending request. **No mid-turn
steering exists in ACP** — `send()` during a run queues and returns
`deliveredImmediately: false`, the honest degraded path the seam already defines.
`session/set_mode` maps permission modes; which mode vocabulary Kimi exposes there needs
to be read out at build time before `permissionModes` is declared.

### Auth and profiles

- **Login**: `kimi login` — RFC 8628 device-code flow, non-TUI: prints verification URL +
  code to stderr, polls, exits 0/1. The TUI `/login` also offers a platform API key path.
  Logout exists over ACP (`auth.logout`); no CLI logout is documented in the successor.
  Credentials at `$KIMI_CODE_HOME/credentials/<name>.json` (0700/0600).
- **The status probe, and the one seam extension this provider wants.** The signed-in
  question is answered over the transport (initialize → `session/new` → `-32000` means
  signed out; verified live), or via the experimental server's `/api/v1/oauth/usage`. But
  `ProviderSignInSpec.statusArgs` models a one-shot argv whose output `parseStatus`
  reads — a JSON-RPC exchange does not fit that shape. The Codex research already named
  the alternative ("have the adapter answer auth from the app-server") and chose the
  parser hook because Codex *had* a status command; Kimi does not. Proposal: allow an
  adapter to supply a programmatic `checkAuthStatus(env)` in place of `statusArgs`, with
  the polling path calling whichever the spec provides. Contained, and it is the missing
  piece for any future provider whose CLI is protocol-first.
- **Isolation**: `KIMI_CODE_HOME` relocates everything — config, sessions, logs, OAuth
  credentials, skills (verified live; docs confirm the full list).
- **Credential-env surface**: notably small. The successor reads provider API keys
  (`KIMI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) from `config.toml`
  `[providers.<name>.env]`, *not* from the shell — shell contamination is largely
  designed out. Scrub the `KIMI_MODEL_*` ephemeral-override family and manage
  `KIMI_CODE_HOME`; strip the API-key trio anyway (cheap insurance against future
  behaviour changes).
- **Quota shape to expect**: subscription quota refreshes every 7 days with a rolling
  5-hour window (~300–1,200 requests per window by tier, 30 concurrent streams), with an
  "Extra Usage" metered top-up. Mid-session rate-limit errors are a *normal* state to
  render, and the classifier already maps them to retryable `rate_limit`.

### Sessions

Protocol-level `session/list` + `session/load` (with history replay) beat the
store-walking the Claude adapter has to do; the spec's `session/list` returns
`sessionId`, `cwd`, `title` and `updatedAt` directly, so the seam's cwd-from-data rule
is satisfied at the protocol level. The advertised `fork` and `delete`
capabilities suggest `forkSession`/`deleteSession` can eventually be true, pending
semantics checks (the codex rule: never advertise a capability the transcript cannot
honour; confirm delete removes data before flipping it). On disk (docs):
`sessions/<workDirKey>/<sessionId>/` where `workDirKey = wd_<slug>_<sha256[:12]>` — a
readable slug plus hash, and the real cwd recoverable from session data. `kimi export
[sessionId]` zips a session.

### Models and the account story (Aug 2026)

Two API planes, easy to conflate:

- **Metered platform** (platform.moonshot.ai → now platform.kimi.ai): flagship
  **`kimi-k3`** (1M context, vision + thinking, released 2026-07-16, open weights —
  2.8T/104B-active MoE under a custom license; $0.30/M cached-input, $3/M input, $15/M
  output), `kimi-k2.7-code` (256k, the dedicated coding model), `-highspeed` variant,
  `kimi-k2.6`. **The entire `kimi-k2-*` preview/thinking generation is already
  delisted**, and `kimi-k2.5` + `moonshot-v1-*` sunset 2026-08-31 — any doc or config
  referencing K2-era ids is stale. Anthropic-compatible endpoint
  `api.moonshot.ai/anthropic` remains, with an official Claude Code guide.
- **Subscription plane** ("Kimi Code" benefits inside Kimi membership tiers): what
  `kimi login` OAuth rides. Tier-dependent models `kimi-for-coding`, `k3`, `k3-256k`,
  `kimi-for-coding-highspeed`; community-reported pricing ~$19/$39/$99/$199 per month.
  Also issues `sk-kimi-…` Code Console keys with Anthropic/OpenAI-compatible endpoints
  (`api.kimi.com/coding/`) and official guides for Claude Code, OpenCode, Codex, Hermes.

For Artemis, `listModels` should come from the CLI/protocol (tier-dependent catalogue);
plan usage from `/api/v1/oauth/usage` if we accept a server sidecar, else
`planUsageReporting: false` at first.

### Capabilities Kimi Code could honestly declare

`interactivePermissions` ✓, `partialMessages` ✓, `resumeSession` ✓, `listSessions` ✓
(protocol-level), `renameSession` — TBD (no rename seen in ACP; `/title` existed in
legacy), `deleteSession` / `forkSession` — advertised in capabilities, verify semantics
before flipping on, `midRunSteering` ✗ (queue instead), `usageReporting` ✗ initially
(not in Kimi's documented subset; ACP defines `usage_update` — verify live), `costReporting` ✗, `planUsageReporting` — only
with the server sidecar, `subagents` ✗ initially, `imageInput` ✓ (promptCapabilities),
`permissionModes` — read `session/set_mode` vocabulary at build time.

### Risks

- **A two-month-old 0.x rewrite releasing weekly.** The ACP surface is the most
  stability-tracked part of it (method-by-method coverage table; the `agent-core-v2`
  migration kept `kimi acp` first-class), but expect churn. Mitigations as with Codex:
  pin a protocol module, version-check in `checkAvailability`, drop unknown updates
  explicitly.
- **Usage reporting is missing from Kimi's documented ACP subset** (the protocol itself
  defines `usage_update`) — a capability regression vs Codex/Claude unless the live agent
  turns out to emit it, or until the server API stabilizes.
- The wind-down window: PyPI still serves the legacy CLI, and users will have both on
  PATH. `checkAvailability` must verify it found *kimi-code* (e.g. via `--version`
  behaviour/ACP handshake), not the Python `kimi`.

### What has to be written

Reuse: `jsonrpc.ts` (the hard 630 lines of the Codex work, deliberately split for a
second JSON-RPC provider). New: an **ACP protocol module — shared with Grok and any
future ACP provider** (~400–600 lines), `kimiMapper.ts` (~500–700; ACP's update stream is
simpler than Codex's 69 notification variants), `kimi.ts` adapter (~800–1,100), tests in
proportion. Seam deltas: the `ProviderId` union, a label, and the transport-based
auth-probe extension above. Estimate: **1.5–2.5 weeks**, less if the ACP module lands
first for whichever of Kimi/Grok goes second.

---

## Grok — Grok Build makes a first-class adapter feasible *(verified against primary docs, not yet driven live)*

The landscape changed in May 2026: xAI shipped **Grok Build**
([xai-org/grok-build](https://github.com/xai-org/grok-build), docs at
[docs.x.ai/build](https://docs.x.ai/build/overview)) — a Rust terminal coding agent,
Apache-2.0, launched for all SuperGrok and X Premium+ subscribers
([announcement](https://x.ai/news/grok-build-cli)). Install is `curl | bash` from
x.ai/cli. The community `superagent-ai/grok-cli` is still alive but API-key-only and
unaffiliated — obsoleted for our purposes, though note both tools default to `~/.grok`
(a collision profiles neatly sidestep). One naming footnote for future readers: xAI
rebranded to SpaceXAI in July 2026 after the SpaceX merger; the `grok` CLI, docs.x.ai,
api.x.ai and the GitHub org keep their names.

### The requirement checklist, answered

| Req | Answer |
| --- | --- |
| R1 runtime | ✓ `grok` runs the agent loop locally: tools, hooks, subagents, git-worktree parallelism, OS sandbox profiles |
| R2 transport | ✓ **`grok agent stdio`** — a long-lived ACP server, JSON-RPC 2.0 over stdio (`grok agent serve --bind …--secret …` for WebSocket). Streams `session/update` notifications: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`; permission requests arrive over the protocol. Plus xAI extension methods under an `x.ai/` prefix: filesystem, git, search, terminal, **session management, history, auth** |
| R3 isolation | ✓ **`GROK_HOME`** relocates the whole `~/.grok` root — `auth.json` (0600), `config.toml`, `sessions/` |
| R4 CLI auth | ✓ `grok login` (browser OAuth at grok.com), `grok login --device-auth` (headless device-code), `grok logout`. **Status probe: same gap as Kimi** — no documented `login status`; candidates are the `x.ai/` auth extension over ACP, `grok inspect` (reported to print auth state), or an `auth.json` presence check. xAI's own Claude Code plugin ships a `/grok-build:check` probe, so scriptable detection demonstrably exists — and the transport-based `checkAuthStatus` extension proposed for Kimi would cover Grok too |
| R5 credential env | ✓ enumerable: `XAI_API_KEY` (metered fallback that must never outrank a profile's subscription login — the *exact* billing trap Artemis's scrub model exists for), plus `GROK_OIDC_ISSUER`/`GROK_OIDC_CLIENT_ID` and the `[auth] auth_provider_command` config hook; `GROK_HOME` joins the managed set |
| R6 sessions | ✓ `$GROK_HOME/sessions/`, per-session `summary.json` + `updates.jsonl` (authoritative NDJSON log) + `chat_history.jsonl` + `plan.json` + `rewind_points.jsonl`; `grok sessions list/search`, `--resume <id-or-title>`, `-c`, `/fork`, `/rewind`. Headless JSON output carries `sessionId` |
| R7 usage | Partial: headless output reports token spend per run; TUI has `/usage`. **No public API found for subscription-quota reads** — `fetchPlanUsage` likely starts unavailable |
| R8 models | ✓ `grok models` lists the account's catalogue (subscription accounts see extra proxy-side models) — satisfies `listModels` with `live: true` |

### Permission modes: Claude-shaped on purpose

Grok Build's permission vocabulary is deliberately Claude-Code-compatible: modes
`default`, `auto`, `acceptEdits`, `dontAsk`, `always-approve` (bypass), with plan mode in
evidence too (xAI's own plugin invokes `--permission-mode plan`); rule syntax like
`--allow 'Bash(git *)'`; it even reads `.claude/settings.json` and Claude/Cursor MCP
configs. If that survives contact with the real binary, Grok could be the first provider
to advertise Artemis's **full** `permissionModes` set — including `auto` and `dontAsk`,
the two Codex had to reject. Verify semantics before advertising: Codex taught us that
"never ask" can mean *proceed* or *deny* depending on vendor, and the two are opposites
exactly when it matters.

### Models and API surface (Aug 2026)

- Catalogue on [docs.x.ai/developers/models](https://docs.x.ai/developers/models):
  `grok-4.6` (flagship, 500k ctx, **Grok Build's default**), `grok-4.5` (500k),
  `grok-4.3` (1M, fast tool-calling), the `grok-4.20-0309` snapshot family (1M), and
  `grok-build-0.1` (256k, "trained specifically for agentic coding workflows" —
  successor slot to 2025's now-delisted `grok-code-fast-1`). No `grok-5` exists.
- **The Anthropic-compatible `/v1/messages` endpoint is deprecated** (migration pointed
  at the Responses API or gRPC) — which closes the "Anthropic-shaped Grok" route for
  good and validates treating endpoint-compat tricks as strategically fragile (see the
  endpoint-override section above).
- Server-side agent tools (`web_search`, `x_search`, `code_execution`, `mcp`, RAG
  collections) exist at the API layer; a management API covers key CRUD and audit logs
  but **no credit-balance or usage read** was found — R7 stays partial whichever route
  is taken.

### Vendor-recommended path

Explicit and unusually clean: the README and launch post position Grok Build as usable
"interactively (TUI), headlessly for scripting/CI, **or embedded via the Agent Client
Protocol (ACP)**" — ACP is the stated surface "for building your own bots and agent
orchestration apps", with Zed, Neovim, Emacs and marimo named as existing clients. For
one-shot delegation xAI's own tooling shells out to headless `-p` instead. And for
third-party *harnesses*, xAI has blessed subscription OAuth into OpenCode, Kilo Code and
Warp via first-party posts — but no self-serve "register your own OAuth client" doc
exists; those look partner-arranged. For Artemis the aligned shape is:
`GROK_HOME=<profile> grok agent stdio`, login via `GROK_HOME=<profile> grok login`.

### What building it looks like

Same skeleton as Codex/Kimi: reuse `jsonrpc.ts`, add the shared ACP protocol module, a
`grokMapper.ts`, and the adapter. The distinctive work items: the `x.ai/` extension
methods for session management/history/auth (which rescue
`listSessions`/`getSessionMessages`/status-probe from filesystem-walking if they pan
out), device-auth-aware sign-in copy, and a `checkAvailability` that verifies both binary
and ACP protocol version. Risks: the CLI is young ("early beta" at launch, three months
old), the ACP extensions are vendor-namespace and undocumented-in-spec, and nothing here
has been driven live — **step one is the smoke-test discipline the Codex research used:
spawn the real binary, complete the ACP handshake, run one turn, park one approval.**
Until a `grok` binary has answered on this machine, the estimate is "Codex-shaped, likely
2–3 weeks" with wide error bars — minus whatever the shared ACP module already covers by
then.

---

## The recommended-path axis

The question this round was steered to answer: not "does a machine surface exist?" but
"is it the one the vendor is committed to?" The answer is different at almost every
vendor, and it moved twice within this research's own subject matter. Per vendor, from
the standpoint of a custom desktop client:

| Vendor | Surfaces that exist | Recommended for embedding | Notes |
| --- | --- | --- | --- |
| Anthropic — Claude Code | Agent SDK (in-process); ACP via the `@agentclientprotocol/claude-agent-acp` adapter | **Agent SDK** — Artemis's current transport | the official ACP adapter is itself built on that same SDK, now maintained in the ACP org |
| OpenAI — Codex | `app-server`; Codex SDK (TS/Python, wraps app-server); MCP server mode; `exec --json` | **app-server** for "embedding Codex into custom products"; the SDK is pointed at CI/automation | vendor docs say it in words — Artemis's Codex adapter sits on the blessed surface. Still capability-gated, no formal stability promise |
| xAI — Grok Build | TUI; headless `-p`; ACP (stdio + WebSocket) | **ACP** — "build your own bots and agent orchestration apps" | launch post + README |
| Moonshot — Kimi Code | ACP; print mode; experimental local server; legacy Wire (being retired) | **ACP** — "the subprocess entry point for IDEs"; the server API "may change in any release" | docs + verified live here |
| Cursor | headless `agent -p`; native `agent acp`; **Cursor SDK**; Cloud Agents API | **Cursor SDK** — flagship programmatic path since 2026-04-29 | the report that Cursor recommends the SDK *instead of* ACP is **partially confirmed**: the SDK is what Cursor promotes, but the ACP docs remain live ("intended for building custom clients and integrations") with no deprecation language |
| GitHub — Copilot CLI | `copilot --acp` (public preview since 2026-01-28); **Copilot SDK** in six languages | **Copilot SDK** — "exposes the same engine behind Copilot CLI" | precedent worth remembering: the old `--headless --stdio` surface was removed *without deprecation*, breaking every SDK 0.1.x integrator |
| Google — Gemini | gemini-cli headless + `--experimental-acp`; in-repo SDK (unpublished on npm); Antigravity `agy` CLI + Python SDK | **in transition — no stable answer.** Consumer subscriptions were cut off gemini-cli (2026-06-18) in favour of Antigravity: closed-source, keyring-authed, no ACP (open feature request) | gemini-cli remains viable only for API-key / enterprise-license profiles |
| Sourcegraph — Amp | `amp -x` + `--stream-json*`; **Amp SDK** (TS/Python) | **Amp SDK** | threads are cloud-resident on ampcode.com — already a mismatch with local profiles |
| Factory — Droid | `droid exec --output-format stream-jsonrpc`; native ACP | **stream-jsonrpc** — "the lowest-level integration path for building your own interaction model around Droid" | its older `stream-json` format is already deprecated |

Three durable takeaways:

1. **The blessed path is per-vendor, and it moves.** Exhibits: Moonshot retired Wire out
   from under its own "build desktop frontends" positioning; Copilot removed a headless
   surface with no deprecation window; Google is migrating off gemini-cli entirely.
   "What does the vendor recommend *today*" is a gate to re-check when each adapter
   starts, not a fact to research once.
2. **For the two providers this round targets, the answer is ACP at both** — which is
   what turns a shared ACP module from opportunism into strategy.
3. **Both existing Artemis adapters already sit on vendor-recommended surfaces.**
   OpenAI's docs now state what the Codex research bet on, and even the official Claude
   ACP adapter is built on the Agent SDK Artemis uses. Nothing needs migrating.

## ACP as a universal transport

**Verdict: mature enough to adopt — as a transport, not as the whole adapter.** Protocol
v1 is stable and integer-versioned, negotiated at `initialize`. Governance moved off Zed
into a neutral `agentclientprotocol` GitHub org (Apache-2.0, RFD process, an agent
registry since Jan 2026). SDKs: TypeScript `@agentclientprotocol/sdk` 1.3.0, Rust,
Python, Java, Kotlin. A **v2 draft** (2026-07-20) targets exactly the gaps a rich client
feels — updates outside turn boundaries, stable message IDs with uniform patch
semantics, structured file changes, richer permission subjects — and is explicitly
subject to change: gate on negotiated version, ignore until stable.

Coverage against Artemis's event union, verified in the v1 JSON schema rather than the
prose docs:

| Artemis need | ACP v1 |
| --- | --- |
| `session.started` | `session/new` → `sessionId` (absolute `cwd` required) ✓ |
| `text.delta` / `thinking.delta` | `agent_message_chunk` / `agent_thought_chunk` ✓ |
| `text.complete` | ✗ — no per-message boundary event; infer from `stopReason` or update-kind switches (v2's stable IDs fix this) |
| `tool.start` / `tool.end` | `tool_call` → `tool_call_update`; statuses `pending/in_progress/completed/failed`; kind hints; diff and embedded-terminal content; file `locations[]` ✓ |
| `permission.request` / `.resolved` | `session/request_permission` with option sets (`allow/reject` × `once/always`); cancelled outcome defined ✓ |
| interrupt | `session/cancel` — spec requires cascade-abort and `stopReason: "cancelled"` ✓ |
| `run.end` | prompt response `stopReason` (`end_turn/max_tokens/max_turn_requests/refusal/cancelled`) ✓ |
| `usage` | `usage_update` — token used/size plus optional cost `{amount, currency}` ✓ (late-v1 addition; per-agent support varies) |
| sessions | `session/list` (returns `sessionId`, `cwd`, `title`, `updatedAt`; paginated; omit the cwd filter to enumerate all projects) ✓; `session/load` replays history ✓; `session/resume` reconnects without replay ✓; `session/delete` ✓ |
| modes / model choice | `session/set_mode` + `current_mode_update`; config options with a reserved `model` category ✓ |
| mid-run steering | ✗ underspecified — real agents variously steer, queue or drop; treat as queue-only until v2 |
| fork / client-initiated rename | ✗ not in the protocol — stay provider-specific |
| plan usage | ✗ absent — per-provider side channels remain |
| background tasks / subagents | ✗ flattened into tool calls in v1; v2's out-of-turn updates are the intended fix |

Adoption is two-sided and real: ~36 agents speak it natively (Gemini CLI, Copilot CLI,
Cursor, Goose, Qwen Code, Kimi, OpenCode, OpenHands, JetBrains Junie, Mistral Vibe,
Factory Droid, Kiro, Qoder, Cline…) plus maintained adapters for Claude Code and Codex;
clients include Zed, JetBrains (first-party), Emacs, four Neovim plugins, marimo, and
several Artemis-like desktop harnesses. Notable holdout: VS Code has not committed to
native ACP (its agent mode standardized on MCP instead).

Architectural consequence for Artemis: **one `acp.ts` protocol module on top of the
existing `jsonrpc.ts` codec, consumed by thin per-vendor adapters — not one generic "ACP
provider".** The seam wants static, honest, per-vendor declarations, and vendors differ
even over the same protocol: implemented subsets differ (Kimi documents 10/12 stable
methods), extensions differ (`x.ai/*` session/history/auth), auth argv and
credential-env vocabularies differ, and capability flags must reflect each binary's
actual behaviour rather than the spec's ceiling. The protocol carries the turn; the
adapter still owns identity, availability, auth, session side channels, and capability
truth.

## The wider field

Each row is a potential future profile, ordered roughly by adapter-readiness:

| CLI | Transport for a driving app | Vendor-recommended | Auth | Isolation env var | Verdict for Artemis |
| --- | --- | --- | --- | --- | --- |
| Cursor CLI | native `agent acp`; headless JSON; Cursor SDK | SDK (ACP maintained) | subscription login or `CURSOR_API_KEY` | `CURSOR_CONFIG_DIR` ✓ | most adapter-ready of the field: full profile kit, rides the shared ACP module |
| Factory Droid | `droid exec --output-format stream-jsonrpc`; native ACP | stream-jsonrpc for own-UX builders | `FACTORY_API_KEY` | ✗ none documented | strong transport (native `--fork`!), blocked on R3 until a relocation var appears |
| GitHub Copilot CLI | `copilot --acp` (preview); Copilot SDK | SDK | GitHub subscription OAuth | `COPILOT_HOME` ✓ | viable; preview-status ACP plus a history of unceremonious surface removal |
| Qwen Code | headless; native ACP; `qwen serve` HTTP daemon (experimental) | `qwen serve` is their forward bet | Qwen OAuth free tier or keys | ✗ none found | watch — free tier is attractive, isolation gap is real |
| Mistral Vibe | headless NDJSON with budget caps; native ACP | ACP for editors | API key or Le Chat plans | `VIBE_HOME` ✓ | clean small candidate via the shared module |
| Gemini CLI | headless; `--experimental-acp` | in transition to Antigravity (closed, no ACP) | API key / enterprise only since 2026-06-18 | `GEMINI_CLI_HOME` ✓ | wait out the Antigravity transition |
| OpenCode | `opencode serve` HTTP + `@opencode-ai/sdk`; native ACP | its own server + SDK | per-provider OAuth (incl. SuperGrok) and keys | partial (`OPENCODE_CONFIG_DIR` covers config, not data) | already declared in `ProviderId`; see below |
| Amp | `amp -x --stream-json*`; Amp SDK | SDK | `amp login` / `AMP_API_KEY` | ✗ threads are cloud-resident | poor profile fit |
| Charm Crush | TUI; `crush run` | none stated | API keys | `CRUSH_GLOBAL_CONFIG`/`_DATA` ✓ | no embedding surface (open feature request); skip |

Also ACP-native and unexamined in depth: AWS Kiro CLI, Alibaba Qoder, Cline, Goose,
OpenHands, Hermes Agent — the shared ACP module is what makes any of them cheap to
evaluate later.

Two field notes that bear on Artemis directly:

- **Anthropic subscription policy.** Since early 2026, Anthropic rejects
  consumer-subscription OAuth from third-party harnesses (reported as enforced from
  2026-01-09 and formalized in ToS on 2026-02-20 — secondary sources), and OpenCode
  removed its Claude login citing "Anthropic explicitly prohibits this" (primary,
  their docs). Artemis's README already tells distributors to seek Anthropic approval
  before shipping a build that ends in a claude.ai login; that caution is now the
  enforced industry norm and worth keeping prominent.
- **OpenCode as the hedge.** The declared-but-unbuilt `opencode` provider is now the
  largest project in the class (~197k stars, repo moved to `anomalyco/opencode`), with
  a real HTTP server, SDK and ACP mode. If a first-party CLI disappoints — or a model
  we want has no CLI — one OpenCode adapter fronts 75+ providers, *including Grok via
  officially-blessed SuperGrok OAuth* (and not Claude subscriptions, per the above).
  The caveat: per-provider logins inside one OpenCode profile blur Artemis's
  one-profile-one-account billing clarity and would need deliberate profile design.

## Suggested order

1. Declare `kimi` and `grok` in the `ProviderId` union now — greyed-out provider rows,
   roadmap for free.
2. Land the seam extension: a programmatic `checkAuthStatus` alternative to
   `statusArgs` (Kimi requires it; Grok likely benefits; any protocol-first CLI will).
3. Build `acp.ts` on top of `jsonrpc.ts`, with a codex-style smoke script that checks
   the event contract programmatically.
4. **Kimi adapter first** — the successor binary is already verified end to end here
   (handshake, capabilities, auth probe, isolation), and install is one npm command.
5. **Grok adapter second**, gated on a live smoke of `grok agent stdio` and the
   `x.ai/*` extensions — needs a SuperGrok / X Premium+ account to verify the full
   login-to-approval path.
6. Re-check every vendor-recommended path at build start. This round proved they move.
