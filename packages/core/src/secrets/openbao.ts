/**
 * OpenBao, and the four places its API does not mean what it looks like.
 * ============================================================================
 *
 * Written against a live OpenBao v2.6.2 rather than against the docs, because
 * four of its behaviours are load-bearing here and none of them is obvious
 * from a signature:
 *
 *  1. **403 is deliberately ambiguous.** A read of a path the token's policy
 *     does not cover, a read of a path that does not exist, and a read through
 *     a *mount* that does not exist all answer `403 permission denied`. That
 *     is a design decision on OpenBao's part — a 404 would let an unprivileged
 *     token map the tree by probing — and it means a client that renders 403
 *     as "not found" is lying to the user about which of three fixes to apply.
 *     Everything below says "denied, or absent, and it will not say which",
 *     names the mount as well as the path, and refuses to guess.
 *
 *  2. **404 is the *good* answer.** `404` with an empty `errors` array is the
 *     one response that proves the token could have read the secret if it were
 *     there. "Your token can reach this path and there is nothing at it" is
 *     the most useful sentence this integration can produce, and it is
 *     available exactly here.
 *
 *  3. **`auth/token/lookup-self` hands back the token.** `data.id` is the
 *     plaintext token, in the body of the call you make to find out when it
 *     expires. Passing that parsed object anywhere — into a log, into a
 *     result, into an error — publishes the credential. {@link lookupSelf}
 *     therefore rebuilds its answer field by field and `id` is not one of the
 *     fields.
 *
 *  4. **`sys/health` answers 429 for standby, not for throttling.** A standby
 *     node in a cluster is *usable* and reports itself with the status code
 *     every HTTP client on earth reads as rate limiting. Treating it as a
 *     failure takes a working manager off the air; treating it as a plain
 *     success hides the fact that the user is not talking to the active node.
 *     It is reported as a degraded success.
 *
 * ## KV v1 and KV v2 are different APIs wearing one name
 *
 * v2 reads `/v1/<mount>/data/<path>` and nests the secret at `data.data`; v1
 * reads `/v1/<mount>/<path>` and puts it flat at `data`. Nothing on the read
 * path says which a mount is. The `auto` ladder below asks the mount catalogue
 * first, falls back to probing, and — when policy refuses both questions —
 * says so rather than picking one and producing a 403 the user would read as a
 * missing secret.
 *
 * ## What never happens here
 *
 * No request is made without certificate verification; see `transport.ts`. No
 * value is cached, logged, or returned in an error. The only thing cached is
 * which engine version a mount runs, which is not a secret and is per session.
 */

import type {
  OpenBaoSecretRef,
  SecretConnection,
  SecretField,
  SecretProviderDescriptor,
  SecretRef,
  SecretVerifyResult,
} from '@rx-artemis/protocol';

import {
  SecretManagerError,
  type ResolvedSecret,
  type SecretCredential,
  type SecretHttpResponse,
  type SecretManagerProvider,
  type SecretMintedToken,
  type SecretRenewal,
  type SecretTransport,
} from './types.js';

/** OpenBao's own header. Not `Authorization`; it ignores that one. */
const TOKEN_HEADER = 'X-Vault-Token';

/**
 * Renew when less than a quarter of the token's life is left.
 *
 * A quarter rather than "when it is nearly gone", because renewal is
 * opportunistic: it happens on the way to a read the user asked for, and a
 * threshold tight enough to be exciting would put the renewal and the expiry
 * in the same minute on a machine that had been asleep. A quarter of a
 * 32-day OpenBao default is eight days of warning.
 */
export const RENEW_THRESHOLD = 0.25;

/* -------------------------------------------------------------------------- */
/* Reading OpenBao's answers                                                  */
/* -------------------------------------------------------------------------- */

