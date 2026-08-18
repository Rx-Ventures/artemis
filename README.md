# Artemis

A desktop UI for agentic coding CLIs.

Artemis is an open-source Electron app that puts a real interface in front of
command-line coding agents: a readable transcript, an approval surface you can
actually reason about, isolated accounts you can switch between, and session
history you can browse. Claude and Codex are the providers today. The
architecture is built around a provider seam so OpenCode can follow.

Powered by Claude.

---

## Status

Working end to end for Claude and for Codex. You can create a profile, sign it
in with the provider's own CLI, start a run, watch it stream, approve or deny
tool calls, interrupt it, and browse past sessions.

Codex shows as available whenever its CLI is on your `PATH`; when it is not,
the profile screen greys the provider out and says so rather than hiding it.
OpenCode is declared in the protocol and appears in the UI as unavailable;
that adapter does not exist yet.

## Authentication

**Artemis never performs a login, and stores no credential of any kind.** It
has no OAuth flow, opens no browser to sign you in, refreshes no tokens — and
it holds nothing you could paste into it. There is no key field anywhere in the
app.

A profile is a label and a config directory. To sign one in, Artemis composes
the provider CLI's own login command with the profile's directory set inline:

```bash
CLAUDE_CONFIG_DIR='…/Artemis/profiles/work' claude auth login
```

You run that line in your own terminal. The CLI opens the browser, completes
the login, and writes its credential into that directory; Artemis polls the
CLI's status probe (`claude auth status`) and moves on by itself when the
directory answers "signed in". The credential belongs to the provider's CLI,
lives where that CLI keeps it, and never passes through Artemis in either
direction.

### Why the account is a property of the directory

The Claude CLI keys both its credential and its session history on
`$CLAUDE_CONFIG_DIR` (Codex does the same with `CODEX_HOME`), so one profile,
one directory, one account, one history. Two profiles pointed at the same
directory are the same account, which is occasionally what someone means.

An earlier design stored the credential itself, alongside an auth mode saying
which environment variable to emit it as. That design had a defect it could not
be rid of: `ANTHROPIC_API_KEY` silently outranks a subscription login, so a
profile that said "bill my plan" could bill metered API usage instead. Artemis
now emits no credential variable at all and strips every one of them —
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and the rest of the provider's
credential surface — from the environment a run inherits. The only thing that
can authenticate a run is the login inside the profile's own directory, which
makes the billing trap structural rather than policed.

### If you are distributing Artemis

Anthropic's Agent SDK documentation states that third-party developers may not
offer claude.ai login or subscription rate limits for their products without
prior approval from Anthropic. Artemis's sign-in flow ends in exactly that
login, so if you are shipping a build of Artemis to other people, seek that
approval first. Running your own build against your own subscription is a
separate matter from distributing one.

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

### Adding an account

Artemis has no credentials of its own and cannot do anything until you give it
a profile that is signed in.

1. Launch the app (`pnpm dev`) and open **Profiles** — the "add one" link on the
   welcome screen, or <kbd>⌘</kbd><kbd>,</kbd>.
2. **New profile**, then give it a label (for example `Work` or `Personal`).
   Artemis suggests a config directory under its own user-data directory; you
   may replace it with any absolute path. Pointing it at the `~/.claude` you
   are already signed in to is the usual shortcut, and makes that account this
   profile's account with no login step at all.
3. Sign in. Artemis shows the provider CLI's login command with the profile's
   directory set inline; run it in your own terminal. The screen polls the
   CLI's status probe and continues on its own when the login lands.
4. Set a working directory in the top bar, type a prompt, and send.

Each profile's config directory isolates its credential *and* its history, so
two profiles never share either unless you point them at the same directory on
purpose. Artemis can recommend which account a fresh session starts on — each
profile can opt out of being chosen — but a running conversation stays on the
account it started with; nothing rotates accounts mid-run.

## Architecture

### Why a seam, not an integration

The three providers Artemis targets have nothing in common at the transport
layer:

