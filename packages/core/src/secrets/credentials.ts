/**
 * The third secret Artemis holds, and the only one that removes others.
 * ============================================================================
 *
 * `profiles/secrets.ts` argues why Artemis stopped storing credentials, and
 * why a local server's API key was allowed back. `memorybanks/secrets.ts` makes
 * the same argument for a private bank's git token: a background sync has
 * nobody at the keyboard, so the token has to outlive the form. Both are
 * exceptions, and both were justified one at a time.
 *
 * This store is the one that pays them back.
 *
 * **THE MANAGER TOKEN EXISTS SO THAT GIT TOKENS NEVER HAVE TO BE STORED.**
 *
 * That is the whole justification, and it is a different *kind* of
 * justification from the other two. They are exceptions granted because the
 * alternative was a feature that could not work. This one is granted because
 * it makes the other exceptions unnecessary: a user who configures a key
 * manager stores one credential here and Artemis stops needing to store the
 * bank's git token at all — the bank keeps an *address*, and every sync
 * resolves the current value out of the manager at the moment git needs it.
 * One secret at rest replaces N, the N that remain are rotated by the manager
 * rather than by the user remembering, and a rotation the user performs in
 * OpenBao is a rotation Artemis is already using.
 *
 * If that trade ever stops holding — if this store grew a second purpose, or
 * if refs were merely *another* way to authenticate rather than the way that
 * replaces stored tokens — then this file has no argument left and the store
 * should go. It is worth restating rather than assuming, because a credential
 * store whose reason has quietly expired is exactly the kind of thing that
 * survives on the grounds that it is already there.
 *
 * ## The rules, unchanged from its two siblings
 *
 *  - **Never in a plain config file.** The connection's non-secret half — its
 *    label, address, certificate, username — lives in readable JSON under
 *    `userData` where a person can inspect it. The credential lives here,
 *    encrypted, written `0600`, in its own file.
 *  - **Never outbound.** No response shape in `protocol/ipc.ts` has a field
 *    this could be returned in; {@link SecretManagerCredentials.has} answers
 *    the only question the renderer asks; and `main/redact.ts` fails a payload
 *    closed if a credential-named key appears on one.
 *  - **Never in an argument list.** Resolved values reach a subprocess through
 *    an environment variable named by a config value — see
 *    `main/gitCredentialEnv.ts` — and the manager's own token never reaches a
 *    subprocess at all.
 *
 * ## Why a password is never what is stored
 *
 * A `userpass` connection is configured with a password and does not keep one.
 * The password is spent immediately on a login, and what is written here is
 * the token that login minted, with the expiry the manager stated. The
 * difference matters twice: a stored password is a credential that works
 * forever and can be replayed against every other service the user reused it
 * on, while a stored token expires on its own and is scoped to what the
 * manager's policy allows. When it does expire, the pane says so and asks for
 * the password again — which is a worse experience than storing one, and is
 * the correct trade.
 *
 * ## Why an interface
 *
 * Encryption is Electron's `safeStorage`, and core must never import
 * `electron` — see `no-electron.test.ts`. So core declares what it needs and
 * the composition root injects it, exactly as the profile and bank stores are
 * injected. {@link EphemeralSecretManagerCredentials} is the test double.
 */

/**
 * What is kept for one connection.
 *
 * Always a token, never a password — see the file header. The expiry travels
 * with it because it is the manager's own statement about the credential and
 * re-deriving it would mean a round trip to find out something already known.
 */
export interface SecretManagerCredential {
  readonly token: string;
  /** Epoch milliseconds. Absent for a credential the manager gave no expiry for. */
  readonly expiresAt?: number;
}

/**
 * Somewhere to keep one credential per configured key manager, safely.
 *
 * Keyed by the connection's id rather than by its address, because the id is
 * what a {@link import('@rx-artemis/protocol').SecretRef} names: a store keyed
 * by URL would lose the credential of a connection whose address the user
 * corrected.
 *
 * Every method is allowed to fail loudly. A credential that cannot be written
 * must not be reported as saved — the user would be looking at a connection
 * that says it is configured and a background resolution that silently stops
 * working.
 */
export interface SecretManagerCredentials {
  /** The stored credential, or `null`. Main-process only. */
  read(connectionId: string): Promise<SecretManagerCredential | null>;
  /** Store (or replace) this connection's credential. */
  write(connectionId: string, credential: SecretManagerCredential): Promise<void>;
  /** Forget it. Idempotent — clearing an absent one is fine. */
  clear(connectionId: string): Promise<void>;
  /**
   * Whether one is stored, without decrypting it.
   *
   * The pane's question, and a boolean. Answering it by decrypting would put a
   * secret in memory for the sake of exposure.
   */
  has(connectionId: string): Promise<boolean>;
}

/**
 * An in-memory implementation, for tests and for a build with no encryption
 * available.
 *
 * Not a fallback the app should quietly use: a credential kept here vanishes
 * on quit, which for this store means every reference stops resolving the
 * moment the window closes. The composition root decides deliberately, and
 * `main/secretManagerSecrets.ts` refuses to store one rather than storing it
 * in clear.
 */
export class EphemeralSecretManagerCredentials implements SecretManagerCredentials {
  readonly #credentials = new Map<string, SecretManagerCredential>();

  read(connectionId: string): Promise<SecretManagerCredential | null> {
    return Promise.resolve(this.#credentials.get(connectionId) ?? null);
  }

  write(connectionId: string, credential: SecretManagerCredential): Promise<void> {
    this.#credentials.set(connectionId, credential);
    return Promise.resolve();
  }

  clear(connectionId: string): Promise<void> {
    this.#credentials.delete(connectionId);
    return Promise.resolve();
  }

  has(connectionId: string): Promise<boolean> {
    return Promise.resolve(this.#credentials.has(connectionId));
  }
}
