# OpenRouter feature-gap analysis for Artemis

Research notes, 2026-08-17. Companion to [CODEX-ADAPTER-RESEARCH.md](CODEX-ADAPTER-RESEARCH.md)
and [FUTURE-PROVIDERS-RESEARCH.md](FUTURE-PROVIDERS-RESEARCH.md). Method: OpenRouter's
feature surface was inventoried from live fetches of openrouter.ai docs, changelog,
enterprise/rankings/benchmarks pages on 2026-08-17 (their docs moved to `/docs/guides/…`
+ `/docs/api_reference/…` this year; several 2026 features below post-date any training
data and were verified only against the vendor's own pages — nothing here was driven
live against their API). The Artemis side was inventoried from the codebase at v0.15.1.
Per house rule, each borrowed idea is judged against the vendor's
*recommended-going-forward* surface, not legacy paths (their deprecations are noted
where they matter).

## Verdict

**OpenRouter and Artemis are control planes for different things — metered API traffic
vs. subscription agent accounts — so most of their surface does not transplant
literally, but about seventeen of their features have real Artemis-shaped analogues,
and five of those are nearly free because the protocol already carries the fields.**

The five-minute version:

1. **Quick wins (protocol-ready, days not weeks):** run budgets (`maxBudgetUsd` /
   `maxTurns` are validated and forwarded to the Claude SDK today — no UI sets them),
   plan-headroom alerts (OpenRouter's budgets explicitly *lack* notifications — we can
   leapfrog), retry/fallback wiring (`RunInput.fallbackModel` is forwarded and never
   set; `AgentError.retryable` is computed and only displayed), transcript export, and
   "why this account" recommendation transparency (scores already computed).
2. **The substantial gaps worth a quarter:** local usage history + analytics (we
   discard every usage event after the run), run presets, side-by-side model
   comparison, model-metadata enrichment, provider status surfacing.
3. **Structurally rejected, on purpose:** everything credential- or billing-shaped
   (BYOK, key management, OAuth issuance, credits). Artemis stores no credential and
   proxies no traffic; `CREDENTIAL_ROUTING_ENV_KEYS` closes the endpoint-override
   route deliberately. The one sanctioned door is a first-class **OpenRouter provider
   adapter** (F15) — likely via their new Ori Harness CLI, which fits our
   CLI-owned-auth model.
4. **The strategic read:** OpenRouter's 2026 arc is *router → agentic runtime* —
   server tools (hosted shell containers, web search, advisor/subagent delegation), an
   Agent SDK, and **Ori Harness, their own coding-agent CLI distributed to enterprise
   employees**. They are walking into Artemis's category from the billing side. That
   makes them simultaneously a feature quarry (this document), a candidate provider
   (F15), and a competitor worth watching.

### Where they eclipse us — and where they cannot

A fair reading of the feature tables below is "none of this is substantial," and that
reading deserves a direct answer rather than a comfortable one. **In their category
they eclipse us completely, and no Artemis feature closes it:** 400+ models behind one
API, routing tuned on live traffic (Auto Router ranks by real spend share per task
type; tool-call routing by measured success rates), organizational governance
(workspaces, guardrails, budgets, SSO/SCIM), an observability pipeline to 19
destinations, a benchmarks operation with 2.4M task evaluations — all compounding
through a **data flywheel Artemis refuses by design**. A desktop app that touches no
traffic and emits no telemetry cannot build any of that. Those entries sit in Part 2
as "Rejected/N-A" not because they are small but because they are unreachable without
becoming a different product.

The translatable feature list is small because the category overlap is thin *today*.
The strategic finding is that the overlap is thinning from their side:

1. **They entered the harness category with the whole stack.** Ori Harness + org
   guardrails/budgets + Broadcast + Ori Eval lets an enterprise answer "our engineers
   run coding agents, governed, observed, billed" entirely inside OpenRouter. Artemis
   has nothing for that buyer. If Ori becomes the enterprise default, harness UIs
   become front-ends to *their* control plane.
