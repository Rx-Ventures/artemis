/**
 * Turning a profile into an environment.
 *
 * Two things happen here and nowhere else:
 *
 *  1. The provider's config-directory variable is pointed at the profile's own
 *     directory. Providers that key their state on it — Claude stores both its
 *     credential and its transcripts under `$CLAUDE_CONFIG_DIR` — get an
 *     isolated account *and* isolated history from that one variable.
 *  2. Every variable that could authenticate the provider some *other* way is
 *     removed, so the account a run uses is the one the profile names rather
 *     than whatever the user happens to have exported.
 *
 * Step 2 is the whole security story now, and it is worth being precise about
 * why it survived the deletion of everything around it. This module used to
 * decrypt a stored credential and write it into the one variable the profile's
 * backend and auth mode expected. It no longer holds a credential at all — the
 * provider's own login owns that, scoped to the config directory. But the
 * *stripping* still matters, and matters more: `ANTHROPIC_API_KEY` outranks the
 * config directory's login, so an ambient key would silently beat the account
 * the user signed this profile into and bill them for it. Artemis emits none of
 * these variables and removes all of them.
 *
 * ## Which variable names?
 *
 * The provider's, and this module does not know them. It takes a
 * {@link ProviderCredentialSpec} — declared by the adapter, reached through the
 * registry — and reads the config-directory variable and the strip list out of
 * it. That indirection is what keeps a second provider from being handed
 * Anthropic's vocabulary.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  configDirProblem,
  isCredentialRoutingEnvKey,
  isSecretEnvKey,
} from '@rx-artemis/protocol';
import type { Profile, ProfileMetadata } from '@rx-artemis/protocol';

import { managedEnvKeys } from '../adapters/types.js';
import type { ProviderCredentialSpec } from '../adapters/types.js';
import { ProfileError } from './errors.js';

/** Directory under the user-data dir that holds config dirs Artemis creates. */
export const PROFILES_DIR_NAME = 'profiles';

/**
 * Variables Artemis sets itself for this provider, as a set.
 *
 * Managed variables are stripped from the inherited environment and rejected in
 * `publicEnv`, so a profile's account is decided by the profile and by nothing
 * else. In particular this is what stops an `ANTHROPIC_API_KEY` sitting in the
 * user's shell from silently overriding the profile they selected — a bug that
 * would look like "account switching does not work".
 */
function managedEnvKeySet(spec: ProviderCredentialSpec): ReadonlySet<string> {
  return new Set(managedEnvKeys(spec));
}

/**
 * Validate a {@link Profile.configDir} and return it normalized.
 *
 * A profile record is JSON on disk and a user can edit it, so this runs on
 * every use rather than only on the way in. The rules themselves live in
 * protocol's {@link configDirProblem} so that the editor can apply exactly the
 * same ones while the user is still typing, instead of discovering the refusal
 * on submit.
 *
 * @throws {ProfileError} when the path cannot be used as a config directory.
 */
export function assertConfigDir(value: string): string {
  const problem = configDirProblem(value);
  if (problem !== null) {
    throw new ProfileError('invalid_request', `"${value}" cannot be used as a config directory: ${problem}`);
  }
  return path.resolve(value.trim());
}

/**
 * Absolute path of a profile's config directory.
 *
 * @throws {ProfileError} when the stored path is malformed.
 */
export function profileConfigDir(profile: Profile | string): string {
  return assertConfigDir(typeof profile === 'string' ? profile : profile.configDir);
}

/** Absolute path of the directory holding config dirs Artemis creates itself. */
export function profilesRoot(userDataDir: string): string {
  return path.join(path.resolve(userDataDir), PROFILES_DIR_NAME);
}

/**
 * Is this config directory one Artemis created, rather than one the user
 * pointed at?
 *
 * The single question that decides whether "delete this profile's directory"
 * is a cleanup or a catastrophe. A profile may legitimately name the user's own
 * `~/.claude`, another profile's directory, or a folder full of unrelated
 * things; recursively deleting any of those on the strength of a checkbox in a
 * profile dialog is not a risk worth taking for the convenience it buys.
 *
 * Compared on resolved paths with a trailing separator, so `/a/profiles-other`
 * is not read as being inside `/a/profiles`.
 */
export function isArtemisOwnedConfigDir(userDataDir: string, configDir: string): boolean {
  const root = profilesRoot(userDataDir);
  const resolved = path.resolve(configDir);
  if (resolved === root) return false;
  return resolved.startsWith(root + path.sep);
}

/** Turn a label into something that reads well as a directory name. */
function slugify(label: string): string {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug.length > 0 ? slug : 'profile';
}

/**
 * Propose a config directory for a profile that does not exist yet.
 *
 * A *suggestion*: nothing is created and nothing is reserved. The user is free
 * to replace it — pointing at an existing `~/.claude` is the main reason the
 * field accepts a full path at all — so this only has to be a good default and
 * not a decision.
 *
 * Named after the label so the path is recognisable in a terminal later, and
 * de-duplicated against directories other profiles already use, because two
 * profiles sharing a directory share an account and that should be something a
 * user chooses rather than something a slug collision does to them.
 */
