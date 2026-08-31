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
 * ## The seam this leaves open
 *
 * {@link MemoryBankCredential} is deliberately a *record about* an
 * authentication, not a string. The next phase lets a bank name a key held by
 * the machine's own key manager instead of one held here, and that is a second
 * variant of this record rather than a second store: everything above the
 * interface asks "how do I authenticate to this bank", and only the
 * implementation cares whether the answer was decrypted or fetched.
 *
 * ## Why an interface
 *
 * Encryption is Electron's `safeStorage`, and core must never import
 * `electron` — see `no-electron.test.ts`, which enforces it. So core declares
 * what it needs and the composition root injects it, exactly as the profile
 * key store is injected. {@link EphemeralMemoryBankSecrets} is the test
 * double.
 */

/**
 * How to authenticate to one bank's remote.
 *
 * Both halves travel together because they are used together and are only
 * meaningful together — a token with the wrong username fails on GitLab in a
 * way that reads as a bad token.
 */
export interface MemoryBankCredential {
  /** The access token. The only field here that is a secret. */
  readonly token: string;
  /**
   * The username git presents alongside it — `x-access-token` unless the host
   * demands its own. Never a secret; see the file header.
   */
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
