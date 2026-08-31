/**
 * `@rx-artemis/core/adapters` — the provider seam and its implementations.
 *
 * | Module       | Contents                                                       |
 * | ------------ | -------------------------------------------------------------- |
 * | `types`      | `ProviderAdapter`, `Run`, `ResolvedRunInput`, `AdapterError`    |
 * | `stream`     | `AsyncQueue`, `createDeferred` — the async plumbing adapters share |
 * | `env`        | `composeProviderEnv` — how a profile becomes a process environment |
 * | `titles`     | what to ask a model for a session name, and how to believe it   |
 * | `mapper`     | pure Claude ⇄ Artemis translation (no SDK loaded, fully testable) |
 * | `claude`     | the Claude adapter: streaming input, permissions, disposal      |
 * | `jsonrpc`    | line-delimited JSON-RPC, for adapters that drive a subprocess   |
 * | `codexProtocol` | the slice of Codex's app-server wire protocol Artemis speaks  |
 * | `codexMapper`| pure Codex ⇄ Artemis translation, same rules as `mapper`          |
 * | `codex`      | the Codex adapter: app-server process, threads, turns, approvals |
 * | `registry`   | `ProviderId` → adapter, and the one-line place to add a provider |
 *
 * Start with `types.ts`: it documents, per method, what a provider that cannot
 * support a capability must do instead.
 */

export * from './types.js';
export * from './stream.js';
export * from './taskLedger.js';
export * from './env.js';
export * from './titles.js';
export * from './jsonrpc.js';
export * from './mapper.js';
export * from './claude.js';
export * from './codexProtocol.js';
export * from './codexMapper.js';
export * from './codex.js';
export * from './registry.js';
export * from './signIn.js';
// The remote-account calls only, not the adapter itself — that is reached
// through the registry like every other provider.
export * from './artemis/admin.js';
