/**
 * Encrypted credential storage.
 *
 * Every credential Libra holds is one the user obtained and pasted in — an API
 * key, or a subscription token their own CLI printed. There is no OAuth flow
 * here and there never will be: nothing in this file mints, refreshes or
 * negotiates a credential, it only encrypts one. That makes it the whole of the
 * app's credential handling: a profile's secret is written here once, read only
 * in the main process when a run is starting, and never leaves.
 *
 * Which *variable* a secret is later emitted as is the profile's auth mode, and
 * that decision lives in `@libra/core`'s `resolveEnv`. This file stores an
 * opaque string and has no opinion about what kind of credential it is.
 *
 * ### Where the ciphertext lives
 *
 * One JSON file under `app.getPath('userData')`, mapping a profile's
 * `secretRef` to a base64 blob produced by Electron's `safeStorage`. On macOS
 * that means the Keychain, on Windows DPAPI, on Linux the session keyring
 * (gnome-libsecret / kwallet). The file itself is written `0600` inside a `0700`
 * directory, and every write is atomic (temp file + `fsync` + `rename`) so a
 * crash mid-write cannot corrupt the store.
 *
 * ### When encryption is not available
 *
 * `safeStorage.isEncryptionAvailable()` can return false — a Linux box with no
 * keyring daemon is the common case. Electron offers
 * `safeStorage.setUsePlainTextEncryption(true)` to make the API "work" anyway;
 * it stores credentials in something barely better than plaintext.
 *
 * **Libra never calls it.** The store reports itself unusable, the failure is
 * surfaced to the user with an actionable message, and profile writes fail
 * loudly. Silently degrading to plaintext would mean a user believes their key
 * is encrypted when it is not, which is worse than not storing it at all.
 *
 * The same reasoning applies to Linux's `basic_text` backend: `safeStorage`
 * reports it as a backend, but it is obfuscation rather than encryption, so
 * this module treats it as unavailable.
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

import { SecretStoreUnavailableError } from './errors.js';
import { createLogger } from './log.js';

const log = createLogger('secrets');

/**
 * Main-process credential storage.
 *
 * Deliberately keyed by an opaque `secretRef` rather than by profile id: the
 * ref is a handle stored *on* the profile record, so rotating a credential or
 * moving a profile between backends never has to touch this file's key space.
 *
 * This interface is what the main process hands to `@libra/core` — core builds
 * the agent's env bundle by reading through it and never sees the file, the
 * encryption backend, or anything else Electron-shaped.
 */
export interface SecretStore {
  /* -- the three methods `@libra/core`'s `SecretStore` seam requires -------- */

  /** Store `secret` under `ref`, replacing any previous value. */
  set(ref: string, secret: string): Promise<void>;
  /** Read the secret behind `ref`. Resolves `null` for an unknown ref. */
  get(ref: string): Promise<string | null>;
  /** Remove the secret behind `ref`. Idempotent. */
  delete(ref: string): Promise<void>;

  /* -- main-process extras, used by the IPC layer and startup diagnostics --- */

  /** False when credentials cannot be stored safely on this machine. */
  isAvailable(): boolean;
  /** Why the store is unusable, when {@link isAvailable} is false. */
  unavailableReason(): string | null;
  /** True when the ref currently holds a credential. */
  has(ref: string): Promise<boolean>;
  /** Every ref with a stored value. Refs only — never values. */
  listRefs(): Promise<readonly string[]>;
  /** Mint a fresh, unguessable ref. */
  mintRef(prefix?: string): string;
}

/** Result of probing the platform's encryption backend. */
export interface EncryptionProbe {
  readonly available: boolean;
  /** Linux keyring backend, when the platform reports one. */
  readonly backend?: string;
  /** User-facing explanation. Present whenever `available` is false. */
  readonly detail?: string;
}

/**
 * Ask the platform whether it can encrypt.
 *
 * Must be called after `app.whenReady()` — on Linux, `safeStorage` needs the
 * app's keyring integration to be up before it can answer.
 */
