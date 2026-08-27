/**
 * Naming a secret without carrying one.
 * ============================================================================
 *
 * Artemis stores two credentials of its own (a local server's API key, a team
 * bank's git token) and `core/profiles/secrets.ts` argues at length that each
 * one is an exception it had to justify. This module is how the app stops
 * needing them: a {@link SecretRef} is an *address* — which manager, which
 * mount, which path, which key — and it is renderer-safe by construction,
 * because an address is not a credential. The value it names is fetched in the
 * main process at the moment a subprocess needs it, injected into that
 * subprocess's environment, and dropped.
 *
 * That is the whole point of the type. A user who keeps their git token in
 * OpenBao rotates it there and Artemis follows, because Artemis never had a
 * copy to go stale. A user whose laptop is stolen has handed the thief a file
 * of *paths*.
 *
 * ## Why these fields, and why they are policed here
 *
 * Every field below interpolates into a URL path or query on its way to a key
 * manager — `/v1/<mount>/data/<path>`, `?name=<name>`. A `..` segment in
 * `path` is not a typo, it is a request addressed to a different endpoint of
 * the same server, and a control character is a request split into two. So the
 * grammar is checked in this package rather than in the provider, for the
 * reason the profile's `configDirProblem` lives here: main validates inbound
 * IPC against it, the renderer disables its own button with it, and there is
 * one rule rather than two that drift.
 *
 * The rules are deliberately about *shape* and not about existence. Whether a
 * path holds anything is the manager's answer, and a manager that says
 * "denied" when it means "absent" — OpenBao does exactly this, on purpose — is
 * a thing the pane has to render honestly rather than guess past.
 *
 * ## What is never in here
 *
 * A value. Not on a ref, not on a {@link SecretConnection}, not on a
 * {@link SecretVerifyResult}. `main/redact.ts` fails a renderer-bound payload
 * closed if a credential-named key appears on one, and the shapes in this file
 * are designed so that there is nothing for it to catch.
 *
 * The one exception travels the other way and only once: the credential input
 * on a save request, renderer → main, on its way to encrypted storage. It has
 * no counterpart coming back.
 */

/** The key managers Artemis speaks to. */
export type SecretProviderId = 'openbao' | 'doppler';

/**
 * How a connection authenticates to its manager.
 *
 * `userpass` is OpenBao's username/password login, and choosing it means the
 * password is used *once*, at save time, to mint a token — see
 * {@link SecretConnection.authMethod}. `token` is a token the user pastes,
 * which is all Doppler offers.
 */
export type SecretAuthMethod = 'userpass' | 'token';

/**
 * Which KV engine version a mount runs, or `auto` to find out.
 *
 * Two versions of the same engine answer at different URLs and nest their
 * payload differently, and a mount does not advertise its version on the read
 * path. `auto` is the default because a user who knows the answer should not
 * have to, and an explicit value exists because the detection ladder can be
 * refused by policy — see the provider — and a user with a locked-down token
 * needs a way to say so.
 */
export type SecretKvVersion = 1 | 2 | 'auto';

/** What {@link OpenBaoSecretRef.kvVersion} means when it is omitted. */
export const DEFAULT_KV_VERSION: SecretKvVersion = 2;

/**
 * One value in an OpenBao KV mount.
 *
 * Four coordinates rather than one string, because OpenBao's own URL is not a
 * concatenation of them: KV v2 reads `/v1/<mount>/data/<path>` and KV v1 reads
 * `/v1/<mount>/<path>`, so the mount has to be separable from the path for the
 * provider to be able to build either. `key` is the entry inside the secret's
 * map, which is not part of the URL at all.
 */
export interface OpenBaoSecretRef {
  readonly provider: 'openbao';
  /** Which configured {@link SecretConnection} answers for it. */
  readonly connectionId: string;
  /** The KV mount, e.g. `secret`. May be nested (`kv/team`); never absolute. */
  readonly mount: string;
  /** The path within the mount, e.g. `claude/artemis`. Never absolute. */
  readonly path: string;
  /** The entry within the secret's map, e.g. `git_token`. */
  readonly key: string;
  /** Defaults to {@link DEFAULT_KV_VERSION}. */
  readonly kvVersion?: SecretKvVersion;
}

