/**
 * The machine's key managers, from the main process's side.
 * ============================================================================
 *
 * `core/secrets` knows how to talk to OpenBao and Doppler. This module knows
 * *which* managers this machine has, where their credentials are encrypted,
 * and — the part with the most rules attached — what happens to a value
 * between being fetched and being used.
 *
 * ## The one thing this file is really for
 *
 * ```
 *   resolve(ref) ─┬─▶ registerLiveSecret(value)   ← scrubbed out of every log
 *                 └─▶ { value, dispose } ─▶ caller uses it ─▶ dispose()
 * ```
 *
 * A resolved value exists for the length of one operation and is protected for
 * exactly that long. It is never written to disk, never returned over IPC,
 * never cached against the next call, and never used as a fallback when a
 * later resolution fails — a stale token silently kept alive is the failure
 * mode a key manager exists to remove, and reintroducing it inside the
 * integration would be the worst possible place for it.
 *
 * ## Two stores, and why they are two
 *
 * `secret-managers.json` holds the connections: label, provider, address,
 * certificate, username, and the last verification. Plain JSON, readable, and
 * carrying nothing that authenticates. Credentials live in
 * `secretManagerSecrets.ts`, encrypted, in their own file — the same split
 * `profiles.json` / `profile-keys.json` makes, for the same reason: the plain
 * file is a thing a user can open and check.
 *
 * ## Certificates are trusted on purpose or not at all
 *
 * {@link fetchServerCertificate} opens a TLS socket with verification off,
 * reads the chain, and closes it **without writing a byte of HTTP**. That is
 * the only unverified socket in this feature and it is not a request: nothing
 * is sent, so there is nothing to intercept. What it produces is evidence for
 * a person — a fingerprint, the SANs, an expiry — and only after that person
 * says yes does the certificate become a connection's `caPem`, after which
 * every real request verifies against it. See `core/secrets/transport.ts` for
 * why the popular alternative (verify nothing, compare the fingerprint
 * afterwards) protects nothing at all.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect as tlsConnect, type DetailedPeerCertificate, type PeerCertificate } from 'node:tls';
import { join } from 'node:path';

import {
  createSecretProviders,
  DOPPLER_API_BASE,
  SecretManagerError,
  type ResolvedSecret,
  type SecretManagerCredentials,
  type SecretManagerProvider,
} from '@rx-artemis/core';
import type {
  SecretConnection,
  SecretConnectionState,
  SecretProviderDescriptor,
  SecretProviderId,
  SecretRef,
  SecretRefTestResult,
  SecretServerCertificate,
  SecretVerifyRecord,
  SecretVerifyResult,
  SecretsConnectionDeleteRequest,
  SecretsConnectionSaveRequest,
  SecretsConnectionSaveResponse,
  SecretsConnectionVerifyRequest,
  SecretsConnectionVerifyResponse,
  SecretsConnectionsResponse,
  SecretsFetchServerCertRequest,
  SecretsRefTestRequest,
} from '@rx-artemis/protocol';

import { WorkspaceError } from './errors.js';
import { createLogger } from './log.js';
import { registerLiveSecret, scrubSecrets } from './redact.js';

const log = createLogger('secret-managers');

/** Beside `profiles.json`, and never holding anything that authenticates. */
const REGISTRY_FILE = 'secret-managers.json';

/** How long a handshake is worth waiting for with a person watching. */
const CERT_TIMEOUT_MS = 10_000;

/**
 * How often one connection's token is checked for renewal.
 *
 * Renewal is opportunistic — it rides along with a resolution the user asked
 * for — and the check itself costs a round trip. A background sync resolving
 * three banks' tokens in one pass should pay for that once, not three times,
 * and a token that has weeks of life left does not become urgent in five
 * minutes.
 */
const RENEW_CHECK_INTERVAL_MS = 5 * 60_000;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

interface RegistryDocument {
  readonly connections: readonly SecretConnection[];
  readonly verifications: Readonly<Record<string, SecretVerifyRecord>>;
}

const EMPTY: RegistryDocument = { connections: [], verifications: {} };

let registryFile: string | null = null;
let credentials: SecretManagerCredentials | null = null;
let providers: Readonly<Record<SecretProviderId, SecretManagerProvider>> = createSecretProviders();

/** Per connection: when its token was last considered for renewal. */
const lastRenewCheck = new Map<string, number>();

