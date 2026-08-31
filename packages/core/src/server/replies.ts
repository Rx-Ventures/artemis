/**
 * Reply-building helpers shared by the server's route modules.
 *
 * Extracted from `http.ts` unchanged when the remote bridge surface
 * (`remote.ts`) grew its own routes: two modules writing replies must agree on
 * the headers — the CORS story in particular is a single policy, argued once
 * in `http.ts`'s file comment — and a second copy is how they stop agreeing.
 */

import type { ServerErrorBody } from '@rx-artemis/protocol';

import type { ServerReply } from './http.js';

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  // The catalogue describes live accounts and can change between two polls.
  // Nothing here should ever be served from a client's disk cache.
  'cache-control': 'no-store',
};

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  // DELETE is here for exactly one route — abandoning a sign-in — and is
  // enumerated at the router rather than allowed generally: every other path
  // refuses it with the same 405 it refuses a PUT with.
  'access-control-allow-methods': 'GET, HEAD, OPTIONS, POST, DELETE',
  // `x-api-key` alongside the standard header because Anthropic-shaped clients
  // send that one, and a client that has to be reconfigured to talk to a
  // compatibility layer is a compatibility layer that did not work.
  // `last-event-id` is the event stream's resume point (see `remote.ts`); a
  // browser client reconnecting cross-origin has to be allowed to send it.
  'access-control-allow-headers': 'authorization, content-type, x-api-key, last-event-id',
  'access-control-max-age': '600',
};

export function ok(body: unknown): ServerReply {
  return { status: 200, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body };
}

export function fail(status: number, type: string, code: string, message: string): ServerReply {
  const body: ServerErrorBody = { error: { message, type, code } };
  return { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body };
}
