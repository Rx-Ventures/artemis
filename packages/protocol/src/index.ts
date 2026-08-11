/**
 * `@rx-artemis/protocol` — the shared contract.
 *
 * Every other package in this repo imports from here and none of them import
 * from each other's internals. The package has **zero runtime dependencies**
 * and must keep it that way: it is loaded by the Electron main process, by the
 * preload script inside a locked-down context, and by the renderer in the
 * browser sandbox. Anything that cannot run in all three does not belong here.
 *
 * What lives here:
 *
 * | Module          | Contents                                                  |
 * | --------------- | --------------------------------------------------------- |
 * | `json`          | `JsonValue`, `assertNever`                                 |
 * | `ids`           | `RunId`, `SessionId`, `ProfileId`, …                       |
 * | `provider`      | `ProviderId`, `Capabilities`, `ProviderDescriptor`         |
 * | `permissions`   | `PermissionMode`, `PermissionRequest`, `PermissionDecision`|
 * | `events`        | the `AgentEvent` union                                     |
 * | `usage`         | `TokenUsage`, `UsageSnapshot`                              |
 * | `errors`        | `AgentError`, `AgentErrorCode`                             |
 * | `run`           | `RunInput`, `RunHandle`, `RunStatus`                       |
 * | `session`       | `SessionSummary`                                           |
 * | `profile`       | `Profile`, `ProfileMetadata`, `configDirProblem`           |
 * | `ipc`           | channel constants, request/response maps, `ArtemisBridge`    |
 *
 * What does *not* live here: the `ProviderAdapter` / `Run` interfaces. Those
 * are the engine's seam and live in `@rx-artemis/core/adapters`, because they
 * describe live objects with async iterables and disposal semantics — things
 * that never cross IPC. They are built out of the types in this package.
 */

export * from './json.js';
export * from './ids.js';
export * from './provider.js';
export * from './permissions.js';
export * from './usage.js';
export * from './errors.js';
export * from './events.js';
export * from './run.js';
export * from './session.js';
export * from './profile.js';
export * from './ipc.js';
