/**
 * The local half of a remote sign-in's loopback flow.
 *
 * Codex's login runs a web server on the machine running the CLI and prints
 * `http://localhost:1455/…` — an address that is only true where the CLI is.
 * When the CLI is in a container on another machine, the serving Artemis
 * relays that port under `…/signin/oauth/` (see `server/http.ts`), and this
 * module is the other end: an HTTP server on the *same* local port, forwarding
 * every request over the authenticated wire. The URL the CLI printed then
 * works verbatim in the browser sitting next to the person.
 *
 * One forwarder per account, started when a flow reports a `loopbackPort` and
 * stopped when the flow settles, is cancelled, or the safety timer fires. A
 * port that is already taken — the user's own local Codex mid-login, say — is
 * reported once and the sign-in continues without forwarding; the URL card
 * still shows where the flow is stuck, which beats a crash in main.
 */

import { createServer, type Server } from 'node:http';

import { SERVER_API_VERSION } from '@rx-artemis/protocol';
import { artemisAuthHeaders, artemisEndpoint } from '@rx-artemis/core';

import { createLogger } from './log.js';

const log = createLogger('signin-loopback');

/** Nothing legitimate signs in for longer. Mirrors the server's own flow cap. */
const FORWARDER_TTL_MS = 15 * 60 * 1000;

interface Forwarder {
  readonly server: Server;
  readonly timer: ReturnType<typeof setTimeout>;
}

const live = new Map<string, Forwarder>();

/**
 * Make `localhost:<port>` here mean the flow's server over there.
 *
 * Idempotent per account: the status poll calls this on every reading that
 * carries a port, and only the first one builds anything.
 */
export function ensureSignInForwarder(options: {
  readonly accountId: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}): void {
  const { accountId, port, env } = options;
  if (live.has(accountId)) return;

  const root = artemisEndpoint(env);
  const headers = artemisAuthHeaders(env);
  const prefix = `${root}/api/${SERVER_API_VERSION}/profiles/${encodeURIComponent(accountId)}/signin/oauth`;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const upstream = await fetch(`${prefix}${request.url ?? '/'}`, {
          method: request.method === 'HEAD' ? 'HEAD' : 'GET',
          redirect: 'manual',
          headers: {
            ...headers,
            ...(request.headers.accept === undefined ? {} : { accept: request.headers.accept }),
            ...(request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }),
          },
        });
        const passed: Record<string, string> = {};
        for (const name of ['content-type', 'location', 'set-cookie', 'cache-control']) {
          const value = upstream.headers.get(name);
          if (value !== null) passed[name] = value;
        }
        response.writeHead(upstream.status, passed);
        response.end(request.method === 'HEAD' ? undefined : await upstream.text());
      } catch (error) {
        // The wire failed, not the flow: answer the browser with something it
        // can show, and leave the forwarder up for the retry.
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('Artemis could not reach the sign-in flow on the server. Try again.');
        log.warn(`Sign-in relay request for ${accountId} failed`, error);
      }
    })();
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    // EADDRINUSE is the honest conflict: something local already owns the
    // port. The sign-in itself continues — only the shortcut is missing — so
    // say so once rather than failing the flow.
    log.warn(
      error.code === 'EADDRINUSE'
        ? `Port ${String(port)} is taken locally; the sign-in URL will not resolve here until it is free.`
        : `Sign-in forwarder for ${accountId} failed`,
      error,
    );
    stopSignInForwarder(accountId);
  });

  const timer = setTimeout(() => stopSignInForwarder(accountId), FORWARDER_TTL_MS);
  timer.unref?.();
  live.set(accountId, { server, timer });
  server.listen(port, '127.0.0.1', () => {
    log.info(`Forwarding localhost:${String(port)} to the serving machine for ${accountId}'s sign-in.`);
  });
}

/** Tear one down. Idempotent, and safe against a server that never bound. */
export function stopSignInForwarder(accountId: string): void {
  const entry = live.get(accountId);
  if (entry === undefined) return;
  live.delete(accountId);
  clearTimeout(entry.timer);
  try {
    entry.server.close();
  } catch {
    // Already down.
  }
}

/** Every forwarder, for shutdown. */
export function stopAllSignInForwarders(): void {
  for (const accountId of [...live.keys()]) stopSignInForwarder(accountId);
}