/**
 * Tell this module where Artemis keeps its own state, and how to encrypt.
 *
 * Called once, at startup, for `configureMemoryBanks`'s reason: the location
 * and the encryption are both unknowable to a module that has to be
 * importable by a test. Until it is called, there are no connections and
 * nothing resolves — which is exactly the state of a machine that has not
 * configured a key manager.
 *
 * `overrideProviders` exists for tests, which need canned HTTP rather than a
 * real vault. Nothing in the app passes it.
 */
export function configureSecretManagers(
  userDataDir: string,
  store: SecretManagerCredentials,
  overrideProviders?: Readonly<Record<SecretProviderId, SecretManagerProvider>>,
): void {
  registryFile = join(userDataDir, REGISTRY_FILE);
  credentials = store;
  if (overrideProviders !== undefined) providers = overrideProviders;
  lastRenewCheck.clear();
}

/* -------------------------------------------------------------------------- */
/* The registry, on disk                                                      */
/* -------------------------------------------------------------------------- */

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read the registry, rebuilding every record field by field.
 *
 * Rebuilt rather than cast for the house reason, and with one extra here: this
 * file is plain JSON a user may have edited, so an unknown key in it is not a
 * hostile renderer but a person who tried something. Dropping it silently is
 * kinder than failing to start, and the fields that survive are the ones the
 * protocol names.
 */
function readRegistry(): RegistryDocument {
  if (registryFile === null) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryFile, 'utf8'));
  } catch (error) {
    // A missing file is the ordinary state — most machines have no key manager.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${REGISTRY_FILE}; treating it as empty.`, error);
    }
    return EMPTY;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY;
  const document = parsed as Record<string, unknown>;

  const connections: SecretConnection[] = [];
  const rawConnections = Array.isArray(document['connections']) ? document['connections'] : [];
  for (const entry of rawConnections) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const id = readString(raw, 'id');
    const label = readString(raw, 'label');
    const provider = raw['provider'];
    if (id === undefined || label === undefined) continue;
    if (provider !== 'openbao' && provider !== 'doppler') continue;
    const authMethod = raw['authMethod'] === 'userpass' ? 'userpass' : 'token';
    const caPem = readString(raw, 'caPem');
    const username = readString(raw, 'username');
    connections.push({
      id,
      label,
      provider,
      address: readString(raw, 'address') ?? '',
      ...(caPem === undefined ? {} : { caPem }),
      authMethod,
      ...(username === undefined ? {} : { username }),
    });
  }

  const verifications: Record<string, SecretVerifyRecord> = {};
  const rawVerifications = document['verifications'];
  if (typeof rawVerifications === 'object' && rawVerifications !== null && !Array.isArray(rawVerifications)) {
    for (const [id, entry] of Object.entries(rawVerifications as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const raw = entry as Record<string, unknown>;
      const at = typeof raw['at'] === 'number' ? raw['at'] : null;
      const result = raw['result'];
      if (at === null || typeof result !== 'object' || result === null) continue;
      verifications[id] = { at, result: rebuildVerify(result as Record<string, unknown>) };
    }
  }

  return { connections, verifications };
}

