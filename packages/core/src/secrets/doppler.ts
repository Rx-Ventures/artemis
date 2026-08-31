/**
 * Doppler — the second provider, which is why the first one has an interface.
 * ============================================================================
 *
 * Doppler exists in this codebase to prove that `types.ts` describes *key
 * managers* rather than describing OpenBao, and it earns that by disagreeing
 * with OpenBao about nearly everything:
 *
 *  - It authenticates with `Authorization: Bearer`, not a bespoke header.
 *  - Its tokens are minted in its web UI and do not expire on a schedule, so
 *    there is no `login` and no `renew` here at all — the two optional methods
 *    on the provider interface are optional because of this file.
 *  - A secret is fetched one at a time by name, so there is no "the other keys
 *    at this path" to offer when a name is wrong. The manager's own message is
 *    what the user gets instead, and pretending otherwise would be inventing a
 *    diagnostic.
 *  - Errors are `{ messages: […], success: false }` — an array of sentences,
 *    not OpenBao's `errors`, and readable enough to quote verbatim.
 *
 * ## `value.computed`, not `value.raw`
 *
 * A Doppler secret may reference another (`${DATABASE_HOST}`). `raw` is what
 * was typed; `computed` is what it means. A client that reads `raw` hands a
 * subprocess a literal `${…}` string, which fails as an authentication error
 * against whatever it was passed to — a wrong-token symptom for a
 * right-token problem.
 *
 * ## `/v3/me` and the shape that catches people
 *
 * The verify call answers with a `workplace` **object**, not a string. Reading
 * it as a name yields `[object Object]` in the one field whose whole job is to
 * tell the user which account they just proved authority over.
 */

import type {
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
  type SecretTransport,
} from './types.js';

/** Doppler's API, and the default for a connection that does not name one. */
export const DOPPLER_API_BASE = 'https://api.doppler.com';

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

/**
 * Doppler's own words, which are worth quoting.
 *
 * Unlike a vault's `permission denied`, these are written for a person —
 * "Could not find requested secret", "Invalid Auth Token" — so the mapping
 * below adds a category and gets out of the way rather than paraphrasing.
 */
