/**
 * `@libra/core` — the headless engine.
 *
 * Everything Libra does that is not drawing pixels or talking to Electron
 * happens here: provider adapters, profile and credential resolution, and the
 * registry of live runs.
 *
 * ```
 * ┌── adapters ──────────────────────────────────────────────────────────┐
 * │ ProviderAdapter / Run — the seam. One implementation per provider,   │
 * │ each mapping a wildly different transport onto the same AgentEvent   │
 * │ union and publishing a capability descriptor the UI degrades against.│
 * ├── profiles ──────────────────────────────────────────────────────────┤
 * │ ProfileStore    CRUD over account records (never secrets)            │
 * │ SecretStore     the seam to encrypted OS storage, injected by the host│
 * │ resolveEnv      profile → the env bundle a run executes with         │
 * ├── sessions ──────────────────────────────────────────────────────────┤
 * │ RunRegistry     live runs by id, event fan-out, guaranteed teardown  │
 * ├── workspace ─────────────────────────────────────────────────────────┤
 * │ checkWorkingDirectory  is this cwd real, a directory, and readable?  │
 * └──────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Two rules hold for every module in this package:
 *
 *  1. **No `electron` import, ever** — directly or transitively. Core has to
 *     run in a plain Node process and under vitest with no Electron runtime
 *     present. Anything that genuinely needs the main process (encrypted
 *     storage, the user-data path) is injected as an interface.
 *  2. **Secrets stay here.** Core reads credentials to build an environment
 *     for a provider; the only profile shape it hands upward is
 *     `ProfileMetadata`, which carries a masked hint and nothing else.
 *
 * Types shared with the renderer — events, capabilities, IPC payloads — live
 * in `@libra/protocol` and are re-exported from nowhere: import them from
 * there directly.
 */

export * from './adapters/index.js';
export * from './profiles/index.js';
export * from './sessions/index.js';
export * from './workspace/index.js';
