/**
 * Administering a *remote* Artemis: adding an account, and signing it in.
 * ============================================================================
 *
 * `adapter.ts` is this Artemis driving another one's *runs*. This is the small
 * second half: driving the other one's **accounts**, which is what makes a
 * headless server usable without a shell inside it. The routes are documented
 * on the server side in `protocol/src/server.ts`; what lives here is the
 * client, reusing the adapter's own address and token derivation so that a
 * profile which can run a turn can also administer the server it runs on.
 *
 * ## Why this is here rather than in the SDK
 *
 * The published SDK has the same six calls, and a program outside Artemis
 * should use those. The desktop app cannot: `@rx-artemis/core` is what the main
 * process already depends on, and reaching for a second package to make six
 * `fetch` calls against an address this module already knows how to compose
 * would be a dependency bought for nothing. The two are kept honest by both
 * being typed against the protocol's own bodies — neither redeclares a shape.
 *
 * ## What crosses this wire
 *
 * A label, a verification URL and a code the user typed. No credential, in
 * either direction: the provider's CLI writes its own token into its own config
 * directory on the *server's* machine, and nothing here reads it.
 */

import type {
  ProfileId,
  ServerProfile,
  ServerProfileCreatedBody,
  ServerProfilesBody,
  ServerSignInStatus,
} from '@rx-artemis/protocol';
import { SERVER_API_VERSION } from '@rx-artemis/protocol';

import { adapterError, isAdapterError } from '../types.js';
import { artemisAuthHeaders, artemisEndpoint, ARTEMIS_PROVIDER_ID } from './adapter.js';

/*
 * Re-exported here because this is the module a *host* imports.
 *
 * The adapter itself is reached through the registry like every other
 * provider's, so its id has never needed to be public; a caller of these
 * functions does need it, to refuse a profile that names some other provider
 * before sending its request to whatever address that profile happens to hold.
 */
export { ARTEMIS_PROVIDER_ID };

const API_PREFIX = `/api/${SERVER_API_VERSION}`;

/** The environment an Artemis profile resolves to: an address and a token. */
export type ArtemisProfileEnv = Readonly<Record<string, string | undefined>>;

/**
 * What a client needs before it can offer to add an account.
 *
 * Two answers in one round trip, because they are one question on screen: may
 * I show this at all, and what is already here? Fetching them separately would
 * let a pane render an "Add account" button a moment before learning it had no
 * authority to use it.
 */
export interface RemoteAccounts {
  /** The serving connection carries the administrative grant. */
  readonly manageProfiles: boolean;
  /** Every account this connection can see, with its models. */
  readonly profiles: readonly ServerProfile[];
}

/**
 * Everything the accounts pane needs for its first paint.
 *
 * The connection read is the authority; the profile read is the content. A
 * connection *without* the grant still gets its profiles — that list is the
 * ordinary catalogue every client may read — so a pane can show what is on the
 * server while hiding the controls that change it.
 */
export async function readRemoteAccounts(
  env: ArtemisProfileEnv,
  options?: { readonly signal?: AbortSignal },
): Promise<RemoteAccounts> {
  const [connection, profiles] = await Promise.all([
    call<{ manageProfiles?: unknown }>(env, `${API_PREFIX}/connection`, options),
    call<ServerProfilesBody>(env, `${API_PREFIX}/profiles`, options),
  ]);
  return {
    // `=== true` because an older server sends nothing here, and a missing
    // field must land as "no" rather than as an administrative surface a
    // client offers and the server then 404s.
    manageProfiles: connection.manageProfiles === true,
    profiles: Array.isArray(profiles.profiles) ? profiles.profiles : [],
  };
}

/** Add an account to the server. */
export async function createRemoteAccount(
  env: ArtemisProfileEnv,
  request: { readonly label: string; readonly provider?: string },
  options?: { readonly signal?: AbortSignal },
): Promise<ServerProfileCreatedBody> {
  return call<ServerProfileCreatedBody>(env, `${API_PREFIX}/profiles`, options, {
    method: 'POST',
    body: request,
  });
}