function parseBody(response: SecretHttpResponse): Record<string, unknown> | null {
  if (response.body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(response.body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The `errors` array, which is present on every OpenBao failure and is
 * sometimes empty on purpose.
 *
 * Empty is not "no information" — on a 404 it is the whole message: the
 * request was authorised and there was nothing there.
 */
function errorsIn(body: Record<string, unknown> | null): readonly string[] {
  return body === null ? [] : strings(body['errors']);
}

/**
 * True when OpenBao said the words, however it wrapped them.
 *
 * `includes` rather than equality, because an *authenticated* denial does not
 * arrive as the bare string: OpenBao wraps policy failures in its multierror
 * formatter, so the body reads `1 error occurred:\n\t* permission denied\n\n`.
 * An equality check passes on the unauthenticated case and silently stops
 * matching the case that actually happens.
 */
function saysPermissionDenied(messages: readonly string[]): boolean {
  return messages.some((message) => message.toLowerCase().includes('permission denied'));
}

/** Join OpenBao's own words onto a sentence of ours, when it had any. */
function withMessages(sentence: string, messages: readonly string[]): string {
  return messages.length === 0 ? sentence : `${sentence} OpenBao said: ${messages.join('; ')}.`;
}

/**
 * A failed HTTP status, as a categorised refusal.
 *
 * `where` names the thing that was being read, in the user's vocabulary, so
 * the sentence works whether the 403 came from a secret, a mount catalogue or
 * a token lookup.
 */
function failureFor(response: SecretHttpResponse, where: string): SecretManagerError {
  const body = parseBody(response);
  const messages = errorsIn(body);

  if (response.status === 503) {
    return new SecretManagerError(
      'sealed',
      withMessages(
        `OpenBao is sealed, so ${where} cannot be read. It is running and holds nothing usable ` +
          'until someone unseals it — retrying will not help.',
        messages,
      ),
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers['retry-after'];
    return new SecretManagerError(
      'rate-limited',
      withMessages(
        `OpenBao is rate-limiting this client${retryAfter === undefined ? '' : `; it asked for ${retryAfter}s`}.`,
        messages,
      ),
    );
  }
  if (response.status === 403) {
    // Deliberately never the words "not found". See the file header.
    return new SecretManagerError(
      'denied',
      withMessages(
        `OpenBao refused ${where} (403). It answers identically for a path this token's policy ` +
          'does not allow, for a path that does not exist, and for a mount that does not exist, ' +
          'so this is "denied, or absent" and it will not say which. Check the policy and check ' +
          'that the mount name is right.',
        saysPermissionDenied(messages) ? [] : messages,
      ),
    );
  }
  if (response.status === 404) {
    return new SecretManagerError(
      'absent',
      messages.length === 0
        ? `This token can reach ${where} and there is nothing there. The path is readable and empty.`
        : withMessages(`OpenBao has nothing at ${where}.`, messages),
    );
  }
  if (response.status === 400) {
    return new SecretManagerError('protocol', withMessages(`OpenBao rejected the request for ${where}.`, messages));
  }
  return new SecretManagerError(
    'protocol',
    withMessages(`OpenBao answered ${response.status} for ${where}.`, messages),
  );
}

/**
 * Percent-encode a path for interpolation, segment by segment.
 *
 * Segment by segment because the separators have to survive: encoding the
 * whole string would turn `claude/artemis` into one segment named
 * `claude%2Fartemis`, which is a different secret. The grammar in
 * `protocol/secretRefs.ts` has already refused the segments that would change
 * what the URL addresses; this refuses the characters that would change where
 * the URL *ends*.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** `https://host:8200/` + `v1/…`, with exactly one slash between them. */
function apiUrl(address: string, path: string): string {
  return `${address.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

/** What `sys/health` said, as something other than a status code. */
export interface OpenBaoHealth {
  readonly reachable: boolean;
  readonly initialized: boolean;
  readonly sealed: boolean;
  readonly standby: boolean;
  readonly version: string | null;
  readonly detail: string;
}

/**
 * Turn `sys/health`'s four codes into four different sentences.
 *
 * The body parses on all four — OpenBao returns the same JSON document
 * whatever the status — so the flags are read from it rather than inferred,
 * and the status code is what disambiguates 200-active from 429-standby, which
 * the body alone does not.
 */
export function describeHealth(response: SecretHttpResponse): OpenBaoHealth {
  const body = parseBody(response);
  const initialized = body?.['initialized'] === true;
  const sealed = body?.['sealed'] === true;
  const standby = response.status === 429 || body?.['standby'] === true;
  const version = typeof body?.['version'] === 'string' ? (body['version'] as string) : null;

  if (response.status === 501 || (body !== null && !initialized)) {
    return {
      reachable: true,
      initialized: false,
      sealed,
      standby,
      version,
      detail: 'This OpenBao has never been initialised, so it holds nothing yet.',
    };
  }
  if (response.status === 503 || sealed) {
    return {
      reachable: true,
      initialized,
      sealed: true,
      standby,
      version,
      detail: 'OpenBao is sealed. It is running, and holds nothing usable until someone unseals it.',
    };
  }
  if (response.status === 429) {
    // The one status whose obvious reading is wrong. See the file header.
    return {
      reachable: true,
      initialized,
      sealed: false,
      standby: true,
      version,
      detail:
        'This is a standby node, which OpenBao reports with 429 — that is not rate limiting, and ' +
        'reads work. Writes are forwarded to the active node.',
    };
  }
  if (response.status === 200) {
    return {
      reachable: true,
      initialized: true,
      sealed: false,
      standby,
      version,
      detail: version === null ? 'OpenBao is active.' : `OpenBao ${version} is active.`,
    };
  }
  return {
    reachable: false,
    initialized,
    sealed,
    standby,
    version,
    detail: `OpenBao answered ${response.status} to an unauthenticated health check, which is not one of the four states it defines.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Token introspection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What a token is, with the token itself deliberately absent.
 *
 * `data.id` in OpenBao's own answer **is the plaintext token**. This shape has
 * no field it could occupy, which is the point: a caller cannot accidentally
 * log the credential by logging the thing it looked up.
 */
export interface OpenBaoTokenInfo {
  readonly policies: readonly string[];
  /** Seconds left. `0` for a token with no expiry. */
  readonly ttl: number;
  /** Seconds it was minted for. `0` for a token with no expiry. */
  readonly creationTtl: number;
  /** ISO-8601, or `null` for a token that does not expire. */
  readonly expireTime: string | null;
  readonly displayName: string;
}

/**
 * Rebuild `lookup-self`'s answer, field by field.
 *
 * Rebuilt rather than narrowed by a type assertion, because a type assertion
 * is a claim about a value the compiler will not check at runtime — and the
 * value in question has the credential in it. Copying five named fields is the
 * only version of this that is true after the code is compiled away.
 */
export function readTokenInfo(body: Record<string, unknown> | null): OpenBaoTokenInfo {
  const data = record(body?.['data']);
  if (data === null) {
    throw new SecretManagerError('protocol', 'OpenBao’s token lookup had no data in it.');
  }
  const ttl = typeof data['ttl'] === 'number' ? data['ttl'] : 0;
  const creationTtl = typeof data['creation_ttl'] === 'number' ? data['creation_ttl'] : 0;
  const expireTime = typeof data['expire_time'] === 'string' ? data['expire_time'] : null;
  const displayName = typeof data['display_name'] === 'string' ? data['display_name'] : 'unknown';
  return { policies: strings(data['policies']), ttl, creationTtl, expireTime, displayName };
}

/**
 * Is this token worth renewing yet?
 *
 * Pure, and separate from the request that acts on it, because the threshold
 * is the part with a judgment in it and a judgment deserves a test. A token
 * with no expiry (`creationTtl === 0`) is never renewed — there is nothing to
 * extend, and asking would produce an error about a healthy token.
 */
export function shouldRenewToken(info: Pick<OpenBaoTokenInfo, 'ttl' | 'creationTtl'>): boolean {
  if (info.creationTtl <= 0) return false;
  if (info.ttl <= 0) return false;
  return info.ttl < info.creationTtl * RENEW_THRESHOLD;
}

/* -------------------------------------------------------------------------- */
/* The provider                                                               */
/* -------------------------------------------------------------------------- */

const CONFIG_FIELDS: readonly SecretField[] = [
  {
    id: 'address',
    label: 'Address',
    placeholder: 'https://vault.example.com:8200',
    required: true,
    kind: 'text',
    note: 'The API address, including the port. https unless it is a dev server on this machine.',
  },
  {
    id: 'username',
    label: 'Username',
    placeholder: 'your-openbao-user',
    required: true,
    kind: 'text',
    onlyForAuthMethod: 'userpass',
    note: 'The userpass account. Its password is spent once, here, on minting a token — Artemis stores the token, never the password.',
  },
];

const REF_FIELDS: readonly SecretField[] = [
  { id: 'mount', label: 'Mount', placeholder: 'secret', required: true, kind: 'text' },
  {
    id: 'path',
    label: 'Path',
    placeholder: 'team/git',
    required: true,
    kind: 'text',
    note: 'The path within the mount, without a leading slash.',
  },
  {
    id: 'key',
    label: 'Key',
    placeholder: 'git_token',
    required: true,
    kind: 'text',
    note: 'The entry inside that secret. Test the reference to see which names are there.',
  },
];

/**
 * Build the OpenBao provider over a transport.
 *
 * A factory rather than a singleton so tests can hand it canned bytes, and so
 * the mount-version cache belongs to one instance rather than to the module —
 * two Artemis windows are two processes, but a test file is one.
 */
export function createOpenBaoProvider(transport: SecretTransport): SecretManagerProvider {
  /**
   * Which KV engine a mount runs, per connection, for this session.
   *
   * Cached because the detection ladder can cost two extra round trips and the
   * answer changes only when someone remounts an engine — which is not a thing
   * that happens while a settings pane is open. Keyed by connection as well as
   * mount, because two connections can address different servers whose
   * `secret/` mounts disagree.
   */
  const versions = new Map<string, 1 | 2>();

  async function call(
    config: SecretConnection,
    path: string,
    init: { method?: 'GET' | 'POST'; token?: string; body?: unknown },
  ): Promise<SecretHttpResponse> {
    return transport({
      method: init.method ?? 'GET',
      url: apiUrl(config.address, path),
      headers: {
        accept: 'application/json',
        ...(init.token === undefined ? {} : { [TOKEN_HEADER]: init.token }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(config.caPem === undefined ? {} : { caPem: config.caPem }),
    });
  }

  async function health(config: SecretConnection): Promise<OpenBaoHealth> {
    // Unauthenticated on purpose: this has to answer for a manager whose token
    // is the thing under suspicion, and `sys/health` is the one endpoint that
    // will talk to an anonymous client.
    return describeHealth(await call(config, 'v1/sys/health', {}));
  }

  async function lookupSelf(
    config: SecretConnection,
    credential: SecretCredential,
  ): Promise<OpenBaoTokenInfo> {
    const response = await call(config, 'v1/auth/token/lookup-self', { token: credential.token });
    if (response.status === 403) {
      throw new SecretManagerError(
        'expired',
        'OpenBao refused this token. It has expired, been revoked, or was never valid — sign in again.',
      );
    }
    if (response.status !== 200) throw failureFor(response, 'this token');
    // The parsed body carries the plaintext token at `data.id`. It goes into
    // `readTokenInfo` and nowhere else, and what comes back has no field for it.
    return readTokenInfo(parseBody(response));
  }

  /**
   * Decide which KV engine a mount runs.
   *
   * The ladder, in order, and the last rung is the interesting one:
   *
   *  1. The user said. Nothing beats being told.
   *  2. The mount catalogue (`sys/internal/ui/mounts/<mount>`) reports
   *     `data.options.version` as the *string* `'2'`. This is the cheap,
   *     authoritative answer and most tokens can read it.
   *  3. It is 403 for a token whose policy is scoped to one path. So probe the
   *     v2 URL: a 200 or a 404 both prove the endpoint exists, which means the
   *     mount is v2 (a v1 mount has no `/data/` child). Only a 403 there is
   *     ambiguous, and then the v1 URL gets the same treatment.
   *  4. Both refused. **Stop.** Guessing produces a 403 from the wrong URL,
   *     which the user reads as "my secret is missing" and acts on by
   *     rewriting a path that was correct.
   */
  async function kvVersion(
    config: SecretConnection,
    credential: SecretCredential,
    ref: OpenBaoSecretRef,
  ): Promise<1 | 2> {
    const requested = ref.kvVersion ?? 2;
    if (requested === 1 || requested === 2) return requested;

    const cacheKey = `${ref.connectionId}\u0000${ref.mount}`;
    const cached = versions.get(cacheKey);
    if (cached !== undefined) return cached;

    const catalogue = await call(config, `v1/sys/internal/ui/mounts/${encodePath(ref.mount)}`, {
      token: credential.token,
    });
    if (catalogue.status === 200) {
      const options = record(record(parseBody(catalogue)?.['data'])?.['options']);
      const version = options?.['version'] === '2' ? 2 : 1;
      versions.set(cacheKey, version);
      return version;
    }

    const v2Probe = await call(config, `v1/${encodePath(ref.mount)}/data/${encodePath(ref.path)}`, {
      token: credential.token,
    });
    if (v2Probe.status === 200 || v2Probe.status === 404) {
      versions.set(cacheKey, 2);
      return 2;
    }
    if (v2Probe.status !== 403) throw failureFor(v2Probe, `${ref.mount}/${ref.path}`);

    const v1Probe = await call(config, `v1/${encodePath(ref.mount)}/${encodePath(ref.path)}`, {
      token: credential.token,
    });
    if (v1Probe.status === 200 || v1Probe.status === 404) {
      versions.set(cacheKey, 1);
      return 1;
    }
    if (v1Probe.status !== 403) throw failureFor(v1Probe, `${ref.mount}/${ref.path}`);

    throw new SecretManagerError(
      'undetermined',
      `This token may not read the mount catalogue for “${ref.mount}”, and both the KV v1 and KV v2 ` +
        'read paths answered 403 — so which engine that mount runs cannot be established, and ' +
        'guessing would report a policy problem as a missing secret. Set the KV version on the ' +
        'reference, or grant the token read on the mount.',
    );
  }

  /**
   * The secret's map at a path, for whichever engine version the mount runs.
   *
   * The two versions differ in the URL *and* in the nesting, which is why this
   * is one function with a branch rather than two call sites: the branch is
   * the whole of the difference and keeping it in one place is what stops a
   * v1 mount being read with v2's unwrapping.
   */
  async function readSecretMap(
    config: SecretConnection,
    credential: SecretCredential,
    ref: OpenBaoSecretRef,
    version: 1 | 2,
  ): Promise<Record<string, unknown>> {
    const where = `${ref.mount}/${ref.path}`;
    const url =
      version === 2
        ? `v1/${encodePath(ref.mount)}/data/${encodePath(ref.path)}`
        : `v1/${encodePath(ref.mount)}/${encodePath(ref.path)}`;
    const response = await call(config, url, { token: credential.token });
    if (response.status !== 200) throw failureFor(response, where);

    const body = parseBody(response);
    const outer = record(body?.['data']);
    if (outer === null) {
      throw new SecretManagerError('protocol', `OpenBao's answer for ${where} had no data in it.`);
    }
    if (version === 1) return outer;

    const inner = record(outer['data']);
    if (inner === null) {
      // v2 keeps a tombstone: the version is gone and its metadata is not.
      // Saying "empty" here would send the user looking for a typo.
      const deletionTime = record(outer['metadata'])?.['deletion_time'];
      if (typeof deletionTime === 'string' && deletionTime.length > 0) {
        throw new SecretManagerError(
          'deleted-version',
          `The current version of ${where} was deleted on ${deletionTime}. Undelete it in OpenBao, ` +
            'or write a new version.',
        );
      }
      throw new SecretManagerError('protocol', `OpenBao's KV v2 answer for ${where} had no secret in it.`);
    }
    return inner;
  }

  const describe = (): SecretProviderDescriptor => ({
    id: 'openbao',
    label: 'OpenBao',
    note: 'Self-hosted secrets with policies and short-lived tokens. Also speaks to HashiCorp Vault.',
    authMethods: ['userpass', 'token'],
    configFields: CONFIG_FIELDS,
    refFields: REF_FIELDS,
  });

  return {
    id: 'openbao',
    label: 'OpenBao',
    note: describe().note,
    authMethods: ['userpass', 'token'],
    configFields: CONFIG_FIELDS,
    refFields: REF_FIELDS,
    describe,

    async login(config, username, password): Promise<SecretMintedToken> {
      // The username is a path segment, so it is escaped rather than trusted:
      // an account named with a slash would otherwise address a different
      // auth method entirely.
      const response = await call(config, `v1/auth/userpass/login/${encodeURIComponent(username)}`, {
        method: 'POST',
        body: { password },
      });
      if (response.status === 400) {
        // 400 here is *not* "malformed request" — OpenBao answers a wrong
        // username or password with it, and reporting it as a protocol error
        // sends the user to check their address instead of their password.
        throw new SecretManagerError(
          'bad-credentials',
          'OpenBao refused that username and password.',
        );
      }
      if (response.status !== 200) throw failureFor(response, 'the userpass login');

      const auth = record(parseBody(response)?.['auth']);
      const token = typeof auth?.['client_token'] === 'string' ? (auth['client_token'] as string) : '';
      if (token.length === 0) {
        throw new SecretManagerError('protocol', 'OpenBao’s login answer carried no token.');
      }
      const lease = typeof auth?.['lease_duration'] === 'number' ? (auth['lease_duration'] as number) : 0;
      const policies = strings(auth?.['token_policies'] ?? auth?.['policies']);
      const identity = record(auth?.['metadata'])?.['username'];
      return {
        token,
        ...(lease > 0 ? { expiresAt: Date.now() + lease * 1000 } : {}),
        renewable: auth?.['renewable'] === true,
        policies,
        ...(typeof identity === 'string' ? { identity } : { identity: username }),
      };
    },

    async verify(config, credential): Promise<SecretVerifyResult> {
      // Health first, unauthenticated, because it is the only question that
      // distinguishes "your token is bad" from "this manager is sealed" — and
      // an authenticated call against a sealed OpenBao produces a 503 that
      // reads like an outage.
      const state = await health(config);
      if (!state.initialized) {
        return { ok: false, detail: state.detail };
      }
      if (state.sealed) {
        return { ok: false, detail: state.detail, degraded: 'sealed', problem: 'sealed' };
      }

      const info = await lookupSelf(config, credential);
      const expiry =
        info.expireTime === null
          ? 'It does not expire.'
          : `It expires ${info.expireTime}.`;
      return {
        ok: true,
        detail: `${state.detail} ${expiry}`,
        identity: info.displayName,
        policies: info.policies,
        ...(info.expireTime === null ? {} : { expiresAt: info.expireTime }),
        ...(state.standby ? { degraded: 'standby' as const } : {}),
      };
    },

    async renew(config, credential): Promise<SecretRenewal> {
      // Never throws: this is housekeeping on the way to something the user
      // asked for, and a manager that will not extend a token has not broken
      // the token — it has told us when it stops.
      try {
        const info = await lookupSelf(config, credential);
        if (!shouldRenewToken(info)) {
          return {
            renewed: false,
            ...(info.expireTime === null ? {} : { expiresAt: Date.parse(info.expireTime) }),
            detail: 'The token has plenty of life left; nothing to renew.',
          };
        }
        const response = await call(config, 'v1/auth/token/renew-self', {
          method: 'POST',
          token: credential.token,
        });
        if (response.status !== 200) {
          return {
            renewed: false,
            detail:
              'OpenBao would not extend this token, so it will need signing in again when it expires.',
          };
        }
        // Read back rather than assume. OpenBao may grant less than asked —
        // a role's max TTL, a period — and a client that recorded its own
        // request would believe in an expiry the token does not have.
        const auth = record(parseBody(response)?.['auth']);
        const lease = typeof auth?.['lease_duration'] === 'number' ? (auth['lease_duration'] as number) : 0;
        return {
          renewed: true,
          ...(lease > 0 ? { expiresAt: Date.now() + lease * 1000 } : {}),
          detail:
            lease > 0
              ? `Renewed; OpenBao granted ${lease}s.`
              : 'Renewed, and OpenBao stated no new lease.',
        };
      } catch {
        return {
          renewed: false,
          detail: 'The token could not be renewed, so it will need signing in again when it expires.',
        };
      }
    },

    async resolve(config, credential, ref: SecretRef): Promise<ResolvedSecret> {
      if (ref.provider !== 'openbao') {
        throw new SecretManagerError('protocol', 'That reference is not an OpenBao reference.');
      }
      const version = await kvVersion(config, credential, ref);
      const map = await readSecretMap(config, credential, ref, version);
      const value = map[ref.key];
      if (typeof value !== 'string') {
        const names = Object.keys(map);
        // The names, never the values: this is the diagnostic that turns
        // "could not read the secret" into "you wrote git-token, it is
        // git_token", and a name is not a credential.
        throw new SecretManagerError(
          'missing-key',
          value === undefined
            ? `${ref.mount}/${ref.path} has no key named “${ref.key}”. It has: ${names.join(', ') || '(nothing)'}.`
            : `${ref.mount}/${ref.path} has “${ref.key}”, but it is not a string.`,
          names,
        );
      }
      return {
        value,
        siblingKeys: Object.keys(map),
        // Nothing to release: the value was never stored anywhere in core.
        // The registration that *does* need ending belongs to the caller.
        dispose: () => undefined,
      };
    },

    forget(connectionId: string): void {
      for (const key of [...versions.keys()]) {
        if (key.startsWith(`${connectionId}\u0000`)) versions.delete(key);
      }
    },
  };
}