/** One verify result, rebuilt from whatever the file held. */
function rebuildVerify(raw: Record<string, unknown>): SecretVerifyResult {
  const policies = Array.isArray(raw['policies'])
    ? raw['policies'].filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const identity = readString(raw, 'identity');
  const expiresAt = readString(raw, 'expiresAt');
  const degraded = raw['degraded'];
  const problem = raw['problem'];
  return {
    ok: raw['ok'] === true,
    detail: typeof raw['detail'] === 'string' ? raw['detail'] : '',
    ...(identity === undefined ? {} : { identity }),
    ...(policies === undefined ? {} : { policies }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(degraded === 'standby' || degraded === 'sealed' || degraded === 'rate-limited'
      ? { degraded }
      : {}),
    ...(typeof problem === 'string' ? { problem: problem as SecretVerifyResult['problem'] } : {}),
  };
}

function writeRegistry(document: RegistryDocument): void {
  if (registryFile === null) {
    throw new WorkspaceError(
      'This process cannot store a key manager connection — it means the secret managers were ' +
        'not configured at startup. Please report this.',
    );
  }
  // Written to a sibling and renamed, so an interrupted write cannot leave a
  // truncated file that reads as "every connection is gone".
  const temporary = `${registryFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
  renameSync(temporary, registryFile);
}

function providerFor(id: SecretProviderId): SecretManagerProvider {
  return providers[id];
}

/** Every provider's descriptor, in the order the pane offers them. */
function describeProviders(): readonly SecretProviderDescriptor[] {
  return [providers.openbao.describe(), providers.doppler.describe()];
}

function requireStore(): SecretManagerCredentials {
  if (credentials === null) {
    throw new WorkspaceError(
      'This process cannot read key manager credentials — it means the secret managers were not ' +
        'configured at startup. Please report this.',
    );
  }
  return credentials;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** The pane's whole state: connections, whether each is armed, and the forms. */
export async function listSecretConnections(): Promise<SecretsConnectionsResponse> {
  const document = readRegistry();
  const store = credentials;
  const connections: SecretConnectionState[] = [];
  for (const connection of document.connections) {
    connections.push({
      connection,
      // `has`, not `read`: a boolean is the whole of what the pane asks, and
      // decrypting to compute one would be exposure bought for nothing.
      hasCredential: store === null ? false : await store.has(connection.id),
      lastVerify: document.verifications[connection.id] ?? null,
    });
  }
  return { connections, providers: describeProviders() };
}

function connectionById(id: string): SecretConnection {
  const found = readRegistry().connections.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new WorkspaceError(`There is no key manager connection with the id ${id}.`);
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Verifying                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turn anything a verification can throw into a result the pane can render.
 *
 * A verify that *rejected* would be a pane with a red toast and no row to act
 * on — and the single most common failure here (a private certificate the
 * machine has not been told about) has a remedy that lives on the row. So
 * every failure becomes an answer, carrying its category so the pane knows
 * which remedy to offer.
 */
function verifyFailure(error: unknown): SecretVerifyResult {
  if (error instanceof SecretManagerError) {
    return {
      ok: false,
      detail: scrubSecrets(error.message),
      problem: error.problem,
      ...(error.problem === 'sealed' || error.problem === 'rate-limited'
        ? { degraded: error.problem }
        : {}),
    };
  }
  return {
    ok: false,
    detail: scrubSecrets(error instanceof Error ? error.message : String(error)),
  };
}

/** Scrub the strings a manager wrote before they become a stored record. */
function scrubVerify(result: SecretVerifyResult): SecretVerifyResult {
  return { ...result, detail: scrubSecrets(result.detail) };
}

async function verifyConnectionRecord(connection: SecretConnection): Promise<SecretVerifyResult> {
  const store = requireStore();
  const credential = await store.read(connection.id);
  if (credential === null) {
    return {
      ok: false,
      detail:
        connection.authMethod === 'userpass'
          ? 'No token is stored for this connection. Enter the password again to mint one.'
          : 'No token is stored for this connection. Paste one to use it.',
      problem: 'bad-credentials',
    };
  }
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
    return {
      ok: false,
      detail:
        connection.authMethod === 'userpass'
          ? `The stored token expired on ${new Date(credential.expiresAt).toISOString()}. Enter the password again to mint a new one.`
          : `The stored token expired on ${new Date(credential.expiresAt).toISOString()}.`,
      problem: 'expired',
    };
  }
  try {
    return scrubVerify(await providerFor(connection.provider).verify(connection, credential));
  } catch (error) {
    return verifyFailure(error);
  }
}

/** Record what a verify came to, so the pane can show it without asking again. */
function rememberVerify(id: string, result: SecretVerifyResult): void {
  const document = readRegistry();
  writeRegistry({
    connections: document.connections,
    verifications: { ...document.verifications, [id]: { at: Date.now(), result } },
  });
}

/** Ask one connection whether it still works. @see IPC.secretsConnectionVerify */
export async function verifySecretConnection(
  request: SecretsConnectionVerifyRequest,
): Promise<SecretsConnectionVerifyResponse> {
  const connection = connectionById(request.id);
  const verify = await verifyConnectionRecord(connection);
  rememberVerify(connection.id, verify);
  return { ...(await listSecretConnections()), verify };
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create or replace a connection, then say whether it works.
 *
 * The order matters and is not the obvious one: **the configuration is saved
 * even when the verification fails.** The commonest failure on this path is a
 * self-signed certificate, whose remedy is a button on the saved row; throwing
 * the row away would take the remedy with it and leave the user retyping an
 * address that was correct.
 *
 * For `userpass`, a supplied password is spent here and now — the login *is*
 * the verification, and what is stored is the token it minted. The password is
 * never written down; see `core/secrets/credentials.ts` for why that trade is
 * the whole point rather than an inconvenience.
 */
export async function saveSecretConnection(
  request: SecretsConnectionSaveRequest,
): Promise<SecretsConnectionSaveResponse> {
  const store = requireStore();
  const existing = readRegistry();
  const id = request.id ?? randomUUID();
  const isUpdate = existing.connections.some((entry) => entry.id === id);

  const address =
    request.address.length > 0
      ? request.address
      : request.provider === 'doppler'
        ? DOPPLER_API_BASE
        : '';
  if (address.length === 0) {
    throw new WorkspaceError('A key manager connection needs the address of its server.');
  }

  const connection: SecretConnection = {
    id,
    label: request.label,
    provider: request.provider,
    address,
    ...(request.caPem === undefined ? {} : { caPem: request.caPem }),
    authMethod: request.authMethod,
    ...(request.username === undefined ? {} : { username: request.username }),
  };

  // The address or the certificate may have changed under an id that other
  // records already point at, so anything cached about the old server goes.
  providerFor(connection.provider).forget?.(id);
  lastRenewCheck.delete(id);

  writeRegistry({
    connections: isUpdate
      ? existing.connections.map((entry) => (entry.id === id ? connection : entry))
      : [...existing.connections, connection],
    verifications: existing.verifications,
  });

  let verify: SecretVerifyResult;
  const password = request.credential?.password;
  const token = request.credential?.token;

  if (connection.authMethod === 'userpass' && password !== undefined && password.length > 0) {
    verify = await mintAndStore(connection, password, store);
  } else if (token !== undefined && token.length > 0) {
    try {
      await store.write(id, { token });
      verify = await verifyConnectionRecord(connection);
    } catch (error) {
      verify = verifyFailure(error);
    }
  } else {
    // No credential in this request. On an update that means "leave the stored
    // one alone" — a user fixing a label must not have to retype a password —
    // and on a create it means the connection is configured and not yet armed,
    // which `verifyConnectionRecord` reports in as many words.
    verify = await verifyConnectionRecord(connection);
  }

  rememberVerify(id, verify);
  return { ...(await listSecretConnections()), id, verify };
}

/**
 * Spend a password on a token, and keep only the token.
 *
 * Both halves of the outcome are reported through the verify result rather
 * than thrown, for {@link saveSecretConnection}'s reason — including the TLS
 * failure, which is the one the certificate flow exists to answer.
 */
async function mintAndStore(
  connection: SecretConnection,
  password: string,
  store: SecretManagerCredentials,
): Promise<SecretVerifyResult> {
  const provider = providerFor(connection.provider);
  if (provider.login === undefined) {
    return {
      ok: false,
      detail: `${provider.label} does not have a username and password login; paste a token instead.`,
      problem: 'protocol',
    };
  }
  const username = connection.username ?? '';
  if (username.length === 0) {
    return { ok: false, detail: 'A username is needed to sign in.', problem: 'bad-credentials' };
  }
  try {
    const minted = await provider.login(connection, username, password);
    // The password goes out of scope here and is never written anywhere. What
    // is stored is the token it produced, with the expiry the manager stated.
    await store.write(connection.id, {
      token: minted.token,
      ...(minted.expiresAt === undefined ? {} : { expiresAt: minted.expiresAt }),
    });
    return scrubVerify(await provider.verify(connection, { token: minted.token }));
  } catch (error) {
    return verifyFailure(error);
  }
}

/** Forget a connection and its credential. @see IPC.secretsConnectionDelete */
export async function deleteSecretConnection(
  request: SecretsConnectionDeleteRequest,
): Promise<SecretsConnectionsResponse> {
  const store = requireStore();
  const document = readRegistry();
  const remaining = document.connections.filter((entry) => entry.id !== request.id);
  const verifications = { ...document.verifications };
  delete verifications[request.id];
  writeRegistry({ connections: remaining, verifications });
  // The credential goes with the connection. A credential left behind for a
  // connection nobody can see is a secret this machine holds and cannot name.
  await store.clear(request.id);
  providerFor('openbao').forget?.(request.id);
  providerFor('doppler').forget?.(request.id);
  lastRenewCheck.delete(request.id);
  return listSecretConnections();
}

/* -------------------------------------------------------------------------- */
/* Resolving                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the value a reference names.
 *
 * Every caller gets `dispose` and every caller must call it. Between resolve
 * and dispose the literal value is registered with `redact.ts`, which means
 * any log line, error message or receipt assembled in that window has it
 * removed — including ones written by code that has no idea a secret is in
 * flight. That is the whole reason the lifetime is explicit rather than
 * implied by garbage collection.
 */
export async function resolveSecretRef(ref: SecretRef): Promise<ResolvedSecret> {
  const store = requireStore();
  const connection = readRegistry().connections.find((entry) => entry.id === ref.connectionId);
  if (connection === undefined) {
    throw new SecretManagerError(
      'protocol',
      'This reference names a key manager connection that is no longer configured.',
    );
  }
  if (connection.provider !== ref.provider) {
    throw new SecretManagerError(
      'protocol',
      `This reference is for ${ref.provider}, but the connection it names is a ${connection.provider} one.`,
    );
  }
  const credential = await store.read(connection.id);
  if (credential === null) {
    throw new SecretManagerError(
      'bad-credentials',
      `“${connection.label}” has no stored credential. Open Key managers and sign in again.`,
    );
  }
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
    throw new SecretManagerError(
      'expired',
      `“${connection.label}”'s token expired on ${new Date(credential.expiresAt).toISOString()}. Open Key managers and sign in again.`,
    );
  }

  const provider = providerFor(connection.provider);
  const fresh = await maybeRenew(provider, connection, credential, store);
  const resolved = await provider.resolve(connection, fresh, ref);

  // The literal is protected for exactly as long as the caller holds it.
  const release = registerLiveSecret(resolved.value);
  return {
    value: resolved.value,
    ...(resolved.siblingKeys === undefined ? {} : { siblingKeys: resolved.siblingKeys }),
    dispose: () => {
      release();
      resolved.dispose();
    },
  };
}

