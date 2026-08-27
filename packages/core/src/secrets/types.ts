/**
 * The key-manager seam.
 * ============================================================================
 *
 * One interface, two implementations, and a hard rule about what crosses it:
 * **a provider hands back a value and a way to stop holding it, and nothing
 * else ever sees that value.** Everything above this file — the registry in
 * main, the pane, the memory banks — deals in addresses, identities and
 * problems.
 *
 * ## Why an interface at all, with only two managers
 *
 * Because the second one is the proof. OpenBao and Doppler disagree about
 * almost everything an integration touches: OpenBao authenticates with a
 * header it invented and mints short-lived tokens, Doppler uses `Bearer` and
 * long-lived ones; OpenBao nests a secret two `data` levels deep behind a
 * mount whose engine version is not discoverable on the read path, Doppler
 * returns one secret at a time with a `computed` field beside the raw one;
 * OpenBao says 403 when it means "denied, or absent, and I will not tell you
 * which", Doppler returns `{messages: […]}`. An abstraction written against
 * one of them would have been shaped like that one. Written against both, the
 * shape is: *config + credential + reference → value*, and every difference
 * above is a provider's own business.
 *
 * ## Why the transport is injected
 *
 * So the providers are testable against canned bytes, and so that the one
 * place TLS is configured is one place. `transport.ts` is the real
 * implementation and it never — on any path, under any option — sets
 * `rejectUnauthorized: false`. A pinned certificate is `ca: [pem]` with
 * verification *on*; the alternative that appears in a lot of vault client
 * code, "skip verification and compare the fingerprint afterwards", verifies
 * nothing, because by the time there is a fingerprint to compare the request
 * has already been sent to whoever answered.
 *
 * The single unverified socket in this feature is the certificate *preview*
 * in `main/secretManagers.ts`, which completes a handshake, reads the chain,
 * and closes without writing a byte of HTTP.
 *
 * ## No `electron`, and no secrets at rest
 *
 * Core's two standing rules both apply. Nothing here imports Electron, and
 * nothing here stores anything: the credential arrives as an argument, is used
 * for one request, and goes out of scope. Where it is *kept* between calls is
 * `main/secretManagerSecrets.ts`, encrypted, and the file that declares that
 * store's contract says why it is allowed to exist at all.
 */

import type {
  SecretAuthMethod,
  SecretConnection,
  SecretField,
  SecretProblem,
  SecretProviderDescriptor,
  SecretProviderId,
  SecretRef,
  SecretVerifyResult,
} from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/** One request to a key manager. */
export interface SecretHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * A PEM to check the server's certificate against.
   *
   * Absent means the system trust store. It never means "do not check" —
   * there is no value of this field, and no other field, that turns
   * verification off.
   */
  readonly caPem?: string;
  readonly timeoutMs?: number;
}

/** What came back. Header names are lowercased by the transport. */
export interface SecretHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The seam the providers speak through.
 *
 * Throws {@link SecretManagerError} for anything that stopped the exchange
 * happening at all — DNS, refused connection, a certificate the machine will
 * not accept — and resolves for every HTTP status, including the failures. A
 * transport that threw on 403 would take the categorisation away from the
 * provider, which is where the manager-specific meaning of 403 lives.
 */
export type SecretTransport = (request: SecretHttpRequest) => Promise<SecretHttpResponse>;

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a key manager did not produce a value.
 *
 * Defined in the protocol rather than here, because the renderer renders the
 * categories differently and the memory banks report them differently — see
 * `protocol/secretRefs.ts` for what each one means and why they are not one
 * bucket. Re-exported so a caller working with providers does not have to
 * import from two packages to catch an error.
 */
export type { SecretProblem } from '@rx-artemis/protocol';

/**
 * The problems it is never worth asking again about.
 *
 * A retry loop over a terminal state is not resilience — it is a background
 * task hammering a manager that has already given its final answer, and for
 * `sealed` in particular it is doing so while a human is trying to fix it.
 */
const TERMINAL_PROBLEMS: ReadonlySet<SecretProblem> = new Set<SecretProblem>([
  'tls',
  'bad-credentials',
  'expired',
  'denied',
  'absent',
  'missing-key',
  'deleted-version',
  'sealed',
  'undetermined',
  'protocol',
]);

/** A key manager's refusal, categorised. */
export class SecretManagerError extends Error {
  readonly problem: SecretProblem;
  /**
   * The key *names* at the path, when the manager listed them and the failure
   * was about which key to read. Never values — see `SecretRefTestResult`.
   */
  readonly keysAtPath?: readonly string[];

