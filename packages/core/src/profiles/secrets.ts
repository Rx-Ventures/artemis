/**
 * The secret-storage seam.
 *
 * `@rx-apollo/core` must never import `electron`, and Electron's `safeStorage`
 * (the thing that actually encrypts a credential against the OS keychain)
 * only exists in the main process. So core does not store secrets: it stores
 * *handles* to them, and calls out through this interface.
 *
 * The main process supplies a `safeStorage`-backed implementation. Tests use
 * {@link InMemorySecretStore}. Nothing in this package ever writes plaintext
 * to disk — {@link import('./store.js').ProfileStore} persists only
 * `secretRef` strings, and the value behind a ref is the implementation's
 * problem.
 *
 * Contract for implementers:
 *
 *  - `set` overwrites an existing value for the same ref.
 *  - `get` resolves `null` for an unknown ref; it must not throw for one.
 *  - `delete` is idempotent — deleting an unknown ref is a no-op, not an error.
 *  - Refs are opaque, filesystem-safe strings minted by the profile store
 *    (`profile-<uuid>`). An implementation may use them as file names or as
 *    keychain account names directly.
 */

/**
 * Encrypted credential storage, injected into core by the host process.
 *
 * Every method is async because the realistic implementations (OS keychain,
 * encrypted file) are.
 */
export interface SecretStore {
  /** Store `secret` under `ref`, replacing any previous value. */
  set(ref: string, secret: string): Promise<void>;
  /** Read the secret behind `ref`, or `null` when there is none. */
  get(ref: string): Promise<string | null>;
  /** Remove the secret behind `ref`. Idempotent. */
  delete(ref: string): Promise<void>;
}

/**
 * A {@link SecretStore} that keeps everything in a `Map`.
 *
 * For tests and for a headless core with no OS keychain available. It is not
 * encrypted and does not persist — which is exactly why it is safe: nothing it
 * holds outlives the process.
 */
export class InMemorySecretStore implements SecretStore {
  readonly #values = new Map<string, string>();

  /** Number of secrets currently held. Test affordance. */
  get size(): number {
    return this.#values.size;
  }

  /** True when a secret is stored under `ref`. Test affordance. */
  has(ref: string): boolean {
    return this.#values.has(ref);
  }

  set(ref: string, secret: string): Promise<void> {
    this.#values.set(ref, secret);
    return Promise.resolve();
  }

  get(ref: string): Promise<string | null> {
    return Promise.resolve(this.#values.get(ref) ?? null);
  }

  delete(ref: string): Promise<void> {
    this.#values.delete(ref);
    return Promise.resolve();
  }

  /** Drop everything. Test affordance. */
  clear(): void {
    this.#values.clear();
  }
}
