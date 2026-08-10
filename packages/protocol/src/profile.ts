/**
 * Profiles: named environment-variable bundles.
 *
 * A profile is how Apollo switches accounts. It bundles a credential, a backend
 * selection, and an isolated config directory. Providers that key their session
 * store on that directory — Claude keys it on `$CLAUDE_CONFIG_DIR` — give each
 * profile isolated credentials *and* isolated history in one move.
 *
 * This file describes the *shape* of a profile and nothing about how any
 * particular provider consumes it. Variable names, backend lists and the
 * credential-to-environment mapping live with the adapter that owns them; a
 * provider-neutral package that hard-codes one vendor's vocabulary makes every
 * other provider a special case.
 *
 * Two rules govern this file, and they are not negotiable:
 *
 *  1. **Apollo never performs an interactive login.** A profile holds a
 *     credential the *user* obtained and pasted in. There is no OAuth flow
 *     here, no browser handoff, no token refresh, and no code that could grow
 *     into one. Which kinds of credential a provider accepts is the provider's
 *     business — see {@link ProviderAuthMode} — but every one of them arrives
 *     the same way: the user brings it.
 *  2. **Secrets never travel to the renderer.** {@link Profile} lives in the
 *     main process. The renderer sees {@link ProfileMetadata}, which carries a
 *     masked hint and nothing more. The secret itself is referenced by
 *     {@link Profile.secretRef} — a handle into encrypted OS storage, never the
 *     value.
 *
 * Secrets *may* travel renderer → main, once, when the user types a key into
 * the profile editor. That direction is unavoidable and safe; the reverse is
 * never allowed.
 */

import type { ProfileId } from './ids.js';
import type { ProviderId } from './provider.js';

/**
 * Which hosting backend a profile's credential is for.
 *
 * **Deliberately opaque.** This used to be the union
 * `'anthropic' | 'bedrock' | 'vertex' | 'foundry'` — which is Claude's list,
 * not a universal one. Sitting in the provider-neutral protocol package it
 * applied to every provider, so a Codex or OpenCode profile had to declare an
 * Anthropic hosting backend or leave the field undefined, and the type system
 * actively rejected the correct value at the IPC boundary. That contradicts
 * this package's own rule that the seam cannot be Claude-shaped.
 *
 * The set of valid backends is a property of the *provider*, so each adapter
 * declares its own and publishes them on
 * `ProviderDescriptor.backends`. The UI builds its picker from that list, the
 * same way it already builds the permission-mode picker from
 * {@link Capabilities.permissionModes}. Semantic validation ("does this
 * provider have a backend called `bedrock`?") belongs wherever the adapter is
 * reachable; {@link isProviderBackend} only checks the shape.
 */
export type ProviderBackend = string;

/** A backend id: lower-case, short, and safe to use as an object key. */
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Shape check for a {@link ProviderBackend}.
 *
 * Answers "could this be a backend id?", not "does this provider have one by
 * that name?" — the second question needs the adapter, which this package
 * cannot see. The authoritative check happens when the credential environment
 * is resolved against the provider's declared backend list.
 */
export function isProviderBackend(value: unknown): value is ProviderBackend {
  return typeof value === 'string' && BACKEND_ID_PATTERN.test(value);
}

/**
 * How a profile's credential authenticates — and therefore what gets billed.
 *
 * **Deliberately opaque, for the same reason {@link ProviderBackend} is.** The
 * modes Apollo ships today are Claude's (`api-key` and `subscription`), and
 * naming them in this package would make them universal facts about every
 * provider rather than one adapter's vocabulary. Each adapter declares its own
 * list and publishes it as `ProviderDescriptor.authModes`; the UI builds its
 * picker from that.
 *
 * The axis exists because the choice is not cosmetic. For Claude, an API key
 * bills metered API usage, while a subscription token bills a Pro/Max/Team plan
 * — and the two credentials travel in *different environment variables*, one of
 * which silently overrides the other when both are present. A profile therefore
 * has to say which one it means, and the resolver has to make sure the other
 * cannot arrive from the ambient environment behind the user's back.
 *
 * Absent on a profile means "the provider's first declared mode".
 */
export type ProviderAuthMode = string;

/** An auth-mode id: lower-case, short, and safe to use as an object key. */
const AUTH_MODE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Shape check for a {@link ProviderAuthMode}.
 *
 * Answers "could this be an auth-mode id?", not "does this provider have one by
 * that name?" — the second question needs the adapter, which this package
 * cannot see. The authoritative check, including whether the mode is valid on
 * the profile's backend, happens when the credential environment is resolved.
 */