2. **The economics could move against the subscription premise.** Artemis is
   subscription-account stewardship; that moat holds while flat-rate plans stay the
   cheap way to run agents. Flex (−50%), batch (−50%), caching, and cheap open-weight
   models are all pressure toward metered-plus-governed.
3. **Runtime capability accrues to their API.** Hosted persistent containers,
   advisor/subagent delegation, Fusion ensembles arrive for anyone on their API; we
   are downstream of vendor CLI roadmaps (churn risk already documented in
   FUTURE-PROVIDERS).
4. **Velocity.** Weekly ship cadence, eight changelog entries in July 2026 alone.

What they structurally cannot do: **bill a subscription** (every Ori run burns metered
credits — for an individual on a $100–200/month plan OpenRouter is strictly more
expensive; Anthropic does not let gateways carry plan auth), and **run locally**
(their shell executes in their containers; Claude Code runs against the user's real
checkout). Add the craft layer — approval surfaces, transcripts, multi-account UX —
where Ori is today a CLI wrapper.

The posture that follows: the Part 1 features are position *maintenance* — they
compound into "the best way to run the accounts you already pay for," which is the
ground OpenRouter cannot take. The position *hedges* are F15 (if the category
consolidates onto their rails, be the best UI on those rails — hence the spike moves
up in the priority read) and a deliberate decision about whether Artemis ever competes
for the governance buyer (requires F16-class self-hosted telemetry, or riding their
governance via F15 — it will not fall out of the feature list).

### Scoring rubric

- **Architecture fit** — *High*: existing seams/surfaces reach it, no design-principle
  conflict. *Medium*: needs a new subsystem or an unresolved design question. *Low*:
  strains a structural decision. *Rejected*: conflicts with a documented, deliberate
  design refusal (no credentials, no traffic proxying, no telemetry).
- **Cost** — one engineer familiar with the codebase. *S* ≤ 1 day · *M* 2–5 days ·
  *L* 1–3 weeks · *XL* > 3 weeks or requires a design decision first. Every feature
  that adds an IPC channel pays a fixed tax in `main/validate.ts` (payload rebuild) and
  `preload/index.ts`; estimates include it.

---

## Part 1 — Gaps worth implementing

### F1. Run budgets & limits UI

- **OpenRouter has:** per-key credit limits with daily/weekly/monthly auto-resets,
  workspace budgets (four hard caps, 403 on breach), guardrail spend caps.
- **Feature:** surface run ceilings in Artemis — a per-run budget/turn cap in the
  composer's run options and a per-profile default in settings.
- **Reason:** the primitives exist end-to-end and are inert: `RunInput.maxBudgetUsd`
  and `maxTurns` are typed (`protocol/run.ts:187-189`), validated
  (`main/validate.ts:1065`), and forwarded to the Claude SDK (`claude.ts:1701`) — and
  no UI ever sets them. A runaway autonomous session today has no ceiling except the
  plan window itself.
- **Expected user:** anyone running long autonomous sessions (workflows, ultracode,
  overnight runs); teams sharing a Max account that one runaway session can drain.
- **Architecture fit:** **High.** Renderer-side work almost entirely. Gate `maxBudgetUsd`
  on the `costReporting` capability (Codex declares it false, so it gets turns-only).
- **Cost:** **S–M** (1–3 days; +1 day for per-profile defaults).

### F2. Plan-headroom alerts

- **OpenRouter has:** hard budget enforcement but — their own docs state — "no
  proactive email or webhook notifications yet." Their gap, our opening.
- **Feature:** OS notifications when a plan window crosses the warning/critical
  thresholds the rings already colour-code, and optionally when a window resets.
- **Reason:** `planUsagePoll.ts` already fetches every profile's windows every 5
  minutes and the renderer already computes `bindingWindow` + `toneFor` boundaries;
  today that intelligence is visible only if you look at the rings. Users discover
  exhaustion when the run fails.
- **Expected user:** Max-plan users near weekly caps; multi-account users timing when
  to rotate; anyone who backgrounds Artemis while a session runs.