/** Spawn the provider's login for one account on the server. */
export async function startRemoteSignIn(
  env: ArtemisProfileEnv,
  accountId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus> {
  return call<ServerSignInStatus>(env, signInPath(accountId), options, { method: 'POST' });
}

/**
 * Where the sign-in has got to, or `null` when there is none.
 *
 * `null` rather than a throw for the 404, because this is polled every second
 * or two while a person reads their email, and "nobody has started one" is an
 * ordinary answer rather than a failure.
 */
export async function readRemoteSignIn(
  env: ArtemisProfileEnv,
  accountId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus | null> {
  return absentOnMissing(call<ServerSignInStatus>(env, signInPath(accountId), options));
}

/** Hand the CLI the code the user pasted. */
export async function submitRemoteSignInCode(
  env: ArtemisProfileEnv,
  accountId: string,
  code: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus> {
  return call<ServerSignInStatus>(env, `${signInPath(accountId)}/code`, options, {
    method: 'POST',
    body: { code },
  });
}

/** Kill the login subprocess. `null` when there was nothing to kill. */
export async function cancelRemoteSignIn(
  env: ArtemisProfileEnv,
  accountId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus | null> {
  return absentOnMissing(
    call<ServerSignInStatus>(env, signInPath(accountId), options, { method: 'DELETE' }),
  );
}

/** An account id is opaque and may be anything the server minted. Encode it. */
function signInPath(accountId: ProfileId | string): string {
  return `${API_PREFIX}/profiles/${encodeURIComponent(String(accountId))}/signin`;
}

async function absentOnMissing<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    // 404 is both "no flow here" and "your connection may not ask", and the
    // server refuses to distinguish them on purpose. Either way there is
    // nothing to show, which is what `null` says.
    if (isAdapterError(error) && error.agentError.httpStatus === 404) return null;
    throw error;
  }
}

/**
 * One request to the serving Artemis, with its refusal turned into something
 * the UI can print.
 *
 * The server's own `error.message` is passed through, and that is right here
 * where it is not elsewhere: these routes are reached only by a connection the
 * operator granted administration, every message they produce is about
 * *this* caller's own request, and the alternative — a generic sentence — would
 * leave a person staring at "the request failed" with a duplicate label they
 * cannot see.
 */
async function call<T>(
  env: ArtemisProfileEnv,
  path: string,
  options?: { readonly signal?: AbortSignal },
  write?: { readonly method: string; readonly body?: unknown },
): Promise<T> {
  const root = artemisEndpoint(env);
  let response: Response;
  try {
    response = await fetch(`${root}${path}`, {
      ...(write === undefined ? {} : { method: write.method }),
      headers: {
        accept: 'application/json',
        ...artemisAuthHeaders(env),
        ...(write?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(write?.body === undefined ? {} : { body: JSON.stringify(write.body) }),
      // Generous, because a `POST …/signin` spawns a process on the far side
      // and the reply waits for it to say something. Not unbounded: a tunnel
      // that has gone away must not hang a pane forever.
      signal: options?.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    throw adapterError(
      'network',
      `Could not reach the Artemis server at ${root}. Is it running, and is its address reachable from this machine?`,
      { retryable: true, cause },
    );
  }

  if (!response.ok) throw await refusal(response, root);
  return (await response.json()) as T;
}

/**
 * Turn a failed response into an error that still carries its status.
 *
 * `httpStatus` is filled in because one caller branches on it —
 * `absentOnMissing`, for the 404 that means "nothing here" — and matching on
 * the message would be matching on prose the server is free to reword.
 */
async function refusal(response: Response, root: string): Promise<Error> {
  let message: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Not JSON, or no body. The status still says something true.
  }

  return adapterError(
    response.status === 401 || response.status === 403
      ? 'auth'
      : response.status >= 500
        ? 'provider_unavailable'
        : 'invalid_request',
    message ??
      (response.status === 404
        ? 'That account surface is not available on this server.'
        : `The Artemis server at ${root} answered ${String(response.status)}.`),
    { httpStatus: response.status },
  );
}
