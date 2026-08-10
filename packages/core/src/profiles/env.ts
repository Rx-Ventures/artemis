/**
 * Turning a profile into an environment.
 *
 * A profile is a named environment-variable bundle, and this module is where
 * it becomes one. Three things happen here and nowhere else:
 *
 *  1. The credential is read out of encrypted storage and placed in the one
 *     variable the profile's selected backend and auth mode expect — and every
 *     competing credential variable is removed, so the run is billed the way
 *     the profile says rather than the way the ambient environment implies.
 *  2. The provider's config-directory variable is pointed at the profile's own
 *     directory. Providers that key their session store on it — Claude stores
 *     transcripts under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/*.jsonl` —
 *     get isolated credentials *and* isolated history from that one variable.
 *  3. The renderer-safe projection of a profile is produced, with a masked
 *     key hint that cannot be turned back into a key.
 *
 * ## Which variable names?
 *
 * The provider's, and this module does not know them. It takes a
 * {@link ProviderCredentialSpec} — declared by the adapter, reached through the
 * registry — and reads the key variable, the config-directory variable and the
 * backend flags out of it.
 *
 * That indirection is the whole point. This function is the single channel
 * through which a credential reaches any provider, and it used to write
 * `ANTHROPIC_API_KEY` unconditionally while never once looking at
 * `profile.providerId`. Any second adapter would have received an OpenAI or
 * OpenCode credential under Anthropic's variable name and been left to either
 * re-map it internally or change this file — which is exactly the coupling the
 * seam exists to prevent.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { isCredentialRoutingEnvKey, isSecretEnvKey, maskApiKey } from '@apollo/protocol';
import type { Profile, ProfileMetadata, ProviderAuthMode, ProviderBackend } from '@apollo/protocol';

import { defaultAuthMode, managedEnvKeys } from '../adapters/types.js';
import type {
  ProviderAuthModeSpec,
  ProviderBackendSpec,
  ProviderCredentialSpec,
} from '../adapters/types.js';
import { ProfileError } from './errors.js';
import type { SecretStore } from './secrets.js';

/** Directory under the user-data dir that holds every profile's config dir. */
export const PROFILES_DIR_NAME = 'profiles';

/**
 * Variables Apollo sets itself for this provider, as a set.
 *
 * Managed variables are stripped from the inherited environment and rejected in
 * `publicEnv`, so a profile's credentials are decided by the profile and by
 * nothing else. In particular this is what stops an `ANTHROPIC_API_KEY` sitting
 * in the user's shell from silently overriding the profile they selected — a
 * bug that would look like "account switching does not work".
 */
function managedEnvKeySet(spec: ProviderCredentialSpec): ReadonlySet<string> {
  return new Set(managedEnvKeys(spec));
}

/** Bare directory names only: no separators, no traversal, no surprises. */
const BARE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate a {@link Profile.configDirName}.
 *
 * A profile record is JSON on disk and a user can edit it. If a hand-edited
 * `configDirName` of `../../..` were joined onto the user-data dir, "delete
 * this profile's config directory" would delete something else entirely. So
 * the name is validated every time it is used, not just when it is written.
 *
 * @throws {ProfileError} when the name is not a plain directory name.
 */
export function assertBareDirName(name: string): string {
  if (!BARE_DIR_NAME.test(name) || name === '.' || name === '..') {
    throw new ProfileError(
      'invalid_request',
      `"${name}" is not a valid profile directory name: it must be a bare name made of letters, digits, dot, dash or underscore`,
    );
  }
  return name;
}

/**
 * Absolute path of a profile's isolated Claude config directory:
 * `<userDataDir>/profiles/<configDirName>`.
 *
 * @throws {ProfileError} when `configDirName` is not a bare directory name.
 */
export function profileConfigDir(userDataDir: string, profile: Profile | string): string {
  const name = typeof profile === 'string' ? profile : profile.configDirName;
  return path.join(path.resolve(userDataDir), PROFILES_DIR_NAME, assertBareDirName(name));
}

/** Absolute path of the directory holding every profile's config directory. */
export function profilesRoot(userDataDir: string): string {
  return path.join(path.resolve(userDataDir), PROFILES_DIR_NAME);
}