function messagesIn(body: Record<string, unknown> | null): readonly string[] {
  const messages = body?.['messages'];
  return Array.isArray(messages)
    ? messages.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function said(body: Record<string, unknown> | null): string {
  const messages = messagesIn(body);
  return messages.length === 0 ? '' : ` Doppler said: ${messages.join('; ')}.`;
}

function failureFor(response: SecretHttpResponse, where: string): SecretManagerError {
  const body = parseBody(response);
  if (response.status === 401 || response.status === 403) {
    return new SecretManagerError(
      'bad-credentials',
      `Doppler refused this token${response.status === 403 ? ' for ' + where : ''}.${said(body)}`,
    );
  }
  if (response.status === 404) {
    return new SecretManagerError('absent', `Doppler has nothing at ${where}.${said(body)}`);
  }
  if (response.status === 429) {
    const retryAfter = response.headers['retry-after'];
    return new SecretManagerError(
      'rate-limited',
      `Doppler is rate-limiting this client${retryAfter === undefined ? '' : `; it asked for ${retryAfter}s`}.${said(body)}`,
    );
  }
  return new SecretManagerError('protocol', `Doppler answered ${response.status} for ${where}.${said(body)}`);
}

const CONFIG_FIELDS: readonly SecretField[] = [
  {
    id: 'address',
    label: 'API address',
    placeholder: DOPPLER_API_BASE,
    required: false,
    kind: 'text',
    note: `Leave empty for ${DOPPLER_API_BASE}. Only worth setting if you reach Doppler through a proxy.`,
  },
];

const REF_FIELDS: readonly SecretField[] = [
  {
    id: 'name',
    label: 'Secret',
    placeholder: 'GIT_TOKEN',
    required: true,
    kind: 'text',
    note: 'Doppler names secrets the way environment variables are named.',
  },
  {
    id: 'project',
    label: 'Project',
    placeholder: '(from the token)',
    required: false,
    kind: 'text',
    note: 'Only for a personal token. A service token already names its project, and Doppler refuses a request that names another.',
  },
  {
    id: 'config',
    label: 'Config',
    placeholder: '(from the token)',
    required: false,
    kind: 'text',
  },
];

/** Build the Doppler provider over a transport. @see createOpenBaoProvider */
export function createDopplerProvider(transport: SecretTransport): SecretManagerProvider {
  async function call(
    config: SecretConnection,
    credential: SecretCredential,
    path: string,
    query: Readonly<Record<string, string | undefined>> = {},
  ): Promise<SecretHttpResponse> {
    const base = config.address.length > 0 ? config.address : DOPPLER_API_BASE;
    const url = new URL(path.replace(/^\/+/, ''), `${base.replace(/\/+$/, '')}/`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value.length > 0) url.searchParams.set(name, value);
    }
    return transport({
      method: 'GET',
      url: url.toString(),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.token}`,
      },
      ...(config.caPem === undefined ? {} : { caPem: config.caPem }),
    });
  }

  const describe = (): SecretProviderDescriptor => ({
    id: 'doppler',
    label: 'Doppler',
    note: 'Hosted secrets, organised by project and config. Authenticates with a token you mint in Doppler.',
    authMethods: ['token'],
    configFields: CONFIG_FIELDS,
    refFields: REF_FIELDS,
  });

  return {
    id: 'doppler',
    label: 'Doppler',
    note: describe().note,
    authMethods: ['token'],
    configFields: CONFIG_FIELDS,
    refFields: REF_FIELDS,
    describe,

    async verify(config, credential): Promise<SecretVerifyResult> {
      const response = await call(config, credential, 'v3/me');
      if (response.status === 429) {
        const retryAfter = response.headers['retry-after'];
        return {
          ok: false,
          detail: `Doppler is rate-limiting this client${retryAfter === undefined ? '' : `; it asked for ${retryAfter}s`}. The token itself may be fine.`,
          degraded: 'rate-limited',
          problem: 'rate-limited',
        };
      }
      if (response.status !== 200) {
        const failure = failureFor(response, 'this token');
        return { ok: false, detail: failure.message, problem: failure.problem };
      }
      const body = parseBody(response);
      // `workplace` is an object. Read as a string it renders as
      // "[object Object]" in the one field that says whose account this is.
      const workplace = record(body?.['workplace']);
      const workplaceName = typeof workplace?.['name'] === 'string' ? (workplace['name'] as string) : null;
      const tokenName = typeof body?.['name'] === 'string' ? (body['name'] as string) : null;
      const kind = typeof body?.['type'] === 'string' ? (body['type'] as string) : null;
      // The workplace is parenthesised only when there is a token name in
      // front of it. A personal token has no `name`, and the bare "(Rx
      // Ventures)" that produced read like a redaction rather than an account.
      const identity =
        tokenName === null
          ? (workplaceName ?? '')
          : workplaceName === null
            ? tokenName
            : `${tokenName} (${workplaceName})`;
      return {
        ok: true,
        detail:
          workplaceName === null
            ? 'Doppler accepted this token.'
            : `Doppler accepted this token for the ${workplaceName} workplace.`,
        ...(identity.length > 0 ? { identity } : {}),
        // Doppler has no policy vocabulary; the token's *type* is the nearest
        // true equivalent and stating it is how a user notices they pasted a
        // personal token where a service token was meant.
        ...(kind === null ? {} : { policies: [kind] }),
      };
    },

    async resolve(config, credential, ref: SecretRef): Promise<ResolvedSecret> {
      if (ref.provider !== 'doppler') {
        throw new SecretManagerError('protocol', 'That reference is not a Doppler reference.');
      }
      const where = [ref.project, ref.config, ref.name].filter((part) => part !== undefined).join('/');
      const response = await call(config, credential, 'v3/configs/config/secret', {
        name: ref.name,
        // Only when the reference carries them: a service token already names
        // its project and config, and Doppler rejects a request that names a
        // different one — so sending them "just in case" turns a working
        // reference into a 401.
        project: ref.project,
        config: ref.config,
      });
      if (response.status !== 200) throw failureFor(response, where);

      const value = record(parseBody(response)?.['value']);
      const computed = value?.['computed'];
      if (typeof computed !== 'string') {
        throw new SecretManagerError(
          'protocol',
          `Doppler's answer for ${where} had no computed value in it.`,
        );
      }
      return { value: computed, dispose: () => undefined };
    },
  };
}