- **Architecture fit:** **High.** The main-process poll is the natural emitter
  (threshold-crossing detection on data it already holds); Electron's Notification API
  needs no new privilege. No new IPC toward the renderer required for the basic form.
- **Cost:** **S** (≤1 day; 2–3 days with per-profile thresholds and reset reminders).

### F3. Automatic retry & account failover

- **OpenRouter has:** `models` fallback arrays, automatic rerouting around degraded
  providers (30-second outage window), auto-retry on 429/503, `Retry-After` honoured,
  typed error vocabulary.
- **Feature:** three rungs — (a) wire `RunInput.fallbackModel` (Claude SDK supports it
  natively; we forward it at `claude.ts:1659` and nothing sets it); (b) a one-click
  "retry on recommended account" affordance on retryable run failures; (c) an opt-in
  policy that does (b) automatically for rate-limit failures at run start.
- **Reason:** reliability-through-redundancy is OpenRouter's core product, and Artemis
  already has the redundancy (multiple profiles) without the automation. We compute
  `AgentError.retryable` (`types.ts:1295`) and use it only for display; the account
  recommender already knows where headroom is.
- **Expected user:** everyone, most acutely overnight/background runs that die at 2am
  on a 5-hour-window reset.
- **Architecture fit:** **High** for (a) and (b). **Medium** for (c) — the UX questions
  (which account, does the permission mode carry, how loud should auto-switching be)
  are the real work. **Low, and deliberately so, for mid-run rotation:** session
  history lives in the account's own config directory; "a running conversation stays
  on the account it started with" is a documented invariant. The honest ceiling is a
  fresh session on the fallback account carrying a context summary, not a silent swap.
- **Cost:** **M** for (a)+(b) (2–5 days); **L** for (c) (1–2 weeks including settings
  and restraint tuning).

### F4. Transcript & usage export

- **OpenRouter has:** Activity CSV/PDF export, chatroom conversation export/import,
  an opt-in logs page, and Broadcast for continuous export.
- **Feature:** "Export session" (Markdown and JSONL) from the session list/menu, and —
  once F6 exists — usage CSV export.
- **Reason:** nothing gets out of Artemis today except per-code-block copy and a
  GitHub-issue URL prefill. Sharing a run with a teammate, archiving before deleting a
  profile, or feeding a transcript to another tool all dead-end.
- **Expected user:** teams reviewing each other's agent runs; anyone with retention
  habits; bug reports that need more than a prefilled title.
- **Architecture fit:** **High.** `sessions:messages` already returns full transcripts
  over IPC; export is one new channel plus a main-process save dialog (main owns fs —
  the renderer sandbox stays intact). Markdown rendering of the eleven event variants
  is mechanical.
- **Cost:** **S–M** (1–2 days for transcripts; usage CSV rides on F6).

### F5. Recommendation transparency

- **OpenRouter has:** `X-OpenRouter-Metadata: enabled` returns the full routing story
  per request — strategy, candidates, fallback chain, pipeline stages.
- **Feature:** make the "Recommended" row in the profile picker explain itself — the
  basis (`same-plan` / `weighted` / `percentage`), each candidate's headroom, plan
  weight, and live-run reservation.
- **Reason:** `recommendProfile` (`protocol/usage.ts:393`) already computes
  score = headroom × planWeight − reservation and a typed basis; the UI shows one word.
  An unexplained recommendation gets ignored the first time it looks wrong.
- **Expected user:** multi-account users; whoever debugs "why did it suggest my
  personal account for work."
- **Architecture fit:** **High.** Pure renderer change — the data is already in the
  store selectors that feed the picker.
- **Cost:** **S** (≤1 day).

### F6. Local usage history & analytics

- **OpenRouter has:** the Activity dashboard (spend/tokens/requests over
  hour/day/month/year, grouped by model, key, member), a beta Analytics API with
  dimensions and metrics, CSV export, cache-hit-rate reporting.