/**
 * Vendor prefixes such as `sk-ant-` are a *label*, not key material — they say
 * which kind of credential you are looking at and nothing about its value.
 * Anything else at the front of a key is entropy and must stay hidden.
 */
const VENDOR_PREFIX = /^[A-Za-z]{2,8}-[A-Za-z]{2,8}-/;

/**
 * Mask a credential for display.
 *
 * Delegates to the protocol's {@link maskApiKey} so the hint format is defined
 * in exactly one place (`sk-ant-...4f2a`), then tightens it: when the key has
 * no recognisable vendor prefix, `maskApiKey` falls back to showing the first
 * three characters, and those *are* key material. Apollo's rule is stricter —
 * nothing beyond a vendor label and the last four characters is ever revealed.
 *
 * Never throws. Empty, whitespace-only, absent and very short secrets all
 * collapse to a fixed placeholder rather than leaking a high proportion of
 * their characters.
 */
export function maskSecretHint(secret: string | null | undefined): string | null {
  const hint = maskApiKey(secret);
  if (hint === null) return null;

  // `secret` is necessarily a non-empty string here: maskApiKey returned a hint.
  const trimmed = (secret ?? '').trim();
  if (VENDOR_PREFIX.test(trimmed)) return hint;

  // No vendor label to show. Reveal at most the trailing four characters.
  if (trimmed.length <= 8) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Project a {@link Profile} down to the only shape allowed across IPC.
 *
 * Drops `secretRef`, `configDirName` and `publicEnv`: the renderer has no use
 * for a storage handle, a filesystem location or an env bundle, and each is a
 * leak waiting to happen.
 *
 * @param profile the stored profile
 * @param secret  the plaintext credential, when the caller already has it.
 *                Omit (or pass `null`) for a profile with no credential —
 *                `keyHint` becomes `null` and the UI shows it as needing setup.
 */
export function toMetadata(profile: Profile, secret?: string | null): ProfileMetadata {
  return {
    id: profile.id,
    label: profile.label,
    providerId: profile.providerId,
    backend: profile.backend,
    // The mode id is not a secret, and the renderer needs it: "is this profile
    // spending API credit or my subscription allowance?" must be answerable by
    // looking at the profile rather than by starting a run.
    authMode: profile.authMode,
    keyHint: maskSecretHint(secret),
  };
}

/**
 * Read the credential behind a profile and project it to
 * {@link ProfileMetadata}. Convenience over {@link toMetadata} for callers
 * that hold a {@link SecretStore} rather than a plaintext key.
 *
 * **Describing a profile never depends on its secret being readable.** The key
 * is wanted here for one cosmetic reason — the masked hint — so a store that
 * cannot produce it degrades that profile to `keyHint: null` rather than
 * failing. Without this, an OS keyring that is missing, locked, or holding an
 * entry from another machine takes out the entire profile list (they are read
 * through one `Promise.all`), leaving the user with an empty profile selector
 * and no way to reach the editor that would fix it. `keyHint: null` is already
 * the protocol's "needs setup" state, and re-entering the key is the correct
 * remedy for every one of those cases.
 *
 * The credential is still enforced where it matters: `resolveEnv` throws on
 * the run path, loudly, when a profile that needs a key does not have one.
 */
export async function readMetadata(profile: Profile, secrets: SecretStore): Promise<ProfileMetadata> {
  let secret: string | null = null;
  try {
    secret = await secrets.get(profile.secretRef);
  } catch {
    secret = null;
  }
  return toMetadata(profile, secret);
}

/** Options for {@link resolveEnv}. */
export interface ResolveEnvOptions {
  /** Apollo's user-data directory. The config directory is resolved under it. */
  readonly userDataDir: string;
  /**
   * The provider's credential vocabulary — normally
   * `providers.require(input.providerId).credentials`.
   *
   * Required, and deliberately not defaulted to Claude's: a default here would
   * silently hand the next provider an Anthropic-shaped environment, which is
   * the defect this parameter exists to make impossible.
   */
  readonly credentials: ProviderCredentialSpec;
  /**
   * Environment to start from — normally `process.env`. Variables the provider
   * manages ({@link managedEnvKeys}) are stripped from it, so an API key in the
   * user's shell can never shadow the selected profile.
   *
   * Defaults to `{}`: an empty bundle, which is the conservative choice for a
   * library. The host process decides how much of its own environment the
   * agent inherits.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Create the profile's config directory if it does not exist. Defaults to
   * true — the provider will not create it itself, and a missing directory
   * means a silently non-isolated session store.
   */
  readonly ensureConfigDir?: boolean;
}

/** Options for {@link resolveStoreEnv}. */
export interface ResolveStoreEnvOptions {
  /** Apollo's user-data directory. The config directory is resolved under it. */
  readonly userDataDir: string;
  /** The provider's credential vocabulary, for its config-directory variable. */
  readonly credentials: ProviderCredentialSpec;
  /**
   * Create the profile's config directory if it does not exist. Defaults to
   * **false** — the opposite of {@link resolveEnv}, because this is the read
   * path and reading history should not create anything.
   */
  readonly ensureConfigDir?: boolean;
}

/**
 * Locate a profile's provider state, without touching its credential.
 *
 * {@link resolveEnv} answers "what does a *run* need?" and therefore refuses to
 * proceed when a key-requiring backend has no key. Listing session history is a
 * different question: it needs the profile's isolated config directory and
 * nothing else — that directory is what locates
 * `projects/<encoded-cwd>/*.jsonl` — so routing it through `resolveEnv` made a
 * read-only query fail with an `auth` error, in a state the protocol models
 * deliberately (`keyHint: null`, "the UI should show it as needing setup").
 *
 * A profile can hold real history and no key at all: removing a credential
 * (`ProfilePatch.apiKey: null`) leaves the config directory untouched. Such a
 * profile should show its transcripts, not `Could not read history: Profile "X"
 * has no API key stored`.
 *
 * @throws {ProfileError} `invalid_request` for a malformed `configDirName`.
 */
export async function resolveStoreEnv(
  profile: Profile,
  options: ResolveStoreEnvOptions,
): Promise<Record<string, string>> {
  const configDir = profileConfigDir(options.userDataDir, profile);
  if (options.ensureConfigDir === true) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
  }
  return { [options.credentials.configDirVar]: configDir };
}