/**
 * One secret in a Doppler config.
 *
 * `project` and `config` are optional because a service token already names
 * both — Doppler rejects the request when a token that is scoped to a config
 * is also *told* a config, so these travel only when the user supplied them.
 */
export interface DopplerSecretRef {
  readonly provider: 'doppler';
  readonly connectionId: string;
  /** The secret's name, which in Doppler is its environment-variable name. */
  readonly name: string;
  /** Only for a token whose scope does not already name one. */
  readonly project?: string;
  /** Only for a token whose scope does not already name one. */
  readonly config?: string;
}

/** An address for a secret held by one of this machine's key managers. */
export type SecretRef = OpenBaoSecretRef | DopplerSecretRef;

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Long enough for a real nested path, short enough that nothing kilobyte-sized
 * reaches a URL builder.
 */
const SECRET_PATH_MAX = 400;

/** Control characters, including the two that would split an HTTP request. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Why this mount or path may not be used, or `null`.
 *
 * The three refusals are the three ways a path stops addressing what it
 * appears to address. A leading `/` makes the interpolation absolute against
 * the manager's API root rather than relative to the mount; a `..` segment
 * walks back out of it — both turn "read this secret" into "call this
 * endpoint". A control character ends the line the request is written on.
 *
 * Backslashes are refused too, because a manager that normalises `\` to `/`
 * (and some proxies in front of one do) would see a path this check has
 * already approved as something else.
 */
export function secretPathProblem(value: string): string | null {
  if (value.length === 0) return 'is required';
  if (value.length > SECRET_PATH_MAX) return `must be ${SECRET_PATH_MAX} characters or fewer`;
  if (CONTROL_CHARACTERS.test(value)) return 'must not contain control characters';
  if (value.startsWith('/')) return 'must not start with "/" — it is relative to the mount';
  if (value.includes('\\')) return 'must not contain a backslash';
  if (value.split('/').some((segment) => segment === '..')) {
    return 'must not contain a ".." segment';
  }
  return null;
}

/**
 * Why this key or secret name may not be used, or `null`.
 *
 * Looser than a path because it is not a path: a KV entry's name is a key in a
 * JSON object and a Doppler secret's name is a query parameter, so neither is
 * split on `/`. What both share is that a control character in them is a
 * malformed request.
 */
export function secretKeyProblem(value: string): string | null {
  if (value.length === 0) return 'is required';
  if (value.length > 200) return 'must be 200 characters or fewer';
  if (CONTROL_CHARACTERS.test(value)) return 'must not contain control characters';
  return null;
}

/**
 * Why this reference cannot be used, or `null`.
 *
 * The single entry point, so that the renderer's disabled Test button and
 * main's inbound validator are enforcing the same sentence. Field names are
 * spelled as the user meets them in the form.
 */
export function secretRefProblem(ref: SecretRef): string | null {
  if (ref.connectionId.length === 0) return 'connection is required';
  if (ref.provider === 'openbao') {
    const mount = secretPathProblem(ref.mount);
    if (mount !== null) return `mount ${mount}`;
    const path = secretPathProblem(ref.path);
    if (path !== null) return `path ${path}`;
    const key = secretKeyProblem(ref.key);
    if (key !== null) return `key ${key}`;
    return null;
  }
  const name = secretKeyProblem(ref.name);
  if (name !== null) return `name ${name}`;
  if (ref.project !== undefined) {
    const project = secretKeyProblem(ref.project);
    if (project !== null) return `project ${project}`;
  }
  if (ref.config !== undefined) {
    const config = secretKeyProblem(ref.config);
    if (config !== null) return `config ${config}`;
  }
  return null;
}

/**
 * One line naming what a ref points at, for a pane that has to show a stored
 * one back to the user.
 *
 * Not round-trippable and not meant to be: the ref is the record, this is the
 * caption under it.
 */
export function describeSecretRef(ref: SecretRef): string {
  return ref.provider === 'openbao'
    ? `${ref.mount}/${ref.path} · ${ref.key}`
    : [ref.project, ref.config, ref.name].filter((part) => part !== undefined).join(' / ');
}