- **Feature:** persist per-run `UsageSnapshot` finals + run metadata (profile, model,
  project, duration) in core, and add a usage dashboard: per-day/week tokens and cost,
  grouped by profile / model / project, with cache-hit share, plus CSV export.
- **Reason:** Artemis renders rich usage live (`usage` events, run-end summary, plan
  rings) and then discards all of it — there is no answer to "what did this week
  cost," "which project is eating the Opus window," or "is caching actually working
  for me." This is the largest pure observability gap on the list.
- **Expected user:** heavy users on capped plans deciding tier upgrades (plan pinning
  via `PLAN_CAPACITIES` already exists — this closes the loop with evidence); team
  leads sizing how many Max seats a team needs.
- **Architecture fit:** **High-Medium.** The event flow exists (`usage` events with
  `scope`, `run.end`, plan snapshots); what's new is a persistence subsystem in core
  (append-only JSONL or SQLite under userData), a query IPC channel, and a dashboard
  surface. Tokens are the universal unit; USD only where `costReporting` is true
  (Claude — Codex declares false), so charts must degrade per capability like
  everything else. No provider dependency at all — this is entirely our data.
- **Cost:** **L** (1–3 weeks: persistence M, dashboard M, export S).

### F7. Run presets

- **OpenRouter has:** server-side Presets — named bundles of model + params + system
  prompt + tool config, versioned with rollback, shared org-wide, referenced as
  `@preset/slug`.
- **Feature:** named local presets bundling model, effort/thinking level, fast mode,
  permission mode, and an agent-prompt selection — selectable from the status line and
  command palette.
- **Reason:** the prompt library (`agentPrompts.ts`) covers exactly one dimension
  (system-prompt append, and it is inert on Codex since it lacks
  `systemPromptAppend`); every other run parameter is re-assembled by hand per pane.
  "Review config" vs "build config" vs "research config" is a real daily workflow.
- **Expected user:** anyone who context-switches between work modes; teams that want a
  house default ("reviews run on Opus, plan mode, no web") — shareable through Cerebro
  later without inventing new sync machinery.
- **Architecture fit:** **High.** Every constituent is already per-pane state with an
  existing setter; a preset is a named record in a small store + one IPC pair +
  capability-aware application (skip fields the provider can't honour, with the
  existing disabled-with-reason pattern).
- **Cost:** **M** (3–5 days).

### F8. Side-by-side model comparison

- **OpenRouter has:** the Chatroom's "Compare AI Models Side by Side," Body Builder's
  parallel comparison batches, and a benchmarks culture around head-to-head evidence.
- **Feature:** compare mode — link 2–4 panes, broadcast one prompt to different
  model/effort/provider/profile combos, render answers (and usage/cost) side by side.
- **Reason:** the pane grid already runs up to 8 concurrent sessions; comparison today
  is paste-×-N with no linkage. Model-choice debates (Fable vs Opus vs GPT-5.5 on our
  actual code) are settled by vibes. This also becomes the acceptance harness when
  Kimi/Grok adapters land (FUTURE-PROVIDERS plan).
- **Expected user:** users picking a default tier; maintainers evaluating new
  providers; anyone asking "was Opus actually better here or just slower."
- **Architecture fit:** **High for the plumbing** (multi-pane, concurrent
  `RunRegistry`, per-pane model state all exist; composer broadcast is new wiring).
  **The design question is side effects:** N agents editing one cwd collide. Compare
  mode should force plan/read-only mode, or allocate per-pane worktrees — Artemis
  currently *recognises* worktrees but never creates them (`workspace/repo.ts`), so
  the worktree variant adds a real new capability.
- **Cost:** **M–L** (3–8 days; read-only-first keeps it at M).

### F9. Model-metadata enrichment

- **OpenRouter has:** a models API carrying pricing, context length, modalities,
  supported parameters, benchmarks, deprecation dates — surfaced at every picking
  moment, with 12 filter params.
