/**
 * `@rx-apollo/core/adapters` — the provider seam and its implementations.
 *
 * | Module       | Contents                                                       |
 * | ------------ | -------------------------------------------------------------- |
 * | `types`      | `ProviderAdapter`, `Run`, `ResolvedRunInput`, `AdapterError`    |
 * | `stream`     | `AsyncQueue`, `createDeferred` — the async plumbing adapters share |
 * | `env`        | `composeProviderEnv` — how a profile becomes a process environment |
 * | `mapper`     | pure Claude ⇄ Apollo translation (no SDK loaded, fully testable) |
 * | `claude`     | the Claude adapter: streaming input, permissions, disposal      |
 * | `jsonrpc`    | line-delimited JSON-RPC, for adapters that drive a subprocess   |
 * | `codexProtocol` | the slice of Codex's app-server wire protocol Apollo speaks  |
 * | `codexMapper`| pure Codex ⇄ Apollo translation, same rules as `mapper`          |
 * | `codex`      | the Codex adapter: app-server process, threads, turns, approvals |
 * | `registry`   | `ProviderId` → adapter, and the one-line place to add a provider |
 *
 * Start with `types.ts`: it documents, per method, what a provider that cannot
 * support a capability must do instead.
 */

export * from './types.js';
export * from './stream.js';
export * from './env.js';
export * from './jsonrpc.js';
export * from './mapper.js';
export * from './claude.js';
export * from './codexProtocol.js';
export * from './codexMapper.js';
export * from './codex.js';
export * from './registry.js';
export * from './signIn.js';
