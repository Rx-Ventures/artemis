# Apollo

A desktop UI for agentic coding CLIs.

Apollo is an open-source Electron app that puts a real interface in front of
command-line coding agents: a readable transcript, an approval surface you can
actually reason about, isolated accounts you can switch between, and session
history you can browse. Claude is the first provider. The architecture is built
around a provider seam so Codex and OpenCode can follow.

Powered by Claude.

---

## Status

Working end to end for Claude. You can create a profile, start a run, watch it
stream, approve or deny tool calls, interrupt it, and browse past sessions.

Not done yet: a native directory picker (the working directory is a text
field), replaying a resumed session's earlier messages into the transcript, and
more than one run rendered at a time. Codex and OpenCode are declared in the
protocol and appear in the UI as unavailable; neither adapter exists.

## Authentication

**Apollo never performs a login.** It has no OAuth flow, opens no browser to sign
you in, and refreshes no tokens. Every credential it uses is one you obtained
yourself and pasted into a profile.

Each Claude profile picks an **auth mode**, which decides what a run costs:

| Mode | Credential | Billed as |
| ---- | ---------- | --------- |
| **API key** (default) | An API key from <https://console.anthropic.com/settings/keys>, starting with `sk-ant-` | Metered API usage, charged to that key's account |
| **Claude subscription** | A token printed by `claude setup-token` | Your Claude Pro, Max, Team or Enterprise plan |

Subscription mode is available only on the first-party Anthropic backend.
Bedrock, Vertex and Foundry are billed by those clouds, so the combination is
rejected rather than silently downgraded.

To get a subscription token, run Anthropic's own CLI yourself:

```bash
claude setup-token     # opens a browser, then prints a long-lived token
```

Apollo does not run that command for you and does not know when the token
expires; when it stops working, mint a new one and paste it in.

### Why the mode is stored on the profile

`ANTHROPIC_API_KEY` **overrides** a subscription token when both are set — the
run is billed as metered API usage even though you chose your plan. So a mode is
not just a label for which box to type into. Apollo strips every Claude
credential variable out of the environment it inherits from your shell and then
writes back exactly the one your profile's mode names. Whichever mode you pick,
the other credential cannot reach the agent, whether it came from your shell,
another profile, or a hand-edited config file.

### If you are distributing Apollo

Anthropic's Agent SDK documentation states that third-party developers may not
offer claude.ai login or subscription rate limits for their products without
prior approval from Anthropic. If you are shipping a build of Apollo to other
people with subscription mode enabled, seek that approval first. Running your
own build against your own subscription is a separate matter from distributing
one.

## Getting started

Requires Node 22+ and pnpm 10+.

```bash
pnpm install     # Electron downloads its runtime on first use
pnpm dev         # build the shared packages, then launch the app
```

Other tasks:

```bash
pnpm typecheck   # build the project graph and typecheck every package
pnpm test        # vitest across the workspace
pnpm build       # production bundles into apps/desktop/out
pnpm smoke       # headless end-to-end run, no Electron (see below)
```

### Adding a credential

Apollo has no credentials of its own and cannot do anything until you give it a
profile.

1. Launch the app (`pnpm dev`) and open **Profiles** — the "add one" link on the
   welcome screen, or <kbd>⌘</kbd><kbd>,</kbd>.