- **Feature:** enrich the model picker/settings catalogue with context window, a
  plan-quota weight hint ("≈8× quota per turn" — `MODEL_LOAD` already encodes this),
  and a maintained static metadata table (context, relative cost) per model family.
- **Reason:** our catalogue (`ProviderModelOption`) knows tier/effort/fast-mode flags
  but the picker says nothing about what a choice *costs* in the currency users
  actually spend (plan headroom). The load model exists and is invisible.
- **Expected user:** capped-plan users choosing tiers; new users who don't know the
  family hierarchy.
- **Architecture fit:** **High** for surfacing `MODEL_LOAD`/`EFFORT_LOAD` (pure UI).
  **Medium** for pricing/context tables: the CLIs don't expose them (the Agent SDK
  declares less than the CLI emits — check the binary before assuming, per prior
  research), so this is a maintained static table like `PLAN_CAPACITIES`, accepting
  staleness risk by design.
- **Cost:** **S** for load hints; **M** (2–4 days) with the metadata table.

### F10. Provider status surfacing

- **OpenRouter has:** per-endpoint uptime charts (3-day hourly bars, 24-hour trend),
  provider-health-driven routing, a public status page.
- **Feature:** poll the providers' public status feeds (status.anthropic.com and
  OpenAI's status page publish JSON) from the main process; show a banner during
  incidents and enrich run-failure surfaces with "Anthropic is reporting degraded
  performance" instead of a bare error.
- **Reason:** during provider incidents Artemis fails opaquely and users debug their
  own setup. OpenRouter turned "is it me or them" into product surface; the desktop
  analogue is one poll and one banner.
- **Expected user:** everyone, precisely when things break.
- **Architecture fit:** **High.** Mirrors `planUsagePoll.ts` structurally (main-process
  poll → scanned push channel). The status-feed URL belongs on the adapter — the
  credential-spec pattern already has adapters declaring vendor facts; a `kimi`/`grok`
  adapter brings its own feed later for free.
- **Cost:** **S–M** (1–3 days).

### F11. Full-text session search

- **OpenRouter has:** a Logs page with per-generation search/filtering (opt-in), plus
  activity filtering by model/key/member.
- **Feature:** search across session *transcripts*, not just titles — palette-first
  ("find the run where we fixed the validator"), scoped by project/profile.
- **Reason:** the sidebar filter is title-only and only renders above 8 sessions
  (`FILTER_THRESHOLD`); the session-owners ledger caps at 20k sessions, which is far
  beyond scroll-archaeology range.