| Provider | Transport                               |
| -------- | --------------------------------------- |
| Claude   | in-process Node library                 |
| Codex    | subprocess speaking JSON-RPC over stdio |
| OpenCode | local HTTP server                       |

So the abstraction cannot be shaped like any one of them. Every adapter
normalizes its native stream onto a single eleven-variant event union —

```
session.started | text.delta | text.complete | thinking.delta | tool.start
| tool.end | permission.request | permission.resolved | usage
| background.tasks | run.end
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
  // …plus permission modes, resume, rename/delete, usage and cost reporting
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
    createCodexAdapter(options?.codex),
    // createOpenCodeAdapter(options?.opencode),
  ])
}
```

That claim has been tested once now: adding Codex was this array plus an
options field, with nothing changed elsewhere in the app.

An adapter declares its own credential vocabulary alongside its capabilities —
which variable points the provider at the profile's isolated config directory
(`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex), which credential
variables could authenticate the provider some other way and must therefore be
stripped, and the sign-in commands (login, status probe, logout) with a
sentence of prose to show beside them. `resolveEnv` reads that spec rather
than any provider's variable names, and the profile screen composes its
sign-in instructions from it, so a second provider does not need a change
anywhere outside its own adapter. Nothing in `@rx-artemis/protocol` names a
variable or a command; it defines the shape and the adapter supplies the
contents.

### The path a prompt takes

```
  renderer          submitPrompt() mints a runId, paints optimistic UI
     │              and starts matching events before start() resolves
     ▼
  window.artemis      preload/index.ts — the whole attack surface.
     │              48 fixed channels, no ipcRenderer passthrough,
     ▼              no channel name ever built from renderer input
  ipcMain           main/ipc.ts — verify sender, validate and rebuild the
     │              payload, dispatch, then scan the response for secrets
     ▼
  ArtemisEngine       main/engine.ts — the composition root
     │
     ▼
  RunRegistry       core/sessions — mints or accepts the run id, resolves
     │              the run's environment via resolveRun, fans out events
     ▼
  resolveEnv        core/profiles — build the env bundle from the provider's
     │              credential spec: point its config-dir variable at the
     │              profile's directory, delete every credential variable
     ▼
  ClaudeAdapter     core/adapters — merges the host env (scrubbing every
     │              inherited credential), calls the Agent SDK
     ▼
  Agent SDK
```

Agent events come back the other way on one push channel, and the renderer
demultiplexes on `event.runId`. A channel per run would force the preload to
build channel names out of renderer-supplied strings, which is exactly the
pattern it is not allowed to have.

### Where secrets live

Nowhere in Artemis, and that is the design rather than an oversight. The
provider's own CLI login writes its token into the profile's config directory;
Artemis's part is to set one environment variable pointing the provider there
and to read a boolean back. `profiles.json` — the whole of what Artemis
persists about an account — is labels and directory paths, readable plaintext
by design, with nothing in it worth stealing.

**No secret crosses the IPC boundary into the renderer, because none exists to
cross.** The renderer sees `ProfileMetadata` — id, label, provider, the
config-directory path, an optional colour and plan pin — and nothing else.
There is no channel in either direction that carries a credential: the `auth`
namespace is a status read and a sign-out, and the profile editor submits a
label and a path.

Three things enforce that rather than merely documenting it:

- No credential channel exists to misuse. Of the 48 fixed channels the preload
  exposes, none accepts or returns a token, `ipcRenderer` is never exposed or
  wrapped, and no channel name is ever built from renderer input — so the
  reachable surface is fixed at build time and readable in one screen.
- Every `invoke` response is scanned on its way out (`main/redact.ts`): key
  names that mean the wrong shape was returned (`publicEnv`, `secretRef`,
  `apiKey`) and credential-shaped string values (`sk-ant-…`, AWS key ids, PEM
  headers, bearer tokens) throw in the main process instead of shipping to the
  renderer. The agent-event, terminal and plan-usage pushes are scanned the
  same way before broadcast; the window-state, updater and menu pushes are
  not, and carry nothing but booleans and version strings.
- Core has no secret to leak. The profile store persists no credential and no
  handle to one, and `resolveEnv` writes exactly one variable — the provider's
  config-directory variable — while deleting every variable that could
  authenticate the provider some other way.

Model output is deliberately exempt from the value patterns: if a user pastes
their own key into a prompt, the transcript legitimately contains it, and
refusing to render the conversation would help nobody.

### Layout

```
packages/protocol/     shared types only — zero runtime deps, imported by everything
packages/core/         headless engine; never imports electron
  src/adapters/        the provider seam: types.ts, claude.ts, codex.ts, registry.ts
  src/profiles/        profile storage and env resolution
  src/sessions/        live-run registry
  src/workspace/       working-directory checks and naming
apps/desktop/
  main/                Electron main process — hosts core, owns the IPC boundary
  preload/             contextBridge; the renderer's entire view of the outside
  renderer/            React + Vite + Tailwind
scripts/smoke.ts       headless end-to-end run, no Electron
```

Three boundaries are enforced by the type system rather than by convention:

- `@rx-artemis/protocol` compiles with `"types": []` — no ambient Node, so it cannot
  reach for a filesystem.
- `@rx-artemis/core` has no dependency on `electron` and must never gain one; it
  runs under plain Node and under vitest with no Electron present. A test
  (`packages/core/src/no-electron.test.ts`) fails the build if that changes.
- `apps/desktop/renderer` compiles without `@types/node`, so `fs`, `process`
  and `electron` are not merely discouraged there — they do not typecheck.

## Debugging without Electron

`scripts/smoke.ts` runs the whole engine — profile store, environment
resolution, run registry, Claude adapter, Agent SDK — in a plain Node process,
and prints the normalized event stream:

```bash
pnpm smoke
pnpm smoke "list the files in this directory"   # custom prompt
```

No environment variable authenticates it. The script runs against the config
directory your CLI is already signed in to — `$CLAUDE_CONFIG_DIR` if set,
`~/.claude` otherwise — exactly as a profile would, **and the run is billed to
that account**. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are
deliberately ignored: Artemis strips both from every run, so a smoke test that
authenticated with one would be exercising a path the product does not have.
If the directory is not signed in, the script exits with the sign-in command
instead of starting a run.

Everything it writes — a disposable profile record and the working directory
the agent is pointed at — lives in one `mkdtemp` directory that is deleted on
exit. The config directory it reads is never written to, and your real Artemis
profiles are never touched. If the smoke test works and the app does not, the
fault is in the Electron plumbing. If the smoke test fails, the fault is in
core and you can attach a debugger to it.

## Naming

The product is **Artemis**. It is an independent open-source project: not
affiliated with, endorsed by, or a distribution of any vendor's CLI, and not a
reimplementation of one's interface. "Powered by Claude" is the extent of the
attribution. Contributions must not introduce another product's branding,
visual identity, or ASCII art.

## Contributing

**Artemis is not accepting pull requests yet. Issues are open, and they are
read.** The provider seam has been tested once, with Codex; until the OpenCode
adapter lands, the interfaces a contribution would build on are still allowed to
move, and a pull request against them could be invalidated by the very change
that proves them. [CONTRIBUTING.md](CONTRIBUTING.md) gives the full reasoning,
says what is welcome now — bug reports, ideas, design disagreement — and
documents the conventions. When the third adapter lands, that file changes.

Security reports go through [private disclosure](SECURITY.md), never the issue
tracker.

## License

[Apache 2.0](LICENSE).

Apache rather than MIT for one reason that matters here: the [NOTICE](NOTICE)
file propagates. If you redistribute Artemis, the warning about shipping a build
whose sign-in ends in a claude.ai login travels with the code, instead of staying
behind in a README you rewrote. Read it before you ship a build to other people.

The Artemis name and visual identity are not licensed under it — section 6 of
the license grants no trademark rights.