2. **New profile**, then give it a label (for example `Work` or `Personal`).
3. Leave the backend on **Anthropic** and choose an auth mode:
   - **API key** — paste a key from
     <https://console.anthropic.com/settings/keys>. It starts with `sk-ant-`.
   - **Claude subscription** — run `claude setup-token` in Anthropic's CLI and
     paste the token it prints. Runs are billed to your plan instead of API
     credit.
   - For **Bedrock**, **Vertex** or **Foundry**, pick that backend instead and
     leave the credential blank — those authenticate from the ambient credential
     chain of the platform's own SDK. Put region and project settings
     (`AWS_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, …) in the profile's extra
     environment variables box.
4. Save. The credential is encrypted through the OS keychain immediately. From
   then on the interface only ever shows you a masked hint like
   `sk-ant-...4f2a`.
5. Set a working directory in the top bar, type a prompt, and send.

Each profile gets its own isolated `CLAUDE_CONFIG_DIR` under Apollo's user-data
directory, so two profiles never share credentials *or* history. Switching
between them is manual: Apollo does not pool accounts, does not fail over
between them, and does not rotate them when one hits a rate limit.

If your machine has no usable credential store, Apollo says so at startup and
refuses to save a key rather than silently writing one in plaintext.

## Architecture

### Why a seam, not an integration

The three providers Apollo targets have nothing in common at the transport
layer:

| Provider | Transport                            |
| -------- | ------------------------------------ |
| Claude   | in-process Node library              |
| Codex    | subprocess speaking JSONL over stdio |
| OpenCode | local HTTP server                    |

So the abstraction cannot be shaped like any one of them. Every adapter
normalizes its native stream onto a single nine-variant event union —

```
session.started | text.delta | text.complete | thinking.delta | tool.start
| tool.end | permission.request | usage | run.end
```

— and publishes a capability descriptor up front:

```ts
interface Capabilities {
  interactivePermissions: boolean
  partialMessages: boolean
  midRunSteering: boolean
  forkSession: boolean
  listSessions: boolean
  subagents: boolean
  // …plus permission modes, resume, usage and cost reporting
}
```

The UI reads that descriptor and *degrades*: it hides the fork affordance when
a provider cannot fork, and renders whole messages instead of a typewriter when
a provider cannot stream. Nothing assumes every provider can do everything.

Registering a provider is one line, in
`packages/core/src/adapters/registry.ts`:

```ts
export function createDefaultProviderRegistry(options?) {
  return createProviderRegistry([
    createClaudeAdapter(options?.claude),
    // createCodexAdapter(options?.codex),
  ])
}
```

An adapter declares its own credential vocabulary alongside its capabilities —
which variable carries the key, which one points at the isolated config
directory, which hosting backends it offers, and which auth modes it supports
(with the variable each mode's secret is emitted as, and the backends each mode
is valid on). `resolveEnv` reads that spec rather than any provider's variable
names, and the profile editor builds both its backend picker and its auth-mode
picker from it, so a second provider does not need a change anywhere outside its
own adapter. Nothing in `@rx-apollo/protocol` names a backend or a mode; it defines
the shape and the adapter supplies the contents.

### The path a prompt takes

```
  renderer          submitPrompt() mints a runId, paints optimistic UI
     │              and starts matching events before start() resolves
     ▼
  window.apollo      preload/index.ts — the whole attack surface.
     │              12 fixed channels, no ipcRenderer passthrough,
     ▼              no channel name ever built from renderer input
  ipcMain           main/ipc.ts — verify sender, validate and rebuild the
     │              payload, dispatch, then scan the response for secrets
     ▼
  ApolloEngine       main/engine.ts — the composition root
     │
     ▼
  RunRegistry       core/sessions — mints or accepts the run id, resolves
     │              credentials via resolveRun, fans out events
     ▼
  resolveEnv        core/profiles — decrypt the credential, build the env
     │              bundle using the provider's own credential spec (the auth
     │              mode's variable + backend flag + isolated config dir), and
     │              delete every competing credential variable
     ▼
  ClaudeAdapter     core/adapters — merges the host env (scrubbing every
     │              inherited credential), calls the Agent SDK
     ▼
  Agent SDK
```

Events come back the other way on one push channel, and the renderer
demultiplexes on `event.runId`. A channel per run would force the preload to
build channel names out of renderer-supplied strings, which is exactly the
pattern it is not allowed to have.

### Where secrets live

Credentials live in the Electron main process, encrypted at rest by the OS
keychain, and are referenced everywhere else by an opaque handle.

**No secret ever crosses the IPC boundary into the renderer.** The renderer
sees `ProfileMetadata` — id, label, provider, backend, auth mode, and a masked
hint — and nothing else. The auth mode is there on purpose: "am I about to spend
API credit or my subscription allowance?" is a question you must be able to
answer by looking at a profile, and a mode id is not a secret. The one exception
runs the other way: when you type a credential into the profile editor it
travels renderer → main, once, and goes straight into encrypted storage. It
never comes back.

Three things enforce that rather than merely documenting it:

- Every IPC response is scanned on its way out (`main/redact.ts`). Returning a
  `Profile` where the contract says `ProfileMetadata` throws in the main
  process instead of shipping a key to the renderer.
- The renderer reads a key straight out of an uncontrolled DOM input at submit
  time and clears the field in the same block. The value never enters React
  state.
- `main/engine.ts` narrows `ProfileStore.create()`'s return type to `{ id }`, so
  the secret-bearing fields are not visible to the compiler at that call site.

### Layout

```
packages/protocol/     shared types only — zero runtime deps, imported by everything
packages/core/         headless engine; never imports electron
  src/adapters/        the provider seam: types.ts, claude.ts, registry.ts
  src/profiles/        profile storage and env resolution
  src/sessions/        live-run registry
apps/desktop/
  main/                Electron main process — hosts core, owns all secrets
  preload/             contextBridge; the renderer's entire view of the outside
  renderer/            React + Vite + Tailwind
scripts/smoke.ts       headless end-to-end run, no Electron
```

Three boundaries are enforced by the type system rather than by convention:

- `@rx-apollo/protocol` compiles with `"types": []` — no ambient Node, so it cannot
  reach for a filesystem.
- `@rx-apollo/core` has no dependency on `electron` and must never gain one; it
  runs under plain Node and under vitest with no Electron present. A test
  (`packages/core/src/no-electron.test.ts`) fails the build if that changes.
- `apps/desktop/renderer` compiles without `@types/node`, so `fs`, `process`
  and `electron` are not merely discouraged there — they do not typecheck.

## Debugging without Electron

`scripts/smoke.ts` runs the whole engine — profile store, credential
resolution, run registry, Claude adapter, Agent SDK — in a plain Node process,
and prints the normalized event stream:

```bash
export ANTHROPIC_API_KEY=sk-ant-…              # or CLAUDE_CODE_OAUTH_TOKEN=…
pnpm smoke
pnpm smoke "list the files in this directory"   # custom prompt
```

Whichever variable you set decides the smoke profile's auth mode, so this is
also how you check that a subscription token actually works before wiring it
into a profile.

Everything it writes lives in one `mkdtemp` directory that is deleted on exit;
it never touches your real Apollo profiles. If the smoke test works and the app
does not, the fault is in the Electron plumbing. If the smoke test fails, the
fault is in core and you can attach a debugger to it.

## Naming

The product is **Apollo**. It is an independent open-source project: not
affiliated with, endorsed by, or a distribution of any vendor's CLI, and not a
reimplementation of one's interface. "Powered by Claude" is the extent of the
attribution. Contributions must not introduce another product's branding,
visual identity, or ASCII art.

## License

MIT
