# Adding an LM Studio provider to Artemis — feasibility

Research notes, 2026-08-18, verified against **LM Studio's server on `127.0.0.1:1234`** and
**`opencode` 1.18.18**. Every claim below was confirmed by driving the real endpoints, not
read off documentation. Companion to [CODEX-ADAPTER-RESEARCH.md](CODEX-ADAPTER-RESEARCH.md)
and [FUTURE-PROVIDERS-RESEARCH.md](FUTURE-PROVIDERS-RESEARCH.md).

## Verdict

**Doable, and a different shape of work from the first three — because LM Studio is not an
agent runtime.**

Claude, Codex and OpenCode each ship something that owns the agent loop: the Agent SDK, the
app-server, an ACP peer. Artemis's adapter translates a loop somebody else runs. LM Studio
ships an OpenAI-compatible inference server and nothing else, so **the loop becomes ours** —
tool schemas, tool execution, permission gating, and the result-feedback cycle all move
inside Artemis.

That is not a reason to refuse it, but it is the reason the estimate is not "another
`opencode.ts`". The transport is the easy half.

Scope, honestly stated: **transport and streaming are a few days. The tool loop is the
product.** Everything after "the model replies with text" is new surface Artemis has never
had to own.

## What was verified live

| Check | Result |
| --- | --- |
| `GET /v1/models` | answers; lists **loaded/servable** models only |
| `GET /api/v0/models` | answers; adds `type` (`llm` / `vlm` / `embeddings`) and `state` (`loaded` / `not-loaded`) |
| `POST /v1/chat/completions` | **1.16 s** round trip, exact instruction following, on `mistralai/ministral-3-3b` |
| Endpoint health under load | fine — the endpoint was never the bottleneck |
| Same model driven through OpenCode | model listed, but **`opencode run` produced nothing in 5 minutes** |

That last row is the finding that matters most, and it is why this document exists rather
than a config recipe.

## Why not just configure OpenCode to point at it

It was tried first, and it works exactly as far as listing:

```jsonc
{ "provider": { "lmstudio-local": {
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": "http://127.0.0.1:1234/v1" },
    "models": { "mistralai/ministral-3-3b": { "name": "Ministral 3B" } } } } }
```

`opencode models` lists the model. `opencode run` against it hung for five minutes and
emitted nothing, while a direct `curl` to the same endpoint answered in **1.16 seconds**. So
the inference path is healthy and the *agent* path through OpenCode is not — most likely
tool-call negotiation with a 3-billion-parameter model that does not support tools, though
that has not been isolated yet.

**Two traps found while trying, both worth keeping even if this route is abandoned:**

1. **Do not reuse OpenCode's known provider id `lmstudio`.** Doing so merges entries from
   OpenCode's own catalogue into the model list. It offered `gpt-oss-20b`,
   `qwen3-30b-a3b-2507` and `qwen3-coder-30b` — **none of which are downloaded on this
   machine**. A custom id (`lmstudio-local`) lists only what is declared. Shipping the
   obvious id would fill the picker with models that fail on selection, which is the
   "capability declared from an advertisement" failure the OpenCode adapter warns about,
   one level down.
2. **`/v1/models` under-reports.** It lists servable models; `/api/v0/models` lists
   everything downloaded, with the `type` needed to tell an embedding model from one that
   can hold a conversation. An adapter must read the second and filter on `type`, or it
   will offer `text-embedding-nomic-embed-text-v1.5` as something to chat with.

## What the adapter must own

The seam's contract is unchanged — the difficulty is that more of it falls to us.

### The tool loop

```
prompt ──► POST /v1/chat/completions  (tools: [...], stream: true)
             │
             ├── content deltas ─────────────► text.delta
             ├── reasoning deltas ───────────► thinking.delta
             └── tool_calls deltas
                    │
                    ▼
             permission.request ──► wait for respondToPermission()
                    │
                    ▼
             execute tool, append {role:"tool", tool_call_id, content}
                    │
                    └──► POST again ──► repeat until finish_reason != "tool_calls"
```

Nothing in Artemis does this today. Three of its parts are genuinely new:

- **A tool set.** A coding agent needs at minimum read, write, edit, glob, grep and a
  shell. Each needs a JSON schema for the model and a real implementation, and the shell
  is the one that decides whether this is safe.
- **Execution inside the app.** The other three providers run tools in *their* process.
  Here Artemis executes them, in the run's cwd, which puts filesystem and process
  execution inside Electron's main process for the first time.
- **Interrupt and abort.** A hung tool or a runaway loop must be stoppable, and unlike the
  other adapters there is no upstream to ask.

### Capabilities this adapter can honestly declare

| Capability | Value | Why |
| --- | :---: | --- |
| `partialMessages` | ✅ | SSE `stream: true` gives content and reasoning deltas |
| `interactivePermissions` | ✅ | we own the loop, so we can park it — and must |
| `usageReporting` | ✅ | the `usage` object on the final chunk |
| `costReporting` | ❌ | local inference has no price to report |
| `planUsageReporting` | ❌ | no plan, no limits |
| `midRunSteering` | ❌ | phase 1; the loop is ours, so this becomes possible later |
| `listSessions` / `resumeSession` / `forkSession` | ❌ | LM Studio stores no conversation. Artemis would have to persist transcripts itself — a real feature, deliberately not phase 1 |
| `subagents` / `subagentTranscripts` | ❌ | no delegation |
| `systemPromptAppend` | ✅ | we build the message array, so appending is trivial |
| `imageInput` | ⚠️ | only for `vlm` models — per-model, from `/api/v0/models` `type` |
| `fileInput` | ❌ | phase 1 |
| `permissionModes` | `plan`, `default`, `acceptEdits`, `bypassPermissions` | enforced by our own loop rather than by a provider |

Note the shape of that table: the `false` rows are mostly **"not yet"** rather than
**"cannot"**, which is the opposite of OpenCode's. Owning the loop costs work and buys
control.

### Credential spec

The simplest of the four. LM Studio needs no credential — it is a local server — so the
spec is nearly empty, and the interesting field is the **base URL**, which is not a
credential and does not belong in `credentialEnvKeys`.

This is the first provider whose profile is defined by an *endpoint* rather than an
account, which `ProviderCredentialSpec` has no field for today. Adding one is a small,
honest change; overloading `configDirVar` to carry a URL would not be.

## Sequencing

**Phase 1 — it talks.** Protocol id, credential spec, capability declaration, an
OpenAI-compatible SSE client, and a run that streams a single text turn. No tools. Ships as
a provider that can hold a conversation and says plainly, through its capability flags, that
it cannot yet do anything else.

**Phase 2 — it works.** Tool schemas, execution, permission gating, the feedback cycle.
This is the bulk, and it is where the safety questions are.

**Phase 3 — it remembers.** Local transcript persistence, which turns `listSessions`,
`resumeSession` and `forkSession` from `false` into features.

## Open questions

1. **Which tool set, and how sandboxed?** Artemis executing a shell command in the main
   process is a materially different security posture from today, where every tool runs
   inside a provider's own process. The `redact.ts` boundary and the fixed-channel preload
   were built on the assumption that Artemis does not do this.
2. **Is a 3B model a fair test?** The hang through OpenCode may simply be a model without
   tool-calling support. Phase 2 needs a model that genuinely supports tools before any
   conclusion is drawn about the loop.
3. **Does this generalise?** Nothing above is LM Studio-specific except reading
   `/api/v0/models`. The same adapter would serve Ollama, `llama-server` or any
   OpenAI-compatible endpoint, which argues for naming it after the shape rather than the
   vendor.