- **Expected user:** heavy users with hundreds of sessions across projects.
- **Architecture fit:** **Medium-High.** Transcripts live in provider storage (JSONL
  under each profile's config dir) and are read lazily today; search needs an index —
  built incrementally at `run.end` plus a backfill pass — as a new core subsystem with
  one query channel. Memory discipline matters at ledger scale; the virtualized list
  pattern shows the house style for that.
- **Cost:** **M–L** (3–8 days depending on index ambition).

### F12. Session auto-tagging

- **OpenRouter has:** Custom Classifiers — a cheap model asynchronously tags every
  generation against up to 8 dimensions; tags become activity/log filters for cost
  attribution.
- **Feature:** opt-in post-run classification of sessions (bugfix / feature / research
  / review / ops …) reusing the auto-naming machinery, surfaced as sidebar filters and
  an analytics dimension for F6.
- **Reason:** the pattern is already proven in-repo — session auto-naming runs a
  one-turn, no-tools, cheapest-model call (`sessions/naming.ts`, `lowestTierModel`);
  tagging is the same call with a different prompt. OpenRouter validated the product
  value (cost attribution by work type).
- **Expected user:** heavy users and team leads reading usage by kind of work rather
  than by raw project.
- **Architecture fit:** **High.** Same seam as naming; honest caveat mirrored from
  their design: it spends (a little) account quota, so it ships opt-in.
- **Cost:** **M** (2–4 days including filter UI).

### F13. MCP server management

- **OpenRouter has:** an official MCP server, MCP tool-reference blocks in their
  Messages API, first-class MCP support in their Agent SDK — MCP as ecosystem table
  stakes.
- **Feature:** an MCP panel in settings: show which servers a run actually loads
  (host-injected browser tools + whatever the CLI's own config carries), then
  add/remove user servers per profile or project, injected via the existing
  `agentToolServers` seam.
- **Reason:** Artemis injects exactly one host-built MCP server (browser tools) and
  exposes no visibility or management beyond it; users with existing `.mcp.json`
  workflows can't see or steer what their runs load from inside Artemis.
- **Expected user:** power users with tool ecosystems (issue trackers, DBs,
  playwright); teams standardising a toolset.
- **Architecture fit:** **High mechanically** — the injection seam is proven, and MCP
  tool calls already flow through the same `canUseTool` permission gate as everything
  else. The care point is that MCP config *is* arbitrary-code execution, so the
  add/remove surface needs the same validator rigour as profiles (no renderer-supplied
  commands executed without rebuild+validation).
- **Cost:** **S–M** for the read-only "what's loaded" view; **L** (1–2 weeks) for full
  management with per-profile scoping.

### F14. Auto model selection

- **OpenRouter has:** Auto Router v2 (classifies the prompt into ~30 task types, ranks
  by real-traffic spend share, `cost_tier` control), Pareto router (cheapest model
  above a quality floor), default-on Auto Exacto for tool calls.
- **Feature:** an "Auto" rung on the thinking ladder: pick model tier + effort per
  prompt from a cheap heuristic (prompt length/shape, plan headroom via the
  recommender, `MODEL_LOAD` weights), always showing and allowing override of the
  choice.
- **Reason:** the ladder defaults to high effort and stays sticky per pane; quota gets
  spent on one-line questions and starved on hard tasks. Their `cost_tier` +
  quality-floor framing translates directly to "spend headroom where it matters."
- **Expected user:** capped-plan users who don't want to micro-manage the ladder.
- **Architecture fit:** **Medium.** All the *signals* exist (recommender, load model,
  binding windows); classification is the new bit. A heuristic is cheap; a
  cheap-model classifier call adds latency to every send (the naming turn shows the
  cost shape). Mispredictions are UX-corrosive, so the override affordance is part of
  the feature, not garnish.
- **Cost:** **M** heuristic-only; **L** with a learned/model-backed classifier.

### F15. OpenRouter as a provider (the direct adoption)

- **OpenRouter has:** the entire other half of this document — 400+ models, an
  Anthropic-Messages-compatible endpoint, org guardrails/budgets, and now **Ori
  Harness** (`ori <agent>`), their CLI that runs existing coding harnesses (Claude
  Code, Codex, OpenCode, Grok Build…) against OpenRouter via OAuth, with org policies
  applying to agent traffic.
- **Feature:** a first-class `openrouter` provider adapter, so a profile can be an
  OpenRouter account and runs bill to its credits — importing their model pool,
  metered billing, and (for org accounts) their guardrails, without Artemis touching a
  credential.
- **Reason:** this is the one move that adopts their whole catalogue instead of
  re-implementing features one at a time. FUTURE-PROVIDERS already establishes the
  sanctioned shape for exactly this: never a user-writable base URL (that route is
  structurally closed in `CREDENTIAL_ROUTING_ENV_KEYS`), but an adapter that owns its
  endpoint/runtime as a constant, declares its own credential vocabulary, and shows
  whose account is billed. Ori Harness makes the fit unusually good — a vendor CLI
  with its own OAuth login, which is precisely our CLI-owned-auth model (R4).
- **Expected user:** users who want metered pay-as-you-go instead of subscription
  windows; model diversity beyond Claude/GPT; org admins who want OpenRouter
  guardrails/budgets to govern agent traffic (which substitutes for several features
  above at the account layer).
- **Architecture fit:** **Medium — gated on the R1–R8 audit, not on our seam.** The
  seam was built for this. Unverified (would need live driving per house discipline):
  Ori's config-dir isolation var (R3), auth-status probe (R4), session
  list/resume/fork (R6), and whether `ori claude` preserves the inner CLI's event
  stream our Claude adapter expects. Their weekly-breaking-change cadence is a real
  maintenance tax to price in.
- **Cost:** **XL** (research spike **S** first: install Ori, run the eight-requirement
  audit from FUTURE-PROVIDERS; the adapter itself is Codex-adapter-class work if the
  audit passes).
- **Also the competitive note:** Ori Harness distributed to enterprises is a competing
  product with Artemis's category. Tracking it is strategy, not just integration
  research.

### F16. Observability export (team telemetry, self-hosted)

- **OpenRouter has:** Broadcast — zero-code export of full request traces to 19
  destinations (Datadog, Langfuse, OTel, BigQuery, S3, webhook…), async, sampled,
  with a privacy mode that strips content.
- **Feature:** opt-in, *self-hosted-target-only* run-event export (OTLP or JSONL to a
  directory/endpoint the user configures), reusing the redaction layer, default off.
- **Reason:** Artemis has zero telemetry by design — which is right for individuals
  and blinding for a team lead running ten seats who wants aggregate usage/failure
  dashboards. Broadcast shows the shape that respects both: export is explicit,
  destination is yours, content can be stripped.
- **Expected user:** team leads and platform engineers; no solo user.
- **Architecture fit:** **Medium.** The event bus exists (`RunRegistry.subscribe` sees
  everything) and `redact.ts` provides the scrubbing vocabulary; the work is the
  design tension — keeping "no phone-home" true while adding an exporter (hard
  default-off, destination allowlist local-only, no vendor endpoints shipped).
- **Cost:** **L.** Park until a real team asks; F4 + F6 cover most solo needs.

### F17. Eval harness

- **OpenRouter has:** Ori Eval (natural-language-generated `.eval.ts` suites run
  against your real prompts with LLM judging + cost/latency assertions) and a public
  Benchmarks platform (2.4M task evaluations) feeding routing.
- **Feature:** a headless "run this task matrix across providers/models and score it"
  mode — `scripts/smoke.ts` grown into a comparison harness with per-run
  usage/duration capture and simple judging.
- **Reason:** the Kimi/Grok adapter round will need "same tasks, compare outcomes"
  evidence, and model-default debates recur; OpenRouter productised exactly this loop.
- **Expected user:** us (maintainers) first; power users later.
- **Architecture fit:** **Medium.** The engine already runs headless with the full
  event stream (smoke.ts proves it); matrix orchestration + scoring + report are new
  scope with real surface area.
- **Cost:** **XL.** Park; F8 (interactive comparison) delivers 80% of the decision
  value for a fraction of the cost.

---

## Part 2 — Census of the rest: theirs with no Artemis feature to build

Per the deliverable's "every piece" rule, everything else found in the sweep, with why
it doesn't convert. Fit column uses the same vocabulary (Rejected = conflicts with a
documented design refusal; N/A = the premise doesn't exist in Artemis's model;
Covered = we already have the analogue).

| OpenRouter piece | Why no Artemis feature | Fit |
| --- | --- | --- |
| Credits, auto-top-up, invoices/tax, crypto, Stripe Projects | Artemis bills nobody; accounts and money belong to the provider relationship | N/A |
| API key management, per-key limits, Management/Provisioning API | "No key field anywhere in the app" is the product's spine; keys never exist here to manage | Rejected |
| BYOK | Inverse of our model (we bring the *vendor's own CLI login*, never a key). The sanctioned adoption path is F15 | Rejected |
| OAuth PKCE issuance for third-party apps | Artemis is a client of CLIs, not a platform issuing account access | N/A |
| Organizations, Workspaces, SSO/SCIM, member roles | Single-user desktop app; the team layer is Cerebro + shared-config, both existing | N/A |
| ZDR routing, `data_collection` filters, in-region endpoints | Data posture lives in the user's provider account and the CLI, which expose no routing knob to us. A static "provider data policy" note per profile would be S-cost, low value | Low |
| Rankings, app attribution, public datasets, market share | Requires aggregate traffic visibility Artemis structurally never has (no telemetry) | Rejected |
| Provider onboarding, private models | Different business. Partial analogue exists: `RunInput.model` deliberately accepts arbitrary ids, so custom/dated models already pass through | Covered/N-A |
| Image/video generation, TTS/STT, embeddings, rerank, files API, batch API | Gateway product lines; coding-agent CLIs don't expose these surfaces to a harness. (Image + PDF *input* we already have — both adapters declare `imageInput`/`fileInput`) | N/A |
| Prompt caching controls, response caching, context compression, response healing, structured outputs | The CLI/SDK owns the request pipeline; Artemis already *reports* cache reads/writes and context share. Their auto-compaction analogue is Claude Code's own | Covered/N-A |
| Zero completion insurance | Nothing metered to insure; failed-run quota treatment is provider policy | N/A |
| Free tier, Free Models Router | No free pool exists behind subscription CLIs | N/A |
| Service tiers (flex/priority) | Priority analogue exists (fast mode, capability-gated to Claude); flex/batch has no subscription-window equivalent | Covered/N-A |
| `user` end-user tracking | One human per profile by construction | N/A |
| Server tools: hosted shell containers, web search/fetch, apply-patch | The agent runtime (Claude Code/Codex) owns tool execution — locally, which is the product's point. A web-search *toggle* folds into F1's `allowedTools` wiring | N/A (toggle → F1) |
| Advisor / Subagent server tools, Fusion multi-model deliberation | Claude Code's own subagents/workflows cover delegation (we render them). Cross-provider deliberation as a harness feature is F8-then-F17 territory; anything more is speculative | Low (park) |
| Auto Exacto, provider `sort`/quantization/`max_price` | Provider-endpoint arbitrage requires being the router; no analogue when the CLI speaks only to its own vendor | N/A |
| Latest-model aliases (`~latest`) | Covered — our built-in lists are alias-style (not dated snapshots) plus a live catalogue fetch | Covered |
| Router metadata | Translated as F5 | → F5 |
| Guardrails (allowlists, PII redaction, injection regex) | Model/tool allowlists translate (F1's `allowedTools`/`disallowedTools` + the permission-rules vocabulary that already exists in the protocol with no settings UI — that UI is worth folding into F1). Content-scanning layers duplicate what the local permission flow already mediates | Partial → F1 |
| Generation feedback reporting | Bug-report URL prefill exists; a per-run "flag this" capture is S-cost if ever wanted | Covered-ish |
| SDKs, API versioning/changelog discipline | We consume SDKs, we don't publish an API. (Standing caveat from prior research: the Agent SDK's types under-declare what the CLI emits — verify against the binary) | N/A |
| Status page for OpenRouter itself | Translated as F10 (we consume provider status; we don't need to publish our own) | → F10 |

---

## Priority read

**Now (≈ one focused week, protocol-ready):** F1 budgets · F2 alerts · F3(a+b)
retry/fallback wiring · F4 transcript export · F5 recommendation transparency.

**Next (the quarter's substance):** F6 usage analytics · F7 presets · F8 compare mode
· F9 model metadata · F10 provider status · F12 auto-tagging · **the F15 spike**
(drive Ori Harness through the R1–R8 audit — small cost, and it prices the hedge
against the category shift described in the asymmetry section).

**Architectural, schedule deliberately:** F3(c) auto-failover · F11 transcript search
· F13 MCP management · F14 auto model selection.

**Parked pending demand:** F15 full adapter (gated on the spike) · F16 team telemetry
· F17 eval harness.

The through-line: OpenRouter's advantage is that they sit *in* the request path and
monetise it; Artemis's advantage is that it sits *beside* the user's own accounts and
is trusted precisely because it touches nothing. Every feature above was chosen
because it strengthens that second position — observability, restraint, and choice
over the accounts the user already owns — rather than imitating the first.
