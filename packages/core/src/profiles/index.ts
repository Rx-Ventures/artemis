/**
 * Profiles: stored account records and the environment a run executes with.
 *
 * ```ts
 * const store = new ProfileStore({ userDataDir })
 * const configDir = await store.suggestConfigDir('Work')
 * const profile = await store.create({ label: 'Work', providerId: 'claude', configDir })
 * const env = await resolveEnv(profile, { credentials, baseEnv: process.env })
 * // env has an isolated CLAUDE_CONFIG_DIR, and nothing provider-flavoured
 * // survived from the shell: credentials, ANTHROPIC_BASE_URL, the
 * // CLAUDE_CODE_USE_* backend switches — the provider's entire namespace is
 * // dropped from baseEnv, because this bundle outranks the adapter's own
 * // host-env scrub. PATH, HOME and the rest pass through.
 * ```
 *
 * There is no secret store here. The profile names a config directory, the
 * provider's own CLI login puts a credential inside it, and Artemis's part is to
 * set one variable and read a boolean back — see `checkAuthStatus`.
 *
 * The only shape from this module that may cross into the renderer is
 * `ProfileMetadata`, produced by {@link toMetadata} / `ProfileStore.describe`.
 */

export * from './errors.js';
export * from './env.js';
export * from './store.js';