/**
 * Resolve the profile's backend against the provider's declared list.
 *
 * This is the authoritative check the protocol's `isProviderBackend` cannot
 * make: it validates the *shape* of a backend id, this validates that the
 * selected provider actually offers one by that name.
 *
 * @throws {ProfileError} `invalid_request` when the provider has no such
 *         backend, naming the ones it does have.
 */
function resolveBackend(
  profile: Profile,
  credentials: ProviderCredentialSpec,
): ProviderBackendSpec {
  const requested: ProviderBackend | undefined = profile.backend;
  const backends = credentials.backends;

  const fallback = backends[0];
  if (requested === undefined) {
    if (fallback === undefined) {
      throw new ProfileError(
        'invalid_request',
        `Provider "${profile.providerId}" declares no backends, so profile "${profile.label}" cannot be resolved.`,
      );
    }
    return fallback;
  }

  const match = backends.find((backend) => backend.id === requested);
  if (match === undefined) {
    throw new ProfileError(
      'invalid_request',
      `Profile "${profile.label}" selects backend ${JSON.stringify(requested)}, which provider "${profile.providerId}" does not offer. Available: ${backends.map((b) => b.id).join(', ') || 'none'}.`,
    );
  }
  return match;
}

/** True when `mode` is offered on `backendId`. An unrestricted mode is on all. */
function authModeSupportsBackend(mode: ProviderAuthModeSpec, backendId: string): boolean {
  return mode.backends === undefined || mode.backends.includes(backendId);
}

/**
 * Resolve the profile's auth mode against the provider's declared list, and
 * against the backend it is being used with.
 *
 * Two failures are possible and they mean different things, so they say
 * different things:
 *
 *  - the provider has no mode by that name — a hand-edited or stale profile.
 *  - the provider has it, but not on this backend. This is the real constraint:
 *    Claude's subscription billing exists only on the first-party Anthropic
 *    API, so `{ backend: 'bedrock', authMode: 'subscription' }` is not an
 *    unsupported combination but a contradictory one. Silently falling back to
 *    an API key would be the worst possible resolution — it would bill an
 *    account the user did not choose, which is the entire class of bug this
 *    axis exists to prevent.
 *
 * @throws {ProfileError} `invalid_request` for either case.
 */
