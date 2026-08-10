/**
 * Composing the environment a provider actually runs with.
 *
 * Every provider in the seam ends up with an environment: the Claude Agent SDK
 * spawns a subprocess, a Codex adapter would spawn one directly, an OpenCode
 * adapter would spawn or configure a local server. All three face the same two
 * problems, so the answer lives here rather than in each adapter.
 *
 * **Problem 1 — you cannot just pass the profile's variables.** A provider that
 * inherits nothing has no `PATH`, no `HOME`, no `TMPDIR`; it cannot find `git`
 * or a shell and is useless for coding work.
 *
 * **Problem 2 — you cannot just inherit everything either.** Apollo's whole
 * account-switching model is that a profile is a *complete* credential
 * environment. If the user happens to have `ANTHROPIC_API_KEY` exported in the
 * shell that launched Apollo, a Bedrock profile would silently authenticate
 * against the first-party API instead — the user would be billed on an account
 * they did not choose, and the isolated `CLAUDE_CONFIG_DIR` would be bypassed.
 *
 * So: inherit the host environment, **scrub the provider's own credential and
 * configuration variables out of it**, then layer the profile on top. What the
 * profile does not set is genuinely unset.
 *
 * The scrub list holds *every* credential variable Claude understands, not just
 * the one the profile happens to use. Both of Apollo's auth modes are in it —
 * `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` — because either one
 * arriving from the shell would change which account is billed. The API key is
 * the sharper edge of the two: the CLI prefers it over a subscription token, so
 * an inherited key would silently turn a subscription profile into metered API
 * spend. The profile bundle is layered on afterwards and always wins, so
 * scrubbing a variable here never stops the profile from setting it.
 */

import type { EnvBundle } from './types.js';

/** Options for {@link composeProviderEnv}. */
export interface ComposeProviderEnvOptions {
  /**
   * Spread {@link hostEnv} underneath the profile bundle. Defaults to `true`.
   * Set false only for a provider that genuinely needs a hermetic environment.
   */
  readonly inheritHostEnv?: boolean;

  /**
   * The environment to inherit from. Defaults to `process.env`. Injectable so
   * this is testable without mutating the test runner's own environment.
   */
  readonly hostEnv?: EnvBundle;

  /**
   * Variable names removed from the inherited base before the profile bundle is
   * layered on. Case-sensitive, matching POSIX semantics. Adapters pass their
   * provider's credential/config surface — see {@link CLAUDE_ENV_SCRUB_KEYS}.
   */
  readonly scrubKeys?: readonly string[];

  /**
   * Additional inherited names to remove, by pattern. Useful for families of
   * variables (`ANTHROPIC_*`) without enumerating them. Applied to the
   * inherited base only, never to the profile bundle.
   */
  readonly scrubPattern?: RegExp;
}

/**
 * Provider variables that must never reach a run by accident.
 *
 * Split into three groups:
 *
 *  - **credentials** — would authenticate as an account, or on a billing
 *    arrangement, the profile did not choose. Both auth modes' variables are
 *    listed; the selected one is put back by the profile bundle.
 *  - **backend selection** — would silently retarget a profile at Bedrock,
 *    Vertex or Foundry.
 *  - **storage location** — would break per-profile session isolation by
 *    pointing every profile at the same config directory.
 */
export const CLAUDE_ENV_SCRUB_KEYS: readonly string[] = [
  // credentials
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY_HELPER',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // endpoint + model overrides that change which account/route is billed
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  // backend selection
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // storage location — the thing that makes profiles isolated at all
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
];

/**
 * Build the complete environment for a provider process.
 *
 * The profile bundle always wins. A key whose value in the bundle is
 * `undefined` is treated as an explicit unset: it is removed from the result
 * rather than passed through as an empty string, which is how a caller says
 * "make sure the provider does *not* see this".
 *
 * @returns a fresh, mutable `Record<string, string>` — provider SDKs tend to
 *          want a plain object they can hand to `spawn`, and returning a copy
 *          means no caller can mutate `process.env` through it.
 */
export function composeProviderEnv(
  env: EnvBundle,
  options?: ComposeProviderEnvOptions,
): Record<string, string> {
  const inherit = options?.inheritHostEnv !== false;
  const hostEnv: EnvBundle = options?.hostEnv ?? process.env;
  const scrubKeys = new Set(options?.scrubKeys ?? []);
  const scrubPattern = options?.scrubPattern;

  const result: Record<string, string> = {};

  if (inherit) {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value === undefined) continue;
      if (scrubKeys.has(key)) continue;
      if (scrubPattern !== undefined && scrubPattern.test(key)) continue;
      result[key] = value;
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete result[key];
      continue;
    }
    result[key] = value;
  }

  return result;
}

/**
 * Read one variable out of a bundle without reaching for `process.env`.
 *
 * Adapters that need to locate a provider's on-disk state (Claude's
 * `CLAUDE_CONFIG_DIR`, for instance) must read it from the run's bundle, never
 * from the ambient environment — otherwise a listing shows the wrong profile's
 * history.
 */
export function readEnv(env: EnvBundle, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