export function probeEncryption(): EncryptionProbe {
  let available: boolean;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch (error) {
    log.error('safeStorage.isEncryptionAvailable() threw', error);
    return { available: false, detail: 'The operating system credential store could not be reached.' };
  }

  if (process.platform !== 'linux') {
    return available
      ? { available: true }
      : {
          available: false,
          detail:
            process.platform === 'darwin'
              ? 'macOS Keychain is not available to Libra. Unlock your login keychain and restart the app.'
              : 'Windows DPAPI is not available to Libra. Sign in to your Windows user account and restart the app.',
        };
  }

  let backend = 'unknown';
  try {
    backend = safeStorage.getSelectedStorageBackend();
  } catch {
    // Older/odd Linux builds may not implement this. Fall through with 'unknown'.
  }

  if (backend === 'basic_text') {
    // `basic_text` is obfuscation, not encryption. Refusing it is the whole
    // point of this module.
    return {
      available: false,
      backend,
      detail:
        'No system keyring was found, so Libra cannot encrypt API keys on this machine. ' +
        'Install and start gnome-keyring or KWallet, then restart Libra.',
    };
  }

  return available
    ? { available: true, backend }
    : {
        available: false,
        backend,
        detail:
          'The system keyring is locked or unavailable, so Libra cannot encrypt API keys. ' +
          'Unlock your keyring (gnome-keyring or KWallet) and restart Libra.',
      };
}

/** On-disk envelope. Versioned so the format can change without guesswork. */
interface SecretsFile {
  readonly version: 1;
  readonly entries: Record<string, string>;
}

const FILE_VERSION = 1 as const;

/**
 * Legal shape for a `secretRef`.
 *
 * Refs are map keys, not paths — but they arrive from `@libra/core` and, one
 * refactor from now, could arrive from somewhere less trustworthy. Constraining
 * them means a ref can never be `../../id_rsa` and can never be `__proto__`.
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const RESERVED_REFS = new Set(['__proto__', 'constructor', 'prototype']);

function assertValidRef(ref: string): void {
  if (!REF_PATTERN.test(ref) || RESERVED_REFS.has(ref)) {
    throw new SecretStoreUnavailableError('io_error', `Invalid secret reference: ${JSON.stringify(ref)}`);
  }
}

/** Default location of the store, under Electron's per-app user data directory. */
export function defaultSecretsPath(): string {
  return join(app.getPath('userData'), 'secrets.v1.json');
}

export interface SecretStoreOptions {
  /** Override the store location. Defaults to {@link defaultSecretsPath}. */
  readonly filePath?: string;
  /** Pre-computed probe result, so the caller can surface it once at startup. */
  readonly probe?: EncryptionProbe;
}

/**
 * `safeStorage`-backed {@link SecretStore}.
 *
 * Reads are served from an in-memory map of *ciphertext* (never plaintext), so
 * a decrypted key exists only inside the `read()` call that asked for it and
 * whatever the caller does with it. Writes are serialised through a promise
 * chain: two profile edits landing at once would otherwise read-modify-write
 * the same file and lose one of the entries.
 */
