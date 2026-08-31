/**
 * The second secret Artemis holds, and the rules it holds it under.
 * ============================================================================
 *
 * `profiles/secrets.ts` argues at length why Artemis stopped storing
 * credentials, and why a local server's API key is nonetheless allowed back:
 * there is no plan for it to outrank, no metered account to bill, and the
 * alternative is that a user with an authenticated server cannot connect at
 * all. A team memory bank's git token is the same shape of exception, for the
 * same reason and one more.
 *
 * A bank is a private git repository. Joining it is one clone; *keeping* it is
 * a fetch at the start of every run and a push whenever an agent promotes a
 * draft — unattended, in the background, with nobody at the keyboard to answer
 * a credential prompt. So the token cannot be a thing the user types once into
 * a form: it has to outlive the form, or the bank stops syncing the moment the
 * window closes. That is what this store is for, and it is the whole of what
 * it is for.
 *
 * The rules are `profiles/secrets.ts`'s, unchanged:
 *
 *  - **Never in the banks' own config.** `~/.config/cerebro/config.json` is
 *    plain JSON that the CLI, the hooks and the user all read and write. The
 *    token lives in its own file, encrypted, written `0600`. That the two
 *    files are written by different programs is a second reason, not the
 *    first one.
 *  - **Never outbound.** No response shape in `protocol/ipc.ts` has a field
 *    this could be returned in, {@link MemoryBankSecrets.has} answers the only
 *    question the renderer asks, and `main/redact.ts` fails a payload closed
 *    if a credential-named key ever appears on one.
 *  - **Never in an argument list.** It reaches git through an environment
 *    variable named by a config value, never on a command line and never
 *    inside a remote URL — see `main/gitCredentialEnv.ts` for why each half of
 *    that matters.
 *
 * ## Why the username is stored beside it, in clear
 *
 * Because it is not a secret and must never become one. Git echoes the
 * username into its own prompts and error text, which is precisely the output
 * a failed sync folds into a receipt the renderer shows. Storing it plainly is
 * the honest record of that: a value in this file that is *not* encrypted is a
 * value nothing in Artemis is pretending to protect.
 *
 * ## The seam this left open, now taken
 *
 * {@link MemoryBankCredential} is deliberately a *record about* an
 * authentication, not a string — and it is now a union of two, because a bank
 * may name a key held by the machine's own key manager instead of one held
 * here. That is a second variant of this record rather than a second store:
 * everything above the interface asks "how do I authenticate to this bank",
 * and only the implementation cares whether the answer was decrypted or
 * fetched. A bank on the `ref` variant has **no secret stored on this
 * machine** — see `secrets/credentials.ts` for why that is the point of the
 * whole arrangement rather than a nicety.
 *
 * ## Why an interface
 *
 * Encryption is Electron's `safeStorage`, and core must never import
 * `electron` — see `no-electron.test.ts`, which enforces it. So core declares
 * what it needs and the composition root injects it, exactly as the profile
 * key store is injected. {@link EphemeralMemoryBankSecrets} is the test
 * double.
 */

import type { SecretRef } from '@rx-artemis/protocol';

/**
 * How to authenticate to one bank's remote — the value, or where to get it.
 *
 * A discriminated union rather than an optional field, because the two
 * variants are stored differently and mean different things about what this
 * machine is holding. `token` is the value, encrypted here, and the bank's
 * sync works for as long as that token does. `ref` is an address in the
 * machine's own key manager: nothing secret is stored for that bank at all,
 * and every sync resolves the current value at the moment git needs it — so a
 * token rotated in the manager is a token Artemis is already using.
 *
 * This is the variant the seam described in the file header was left open
 * for, and it is the one that makes `secrets/credentials.ts`'s argument true:
 * a machine with a key manager configured stores one credential instead of one
 * per private bank.
 *
 * The username travels on both because it is used with both and is only
 * meaningful alongside a token — a token with the wrong username fails on
 * GitLab in a way that reads as a bad token — and because it is never a
 * secret however the token was obtained.
 */