/* -------------------------------------------------------------------------- */
/* Connections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A configured key manager, as everything outside the main process sees it.
 *
 * Renderer-safe by construction: there is no credential field, and the one
 * value here that looks like one is not. `caPem` is a **public** certificate —
 * the thing a client uses to check the server's identity — and it has to cross
 * into the renderer because the pane is where a user confirms it (see
 * {@link SecretServerCertificate}). A store that hid it would be hiding the
 * evidence the user is being asked to judge.
 */
export interface SecretConnection {
  /** Minted by main. Refs address a connection by this and nothing else. */
  readonly id: string;
  /** What the user called it: "work vault", "team doppler". */
  readonly label: string;
  readonly provider: SecretProviderId;
  /** The manager's base URL, e.g. `https://vault.example.com:8200`. */
  readonly address: string;
  /**
   * The PEM certificate this connection's TLS is checked against, when the
   * manager presents one a public root does not cover.
   *
   * Present means "trust this issuer for this address, and nothing else".
   * Absent means the system trust store — never means "skip the check".
   */
  readonly caPem?: string;
  readonly authMethod: SecretAuthMethod;
  /** The account name for `userpass`. Never a place to put a password. */
  readonly username?: string;
}

/**
 * What one verify came to.
 *
 * `identity` and `policies` are the two facts that make a green tick worth
 * anything: "reachable" tells a user nothing about *whose* authority they just
 * proved, and a token with the wrong policies fails later, on a path where
 * nobody is watching.
 *
 * Named for the domain rather than `VerifyResult`, because this package has a
 * flat export surface and a name that generic would be claimed by whichever
 * feature reached for it first.
 */
export interface SecretVerifyResult {
  readonly ok: boolean;
  /** One line, safe to show verbatim. Already scrubbed in main. */
  readonly detail: string;
  /** Who the manager says the credential is. */
  readonly identity?: string;
  /** What it is allowed to do, in the manager's own vocabulary. */
  readonly policies?: readonly string[];
  /** ISO-8601, when the credential has an expiry the manager will state. */
  readonly expiresAt?: string;
  /** Working, but not in the state a reader would assume. See the type. */
  readonly degraded?: SecretDegradedReason;
  /**
   * Which kind of failure this was, when it was one.
   *
   * A category and not a second copy of `detail`, because the pane acts on it:
   * `tls` is the one failure Artemis can offer a remedy for in place — fetch
   * the certificate, look at it, trust it — and a pane that had only prose to
   * go on would either offer that button for every failure or for none.
   */
  readonly problem?: SecretProblem;
}

/**
 * Why a key manager did not produce what was asked of it.
 *
 * Lives here rather than in the provider that raises it because the renderer
 * renders these differently and the memory banks report them differently: the
 * remedy for `denied` is a policy change, for `absent` a corrected path, for
 * `sealed` a person with unseal keys, and for `unreachable` the network.
 * Collapsing them into "could not read the secret" is how a user with a typo
 * spends an afternoon on their VPN.
 *
 * `denied` and `absent` stay separate even though OpenBao deliberately makes
 * them indistinguishable in the common case — because in the *uncommon* case
 * it proves which, and "your token can reach this path and there is nothing at
 * it" is the single most useful sentence this feature can produce.
 */
export type SecretProblem =
  /** Nothing answered: DNS, connection refused, timeout. */
  | 'unreachable'
  /** Something answered and its certificate was not acceptable. */
  | 'tls'
  /** The username/password or token was refused. */
  | 'bad-credentials'
  /** The credential was valid and has expired. */
  | 'expired'
  /** Refused by policy — or absent, where the manager will not distinguish. */
  | 'denied'
  /** Proven absent: the manager confirmed access and had nothing there. */
  | 'absent'
  /** The path exists and does not carry that key. Carries the names it does. */
  | 'missing-key'
  /** That version of the secret was deleted (KV v2 keeps the tombstone). */
  | 'deleted-version'
  /** Up, holding nothing usable, waiting for a human. Never retried. */
  | 'sealed'
  /** Throttled. The manager's own `retry-after` is in the detail. */
  | 'rate-limited'
  /** The manager refused every question that would settle which engine a mount runs. */
  | 'undetermined'
  /** An answer in a shape this code does not know how to read. */
  | 'protocol';