export function isProviderAuthMode(value: unknown): value is ProviderAuthMode {
  return typeof value === 'string' && AUTH_MODE_ID_PATTERN.test(value);
}

/**
 * A stored profile. **Main process only.**
 *
 * This type must never be sent over IPC. If you find yourself wanting to, you
 * want {@link ProfileMetadata}.
 */
export interface Profile {
  readonly id: ProfileId;
  /** User-chosen display name, e.g. "Work — Bedrock". */
  readonly label: string;
  readonly providerId: ProviderId;
  /**
   * One of the backends {@link providerId}'s adapter declares. Absent means
   * that provider's default backend.
   */
  readonly backend?: ProviderBackend;

  /**
   * One of the auth modes {@link providerId}'s adapter declares. Absent means
   * that provider's default mode.
   *
   * This decides which variable {@link secretRef}'s value is emitted as, and
   * therefore which account is billed. It is a property of the *profile* on
   * purpose: billing must never be decided by whatever happens to be exported
   * in the shell that launched Apollo.
   */
  readonly authMode?: ProviderAuthMode;

  /**
   * Directory name (not a full path) for this profile's isolated provider
   * config directory. Resolved against Apollo's user-data directory. Keeping it
   * a bare name means a profile record can never point at an arbitrary
   * location on disk.
   *
   * Which *variable* points the provider at it is the adapter's business —
   * `CLAUDE_CONFIG_DIR` for Claude, something else for the next provider.
   */
  readonly configDirName: string;

  /**
   * Handle into encrypted OS storage — **never the secret itself**. Reading it
   * is a main-process operation guarded by the secret store.
   */
  readonly secretRef: string;

  /**
   * Non-sensitive environment variables merged into the agent's environment,
   * e.g. `ANTHROPIC_MODEL`, `AWS_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`.
   *
   * Validate with {@link isSecretEnvKey} *and*
   * {@link isCredentialRoutingEnvKey} before writing: anything that looks like
   * a credential belongs in the secret store, and anything that decides where
   * the credential is *sent* belongs to Apollo rather than to the profile.
   */
  readonly publicEnv: Readonly<Record<string, string>>;

  /** Creation time, ms since epoch. */
  readonly createdAt?: number;
  /** Last modification time, ms since epoch. */
  readonly updatedAt?: number;
}

/**
 * The renderer-safe projection of a {@link Profile}.
 *
 * This is the *only* profile shape allowed across the IPC boundary into the
 * renderer. It deliberately omits `secretRef`, `configDirName` and `publicEnv`:
 * the renderer has no use for a storage handle, a filesystem location, or an
 * env bundle, and each of those is a leak waiting to happen.
 */
export interface ProfileMetadata {
  readonly id: ProfileId;
  readonly label: string;
  readonly providerId: ProviderId;
  /** Absent means the provider's default backend. */
  readonly backend?: ProviderBackend;
  /**
   * Which auth mode — and therefore which billing arrangement — this profile
   * uses. Absent means the provider's default mode.
   *
   * Carried into the renderer deliberately: "am I about to spend API credit or
   * my subscription allowance?" is a question the user must be able to answer
   * by looking at the profile, and the id is not a secret.
   */
  readonly authMode?: ProviderAuthMode;
  /**
   * Masked credential hint for display, e.g. `"sk-ant-...4f2a"`.
   *
   * `null` when the profile has no credential stored yet — the UI should show
   * it as needing setup. Produced by {@link maskApiKey}; never assembled by
   * hand, and never anything from which a key could be reconstructed.
   */
  readonly keyHint: string | null;
}

/**
 * Fields the renderer supplies when creating a profile.
 *
 * {@link apiKey} is the one place a secret legitimately crosses IPC, and only
 * renderer → main. The main process writes it straight into encrypted storage
 * and returns {@link ProfileMetadata}; the plaintext never comes back.
 */
