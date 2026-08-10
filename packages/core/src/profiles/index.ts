/**
 * Profiles: stored account records, encrypted credentials, and the
 * environment a run executes with.
 *
 * ```ts
 * const store = new ProfileStore({ userDataDir, secrets })
 * const profile = await store.create({ label: 'Work', providerId: 'claude', apiKey })
 * const env = await resolveEnv(profile, secrets, { userDataDir, baseEnv: process.env })
 * // env now has ANTHROPIC_API_KEY and an isolated CLAUDE_CONFIG_DIR
 * ```
 *
 * The only shape from this module that may cross into the renderer is
 * `ProfileMetadata`, produced by {@link toMetadata} / `ProfileStore.describe`.
 */

export * from './errors.js';
export * from './secrets.js';
export * from './env.js';
export * from './store.js';
