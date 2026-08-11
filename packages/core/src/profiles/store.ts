/**
 * Profile persistence.
 *
 * Profiles live in a single JSON document under Artemis's user-data directory:
 *
 * ```
 * <userDataDir>/profiles.json          the records
 * <userDataDir>/profiles/<name>/       config dirs Artemis suggested
 * ```
 *
 * The document contains labels and config-directory paths. It contains no
 * credential and no handle to one — there is no secret store behind this file
 * any more, because the provider's own CLI owns the credential and keeps it
 * inside the config directory. This file is readable plaintext by design and
 * there is nothing in it worth stealing.
 *
 * The second path above is only where Artemis's *suggestions* land. A profile's
 * `configDir` is an absolute path the user chose and may point anywhere —
 * commonly at the `~/.claude` they are already signed in to. Nothing here
 * assumes otherwise, and {@link ProfileStore.delete} is careful about it.
 *
 * `@rx-artemis/core` must not import `electron`, so the store takes its user-data
 * directory as a constructor argument rather than reaching for
 * `app.getPath('userData')`.
 *
 * Every mutation is serialised through an internal lock and committed with a
 * write-to-temp-then-rename, so an interrupted write cannot truncate the file.
 */

import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  isCredentialRoutingEnvKey,
  isProviderId,
  isSecretEnvKey,
  normalizeProfileColor,
} from '@rx-artemis/protocol';
import type {
  Profile,
  ProfileDraft,
  ProfileId,
  ProfileMetadata,
  ProfilePatch,
  ProviderId,
} from '@rx-artemis/protocol';

import { ProfileError } from './errors.js';
import {
  assertConfigDir,
  isArtemisOwnedConfigDir,
  profileConfigDir,
  profilesRoot,
  suggestConfigDir,
  toMetadata,
} from './env.js';

/** File name of the profile document inside the user-data directory. */
export const PROFILE_STORE_FILE = 'profiles.json';

/** Schema version written into the document. */
export const PROFILE_STORE_VERSION = 2;

/**
 * The previous schema, still readable.
 *
 * Version 1 stored `configDirName` — a bare directory name resolved under
 * `<userDataDir>/profiles` — plus `secretRef`, `backend` and `authMode`. It is
 * migrated on read rather than rejected: the directories those names point at
 * hold real logins and real transcripts, and a user whose profiles vanished
 * because Artemis changed its own file format would have no way to tell that
 * their accounts were still there.
 */
const PROFILE_STORE_VERSION_LEGACY = 1;

/** Valid POSIX environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shape of the on-disk document. */
interface PersistedDocument {
  readonly version: number;
  readonly profiles: readonly Profile[];
}

/** Construction options for {@link ProfileStore}. */
export interface ProfileStoreOptions {
  /** Artemis's user-data directory. Injected — core cannot ask Electron for it. */
  readonly userDataDir: string;
  /**
   * Variable names Artemis sets itself, across every registered provider —
   * normally the union of `managedEnvKeys(adapter.credentials)`.
   *
   * Used to reject `publicEnv` entries that would override Artemis's own
   * isolation choices. It is a *denylist*, so the union is the
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
   * Also remove the profile's config directory, discarding its session history.
   * Defaults to false: deleting an account should not silently destroy
   * transcripts.
   *
   * A *request*, not an instruction — see {@link ProfileStore.delete}, which
   * honours it only for a directory Artemis created.
   */
  readonly deleteConfigDir?: boolean;
}

