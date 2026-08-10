/**
 * Profile persistence.
 *
 * Profiles live in a single JSON document under Libra's user-data directory:
 *
 * ```
 * <userDataDir>/profiles.json          the records  (no secrets, ever)
 * <userDataDir>/profiles/<dirName>/    one isolated CLAUDE_CONFIG_DIR each
 * ```
 *
 * The document contains labels, backends, config-directory *names* and
 * `secretRef` handles. It never contains a credential — the value behind a ref
 * lives in whatever {@link SecretStore} the host injected, which in the
 * desktop app is Electron `safeStorage`. That split is the whole point: this
 * file is readable plaintext by design, and there is nothing in it worth
 * stealing.
 *
 * `@libra/core` must not import `electron`, so the store takes its user-data
 * directory and its secret storage as constructor arguments rather than
 * reaching for `app.getPath('userData')`.
 *
 * Every mutation is serialised through an internal lock and committed with a
 * write-to-temp-then-rename, so an interrupted write cannot truncate the file.
 */

import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  isCredentialRoutingEnvKey,
  isProviderAuthMode,
  isProviderBackend,
  isProviderId,
  isSecretEnvKey,
} from '@libra/protocol';
import type {
  Profile,
  ProfileDraft,
  ProfileId,
  ProfileMetadata,
  ProfilePatch,
  ProviderAuthMode,
  ProviderBackend,
  ProviderId,
} from '@libra/protocol';

import { ProfileError } from './errors.js';
import { assertBareDirName, profileConfigDir, profilesRoot, readMetadata } from './env.js';
import type { SecretStore } from './secrets.js';

/** File name of the profile document inside the user-data directory. */
export const PROFILE_STORE_FILE = 'profiles.json';

/** Schema version written into the document. */
export const PROFILE_STORE_VERSION = 1;

/** Valid POSIX environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shape of the on-disk document. */
interface PersistedDocument {
  readonly version: number;
  readonly profiles: readonly Profile[];
}

/** Construction options for {@link ProfileStore}. */
export interface ProfileStoreOptions {
  /** Libra's user-data directory. Injected — core cannot ask Electron for it. */
  readonly userDataDir: string;
  /** Encrypted credential storage supplied by the host process. */
  readonly secrets: SecretStore;
  /**
   * Variable names Libra sets itself, across every registered provider —
   * normally the union of `managedEnvKeys(adapter.credentials)`.
   *
   * Used to reject `publicEnv` entries that would override Libra's own
   * credential and isolation choices. It is a *denylist*, so the union is the
   * right shape: over-rejecting a name one provider manages costs a user
   * nothing, while under-rejecting one silently breaks account isolation.
   *
   * Defaults to empty, which keeps this class provider-agnostic — the store
   * has no way to reach an adapter, and hard-coding one provider's variables
   * here is what made the whole profile model Claude-shaped.
   */
  readonly managedEnvKeys?: readonly string[];
  /** Override the document's file name. Tests only. */
  readonly fileName?: string;
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number;
  /** Id generator, injectable for deterministic tests. */
  readonly newId?: () => ProfileId;
}

/** Options for {@link ProfileStore.delete}. */
export interface DeleteProfileOptions {
  /**
   * Also remove the profile's isolated config directory, discarding its
   * session history. Defaults to false: deleting an account should not
   * silently destroy transcripts.
   */
  readonly deleteConfigDir?: boolean;
}

/** Result of {@link ProfileStore.delete}. */
export interface DeleteProfileResult {
  readonly id: ProfileId;
  /** True when a config directory existed and was removed. */
  readonly configDirDeleted: boolean;
}

/**
 * CRUD over {@link Profile} records.
 *
 * Main-process only. Hand the renderer {@link ProfileMetadata} from
 * {@link listMetadata} or {@link describe} — never a {@link Profile}.
 */
export class ProfileStore {
  readonly #userDataDir: string;
  readonly #file: string;
  readonly #secrets: SecretStore;
  readonly #managedEnvKeys: readonly string[];
  readonly #now: () => number;
  readonly #newId: () => ProfileId;