/**
 * Extend a token if it is worth extending, on the way to using it.
 *
 * Opportunistic, throttled, and silent about failure — a renewal that does not
 * happen has not broken anything, it has left the token expiring on the day it
 * was always going to. Throwing here would turn "your token has three days
 * left" into "your memory bank did not sync".
 *
 * The renewed *token* is the same string; only its lease moves. So what is
 * written back is the expiry, which is what the pane shows and what
 * {@link resolveSecretRef} checks before spending a round trip.
 */
async function maybeRenew(
  provider: SecretManagerProvider,
  connection: SecretConnection,
  credential: { token: string; expiresAt?: number },
  store: SecretManagerCredentials,
): Promise<{ token: string; expiresAt?: number }> {
  if (provider.renew === undefined) return credential;
  const now = Date.now();
  const checked = lastRenewCheck.get(connection.id) ?? 0;
  if (now - checked < RENEW_CHECK_INTERVAL_MS) return credential;
  lastRenewCheck.set(connection.id, now);

  const outcome = await provider.renew(connection, credential);
  if (!outcome.renewed || outcome.expiresAt === undefined) return credential;
  const renewed = { token: credential.token, expiresAt: outcome.expiresAt };
  try {
    await store.write(connection.id, renewed);
  } catch (error) {
    // The token is longer-lived than the file says. That is a stale record,
    // not a broken credential, and the next successful write corrects it.
    log.warn(`Could not record the renewed expiry for '${connection.id}'.`, error);
  }
  return renewed;
}