  constructor(problem: SecretProblem, message: string, keysAtPath?: readonly string[]) {
    super(message);
    this.name = 'SecretManagerError';
    this.problem = problem;
    if (keysAtPath !== undefined) this.keysAtPath = keysAtPath;
  }

  /** False for every state where asking again is the wrong response. */
  get retryable(): boolean {
    return !TERMINAL_PROBLEMS.has(this.problem);
  }
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a provider authenticates with — always a token, never a password.
 *
 * A `userpass` connection has a password exactly once, at save time, and what
 * is kept afterwards is the token that login minted. So every method below
 * that needs authority takes this, and {@link SecretManagerProvider.login} is
 * the one place a password appears at all.
 */
export interface SecretCredential {
  readonly token: string;
  /** Epoch milliseconds, when the manager stated an expiry. */
  readonly expiresAt?: number;
}

/** What a login produced, as the caller has to store it. */
export interface SecretMintedToken {
  readonly token: string;
  /** Epoch milliseconds, derived from the lease the manager reported. */
  readonly expiresAt?: number;
  readonly renewable: boolean;
  readonly policies: readonly string[];
  readonly identity?: string;
}

/**
 * What a renewal attempt came to.
 *
 * Never throws and never fails the operation it was attached to. A renewal is
 * housekeeping done on the way to something the user actually asked for, and a
 * manager that refuses to extend a token has not stopped that token working —
 * it has told us the day it stops, which is a thing to report and not a thing
 * to fail on.
 */
export interface SecretRenewal {
  readonly renewed: boolean;
  /**
   * Read back from the manager's answer, never assumed from the increment we
   * asked for. A manager is free to grant less than requested (a max TTL, a
   * role limit), and a client that recorded its own request would believe in
   * an expiry that is not the one the token has.
   */
  readonly expiresAt?: number;
  readonly detail: string;
}

/**
 * A value, and the end of holding it.
 *
 * `dispose` is not a formality. The caller registers this value with the
 * literal-secret scrub for exactly as long as it is live, and disposing is how
 * that registration ends — see `main/secretManagers.ts`. A caller that forgets
 * leaves a string being scrubbed out of log lines forever, which is harmless
 * and is also a leak of a different kind: a secret Artemis still knows.
 */
export interface ResolvedSecret {
  readonly value: string;
  /**
   * The other key names at the same path, when the manager returned them on
   * the way to this one. Names only, and the reason they are worth carrying is
   * `SecretRefTestResult`.
   */
  readonly siblingKeys?: readonly string[];
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* The provider                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One key manager, as everything above it sees it.
 *
 * `login` and `renew` are optional because they are OpenBao's shape and not
 * the general one: Doppler has no login (its tokens are minted in its own web
 * UI) and no renewal (they do not expire on a schedule). A caller asks whether
 * the method is there rather than asking which provider it is holding, which
 * is the difference between an abstraction and a `switch`.
 */
export interface SecretManagerProvider {
  readonly id: SecretProviderId;
  readonly label: string;
  /** One line for a user choosing between managers. */
  readonly note: string;
  readonly authMethods: readonly SecretAuthMethod[];
  /** The connection form's fields, beyond label and auth method. */
  readonly configFields: readonly SecretField[];
  /** The fields one of this provider's references is made of. */
  readonly refFields: readonly SecretField[];

  /** The descriptor the renderer builds its forms from. */
  describe(): SecretProviderDescriptor;

  /**
   * Is this connection usable, and under whose authority?
   *
   * Resolves rather than throws for every answer a manager can give about
   * itself, including the bad ones: "sealed" is a verify result, not an
   * exception, because the pane has to render it as a row rather than as a
   * failed call.
   */
  verify(config: SecretConnection, credential: SecretCredential): Promise<SecretVerifyResult>;

  /** Fetch one value. Throws {@link SecretManagerError} for every refusal. */
  resolve(
    config: SecretConnection,
    credential: SecretCredential,
    ref: SecretRef,
  ): Promise<ResolvedSecret>;

  /** Extend the credential's life if it is worth extending. Never throws. */
  renew?(config: SecretConnection, credential: SecretCredential): Promise<SecretRenewal>;

  /** Spend a password on a token. The only method that sees one. */
  login?(
    config: SecretConnection,
    username: string,
    password: string,
  ): Promise<SecretMintedToken>;

  /**
   * Drop anything cached about a connection.
   *
   * Called when one is edited or deleted. What is cached is per-session and
   * non-secret (which engine version a mount runs), but an address that has
   * been repointed at a different server must not inherit the last one's
   * answers.
   */
  forget?(connectionId: string): void;
}
