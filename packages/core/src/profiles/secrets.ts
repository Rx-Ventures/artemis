/**
 * The one secret Artemis holds again, and the rules it holds it under.
 * ============================================================================
 *
 * `profile.ts` explains at length why Artemis stopped storing credentials: a
 * profile used to carry a `secretRef` into encrypted OS storage, and
 * `ANTHROPIC_API_KEY` silently outranks a subscription login, so a profile that
 * said "bill my plan" could bill metered API usage instead. No amount of care
 * in the editor could fix that while Artemis was the thing holding the key.
 *
 * A local server's key is not that. There is no plan for it to outrank, no
 * metered account to bill, and no vendor: it authenticates one endpoint the
 * user typed — `llama-server --api-key`, a reverse proxy, a tunnel — and the
 * request goes nowhere else. The defect that killed the old design does not
 * exist here, and the alternative to storing it is that a user with an
 * authenticated server cannot connect at all.
 *
 * What survives from that deletion is every rule around it, made explicit:
 *
 *  - **Never in `profiles.json`.** That file is plain, hand-editable JSON and
 *    its tests assert there is no secret in it. Keys live in their own file,
 *    encrypted, written `0600`.
 *  - **Never outbound.** The renderer learns `hasApiKey`, a boolean, and
 *    nothing else — see {@link ProfileMetadata}. `main/redact.ts` refuses the
 *    key name `apiKey` on anything crossing to the renderer, and it should go
 *    on refusing it.
 *  - **One path to a provider.** The key reaches the adapter the way every
 *    other environment value does, through `resolveEnv`, and is named in the
 *    provider's strip list so an ambient one cannot beat it.
 *
 * ## Why an interface
 *
 * Encryption is Electron's `safeStorage`, and core must never import
 * `electron` — it has to run under vitest and in a plain Node process. So core
 * declares what it needs and the composition root injects it, exactly as the
 * old credential store was injected. {@link MemoryProfileSecrets} is the test
 * double, and is deliberately not exported as anything a real build would pick
 * up by accident.
 */

import type { ProfileId } from '@rx-artemis/protocol';

/**
 * Somewhere to keep one string per profile, safely.
 *
 * Every method is allowed to fail loudly: a key that cannot be written must
 * not be reported as saved, because the user would then be looking at a
 * profile that says a key is set and a server that refuses every request.
 */
export interface ProfileSecrets {
  /** The stored key, or `null` when there is none. Main-process only. */
  read(id: ProfileId): Promise<string | null>;
  /** Store (or replace) the key for this profile. */
  write(id: ProfileId, secret: string): Promise<void>;
  /** Forget this profile's key. Idempotent — clearing an absent key is fine. */
  clear(id: ProfileId): Promise<void>;
  /**
   * Whether a key is stored, without decrypting it.
   *
   * Separate from `read` because this is the question the renderer's copy
   * answers, and answering it by decrypting a secret nobody asked for would
   * put the value in memory for the sake of a boolean.
   */
  has(id: ProfileId): Promise<boolean>;
}

/**
 * An in-memory implementation, for tests and for a build with no encryption
 * available.
 *
 * Not a fallback the app should quietly use: a key kept here vanishes on quit,
 * so the composition root decides deliberately whether an unavailable
 * `safeStorage` means "keep keys for this session" or "refuse to store one".
 */
export class MemoryProfileSecrets implements ProfileSecrets {
  readonly #keys = new Map<ProfileId, string>();

  read(id: ProfileId): Promise<string | null> {
    return Promise.resolve(this.#keys.get(id) ?? null);
  }

  write(id: ProfileId, secret: string): Promise<void> {
    this.#keys.set(id, secret);
    return Promise.resolve();
  }

  clear(id: ProfileId): Promise<void> {
    this.#keys.delete(id);
    return Promise.resolve();
  }

  has(id: ProfileId): Promise<boolean> {
    return Promise.resolve(this.#keys.has(id));
  }
}
