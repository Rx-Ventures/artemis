/**
 * The one place TLS is configured, and the one place it is never turned off.
 * ============================================================================
 *
 * Every request a key-manager provider makes goes through here. That is the
 * point of the file: `rejectUnauthorized: false` does not appear in it, cannot
 * be reached by any option a caller passes, and has no code path that would
 * set it. A connection that presents a certificate the machine does not
 * already trust is served by putting that certificate in
 * {@link SecretHttpRequest.caPem} — `ca: [pem]` with verification **on** —
 * after a person has looked at it and said yes.
 *
 * ## Why the "fake pinning" pattern is refused
 *
 * The shape that shows up in a lot of vault-client code is: disable
 * verification, get the peer certificate from the socket, compare its
 * fingerprint to a stored one, and tear the connection down if it does not
 * match. It reads like pinning and it is not, for a reason that is about
 * ordering rather than about cryptography: with verification off, the
 * handshake completes and the request body is written before any application
 * code gets a chance to look at the certificate. By the time the fingerprint
 * is compared, the token has already been sent to whoever answered. The check
 * that follows can only decide whether to *believe the reply*.
 *
 * `ca: [pem]` does the comparison in the handshake, before anything is
 * written, which is the only ordering that protects the secret rather than the
 * response.
 *
 * The certificate *preview* — the flow that gets the user something to look at
 * in the first place — is deliberately not here. It lives in
 * `main/secretManagers.ts`, is a handshake and a close, and writes no request.
 *
 * ## Why plain HTTP is allowed to loopback and nowhere else
 *
 * An OpenBao dev server binds `http://127.0.0.1:8200` and is how most people
 * meet one. Refusing it outright would make "try this out" impossible;
 * allowing it anywhere would let a mistyped address send a token across a
 * network in clear. Loopback is the line: the packets do not leave the
 * machine, so there is nothing on the wire to intercept.
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

import { SecretManagerError, type SecretHttpRequest, type SecretHttpResponse, type SecretTransport } from './types.js';

/** Long enough for a slow vault, short enough that a pane is not left hanging. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A ceiling on what a manager may say.
 *
 * A key manager's answers are kilobytes. Anything at this scale is a wrong
 * address — a file server, a captive portal — and reading it into memory to
 * find that out is the failure mode a cap exists to prevent.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Node's own names for "nothing answered". */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** True for the hosts whose traffic never reaches a network interface. */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.');
}

/**
 * Which failure a Node socket error is.
 *
 * The distinction earns its keep in the pane: `tls` has a remedy Artemis can
 * offer (look at the certificate, then trust it), and `unreachable` has one
 * only the user can apply. Rendering a self-signed certificate as "could not
 * connect" hides the button that fixes it.
 */
function transportError(error: unknown, url: string): SecretManagerError {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (
    code.startsWith('CERT_') ||
    code.startsWith('ERR_TLS') ||
    code.includes('SELF_SIGNED') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return new SecretManagerError(
      'tls',
      `The certificate at ${url} was not accepted: ${message}. If this manager uses a private ` +
        'certificate authority, fetch its certificate and confirm it before trusting it.',
    );
  }
  if (UNREACHABLE_CODES.has(code)) {
    return new SecretManagerError('unreachable', `Could not reach ${url}: ${message}`);
  }
  return new SecretManagerError('unreachable', `The request to ${url} failed: ${message}`);
}

/**
 * The real transport.
 *
 * Agents are cached per certificate rather than made per request, because a
 * background sync resolving three banks' tokens should reuse one connection
 * and one parsed certificate chain rather than three. The cache key is the PEM
 * itself, so rotating a certificate produces a new agent by construction —
 * there is no invalidation to forget.
 */
export function createHttpsTransport(): SecretTransport {
  const agents = new Map<string, HttpsAgent>();
  const plainAgent = new HttpAgent({ keepAlive: false });

  function agentFor(caPem: string | undefined): HttpsAgent {
    const key = caPem ?? '';
    const existing = agents.get(key);
    if (existing !== undefined) return existing;
    // `rejectUnauthorized` is stated rather than left to the default. It is
    // the default, and the point of writing it is that a reader looking for
    // the place verification could be disabled finds it asserted instead.
    const agent =
      caPem === undefined
        ? new HttpsAgent({ keepAlive: false, rejectUnauthorized: true })
        : new HttpsAgent({ keepAlive: false, rejectUnauthorized: true, ca: [caPem] });
    agents.set(key, agent);
    return agent;
  }

  return async function send(request: SecretHttpRequest): Promise<SecretHttpResponse> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new SecretManagerError('protocol', `“${request.url}” is not a valid URL.`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      throw new SecretManagerError(
        'protocol',
        `${url.origin} is not https. A key manager reached over plain HTTP would carry its own ` +
          'token in clear; only a loopback address (a local dev server) is allowed without TLS.',
      );
    }

    const secure = url.protocol === 'https:';
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<SecretHttpResponse>((resolve, reject) => {
      const send = secure ? httpsRequest : httpRequest;
      const call = send(
        url,
        {
          method: request.method,
          headers: {
            ...request.headers,
            ...(request.body === undefined
              ? {}
              : { 'content-length': String(Buffer.byteLength(request.body, 'utf8')) }),
          },
          agent: secure ? agentFor(request.caPem) : plainAgent,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              response.destroy();
              reject(
                new SecretManagerError(
                  'protocol',
                  `${url.origin} answered with more than ${MAX_BODY_BYTES} bytes, which is not a key manager.`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === 'string') headers[name.toLowerCase()] = value;
              else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
            }
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          response.on('error', (error) => reject(transportError(error, url.origin)));
        },
      );

      call.setTimeout(timeoutMs, () => {
        call.destroy(
          new SecretManagerError(
            'unreachable',
            `${url.origin} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      });
      call.on('error', (error) => {
        // A timeout destroys the socket with the error above already built;
        // anything else is a socket condition that still needs categorising.
        reject(error instanceof SecretManagerError ? error : transportError(error, url.origin));
      });
      if (request.body !== undefined) call.write(request.body);
      call.end();
    });
  };
}