export function suggestConfigDir(
  userDataDir: string,
  label: string,
  existing: readonly Profile[] = [],
): string {
  const root = profilesRoot(userDataDir);
  const taken = new Set(existing.map((profile) => path.resolve(profile.configDir)));
  const base = slugify(label);

  let candidate = path.join(root, base);
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = path.join(root, `${base}-${n}`);
  }
  return candidate;
}

/**
 * Project a {@link Profile} down to the shape that crosses IPC.
 *
 * Drops `publicEnv` and nothing else. There is no longer a credential to mask
 * or withhold, which is why this is a plain field selection rather than the
 * careful redaction it used to be.
 */
export function toMetadata(profile: Profile): ProfileMetadata {
  return {
    id: profile.id,
    label: profile.label,
    providerId: profile.providerId,
    configDir: profile.configDir,
    color: profile.color,
    planId: profile.planId,
    // Both carried: the renderer owns every surface these decide — the picker
    // that hides a disabled account, and the Recommended row that skips one
    // outside the pool.
    autoSelect: profile.autoSelect,
    disabled: profile.disabled,
  };
}

/** Options for {@link resolveEnv}. */
export interface ResolveEnvOptions {
  /**
   * The provider's environment vocabulary — normally
   * `providers.require(input.providerId).credentials`.
   *
   * Required, and deliberately not defaulted to Claude's: a default here would
   * silently hand the next provider an Anthropic-shaped environment, which is
   * the defect this parameter exists to make impossible.
   */
  readonly credentials: ProviderCredentialSpec;
  /**
   * Environment to start from — normally `process.env`. Variables the provider
   * manages ({@link managedEnvKeys}) are stripped from it, so a credential in
   * the user's shell can never shadow the selected profile.
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
  /** The provider's vocabulary, for its config-directory variable. */
  readonly credentials: ProviderCredentialSpec;
  /**
   * Create the profile's config directory if it does not exist. Defaults to
   * **false** — the opposite of {@link resolveEnv}, because this is the read
   * path and reading history should not create anything.
   */
  readonly ensureConfigDir?: boolean;
}

/**
 * Locate a profile's provider state, without building a full run environment.
 *
 * {@link resolveEnv} answers "what does a *run* need?". Listing session history
 * is a narrower question: it needs the profile's config directory and nothing
 * else — that directory is what locates `projects/<encoded-cwd>/*.jsonl`.
 *
 * A profile that has never been signed in still has history to show if its
 * directory holds any, so this deliberately asks nothing about login state.
 *
 * @throws {ProfileError} `invalid_request` for a malformed `configDir`.
 */
export async function resolveStoreEnv(
  profile: Profile,
  options: ResolveStoreEnvOptions,
): Promise<Record<string, string>> {
  const configDir = profileConfigDir(profile);
  if (options.ensureConfigDir === true) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
  }
  return { [options.credentials.configDirVar]: configDir };
}

/**
 * Build the environment a run executes with.
 *
 * Precedence, lowest to highest:
 *
 *  1. `baseEnv`, minus every managed key.
 *  2. `profile.publicEnv`, minus every managed key, anything that looks like a
 *     credential, and anything that decides where a credential is sent. A
 *     hand-edited profile file cannot smuggle a token in through the "extra env
 *     vars" box, nor point the CLI's own credential at another host.
 *  3. The provider's config-directory variable.
 *
 * Step 3 is the only variable Artemis sets, and it comes from
 * `options.credentials`. For Claude that resolves to `CLAUDE_CONFIG_DIR`, but
 * nothing in this function knows that.
 *
 * ## Which account, and therefore which bill
 *
 * The config directory decides, because the credential lives inside it. What
 * this function contributes is the guarantee that *nothing else* gets a vote:
 * every credential variable the provider would accept is removed, unset, on
 * every run. With `ANTHROPIC_API_KEY` inherited from the user's shell, a
 * profile signed into a Max plan would bill metered API usage instead — the
 * variable wins over the directory — so its absence is enforced here rather
 * than assumed from the fact that Artemis never writes it.
 *
 * @throws {ProfileError} `invalid_request` for a malformed `configDir`.
 */
export async function resolveEnv(
  profile: Profile,
  options: ResolveEnvOptions,
): Promise<Record<string, string>> {
  const credentials = options.credentials;
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
    // check matters most — the provider CLI sends a real credential to
    // whatever endpoint it is aimed at, and a `publicEnv` that survived to
    // this point could otherwise aim it.
    if (managed.has(key) || isSecretEnvKey(key) || isCredentialRoutingEnvKey(key)) continue;
    env[key] = value;
  }

  const configDir = profileConfigDir(profile);
  if (options.ensureConfigDir !== false) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
  }
  env[credentials.configDirVar] = configDir;

  return env;
}