/**
 * Why an answer is worth qualifying even when it is an answer.
 *
 * All three are states a user has to be *told* rather than protected from:
 *
 *  - `standby` — an OpenBao node in a cluster that is not the active one. It
 *    answers health checks with 429, which every HTTP client in the world
 *    reads as rate limiting, and it is neither. Reads still work.
 *  - `sealed` — the manager is up and holds nothing usable until a human
 *    unseals it. Retrying is pointless and saying "unreachable" sends the user
 *    to check their network.
 *  - `rate-limited` — genuinely throttled, with the manager's own
 *    `retry-after` in the detail.
 */
export type SecretDegradedReason = 'standby' | 'sealed' | 'rate-limited';

/**
 * A certificate chain as fetched for the user to look at, before anything
 * trusts it.
 *
 * This is the evidence half of trust-on-first-use. The fetch is a TLS
 * handshake and nothing else — no request is written on that socket — and what
 * comes back is shown to the user, who confirms it, and only then is `pem`
 * stored as a connection's {@link SecretConnection.caPem}. Silent pinning
 * would be indistinguishable to the user from no verification at all.
 */
export interface SecretServerCertificate {
  /**
   * The leaf's SHA-256 fingerprint, colon-separated, as `openssl x509
   * -fingerprint -sha256` prints it.
   *
   * That format rather than a tidier one because this string exists to be
   * compared by a human against the output of that exact command, and a
   * fingerprint the user has to re-punctuate before comparing is a
   * fingerprint they will skim instead.
   */
  readonly fingerprintSha256: string;
  readonly subject: string;
  readonly issuer: string;
  /** Subject alternative names, so an address mismatch is visible up front. */
  readonly san: readonly string[];
  /** ISO-8601 expiry of the leaf. */
  readonly notAfter: string;
  /**
   * The PEM to store, which is the **issuer's** where the chain offered one
   * and the leaf's for a self-signed certificate. Pinning the leaf of a
   * CA-issued chain would break on the server's next renewal.
   */
  readonly pem: string;
  /** True when the chain ended at the leaf itself. */
  readonly selfSigned: boolean;
}

/**
 * What testing a reference came to.
 *
 * `keysAtPath` is the diagnostic that makes a failed test actionable, and it
 * is safe for exactly one reason: a key *name* is not a secret, and the whole
 * failure mode it addresses is a user who typed `git-token` where the store
 * says `git_token`. Values never appear here, on either outcome.
 */
export interface SecretRefTestResult {
  readonly found: boolean;
  /** The names beside it, when the manager was willing to say. Never values. */
  readonly keysAtPath?: readonly string[];
  /** Why not, in a sentence that distinguishes denied from absent. */
  readonly problem?: string;
}

/* -------------------------------------------------------------------------- */
/* Provider descriptors                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One field of a connection form or a reference form.
 *
 * Declarative because the alternative is a pane with a `switch (provider)` in
 * it, and that switch is how the second provider ends up half-supported: the
 * form knows OpenBao's fields, the validator knows OpenBao's fields, and
 * Doppler is whatever the person adding it remembered to touch. A provider
 * that declares its own fields cannot be forgotten by the form.
 */
export interface SecretField {
  /** Matches the property it fills on the connection or the ref. */
  readonly id: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly required: boolean;
  /** One line under the field. Worth writing for anything a user could guess wrong. */
  readonly note?: string;
  /**
   * `secret` renders masked and travels renderer → main once. A field marked
   * `secret` has no counterpart in any response.
   */
  readonly kind: 'text' | 'secret';
  /**
   * Shown only when the connection uses this authentication method.
   *
   * OpenBao's `username` is meaningless for a pasted token and required for a
   * `userpass` login, and a form that showed it either way would be asking for
   * a value that does nothing half the time. Absent means "always shown".
   */
  readonly onlyForAuthMethod?: SecretAuthMethod;
}

/** What a provider is, as far as the pane needs to know. */
export interface SecretProviderDescriptor {
  readonly id: SecretProviderId;
  readonly label: string;
  /** One line on what this manager is, for a user choosing between them. */
  readonly note: string;
  readonly authMethods: readonly SecretAuthMethod[];
  /** The connection's own fields, beyond label and auth method. */
  readonly configFields: readonly SecretField[];
  /** The fields one of this provider's references is made of. */
  readonly refFields: readonly SecretField[];
}