function resolveAuthMode(
  profile: Profile,
  credentials: ProviderCredentialSpec,
  backend: ProviderBackendSpec,
): ProviderAuthModeSpec {
  const requested: ProviderAuthMode | undefined = profile.authMode;
  const modes = credentials.authModes;

  if (modes.length === 0) {
    // A provider with one implicit way of authenticating. Naming a mode on such
    // a profile is a mistake worth reporting rather than ignoring.
    if (requested !== undefined) {
      throw new ProfileError(
        'invalid_request',
        `Profile "${profile.label}" selects authentication mode ${JSON.stringify(requested)}, but provider "${profile.providerId}" offers no choice of authentication mode.`,
      );
    }
    return defaultAuthMode(credentials);
  }

  if (requested === undefined) {
    // The first mode the provider declares that is actually usable on this
    // backend. Order is the adapter's statement of what the default is.
    const fallback = modes.find((mode) => authModeSupportsBackend(mode, backend.id));
    if (fallback === undefined) {
      throw new ProfileError(
        'invalid_request',
        `Provider "${profile.providerId}" declares no authentication mode valid on backend "${backend.id}", so profile "${profile.label}" cannot be resolved.`,
      );
    }
    return fallback;
  }

  const match = modes.find((mode) => mode.id === requested);
  if (match === undefined) {
    throw new ProfileError(
      'invalid_request',
      `Profile "${profile.label}" selects authentication mode ${JSON.stringify(requested)}, which provider "${profile.providerId}" does not offer. Available: ${modes.map((m) => m.id).join(', ') || 'none'}.`,
    );
  }

  if (!authModeSupportsBackend(match, backend.id)) {
    throw new ProfileError(
      'invalid_request',
      `Profile "${profile.label}" selects authentication mode ${JSON.stringify(match.id)} on backend ${JSON.stringify(backend.id)}, which does not support it. ${match.label} is available on: ${(match.backends ?? []).join(', ') || 'no backend'}.`,
    );
  }

  return match;
}

/**
 * Every credential variable this provider knows about *except* the selected
 * mode's.
 *
 * These are deleted from the resolved environment immediately before the
 * credential is written. `managedEnvKeys` has already kept them out of
 * `baseEnv` and `publicEnv`, so in practice this removes nothing — which is the
 * point of doing it anyway. The guarantee being defended is narrow and
 * expensive to get wrong: with both `ANTHROPIC_API_KEY` and
 * `CLAUDE_CODE_OAUTH_TOKEN` set, the API key wins and the user is billed for
 * metered usage instead of their subscription. One future caller passing a
 * `baseEnv` that was filtered somewhere else is all it would take, so the
 * absence is enforced here rather than inferred from two other functions.
 */
function competingSecretEnvVars(
  credentials: ProviderCredentialSpec,
  selected: ProviderAuthModeSpec,
): readonly string[] {
  const all = new Set<string>([
    credentials.apiKeyVar,
    // Modes that store no secret contribute no variable; the rest are still
    // stripped so ambient shell state cannot override a CLI-owned login.
    ...credentials.authModes.flatMap((mode) =>
      mode.secretEnvVar === undefined ? [] : [mode.secretEnvVar],
    ),
  ]);
  // The selected mode's own variable is the one we intend to set, so it is not
  // stripped. A mode that stores no secret has none to spare — every credential
  // variable stays in the strip list, which is exactly what lets the provider
  // CLI's own login win.
  if (selected.secretEnvVar !== undefined) all.delete(selected.secretEnvVar);
  return [...all];
}