export interface ProfileDraft {
  readonly label: string;
  readonly providerId: ProviderId;
  readonly backend?: ProviderBackend;
  /**
   * Which auth mode the credential below is for. Omit for the provider's
   * default mode.
   */
  readonly authMode?: ProviderAuthMode;
  /**
   * Plaintext credential for the selected {@link authMode}. Required whenever
   * the chosen backend and mode both say a secret is needed; omitted for
   * backends that authenticate from an ambient credential chain.
   *
   * Named `apiKey` for continuity, but it is whatever the mode expects — an API
   * key, or a subscription token the user minted themselves. Apollo does not
   * mint it either way.
   */
  readonly apiKey?: string;
  readonly publicEnv?: Readonly<Record<string, string>>;
  /**
   * Override the generated config directory name. Must be a bare directory
   * name — no separators, no `..`. Normally omitted.
   */
  readonly configDirName?: string;
}

/**
 * Fields the renderer may change on an existing profile.
 *
 * `apiKey` is tri-state: omit to leave the stored credential alone, pass a
 * string to replace it, pass `null` to delete it.
 */
export interface ProfilePatch {
  readonly label?: string;
  readonly backend?: ProviderBackend;
  /**
   * Switch the profile's auth mode. Omit to leave it alone.
   *
   * Changing this changes what gets billed, and the stored credential is *not*
   * migrated: a key is not a subscription token. Send `apiKey` alongside it.
   */
  readonly authMode?: ProviderAuthMode;
  readonly apiKey?: string | null;
  readonly publicEnv?: Readonly<Record<string, string>>;
}

/**
 * Mask a credential for display.
 *
 * Keeps a recognisable prefix and the last four characters, so a user can tell
 * two keys apart without the masked form being useful to anyone else.
 *
 * ```ts
 * maskApiKey('sk-ant-api03-Zx9...q4f2a') // → 'sk-ant-...4f2a'
 * ```
 *
 * Short or empty inputs collapse to a fixed placeholder rather than leaking a
 * high proportion of their characters.
 *
 * @param key      the plaintext credential
 * @param visible  how many trailing characters to keep (default 4)
 */
export function maskApiKey(key: string | null | undefined, visible = 4): string | null {
  if (key === null || key === undefined) return null;
  const trimmed = key.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= visible * 2) return '••••';

  const tail = trimmed.slice(-visible);
  // Preserve a leading vendor prefix like `sk-ant-` when there is one, because
  // it tells the user which kind of credential they are looking at.
  const prefixMatch = /^([A-Za-z]{2,8}-[A-Za-z]{2,8}-)/.exec(trimmed);
  const prefix = prefixMatch?.[1] ?? trimmed.slice(0, 3);
  return `${prefix}...${tail}`;
}

/**
 * Does this credential look like what the chosen auth mode expects?
 *
 * A malformed credential is otherwise invisible until a run fails, and the
 * failure it produces is opaque: the provider answers `401 invalid bearer
 * token`, which says nothing about *why*. Catching the obvious cases at entry
 * turns a mid-run mystery into a message next to the field the user just typed
 * into.
 *
 * This is deliberately a **warning, not a rejection**. Vendor prefixes are a
 * convention, not a contract — they have changed before and will again, and a
 * hard block would lock a user out of a credential that works perfectly well.
 * Callers should surface the message and still let the save proceed.
 *
 * Returns `null` when nothing looks wrong, or when there is nothing to judge.
 */