/** Result of {@link ProfileStore.delete}. */
export interface DeleteProfileResult {
  readonly id: ProfileId;
  /** True when a config directory existed, was Artemis's, and was removed. */
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
    this.#managedEnvKeys = options.managedEnvKeys ?? [];
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => randomUUID());
  }

  /** Artemis's user-data directory, as given. */
  get userDataDir(): string {
    return this.#userDataDir;
  }

  /** Absolute path of the profile document. */
  get filePath(): string {
    return this.#file;
  }

  /** Absolute path of `<userDataDir>/profiles`, where suggestions land. */
  get profilesRoot(): string {
    return profilesRoot(this.#userDataDir);
  }

  /** Absolute path of one profile's config directory, re-validated. */
  configDirFor(profile: Profile | string): string {
    return profileConfigDir(profile);
  }

  /**
   * A config-directory path to offer for a profile that does not exist yet.
   *
   * Answers the `profiles:suggest-dir` IPC call. Nothing is created and nothing
   * is reserved; the user may replace it with any directory they like.
   */
  async suggestConfigDir(label: string): Promise<string> {
    return suggestConfigDir(this.#userDataDir, label, await this.#read());
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

  /** Renderer-safe projection of one profile. */
  async describe(profile: Profile | ProfileId): Promise<ProfileMetadata> {
    const resolved = typeof profile === 'string' ? await this.require(profile) : profile;
    return toMetadata(resolved);
  }

  /** Renderer-safe projections of every profile. What `profiles:list` returns. */
  async listMetadata(providerId?: ProviderId): Promise<readonly ProfileMetadata[]> {
    return (await this.list(providerId)).map(toMetadata);
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Create a profile.
   *
   * The profile is created signed *out*. That is the ordinary first state, not
   * an error: signing in happens afterwards, in the user's own terminal,
   * against the directory this record names. `authStatus` is what reports it.
   *
   * Two profiles may legitimately share a `configDir` — that makes them the
   * same account, which is a reasonable thing to want on purpose — so no
   * uniqueness check is imposed here. `suggestConfigDir` avoids the collision
   * for anyone who did not intend one.
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
      const configDir = assertConfigDir(draft.configDir);
      const publicEnv = sanitizePublicEnv(draft.publicEnv ?? {}, this.#managedEnvKeys);

      const existing = await this.#read();
      const timestamp = this.#now();
      const profile: Profile = {
        id: this.#newId(),
        label,
        providerId: draft.providerId,
        configDir,
        publicEnv,
        // An unusable colour is dropped rather than rejected. It decides
        // nothing, so refusing to create the profile over one would fail the
        // request for the one field that does not matter.
        color: normalizeProfileColor(draft.color) ?? undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.#write([...existing, profile]);
      return profile;
    });
  }

  /**
   * Update a profile.
   *
   * Repointing `configDir` changes which account and which history the profile
   * has. The directory it previously named is left entirely alone — it may be
   * another profile's, or the user's own `~/.claude`.
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
        configDir:
          patch.configDir === undefined ? current.configDir : assertConfigDir(patch.configDir),
        publicEnv:
          patch.publicEnv === undefined
            ? current.publicEnv
            : sanitizePublicEnv(patch.publicEnv, this.#managedEnvKeys),
        // Omitted leaves the colour alone; anything that does not normalise —
        // the empty string being the one a caller sends on purpose — removes
        // it. See `ProfilePatch.color`.
        color:
          patch.color === undefined
            ? current.color
            : (normalizeProfileColor(patch.color) ?? undefined),
        updatedAt: this.#now(),
      };

      profiles[index] = next;
      await this.#write(profiles);
      return next;
    });
  }

  /**
   * Delete a profile.
   *
   * The config directory — and therefore the credential and the session
   * history — survives unless `deleteConfigDir` is set **and** the directory is
   * one Artemis created.
   *
   * That second condition is not a formality. `configDir` is an absolute path
   * the user chose, and the most useful thing they can put there is the
   * `~/.claude` their own CLI already uses. Honouring a recursive delete
   * against it because a switch in a profile dialog was left on would destroy
   * the user's real Claude installation, every project transcript in it, and
   * the login for whatever other profiles point at the same place. So Artemis
   * deletes only what Artemis made, and {@link DeleteProfileResult.configDirDeleted}
   * reports honestly when it declined.
   */
  async delete(id: ProfileId, options: DeleteProfileOptions = {}): Promise<DeleteProfileResult> {
    return this.#withLock(async () => {
      const profiles = [...(await this.#read())];
      const index = profiles.findIndex((p) => p.id === id);
      const profile = index < 0 ? undefined : profiles[index];
      if (!profile) throw new ProfileError('invalid_request', `No profile with id "${id}"`);

      // Resolve and check the directory *before* mutating anything, so a record
      // with a malformed `configDir` fails the whole call rather than half of
      // it. This is an `rm -r` against a path from a user-editable JSON file,
      // so it is re-validated here rather than trusted.
      let configDir: string | undefined;
      if (options.deleteConfigDir === true) {
        const resolved = this.configDirFor(profile);
        if (isArtemisOwnedConfigDir(this.#userDataDir, resolved)) configDir = resolved;
      }

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

    this.#cache = parseDocument(parsed, this.#file, this.#userDataDir);
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
 * Validate the non-sensitive environment bundle.
 *
 * Rejects three classes of name, in order of how obvious they are:
 *
 *  1. **Anything that looks like a credential.** `publicEnv` is written to a
 *     plaintext file, so this has to be a hard error rather than a warning.
 *  2. **Anything that decides where a credential is sent.** `ANTHROPIC_BASE_URL`
 *     holds no secret and passes the name heuristic, but it points the provider
 *     at a host of the writer's choosing — and the provider CLI will send the
 *     credential from its config directory there. Accepting one would let
 *     anything that can write a profile redirect a real token off-box. See
 *     {@link isCredentialRoutingEnvKey}.
 *  3. **Anything Artemis manages itself** — the config-directory variable, and
 *     every credential variable that would outrank it.
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
        `${key} looks like a credential. Sign the profile in instead — publicEnv is written to disk in plaintext, and a credential set here would override the login anyway.`,
      );
    }
    if (isCredentialRoutingEnvKey(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} controls where the profile's credential is sent, which Artemis decides rather than the profile. It cannot be set in publicEnv.`,
      );
    }
    if (managedEnvKeys.includes(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} is set by Artemis from the profile's config directory and cannot be overridden in publicEnv`,
      );
    }
    if (typeof value !== 'string') {
      throw new ProfileError('invalid_request', `publicEnv.${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function parseDocument(value: unknown, file: string, userDataDir: string): readonly Profile[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProfileError('unknown', `${file} is not a Artemis profile document`);
  }
  const document = value as { version?: unknown; profiles?: unknown };

  const legacy = document.version === PROFILE_STORE_VERSION_LEGACY;
  if (document.version !== PROFILE_STORE_VERSION && !legacy) {
    throw new ProfileError(
      'unknown',
      `${file} has schema version ${String(document.version)}; this build understands version ${PROFILE_STORE_VERSION}`,
    );
  }
  if (!Array.isArray(document.profiles)) {
    throw new ProfileError('unknown', `${file} has no profiles array`);
  }

  return document.profiles.map((entry, index) => parseProfile(entry, file, index, userDataDir, legacy));
}

function parseProfile(
  value: unknown,
  file: string,
  index: number,
  userDataDir: string,
  legacy: boolean,
): Profile {
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

  /*
    A version-1 record names its directory rather than locating it, so the
    migration is a join against the same root version 1 resolved against. The
    result points at the directory that already exists, which is the whole
    object of the exercise: the user's login and transcripts are in it.

    `secretRef`, `backend` and `authMode` are dropped on the floor. Any secret
    behind that ref stays in the OS credential store, orphaned — deleting it
    from here would mean reaching for a `SecretStore` this class no longer has,
    to destroy a credential the user may still want in their own tooling.
  */
  const configDir = legacy
    ? path.join(
        profilesRoot(userDataDir),
        requireString(raw['configDirName'], `${at} is missing a configDirName`),
      )
    : requireString(raw['configDir'], `${at} is missing a configDir`);

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
    configDir,
    publicEnv,
    // Re-normalised on the way out, not trusted from disk: this file is
    // hand-editable, the value ends up in a `style` attribute, and a record
    // written by an older build predates the field entirely. A colour that
    // does not parse simply is not one.
    color: normalizeProfileColor(raw['color']) ?? undefined,
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