class SafeStorageSecretStore implements SecretStore {
  readonly #filePath: string;
  readonly #probe: EncryptionProbe;
  #cache: Map<string, string> | null = null;
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SecretStoreOptions = {}) {
    this.#filePath = options.filePath ?? defaultSecretsPath();
    this.#probe = options.probe ?? probeEncryption();
  }

  isAvailable(): boolean {
    return this.#probe.available;
  }

  unavailableReason(): string | null {
    return this.#probe.available ? null : (this.#probe.detail ?? 'Encrypted storage is unavailable.');
  }

  mintRef(prefix = 'secret'): string {
    return `${prefix}_${randomBytes(16).toString('hex')}`;
  }

  async get(ref: string): Promise<string | null> {
    assertValidRef(ref);
    const entries = await this.#load();
    const encoded = entries.get(ref);
    // An unknown ref is not an error: core calls this for profiles on cloud
    // backends that authenticate from the ambient credential chain and have no
    // stored key at all. Core's `SecretStore` contract says so explicitly —
    // "`get` resolves `null` for an unknown ref; it must not throw for one."
    if (encoded === undefined) return null;

    // Availability is asserted only once there is ciphertext to decrypt.
    // Asserting earlier would make every profile unreadable on a machine with
    // no working keyring — including cloud-backend profiles that store no key
    // at all — which is precisely what the startup dialog promises will keep
    // working. `set` still asserts unconditionally: writing a key that cannot
    // be encrypted has to fail loudly.
    this.#assertAvailable();

    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch (error) {
      log.error(`Failed to decrypt secret ${ref}`, error);
      throw new SecretStoreUnavailableError(
        'corrupt_store',
        'A stored API key could not be decrypted. This usually means the OS keychain entry ' +
          'was removed or the profile was copied from another machine. Re-enter the key for this profile.',
      );
    }
  }

  async set(ref: string, secret: string): Promise<void> {
    assertValidRef(ref);
    this.#assertAvailable();
    if (secret.length === 0) {
      throw new SecretStoreUnavailableError('io_error', 'Refusing to store an empty credential.');
    }

    const encoded = safeStorage.encryptString(secret).toString('base64');
    await this.#mutate((entries) => {
      entries.set(ref, encoded);
      return true;
    });
  }

  async delete(ref: string): Promise<void> {
    assertValidRef(ref);
    await this.#mutate((entries) => entries.delete(ref));
  }

  async has(ref: string): Promise<boolean> {
    assertValidRef(ref);
    const entries = await this.#load();
    return entries.has(ref);
  }

  async listRefs(): Promise<readonly string[]> {
    const entries = await this.#load();
    return [...entries.keys()];
  }

  #assertAvailable(): void {
    if (this.#probe.available) return;
    throw new SecretStoreUnavailableError(
      this.#probe.backend === 'basic_text' ? 'plaintext_backend' : 'encryption_unavailable',
      this.#probe.detail ??
        'Libra cannot encrypt API keys on this machine, so it will not store them. ' +
          'No credential has been written to disk.',
    );
  }

  /** Read the file into `#cache`, tolerating a missing file but not a broken one. */
  async #load(): Promise<Map<string, string>> {
    const cached = this.#cache;
    if (cached) return cached;

    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        const empty = new Map<string, string>();
        this.#cache = empty;
        return empty;
      }
      log.error('Failed to read the secret store', error);
      throw new SecretStoreUnavailableError('io_error', 'Libra could not read its credential store.');
    }

    const entries = new Map<string, string>();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      const file = parsed as Partial<SecretsFile>;
      if (file.version !== FILE_VERSION) throw new Error(`unsupported version ${String(file.version)}`);
      const stored = file.entries;
      if (typeof stored !== 'object' || stored === null) throw new Error('missing entries');
      for (const [ref, value] of Object.entries(stored)) {
        if (typeof value !== 'string') continue;
        if (!REF_PATTERN.test(ref) || RESERVED_REFS.has(ref)) continue;
        entries.set(ref, value);
      }
    } catch (error) {
      log.error('The secret store is corrupt', error);
      // Do not overwrite it. A corrupt file the user can inspect and restore
      // beats a clean file with their credentials silently deleted.
      throw new SecretStoreUnavailableError(
        'corrupt_store',
        `Libra's credential store at ${this.#filePath} could not be parsed. ` +
          'Move it aside and re-enter your API keys to start fresh.',
      );
    }

    this.#cache = entries;
    return entries;
  }

  /**
   * Apply `change` to the entry map and persist it, one caller at a time.
   *
   * `change` returns false when nothing actually changed, which skips the disk
   * write — deleting a ref that was never there should not rewrite the file.
   */
  async #mutate(change: (entries: Map<string, string>) => boolean): Promise<void> {
    const run = this.#writeQueue.then(async () => {
      const entries = await this.#load();
      if (!change(entries)) return;
      await this.#persist(entries);
    });
    // Keep the chain alive even when this link rejects, or one failed write
    // would poison every later one.
    this.#writeQueue = run.catch(() => undefined);
    await run;
  }

  async #persist(entries: Map<string, string>): Promise<void> {
    const payload: SecretsFile = {
      version: FILE_VERSION,
      entries: Object.fromEntries(entries),
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const directory = dirname(this.#filePath);
    const tempPath = `${this.#filePath}.${randomBytes(6).toString('hex')}.tmp`;

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // `mkdir` leaves an existing directory's mode alone, so tighten it too.
      await chmod(directory, 0o700).catch(() => undefined);

      const handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        // Durability matters more than speed here: an unflushed rename can
        // leave a zero-length file after a power loss, which reads as "all your
        // profiles lost their keys".
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(tempPath, this.#filePath);
      await chmod(this.#filePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      // The cache no longer reflects disk; drop it so the next read re-syncs.
      this.#cache = null;
      log.error('Failed to write the secret store', error);
      throw new SecretStoreUnavailableError('io_error', 'Libra could not save the API key to its credential store.');
    }
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}

/** Build the main process's credential store. */
export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  return new SafeStorageSecretStore(options);
}