export type MemoryBankCredential = StoredTokenCredential | SecretRefCredential;

/** A token this machine holds, encrypted. */
export interface StoredTokenCredential {
  readonly kind: 'token';
  /** The access token. The only field in this file that is a secret. */
  readonly token: string;
  /**
   * The username git presents alongside it — `x-access-token` unless the host
   * demands its own. Never a secret; see the file header.
   */
  readonly username: string;
}

/**
 * A token this machine does **not** hold, and knows where to find.
 *
 * Nothing here is a secret, which is why the whole record can be written in
 * clear beside the encrypted ones without changing what the file's `0600` is
 * protecting. It is stored in the same file all the same, because "how does
 * this bank authenticate" is one question and answering it from two places is
 * how the two answers start disagreeing.
 */
export interface SecretRefCredential {
  readonly kind: 'ref';
  readonly ref: SecretRef;
  /** @see StoredTokenCredential.username */
  readonly username: string;
}

/**
 * Somewhere to keep one git credential per bank, safely.
 *
 * Keyed by the bank's slug rather than by its remote, because the slug is what
 * every other operation already names: a sync addresses `--bank <slug>`, and a
 * store keyed by URL would have to re-derive the URL for a bank whose remote
 * the user has since changed.
 *
 * Every method is allowed to fail loudly. A token that cannot be written must
 * not be reported as saved — the user would be looking at a bank that says it
 * is authenticated and a background sync that silently stops working.
 */
export interface MemoryBankSecrets {
  /** The stored credential, or `null` when the bank has none. Main-process only. */
  read(slug: string): Promise<MemoryBankCredential | null>;
  /** Store (or replace) this bank's credential. */
  write(slug: string, credential: MemoryBankCredential): Promise<void>;
  /** Forget this bank's credential. Idempotent — clearing an absent one is fine. */
  clear(slug: string): Promise<void>;
  /**
   * Whether a credential is stored, without decrypting it.
   *
   * Separate from `read` for {@link MemoryBankSecrets.list}'s reason: this
   * answers "does this bank have a token", which is a boolean, and computing a
   * boolean by putting a secret in memory is work done for the sake of
   * exposure.
   */
  has(slug: string): Promise<boolean>;
  /**
   * Which banks have a credential stored. Never decrypts.
   *
   * The background sync's question: it runs one CLI pass over every enabled
   * bank and has to compose the environment for all of them at once, so it
   * needs to know which slugs are worth reading before it reads any.
   */
  list(): Promise<readonly string[]>;
}

/**
 * An in-memory implementation, for tests and for a build with no encryption
 * available.
 *
 * Not a fallback the app should quietly use: a credential kept here vanishes
 * on quit, which for this store means the banks sync until the window closes
 * and then stop. The composition root decides deliberately whether an
 * unavailable `safeStorage` means "keep it for this session" or "refuse to
 * store one" — and `main/memoryBankSecrets.ts` chooses the latter, loudly.
 *
 * Named for what it is rather than by the sibling's `Memory…` convention,
 * which would have produced `MemoryMemoryBankSecrets`.
 */
export class EphemeralMemoryBankSecrets implements MemoryBankSecrets {
  readonly #credentials = new Map<string, MemoryBankCredential>();

  read(slug: string): Promise<MemoryBankCredential | null> {
    return Promise.resolve(this.#credentials.get(slug) ?? null);
  }

  write(slug: string, credential: MemoryBankCredential): Promise<void> {
    this.#credentials.set(slug, credential);
    return Promise.resolve();
  }

  clear(slug: string): Promise<void> {
    this.#credentials.delete(slug);
    return Promise.resolve();
  }

  has(slug: string): Promise<boolean> {
    return Promise.resolve(this.#credentials.has(slug));
  }

  list(): Promise<readonly string[]> {
    return Promise.resolve([...this.#credentials.keys()]);
  }
}