  /** Parsed document, or null when it has not been read yet. */
  #cache: readonly Profile[] | null = null;
  /** Serialises mutations so two concurrent writes cannot lose one another. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ProfileStoreOptions) {
    if (!options.userDataDir || !path.isAbsolute(options.userDataDir)) {
      throw new ProfileError(
        'invalid_request',
        `userDataDir must be an absolute path, got ${JSON.stringify(options.userDataDir)}`,
      );
    }
    this.#userDataDir = path.resolve(options.userDataDir);
    this.#file = path.join(this.#userDataDir, options.fileName ?? PROFILE_STORE_FILE);
    this.#secrets = options.secrets;
    this.#managedEnvKeys = options.managedEnvKeys ?? [];
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => randomUUID());
  }

  /** Libra's user-data directory, as given. */
  get userDataDir(): string {
    return this.#userDataDir;
  }

  /** Absolute path of the profile document. */
  get filePath(): string {
    return this.#file;
  }

  /** Absolute path of `<userDataDir>/profiles`. */
  get profilesRoot(): string {
    return profilesRoot(this.#userDataDir);
  }

  /** Absolute path of one profile's isolated `CLAUDE_CONFIG_DIR`. */
  configDirFor(profile: Profile | string): string {
    return profileConfigDir(this.#userDataDir, profile);
  }

  /** Drop the in-memory cache so the next read hits disk. */
  reload(): void {
    this.#cache = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  /** Every stored profile, optionally narrowed to one provider. */
  async list(providerId?: ProviderId): Promise<readonly Profile[]> {
    const profiles = await this.#read();
    return providerId === undefined ? profiles : profiles.filter((p) => p.providerId === providerId);
  }

  /** One profile by id, or `undefined`. */
  async get(id: ProfileId): Promise<Profile | undefined> {
    return (await this.#read()).find((p) => p.id === id);
  }

  /**
   * One profile by id.
   *
   * @throws {ProfileError} `invalid_request` when there is no such profile.
   */
  async require(id: ProfileId): Promise<Profile> {
    const profile = await this.get(id);
    if (!profile) throw new ProfileError('invalid_request', `No profile with id "${id}"`);
    return profile;
  }

  /** The plaintext credential behind a profile, or `null`. Main process only. */
  async readSecret(profile: Profile | ProfileId): Promise<string | null> {
    const resolved = typeof profile === 'string' ? await this.require(profile) : profile;
    return this.#secrets.get(resolved.secretRef);
  }

  /** Renderer-safe projection of one profile, with a masked key hint. */
  async describe(profile: Profile | ProfileId): Promise<ProfileMetadata> {
    const resolved = typeof profile === 'string' ? await this.require(profile) : profile;
    return readMetadata(resolved, this.#secrets);
  }

  /**
   * Renderer-safe projections of every profile.
   *
   * This is what the `profiles:list` IPC handler returns. Reading each secret
   * to compute its hint keeps the mask out of the plaintext document; the
   * decryption happens in the main process and the key never leaves it.
   */
  async listMetadata(providerId?: ProviderId): Promise<readonly ProfileMetadata[]> {
    const profiles = await this.list(providerId);
    return Promise.all(profiles.map((profile) => readMetadata(profile, this.#secrets)));
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Create a profile.
   *
   * `draft.apiKey` is the one place a plaintext secret legitimately enters
   * core. It goes straight into the {@link SecretStore} and is not retained.
   *
   * A draft with no key is allowed and produces a profile with
   * `keyHint: null` — the "needs setup" state the protocol models explicitly.
   * The credential is enforced where it matters, in `resolveEnv`, which
   * refuses to start a run for an `anthropic` profile with no key.
   */
  async create(draft: ProfileDraft): Promise<Profile> {
    return this.#withLock(async () => {
      const label = requireLabel(draft.label);
      if (!isProviderId(draft.providerId)) {
        throw new ProfileError(
          'invalid_request',
          `Unknown providerId ${JSON.stringify(draft.providerId)}`,
        );
      }
      // No default. Which backend is "the usual one" is the provider's answer,
      // not this file's — defaulting to `'anthropic'` here is what stamped an
      // Anthropic hosting backend onto profiles for every other provider.
      // Absent means "the provider's first declared backend", resolved when the
      // environment is built.
      const backend = draft.backend === undefined ? undefined : requireBackend(draft.backend);
      // Same reasoning as `backend`: shape only, no default. Which mode is "the
      // usual one" is the provider's answer, and whether the mode is legal on
      // the chosen backend is checked where an adapter is reachable.
      const authMode = draft.authMode === undefined ? undefined : requireAuthMode(draft.authMode);
      const publicEnv = sanitizePublicEnv(draft.publicEnv ?? {}, this.#managedEnvKeys);

      const existing = await this.#read();
      const id = this.#newId();
      const configDirName =
        draft.configDirName === undefined
          ? uniqueConfigDirName(label, id, existing)
          : assertUnusedDirName(draft.configDirName, existing);

      const secretRef = `profile-${id}`;
      const apiKey = draft.apiKey?.trim();
      if (apiKey) await this.#secrets.set(secretRef, apiKey);

      const timestamp = this.#now();
      const profile: Profile = {
        id,
        label,
        providerId: draft.providerId,
        backend,
        authMode,
        configDirName,
        secretRef,
        publicEnv,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      try {
        await this.#write([...existing, profile]);
      } catch (error) {
        // Do not leave an orphaned credential behind a ref nothing points at.
        if (apiKey) await this.#secrets.delete(secretRef).catch(() => undefined);
        throw error;
      }
      return profile;
    });
  }

  /**
   * Update a profile.
   *
   * `patch.apiKey` is tri-state, as the protocol specifies: omit to leave the
   * stored credential alone, pass a string to replace it, pass `null` to
   * delete it.
   */
  async update(id: ProfileId, patch: ProfilePatch): Promise<Profile> {
    return this.#withLock(async () => {
      const profiles = [...(await this.#read())];
      const index = profiles.findIndex((p) => p.id === id);
      const current = index < 0 ? undefined : profiles[index];
      if (!current) throw new ProfileError('invalid_request', `No profile with id "${id}"`);

      const next: Profile = {
        ...current,
        label: patch.label === undefined ? current.label : requireLabel(patch.label),
        backend: patch.backend === undefined ? current.backend : requireBackend(patch.backend),
        authMode:
          patch.authMode === undefined ? current.authMode : requireAuthMode(patch.authMode),
        publicEnv:
          patch.publicEnv === undefined
            ? current.publicEnv
            : sanitizePublicEnv(patch.publicEnv, this.#managedEnvKeys),
        updatedAt: this.#now(),
      };

      if (patch.apiKey === null) {
        await this.#secrets.delete(current.secretRef);
      } else if (patch.apiKey !== undefined) {
        const key = patch.apiKey.trim();
        if (!key) {
          throw new ProfileError(
            'invalid_request',
            'apiKey must not be empty — pass null to remove the stored credential',
          );
        }
        await this.#secrets.set(current.secretRef, key);
      }

      profiles[index] = next;
      await this.#write(profiles);
      return next;
    });
  }

  /**
   * Delete a profile and its stored credential.
   *
   * The config directory — and therefore the session history — survives unless
   * `deleteConfigDir` is set.
   */
  async delete(id: ProfileId, options: DeleteProfileOptions = {}): Promise<DeleteProfileResult> {
    return this.#withLock(async () => {
      const profiles = [...(await this.#read())];
      const index = profiles.findIndex((p) => p.id === id);
      const profile = index < 0 ? undefined : profiles[index];
      if (!profile) throw new ProfileError('invalid_request', `No profile with id "${id}"`);

      // Resolve and validate the directory *before* mutating anything, so a
      // record with a bad `configDirName` fails the whole call rather than
      // half of it. `configDirName` is user-editable JSON and this is an
      // `rm -r`, so it is re-validated here rather than trusted.
      let configDir: string | undefined;
      if (options.deleteConfigDir) {
        configDir = this.configDirFor(profile);
        assertInside(this.profilesRoot, configDir);
      }

      // Remove the credential first. If that fails the record is still there,
      // which is recoverable; the reverse would strand an encrypted secret
      // with nothing pointing at it.
      await this.#secrets.delete(profile.secretRef);

      profiles.splice(index, 1);
      await this.#write(profiles);

      let configDirDeleted = false;
      if (configDir !== undefined) {
        configDirDeleted = await pathExists(configDir);
        await rm(configDir, { recursive: true, force: true });
      }

      return { id, configDirDeleted };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /** Run `fn` after every previously queued mutation, successful or not. */
  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #read(): Promise<readonly Profile[]> {
    if (this.#cache) return this.#cache;

    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        this.#cache = [];
        return this.#cache;
      }
      throw new ProfileError('unknown', `Could not read ${this.#file}: ${describe(error)}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ProfileError(
        'unknown',
        `${this.#file} is not valid JSON. Move it aside to start over: ${describe(error)}`,
        { cause: error },
      );
    }

    this.#cache = parseDocument(parsed, this.#file);
    return this.#cache;
  }

  async #write(profiles: readonly Profile[]): Promise<void> {
    const document: PersistedDocument = { version: PROFILE_STORE_VERSION, profiles };
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const tmp = `${this.#file}.${randomUUID().slice(0, 8)}.tmp`;

    await mkdir(this.#userDataDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tmp, this.#file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw new ProfileError('unknown', `Could not write ${this.#file}: ${describe(error)}`, {
        cause: error,
      });
    }
    this.#cache = profiles;
  }
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Trim and require a non-empty label. */
export function requireLabel(label: string): string {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed) throw new ProfileError('invalid_request', 'A profile needs a non-empty label');
  if (trimmed.length > 120) {
    throw new ProfileError('invalid_request', 'Profile labels are limited to 120 characters');
  }
  return trimmed;
}

/**
 * Shape-check a backend id.
 *
 * Only the shape: whether the selected *provider* offers a backend by this name
 * is checked where an adapter is reachable — `resolveEnv`, against the
 * provider's declared list. The store deliberately has no adapter access, which
 * is what keeps a profile record from being one vendor's shape.
 */
function requireBackend(backend: ProviderBackend): ProviderBackend {
  if (!isProviderBackend(backend)) {
    throw new ProfileError('invalid_request', `Malformed backend ${JSON.stringify(backend)}`);
  }
  return backend;
}

/**
 * Shape-check an auth-mode id.
 *
 * Only the shape, for the same reason as {@link requireBackend}: whether the
 * provider offers a mode by this name — and whether it offers it on the
 * profile's backend, which is the constraint that actually matters for
 * subscription billing — is checked in `resolveEnv`, where the adapter's
 * declared list is reachable.
 */
function requireAuthMode(authMode: ProviderAuthMode): ProviderAuthMode {
  if (!isProviderAuthMode(authMode)) {
    throw new ProfileError(
      'invalid_request',
      `Malformed authentication mode ${JSON.stringify(authMode)}`,
    );
  }
  return authMode;
}

/**
 * Validate the non-sensitive environment bundle.
 *
 * Rejects three classes of name, in order of how obvious they are:
 *
 *  1. **Anything that looks like a credential.** `publicEnv` is written to a
 *     plaintext file, so this has to be a hard error rather than a warning.
 *  2. **Anything that decides where a credential is sent.** `ANTHROPIC_BASE_URL`
 *     holds no secret and passes the name heuristic, but it points the provider
 *     at a host of the writer's choosing — and `resolveEnv` puts the decrypted
 *     key into the very same bundle. Accepting one would let anything that can
 *     write a profile redirect the key off-box without a secret ever crossing
 *     IPC. See {@link isCredentialRoutingEnvKey}.
 *  3. **Anything Libra manages itself**, which the profile's backend decides.
 */
export function sanitizePublicEnv(
  env: Readonly<Record<string, string>>,
  managedEnvKeys: readonly string[] = [],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) {
      throw new ProfileError(
        'invalid_request',
        `${JSON.stringify(key)} is not a valid environment variable name`,
      );
    }
    if (isSecretEnvKey(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} looks like a credential. Store it as the profile's API key — publicEnv is written to disk in plaintext.`,
      );
    }
    if (isCredentialRoutingEnvKey(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} controls where the profile's credential is sent, which Libra decides rather than the profile. It cannot be set in publicEnv.`,
      );
    }
    if (managedEnvKeys.includes(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} is set by Libra from the profile's backend and cannot be overridden in publicEnv`,
      );
    }
    if (typeof value !== 'string') {
      throw new ProfileError('invalid_request', `publicEnv.${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

/** `Work — Bedrock` → `work-bedrock`. */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'profile';
}

/**
 * Derive a config-directory name that is readable *and* unique.
 *
 * The id suffix is what guarantees uniqueness; the slug is there so a user
 * browsing `<userData>/profiles` can tell which directory belongs to which
 * account.
 */
function uniqueConfigDirName(label: string, id: string, existing: readonly Profile[]): string {
  const suffix = id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || randomUUID().slice(0, 8);
  const taken = new Set(existing.map((p) => p.configDirName));
  let candidate = `${slugify(label)}-${suffix}`;
  let counter = 2;
  while (taken.has(candidate)) candidate = `${slugify(label)}-${suffix}-${counter++}`;
  return assertBareDirName(candidate);
}

function assertUnusedDirName(name: string, existing: readonly Profile[]): string {
  const validated = assertBareDirName(name);
  if (existing.some((p) => p.configDirName === validated)) {
    throw new ProfileError(
      'invalid_request',
      `Config directory "${validated}" is already used by another profile`,
    );
  }
  return validated;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function parseDocument(value: unknown, file: string): readonly Profile[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProfileError('unknown', `${file} is not a Libra profile document`);
  }
  const document = value as { version?: unknown; profiles?: unknown };

  if (document.version !== PROFILE_STORE_VERSION) {
    throw new ProfileError(
      'unknown',
      `${file} has schema version ${String(document.version)}; this build understands version ${PROFILE_STORE_VERSION}`,
    );
  }
  if (!Array.isArray(document.profiles)) {
    throw new ProfileError('unknown', `${file} has no profiles array`);
  }

  return document.profiles.map((entry, index) => parseProfile(entry, file, index));
}

function parseProfile(value: unknown, file: string, index: number): Profile {
  if (typeof value !== 'object' || value === null) {
    throw new ProfileError('unknown', `${file}: profile #${index} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const at = `${file}: profile #${index}`;

  const id = requireString(raw['id'], `${at} is missing an id`);
  const label = requireString(raw['label'], `${at} is missing a label`);
  const providerId = raw['providerId'];
  if (!isProviderId(providerId)) {
    throw new ProfileError('unknown', `${at} has an unknown providerId`);
  }
  const configDirName = requireString(raw['configDirName'], `${at} is missing a configDirName`);
  const secretRef = requireString(raw['secretRef'], `${at} is missing a secretRef`);

  const backendRaw: unknown = raw['backend'];
  let backend: ProviderBackend | undefined;
  if (backendRaw !== undefined) {
    if (!isProviderBackend(backendRaw)) {
      throw new ProfileError('unknown', `${at} has an unknown backend`);
    }
    backend = backendRaw;
  }

  // Absent on every profile written before the auth-mode axis existed, which is
  // exactly what "the provider's default mode" means — so old documents load
  // unchanged and keep billing the way they always did.
  const authModeRaw: unknown = raw['authMode'];
  let authMode: ProviderAuthMode | undefined;
  if (authModeRaw !== undefined) {
    if (!isProviderAuthMode(authModeRaw)) {
      throw new ProfileError('unknown', `${at} has an unknown authMode`);
    }
    authMode = authModeRaw;
  }

  const publicEnvRaw = raw['publicEnv'];
  const publicEnv: Record<string, string> = {};
  if (publicEnvRaw !== undefined) {
    if (typeof publicEnvRaw !== 'object' || publicEnvRaw === null || Array.isArray(publicEnvRaw)) {
      throw new ProfileError('unknown', `${at} has a malformed publicEnv`);
    }
    for (const [key, entry] of Object.entries(publicEnvRaw as Record<string, unknown>)) {
      if (typeof entry !== 'string') {
        throw new ProfileError('unknown', `${at} has a non-string publicEnv.${key}`);
      }
      publicEnv[key] = entry;
    }
  }

  const createdAt: unknown = raw['createdAt'];
  const updatedAt: unknown = raw['updatedAt'];

  const profile: Profile = {
    id,
    label,
    providerId,
    backend,
    authMode,
    configDirName,
    secretRef,
    publicEnv,
    createdAt: typeof createdAt === 'number' ? createdAt : undefined,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : undefined,
  };
  return profile;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProfileError('unknown', message);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to touch anything outside `root`.
 *
 * Guards the `rm -r` in {@link ProfileStore.delete}. Equality with `root`
 * counts as outside: deleting the profiles root would take every profile's
 * history with it.
 */
export function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProfileError(
      'invalid_request',
      `Refusing to operate on ${candidate}: it is not inside ${root}`,
    );
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