export function credentialShapeWarning(
  secret: string | null | undefined,
  authMode: ProviderAuthMode | undefined,
): string | null {
  if (secret === null || secret === undefined) return null;
  const trimmed = secret.trim();
  if (trimmed.length === 0) return null;

  // Whitespace inside a credential is nearly always a broken copy-paste — a
  // wrapped terminal line, or a selection that swallowed a trailing newline.
  if (/\s/.test(trimmed)) {
    return 'That looks like it contains a space or line break. Credentials are a single unbroken string — check the copy.';
  }

  // The single most likely mistake, and the one that motivated this check.
  //
  // `claude setup-token` opens a browser. When the browser cannot reach the
  // CLI's local callback server — common over SSH, in WSL2 and in containers —
  // it displays a LOGIN CODE instead of redirecting. That code is an OAuth
  // authorization code and its state parameter joined by "#", and it belongs in
  // the terminal, at the CLI's "Paste code here if prompted" prompt. The token
  // is what the terminal prints *afterwards*.
  //
  // Pasted here instead, it is sent as a bearer token and comes back as a bare
  // `401 invalid bearer token`, which points at nothing.
  if (trimmed.includes('#') && !trimmed.startsWith('sk-ant-')) {
    return 'That looks like the login code from the browser, not the token. Paste it back into the terminal at the “Paste code here if prompted” prompt — `claude setup-token` prints the actual token after that.';
  }

  // Anthropic credentials are `sk-ant-…`. Anything else is worth flagging
  // before it becomes a 401 twenty seconds into a run.
  if (!trimmed.startsWith('sk-ant-')) {
    return authMode === 'subscription'
      ? 'That does not look like a token from `claude setup-token`. Check you pasted the token the terminal printed, rather than a code from the browser page.'
      : 'That does not look like an Anthropic API key, which starts with "sk-ant-". Check you pasted the right value.';
  }

  // Right vendor, wrong kind. An API key in subscription mode would be sent as
  // a bearer token and rejected; a subscription token in api-key mode would be
  // sent as `x-api-key` and rejected. Both fail identically and confusingly.
  const looksLikeOAuthToken = trimmed.startsWith('sk-ant-oat');
  const looksLikeApiKey = trimmed.startsWith('sk-ant-api');

  // Only judge the pairing when a mode was actually chosen. A provider that
  // declares no auth modes leaves `authMode` undefined, and there is no
  // mismatch to report against a choice the user never made.
  if (authMode === undefined) return null;

  if (authMode === 'subscription' && looksLikeApiKey) {
    return 'That looks like an API key, but this profile is set to subscription billing. Either switch this profile to API key, or paste the token from `claude setup-token`.';
  }
  if (authMode !== 'subscription' && looksLikeOAuthToken) {
    return 'That looks like a subscription token from `claude setup-token`, but this profile is set to API key billing. Either switch this profile to subscription, or paste an API key.';
  }

  return null;
}

/**
 * Environment variable names that must never be stored in
 * {@link Profile.publicEnv}.
 *
 * A heuristic, not a proof — but it catches the realistic mistakes (someone
 * pasting `ANTHROPIC_AUTH_TOKEN` into the "extra env vars" box) before they
 * reach a file that is not encrypted.
 */
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** True when `name` looks like it would hold a credential. */
export function isSecretEnvKey(name: string): boolean {
  return SECRET_ENV_PATTERN.test(name);
}

/**
 * Variables that decide **where a credential is sent**, rather than what it is.
 *
 * {@link isSecretEnvKey} asks "does this hold a secret?". That is the wrong
 * question for a variable like `ANTHROPIC_BASE_URL`: it holds no secret, passes
 * the name heuristic cleanly, and yet points the provider — and therefore the
 * decrypted API key — at a host of the caller's choosing. A renderer that could
 * write one into `publicEnv` would exfiltrate the key without any secret ever
 * crossing IPC, defeating the masked `keyHint`, the leak scanner and
 * {@link ProfileMetadata} all at once.
 *
 * Four families, all of which redirect or expose traffic that carries the key:
 *
 *  - **endpoint overrides** — send the request somewhere else outright.
 *  - **proxies** — route it through a host that can observe or alter it.
 *  - **TLS trust** — make interception by such a host undetectable.
 *  - **runtime injection** — `NODE_OPTIONS` can `--require` arbitrary code into
 *    the provider process, which holds the plaintext key in memory.
 *
 * A profile legitimately needs none of these: region and model selection go in
 * `publicEnv`, but *routing* is Apollo's to decide. Enforced at the IPC boundary
 * and again in the profile store, so a hand-edited `profiles.json` is covered
 * too.
 *
 * Matching is case-insensitive. POSIX environments are case-sensitive, but
 * `http_proxy` and `HTTP_PROXY` are both honoured in the wild, so a
 * case-sensitive list would be trivially bypassed.
 */
const CREDENTIAL_ROUTING_ENV_KEYS: readonly string[] = [
  // endpoint overrides
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_BEDROCK',
  'OPENAI_BASE_URL',
  // proxies (NO_PROXY is here because it can *disable* a trusted proxy)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'PROXY',
  // TLS trust
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // runtime injection into the process holding the key
  'NODE_OPTIONS',
];

const CREDENTIAL_ROUTING_ENV_KEY_SET: ReadonlySet<string> = new Set(CREDENTIAL_ROUTING_ENV_KEYS);

/**
 * True when `name` decides where a credential is sent or who can read it.
 *
 * Companion to {@link isSecretEnvKey}: that one rejects names that would *hold*
 * a secret, this one rejects names that would *redirect* it.
 */
export function isCredentialRoutingEnvKey(name: string): boolean {
  return CREDENTIAL_ROUTING_ENV_KEY_SET.has(name.toUpperCase());
}