/**
 * Resolve a reference and throw the value away.
 *
 * The same path a real use takes — same request, same version detection, same
 * error mapping — because a test that took a shortcut would be a test of the
 * shortcut. The value is disposed without ever being read; what comes back is
 * a boolean and, when the manager offered them, the key *names* at the path.
 */
export async function testSecretRef(request: SecretsRefTestRequest): Promise<SecretRefTestResult> {
  try {
    const resolved = await resolveSecretRef(request.ref);
    const keys = resolved.siblingKeys;
    resolved.dispose();
    return { found: true, ...(keys === undefined ? {} : { keysAtPath: keys }) };
  } catch (error) {
    if (error instanceof SecretManagerError) {
      return {
        found: false,
        problem: scrubSecrets(error.message),
        ...(error.keysAtPath === undefined ? {} : { keysAtPath: error.keysAtPath }),
      };
    }
    return {
      found: false,
      problem: scrubSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Certificates                                                               */
/* -------------------------------------------------------------------------- */

/** DER → PEM, wrapped at 64 characters the way every other tool prints it. */
function toPem(der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body}${body.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`;
}

/** An X.509 name object → the one-line form a person reads. */
function formatName(name: PeerCertificate['subject'] | undefined): string {
  if (name === undefined || name === null) return '';
  return Object.entries(name as unknown as Record<string, string | string[]>)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`)
    .join(', ');
}

/**
 * The certificate to store, walking up to the issuer where there is one.
 *
 * Pinning a leaf works until the server renews, which for a private CA is
 * every few months and produces a failure that looks exactly like an attack.
 * Pinning the issuer survives renewal and is what the user means when they say
 * "trust our vault's CA". A genuinely self-signed certificate has no issuer to
 * climb to, and then the leaf is the answer.
 */
function chainAnchor(leaf: DetailedPeerCertificate): {
  certificate: DetailedPeerCertificate;
  selfSigned: boolean;
} {
  let current = leaf;
  const seen = new Set<string>();
  while (
    current.issuerCertificate !== undefined &&
    current.issuerCertificate !== null &&
    current.issuerCertificate.fingerprint256 !== current.fingerprint256 &&
    !seen.has(current.issuerCertificate.fingerprint256)
  ) {
    seen.add(current.fingerprint256);
    current = current.issuerCertificate;
  }
  return { certificate: current, selfSigned: current.fingerprint256 === leaf.fingerprint256 };
}

/**
 * Complete a TLS handshake, read the chain, and hang up.
 *
 * **Nothing is written to this socket.** Not a request line, not a header. The
 * connection exists to make the server present its certificate, and it is
 * destroyed the moment it has. That is what makes an unverified socket
 * acceptable here and nowhere else in this feature: there is no secret in
 * flight to expose, because nothing was sent.
 */
export async function fetchServerCertificate(
  request: SecretsFetchServerCertRequest,
): Promise<SecretServerCertificate> {
  // `async`, so that the argument checks below reject rather than throwing
  // synchronously. A function whose type says "promise" and whose bad-input
  // path throws is one a caller can only get right by reading it.
  let url: URL;
  try {
    url = new URL(request.address);
  } catch {
    throw new WorkspaceError(`“${request.address}” is not a URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new WorkspaceError(
      `${url.origin} is not an https address, so it presents no certificate. Nothing needs trusting here.`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port.length > 0 ? Number(url.port) : 443;

  return new Promise<SecretServerCertificate>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host,
        port,
        // `servername` only for a DNS name: SNI forbids a literal IP, and
        // sending one makes some servers answer with a default certificate
        // rather than the one the user is trying to look at.
        ...(/^[\d.]+$/.test(host) || host.includes(':') ? {} : { servername: host }),
        // The one unverified socket in this feature, and it carries no
        // request. See this function's comment and `transport.ts`.
        rejectUnauthorized: false,
      },
      () => {
        const leaf = socket.getPeerCertificate(true);
        socket.destroy();
        if (leaf === null || Object.keys(leaf).length === 0) {
          reject(new WorkspaceError(`${url.origin} completed a handshake without presenting a certificate.`));
          return;
        }
        const { certificate, selfSigned } = chainAnchor(leaf);
        const notAfter = Date.parse(leaf.valid_to);
        resolve({
          fingerprintSha256: leaf.fingerprint256,
          subject: formatName(leaf.subject),
          issuer: formatName(leaf.issuer),
          san: (leaf.subjectaltname ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
          notAfter: Number.isNaN(notAfter) ? leaf.valid_to : new Date(notAfter).toISOString(),
          pem: toPem(Buffer.from(certificate.raw)),
          selfSigned,
        });
      },
    );
    socket.setTimeout(CERT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new WorkspaceError(`${url.origin} did not complete a handshake within ${CERT_TIMEOUT_MS / 1000}s.`));
    });
    socket.on('error', (error: Error) => {
      socket.destroy();
      reject(new WorkspaceError(`Could not reach ${url.origin}: ${scrubSecrets(error.message)}`));
    });
  });
}