/**
 * Build the environment a run executes with.
 *
 * Precedence, lowest to highest:
 *
 *  1. `baseEnv`, minus every managed key.
 *  2. `profile.publicEnv`, minus every managed key, anything that looks like a
 *     credential, and anything that decides where a credential is sent. A
 *     hand-edited profile file cannot smuggle an API key in through the "extra
 *     env vars" box, nor point the one Apollo decrypts at another host.
 *  3. The backend selection and the credential, in the variable the profile's
 *     **auth mode** names — with every competing credential variable removed
 *     first.
 *  4. The provider's config-directory variable.
 *
 * Steps 3 and 4 come entirely from `options.credentials`. For Claude that
 * resolves to `ANTHROPIC_API_KEY` *or* `CLAUDE_CODE_OAUTH_TOKEN`, plus
 * `CLAUDE_CODE_USE_*` and `CLAUDE_CONFIG_DIR`, but nothing in this function
 * knows that.
 *
 * ## Which credential, and therefore which bill
 *
 * The auth mode is the axis that decides what the run costs. For Claude,
 * `api-key` bills metered API usage and `subscription` bills a Pro/Max/Team
 * plan. The two are not interchangeable and they are not additive: with both
 * variables set the API key wins. So this function emits exactly one credential
 * variable and actively removes the others — the profile decides the billing
 * arrangement, and the ambient environment gets no vote. That is the whole
 * reason the mode lives on the profile instead of being sniffed from whatever
 * the provider finds set.
 *
 * A backend whose `requiresApiKey` is false authenticates from an ambient
 * credential chain, so nothing is read for it even if a secret happens to be
 * stored. Region and project settings belong in `publicEnv` (`AWS_REGION`,
 * `ANTHROPIC_VERTEX_PROJECT_ID`, …); endpoint and proxy settings do not — see
 * {@link isCredentialRoutingEnvKey}.
 *
 * @throws {ProfileError} `auth` when a backend and mode that need a credential
 *         have none stored.
 * @throws {ProfileError} `invalid_request` for a backend the provider does not
 *         offer, an auth mode it does not offer or does not support on that
 *         backend, or a malformed `configDirName`.
 */
export async function resolveEnv(
  profile: Profile,
  secrets: SecretStore,
  options: ResolveEnvOptions,
): Promise<Record<string, string>> {
  const credentials = options.credentials;
  const backend = resolveBackend(profile, credentials);
  const authMode = resolveAuthMode(profile, credentials, backend);
  const managed = managedEnvKeySet(credentials);

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(options.baseEnv ?? {})) {
    if (value === undefined) continue;
    if (managed.has(key)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(profile.publicEnv ?? {})) {
    // Defence in depth: the profile store rejects these on write, but a
    // profile file is JSON on disk and can be edited by hand. The routing
    // check matters most here — the decrypted credential is written into this
    // same object a few lines below, so a `publicEnv` that survived to this
    // point could otherwise choose the host it is sent to.
    if (managed.has(key) || isSecretEnvKey(key) || isCredentialRoutingEnvKey(key)) continue;
    env[key] = value;
  }

  // Remove every *other* credential variable before writing ours, so the
  // provider cannot see two and pick the one the profile did not choose.
  for (const key of competingSecretEnvVars(credentials, authMode)) delete env[key];

  /*
    A mode with no `secretEnvVar` owns no credential Apollo can emit.

    That is not a gap — it is the mode working. The provider CLI holds its own
    login, scoped to the `CLAUDE_CONFIG_DIR` set above, so the correct action
    here is to write *nothing* and let that login answer. Writing a variable
    would actively break it: an explicitly-set credential outranks whatever the
    config directory holds, so a stale value would silently beat a good login.
  */
  if (backend.requiresApiKey && authMode.requiresSecret && authMode.secretEnvVar !== undefined) {
    const secret = (await secrets.get(profile.secretRef))?.trim();
    if (!secret) {
      const howTo = authMode.secretHowTo === undefined ? '' : ` ${authMode.secretHowTo}`;
      throw new ProfileError(
        'auth',
        `Profile "${profile.label}" has no credential stored for its "${authMode.label}" authentication mode. Add one in profile settings.${howTo}`,
      );
    }
    env[authMode.secretEnvVar] = secret;
  }

  if (backend.envFlag !== null) env[backend.envFlag] = '1';

  const configDir = profileConfigDir(options.userDataDir, profile);
  if (options.ensureConfigDir !== false) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
  }
  env[credentials.configDirVar] = configDir;

  return env;
}
