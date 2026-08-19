/**
 * The server itself: routing, auth, and a socket.
 * ============================================================================
 *
 * Two layers, split so that the interesting half can be tested without a port.
 * {@link handleServerRequest} is a function from a request to a response —
 * every routing and authorisation decision lives there, and a test calls it
 * directly. {@link createArtemisServer} is the thin part that owns a
 * `node:http` server, counts traffic and turns the result into bytes.
 *
 * ---------------------------------------------------------------------------
 * WHAT GUARDS THIS PORT
 * ---------------------------------------------------------------------------
 *
 * Three checks, in this order, and each covers a hole the others do not.
 *
 * **1. The Host header must name loopback.** The socket is bound to
 * `127.0.0.1`, which stops another machine connecting — and does nothing about
 * DNS rebinding, where a page the user is looking at resolves an attacker's
 * hostname to `127.0.0.1` and then talks to this port from inside their
 * browser. The request arrives on loopback and looks local. What it cannot fake
 * is the `Host` header, which still says `evil.example`, so that is what is
 * checked.
 *
 * **2. A bearer token, compared in constant time.** The token is the only thing
 * separating a program the user configured from every other process on the
 * machine. `===` on a secret leaks its length and its matching prefix to
 * anything that can time the reply, which over loopback is everything, so the
 * comparison is `timingSafeEqual`.
 *
 * **3. Methods are enumerated, not assumed.** `GET`, `HEAD` and `OPTIONS` read;
 * exactly one `POST` route runs a turn, and it is named explicitly rather than
 * reached by relaxing the gate. Every other path answers `405` — or `404`, when
 * the path does not exist at all, since "wrong verb" on a route this server has
 * never heard of sends the caller looking for the right one.
 *
 * `OPTIONS` is exempt from the token and cannot be otherwise: a CORS preflight
 * is sent by the browser before the request that carries the credential, so a
 * server that demanded one would fail every browser client at the first hop. It
 * is safe because a preflight response carries no data — it only says which
 * requests *would* be allowed, and those are still checked when they arrive.
 *
 * ---------------------------------------------------------------------------
 * WHY CORS IS OPEN
 * ---------------------------------------------------------------------------
 *
 * `Access-Control-Allow-Origin: *`, which looks alarming and is not, because of
 * one property: this server has **no ambient authority**. There is no cookie,
 * no session, nothing the browser attaches on its own. Every request is
 * authorised by a token the caller must already know, so a hostile page that
 * reaches the port gets a 401 exactly as a hostile `curl` does, and a friendly
 * web client — a local dashboard, a browser-based editor — works without a
 * proxy. `Allow-Credentials` is deliberately absent, which is what keeps that
 * true.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type {
  OpenAiChatRequest,
  OpenAiModelList,
  ServerErrorBody,
  ServerHealthBody,
  ServerModel,
  ServerModelsBody,
  ServerConnection,
  ServerProfile,
  ServerProfilesBody,
} from '@rx-artemis/protocol';
import {
  SERVER_API_VERSION,
  SERVER_HEALTH_PATH,
  SERVER_HOST,
  SSE_DONE,
  describeConnection,
  parseModelRoute,
  readChatExtensions,
  reviewParameters,
  sseEvent,
  visibleToConnection,
} from '@rx-artemis/protocol';

import type { Catalogue } from './catalogue.js';
import {
  chatChunk,
  chatResponse,
  runTurn,
  type RunSource,
  type TurnResult,
} from './completions.js';
import { WorkspaceUnavailableError, type WorkspaceResolver } from './workspaces.js';

/* -------------------------------------------------------------------------- */
/* The request/response shapes the router works in                            */
/* -------------------------------------------------------------------------- */

/** One request, reduced to what routing and auth actually read. */
export interface ServerRequestInfo {
  readonly method: string;
  /** Path and query, as it arrived on the wire: `/v1/models?refresh=1`. */
  readonly url: string;
  /** Lower-cased header names, as `node:http` already delivers them. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * The parsed JSON body, for the one route that has one.
   *
   * Read and parsed by the socket layer rather than here, so the router stays a
   * pure function of its inputs and a test can hand it an object instead of a
   * stream.
   */
  readonly body?: unknown;
  /** Aborts when the client hangs up mid-turn. */
  readonly signal?: { readonly aborted: boolean };
}

/** What the router decided. `body` is JSON-serialisable or `null` for no content. */
export interface ServerReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  /**
   * Which connection answered, when one did.
   *
   * Carried out so the socket layer can stamp `lastUsedAt` without re-deriving
   * the match — and so it never has to look at a token to do it.
   */
  readonly connectionId?: string;
  /**
   * The request was refused for a bad or missing token.
   *
   * Surfaced separately from the status code so the traffic counter can report
   * it without re-deriving intent from a number — a 401 from auth and a 404
   * from a typo are different news for the user watching the pane.
   */
  readonly rejected?: boolean;
}

/** What the router needs besides the request. */
export interface ServerContext {
  /**
   * Every configured connection. A request authenticates as exactly one.
   *
   * A list rather than a single token because the token *is* the identity here:
   * it decides which directory a turn runs in and which accounts are reachable.
   * See {@link ServerConnection}.
   */
  readonly connections: readonly ServerConnection[];
  /** Artemis's version, reported by `/health` and the index. */
  readonly version: string;
  readonly catalogue: Catalogue;
  /**
   * Epoch ms the server started listening.
   *
   * OpenAI's model rows carry a `created` timestamp and clients do parse it.
   * Artemis has nothing truthful to put there — a route is not a thing with a
   * creation date — so it reports when this server came up, which is at least a
   * real event and is stable for the lifetime of the process.
   */
  readonly startedAt: number;
  /**
   * How to run a turn, when this build can.
   *
   * Absent means the completions surface answers `501` — which is what a
   * catalogue-only deployment does, and what every test that is not about
   * running turns gets.
   */
  readonly runs?: RunSource;
  /** Where a connection's turns run. Required alongside {@link runs}. */
  readonly workspaces?: WorkspaceResolver;
}

/** True when this reply is written incrementally rather than as one body. */
export function isStreamReply(reply: ServerReply | ServerStreamReply): reply is ServerStreamReply {
  return 'stream' in reply;
}

/** A reply that is written as a stream of events rather than one JSON body. */
export interface ServerStreamReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly connectionId?: string;
  /** Each yielded string is written and flushed as it arrives. */
  readonly stream: AsyncIterable<string>;
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  // The catalogue describes live accounts and can change between two polls.
  // Nothing here should ever be served from a client's disk cache.
  'cache-control': 'no-store',
};

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS, POST',
  // `x-api-key` alongside the standard header because Anthropic-shaped clients
  // send that one, and a client that has to be reconfigured to talk to a
  // compatibility layer is a compatibility layer that did not work.
  'access-control-allow-headers': 'authorization, content-type, x-api-key',
  'access-control-max-age': '600',
};

/** Hosts a request may legitimately claim to have been sent to. See the file comment. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Endpoints this server intends to have and does not have yet.
 *
 * Listed so they can answer `501` with a sentence instead of falling through to
 * a bare `404` — see where this is used. The list is the OpenAI surface a
 * client is most likely to reach for the moment it has a model id in hand, and
 * each entry comes off it as it is implemented.
 */
const PLANNED_PATHS = new Set(['/v1/completions', '/v1/responses', '/v1/embeddings']);

/** The one path that runs a turn. */
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/**
 * The largest request body this server will read.
 *
 * A megabyte is far more than a conversation needs and far less than a caller
 * could use to exhaust memory. The cap exists because body size is the one
 * resource an authenticated client controls directly.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Answer one request.
 *
 * Never throws: a fault becomes a 500 with an error body, because a rejected
 * promise here would take out the socket rather than the request.
 */
export async function handleServerRequest(
  request: ServerRequestInfo,
  context: ServerContext,
): Promise<ServerReply | ServerStreamReply> {
  const method = request.method.toUpperCase();

  // Preflight first, before anything that could 401 or 404 it — see the file
  // comment on why this one cannot carry a token.
  if (method === 'OPTIONS') {
    return { status: 204, headers: { ...CORS_HEADERS }, body: null };
  }

  if (!hostIsLocal(request.headers['host'])) {
    // Deliberately curt. A caller that reached this branch is either a
    // rebinding attempt or a proxy misconfiguration, and neither deserves a
    // description of what the server would have accepted.
    return fail(403, 'invalid_request_error', 'forbidden_host', 'This server only answers on loopback.');
  }

  // Parsed against a fixed base: `request.url` is a path, not an absolute URL,
  // and the base is never used for anything but making `URL` willing to parse.
  let url: URL;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    return fail(400, 'invalid_request_error', 'invalid_url', 'The request path could not be parsed.');
  }
  const path = normalizePath(url.pathname);

  if (path === SERVER_HEALTH_PATH) {
    const health: ServerHealthBody = {
      object: 'artemis.health',
      status: 'ok',
      version: context.version,
      api: SERVER_API_VERSION,
    };
    return ok(health);
  }

  const connection = resolveConnection(request.headers, context.connections);
  if (connection === undefined) {
    return {
      ...fail(
        401,
        'authentication_error',
        'invalid_api_key',
        'Send a connection token as `Authorization: Bearer <token>`. Settings → Server lists them, and each one carries its own working directory.',
      ),
      rejected: true,
    };
  }

  const refresh = url.searchParams.get('refresh') === '1';
  const apiPrefix = `/api/${SERVER_API_VERSION}`;

  /**
   * The catalogue *this* connection can see.
   *
   * Filtered rather than merely enforced at call time, and that is the point of
   * doing it here: a connection restricted to one account should not be able to
   * *enumerate* the others, nor to see models on an account it may use but is
   * not allowed to run. A picker built against this token shows what it can
   * actually use, so a user of that program is never offered a route that will
   * come back refused.
   */
  const visibleProfiles = async (): Promise<readonly ServerProfile[]> =>
    visibleToConnection(connection, await context.catalogue.read({ refresh }));

  /** Every reply from here on is attributable to the connection that asked. */
  const answer = (body: unknown): ServerReply => ({ ...ok(body), connectionId: connection.id });

  /*
   * "Not built yet" is a different answer from "no such thing", and a client
   * deserves to be told which.
   *
   * This build serves the catalogue and nothing else, so every completions path
   * is absent — but absent for a reason a caller can act on. The first version
   * of this file checked the method before the path and answered `405 Method
   * Not Allowed` to `POST /v1/chat/completions`, which is precisely the wrong
   * thing to say: 405 means "this endpoint exists, you used the wrong verb",
   * and an OpenAI client shows that to a user who then goes looking for a GET.
   * Found by pointing the real SDK at it.
   *
   * 501 rather than 404, because the distinction is the whole point: the route
   * is one this server intends to have and does not have yet.
   */
  if (path === CHAT_COMPLETIONS_PATH) {
    if (method !== 'POST') {
      return fail(
        405,
        'invalid_request_error',
        'method_not_allowed',
        'Chat completions are a POST.',
      );
    }
    return handleChatCompletions(request, context, connection);
  }

  if (PLANNED_PATHS.has(path)) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      `Artemis's server does not run turns yet — it publishes its catalogue only. ${path} is planned; list what is available at /v1/models.`,
    );
  }

  if (method !== 'GET' && method !== 'HEAD') {
    // 405 only for a route that genuinely exists and genuinely refuses the
    // verb. Anything else is a 404, because "wrong method" on a path this
    // server has never heard of sends the caller looking for the right verb.
    return isServedPath(path)
      ? fail(
          405,
          'invalid_request_error',
          'method_not_allowed',
          `${method} is not supported. This server is read-only.`,
        )
      : fail(404, 'invalid_request_error', 'unknown_endpoint', `No route for ${path}.`);
  }

  if (path === '/') return answer(indexBody(context));

  /**
   * Who am I, and where do my turns run?
   *
   * The call a client makes at startup to find out what it was handed. Without
   * it a program knows its token works and nothing else — not which directory
   * it is bound to, and not whether it may run turns at all.
   */
  if (path === `${apiPrefix}/connection`) return answer(describeConnection(connection));

  if (path === '/v1/models') {
    const profiles = await visibleProfiles();
    const list: OpenAiModelList = {
      object: 'list',
      data: routableModels(profiles).map((model) => ({
        id: model.route,
        object: 'model',
        // Seconds, not milliseconds. Every OpenAI client divides or formats
        // this, and a value a thousand times too large renders as the year
        // 56000 in the ones that format it.
        created: Math.floor(context.startedAt / 1000),
        owned_by: model.profileSlug,
      })),
    };
    return answer(list);
  }

  if (path.startsWith('/v1/models/')) {
    const profiles = await visibleProfiles();
    const model = findModel(profiles, path.slice('/v1/models/'.length));
    if (model === undefined) return modelNotFound(path.slice('/v1/models/'.length));
    return answer({
      id: model.route,
      object: 'model',
      created: Math.floor(context.startedAt / 1000),
      owned_by: model.profileSlug,
    });
  }

  if (path === `${apiPrefix}/profiles`) {
    const profiles = await visibleProfiles();
    const body: ServerProfilesBody = { object: 'artemis.profiles', profiles };
    return answer(body);
  }

  if (path === `${apiPrefix}/models`) {
    const profiles = await visibleProfiles();
    // A `?profile=` filter, because the flat list is the one a client polls and
    // an editor pinned to one account should not have to receive every other
    // account's catalogue to find its own rows. Matches slug or id, exactly as
    // a route's left half does.
    const wanted = url.searchParams.get('profile');
    const models = routableModels(profiles).filter(
      (model) =>
        wanted === null || model.profileSlug === wanted || String(model.profileId) === wanted,
    );
    const body: ServerModelsBody = { object: 'artemis.models', models };
    return answer(body);
  }

  if (path.startsWith(`${apiPrefix}/models/`)) {
    const profiles = await visibleProfiles();
    const route = path.slice(`${apiPrefix}/models/`.length);
    const model = findModel(profiles, route);
    if (model === undefined) return modelNotFound(route);
    return answer(model);
  }

  return fail(404, 'invalid_request_error', 'unknown_endpoint', `No route for ${path}.`);
}

/**
 * The index: what this server is and where the rest of it is.
 *
 * Present because the first thing anyone does with a new local server is open
 * its root in a browser, and a 404 there teaches them nothing. Every path it
 * names is one this build actually serves.
 */
function indexBody(context: ServerContext): Record<string, unknown> {
  const apiPrefix = `/api/${SERVER_API_VERSION}`;
  return {
    object: 'artemis.server',
    version: context.version,
    api: SERVER_API_VERSION,
    endpoints: [
      { method: 'GET', path: SERVER_HEALTH_PATH, description: 'Liveness. The only path that needs no token.' },
      { method: 'GET', path: '/v1/models', description: 'Every route, in OpenAI shape.' },
      { method: 'GET', path: '/v1/models/{profile}/{model}', description: 'One route, in OpenAI shape.' },
      {
        method: 'GET',
        path: `${apiPrefix}/connection`,
        description: 'What your token is, and where its turns run.',
      },
      {
        method: 'GET',
        path: `${apiPrefix}/profiles`,
        description: 'Accounts, their capabilities, and the models each offers.',
      },
      {
        method: 'GET',
        path: `${apiPrefix}/models`,
        description:
          'Every route with thinking levels, fast mode and ultracode. Filter with ?profile=<slug>.',
      },
      {
        method: 'GET',
        path: `${apiPrefix}/models/{profile}/{model}`,
        description: 'One route, in full.',
      },
    ],
    // Said out loud rather than left to a 401: a catalogue that changes when an
    // account is added is worth re-reading, and a client that does not know the
    // answer is cached will not know why its refresh did nothing.
    notes: [
      'Every path except /health requires `Authorization: Bearer <token>`.',
      'A model is addressed as `<profile>/<model>` — the account is part of the address.',
      'Where a turn runs is fixed to your connection, not chosen per request. See /api/v0/connection.',
      'Catalogues are cached for a few minutes. Append ?refresh=1 to force a re-read.',
    ],
  };
}

/** Every model on the server, in profile order. */
function routableModels(profiles: readonly ServerProfile[]): readonly ServerModel[] {
  return profiles.flatMap((profile) => profile.models);
}

/**
 * Resolve a route to a model.
 *
 * The path segment arrives percent-encoded in the general case — a client that
 * URL-encoded the slash is not wrong — so it is decoded before parsing.
 * Matching accepts the profile's slug *or* its id, which is what makes a route
 * survivable across a rename: see `parseModelRoute`.
 */
function findModel(
  profiles: readonly ServerProfile[],
  rawRoute: string,
): ServerModel | undefined {
  const parsed = parseModelRoute(decodeRoute(rawRoute));
  if (parsed === undefined) return undefined;

  for (const profile of profiles) {
    if (profile.slug !== parsed.profile && String(profile.id) !== parsed.profile) continue;
    for (const model of profile.models) {
      if (model.id === parsed.model) return model;
    }
  }
  return undefined;
}

/**
 * Undo the encoding a client may have applied to a route.
 *
 * A caller that percent-encoded the separator is not wrong, so `work-max%2Fopus`
 * has to resolve. A malformed escape is left as it arrived rather than throwing:
 * the caller asked for something that is not here either way, and a 400 about
 * URL syntax is a worse answer than "no such model".
 */
function decodeRoute(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The message quotes the route as the *caller meant it*, not as it arrived.
 *
 * Echoing the raw path put `work-max%2Fgpt-4` in front of a user who typed
 * `work-max/gpt-4` — the client shows this string verbatim, so an escape
 * sequence in it reads as part of the name they got wrong.
 */
function modelNotFound(route: string): ServerReply {
  return fail(
    404,
    'invalid_request_error',
    'model_not_found',
    `No model is routed at "${decodeRoute(route)}". List them at /v1/models.`,
  );
}

/**
 * Is this a path this build actually answers?
 *
 * Only used to tell a `405` from a `404` — the GET routing below is still the
 * one place a route is resolved, so this cannot drift into being a second
 * router. Kept in step with it by being the same four paths and two prefixes.
 */
function isServedPath(path: string): boolean {
  const apiPrefix = `/api/${SERVER_API_VERSION}`;
  return (
    path === '/' ||
    path === SERVER_HEALTH_PATH ||
    path === '/v1/models' ||
    path === `${apiPrefix}/profiles` ||
    path === `${apiPrefix}/models` ||
    path.startsWith('/v1/models/') ||
    path.startsWith(`${apiPrefix}/models/`)
  );
}

/** Strip a trailing slash so `/v1/models/` and `/v1/models` are one route. */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function hostIsLocal(host: string | undefined): boolean {
  if (host === undefined) return false;
  // Strip the port. An IPv6 literal keeps its brackets, which is why they are
  // in `ALLOWED_HOSTS` — `[::1]:6472` splits to `[::1]`.
  const withoutPort = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? '');
  return ALLOWED_HOSTS.has(withoutPort.toLowerCase());
}

/**
 * Which connection does this request authenticate as, if any?
 *
 * Two headers are accepted for the reason {@link CORS_HEADERS} names one of
 * them: OpenAI-shaped clients send `Authorization: Bearer`, Anthropic-shaped
 * ones send `x-api-key`, and a router that only spoke one of those would turn
 * away half the ecosystem over a header name.
 *
 * **Every connection is compared, even after a match.** The loop does not break
 * early, because the time it takes to answer would otherwise reveal *which*
 * connection matched — and with it, roughly how many are configured and where in
 * the list a guessed prefix landed. The cost is a handful of fixed-time
 * comparisons on a list that is realistically single digits.
 */
function resolveConnection(
  headers: Readonly<Record<string, string | undefined>>,
  connections: readonly ServerConnection[],
): ServerConnection | undefined {
  const authorization = headers['authorization'];
  const presented =
    authorization !== undefined && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, '').trim()
      : (headers['x-api-key']?.trim() ?? '');

  // An empty header must never match a connection whose token is somehow empty.
  if (presented.length === 0) return undefined;

  let matched: ServerConnection | undefined;
  for (const connection of connections) {
    if (connection.token.length === 0) continue;
    if (constantTimeEquals(presented, connection.token)) matched = connection;
  }
  return matched;
}

/**
 * Compare two secrets without leaking where they diverge.
 *
 * `timingSafeEqual` throws on a length mismatch — which is itself the leak it
 * is meant to prevent — so the lengths are compared first and the result is
 * folded in rather than returned early. The buffers are only compared when they
 * are the same size, and a wrong-length token costs the same as a wrong one.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still do a comparison, against a same-length buffer, so the reply time
    // does not depend on whether the length was right.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function ok(body: unknown): ServerReply {
  return { status: 200, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body };
}

function fail(status: number, type: string, code: string, message: string): ServerReply {
  const body: ServerErrorBody = { error: { message, type, code } };
  return { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body };
}

/* -------------------------------------------------------------------------- */
/* The socket                                                                 */
/* -------------------------------------------------------------------------- */

export interface ArtemisServerOptions {
  readonly port: number;
  /**
   * How to run a turn. Omit for a catalogue-only server, which answers `501`
   * on the completions path — see {@link ServerContext.runs}.
   */
  readonly runs?: RunSource;
  /** Where turns run. Required alongside {@link runs}. */
  readonly workspaces?: WorkspaceResolver;
  /**
   * The configured connections, read fresh on every request.
   *
   * A function rather than an array, and that is what makes revocation mean
   * something: a token deleted in the Server tab stops working on the *next*
   * request, with no restart. An array captured at construction would keep
   * authorising a connection the user believed they had just removed.
   */
  readonly connections: () => readonly ServerConnection[];
  readonly version: string;
  readonly catalogue: Catalogue;
  /** Defaults to {@link SERVER_HOST}. Injected only so a test can be explicit. */
  readonly host?: string;
  /**
   * Called once per answered request, so the UI can show that something is
   * talking — and so the connection that asked can have its `lastUsedAt`
   * stamped. `connectionId` is absent when nothing authenticated.
   */
  readonly onRequest?: (outcome: {
    readonly rejected: boolean;
    readonly connectionId?: string;
  }) => void;
  /** Where a fault that never reached a client goes. */
  readonly onError?: (error: unknown) => void;
}

export interface ArtemisServer {
  /** Bind, and resolve the port actually bound — which differs from `port` when it was `0`. */
  listen(): Promise<number>;
  /** Stop accepting, and wait for open sockets to finish. */
  close(): Promise<void>;
}

/**
 * A listening Artemis server.
 *
 * Nothing here decides policy: every request goes straight to
 * {@link handleServerRequest} and the result is written out. What this layer
 * owns is the socket's own hazards — a listen that fails, a client that hangs
 * up mid-write, and a `close` that must not wait forever.
 */
export function createArtemisServer(options: ArtemisServerOptions): ArtemisServer {
  const host = options.host ?? SERVER_HOST;
  let startedAt = Date.now();

  const server: Server = createServer((request, response) => {
    void answer(request, response);
  });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    /*
     * The client going away is news the turn needs.
     *
     * A run started by this request is a real process on the user's machine
     * doing real work against their plan; if the caller has hung up, every
     * token after this point is spent on output nobody will read. The signal is
     * threaded into the router and reaches `runTurn`, which interrupts.
     */
    const disconnected = { aborted: false };
    request.on('aborted', () => {
      disconnected.aborted = true;
    });
    response.on('close', () => {
      if (!response.writableEnded) disconnected.aborted = true;
    });

    let reply: ServerReply | ServerStreamReply;
    try {
      reply = await handleServerRequest(
        {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers: request.headers as Readonly<Record<string, string | undefined>>,
          ...(await readJsonBody(request)),
          signal: disconnected,
        },
        {
          connections: options.connections(),
          version: options.version,
          catalogue: options.catalogue,
          startedAt,
          ...(options.runs === undefined ? {} : { runs: options.runs }),
          ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
        },
      );
    } catch (error) {
      options.onError?.(error);
      reply = {
        status: 500,
        headers: { ...JSON_HEADERS, ...CORS_HEADERS },
        // The message is fixed rather than the error's own: an exception's text
        // is written for a maintainer's log and can name a path, an account or
        // a command line, none of which belongs in a reply to a caller whose
        // identity is one token.
        body: { error: { message: 'The server failed to answer.', type: 'server_error' } },
      };
    }

    options.onRequest?.({
      rejected: isStreamReply(reply) ? false : reply.rejected === true,
      ...(reply.connectionId === undefined ? {} : { connectionId: reply.connectionId }),
    });

    // A client that hung up mid-request leaves nothing to write to, and
    // writing anyway throws asynchronously from a place with no caller.
    if (response.writableEnded || response.destroyed) return;

    if (isStreamReply(reply)) {
      response.writeHead(reply.status, { ...reply.headers });
      try {
        for await (const chunk of reply.stream) {
          if (response.writableEnded || response.destroyed) break;
          // Written and flushed one event at a time. Buffering here would turn
          // a stream into a slow whole-response, which is exactly what the
          // caller asked not to have.
          response.write(chunk);
        }
      } catch (error) {
        options.onError?.(error);
      }
      if (!response.writableEnded) response.end();
      return;
    }

    const payload = reply.body === null ? '' : `${JSON.stringify(reply.body)}\n`;
    const headers: Record<string, string> = { ...reply.headers };
    if (payload.length > 0) headers['content-length'] = String(Buffer.byteLength(payload));

    response.writeHead(reply.status, headers);
    // HEAD gets the headers and no body, which is the whole of what HEAD means
    // and what a client probing for liveness without cost expects.
    if (request.method?.toUpperCase() === 'HEAD' || payload.length === 0) {
      response.end();
      return;
    }
    response.end(payload);
  }

    /**
   * Read and parse a JSON body, for the routes that have one.
   *
   * Capped, because this is the one place a caller controls how much memory the
   * server allocates — an unbounded read is a one-line denial of service from
   * any process that has a token. A body that is not JSON is not an error here:
   * the router answers `400` with a message, which is a better failure than a
   * parse exception with no route context.
   */
  async function readJsonBody(request: IncomingMessage): Promise<{ body?: unknown }> {
    if (request.method !== 'POST') return {};

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return { body: undefined };
      chunks.push(buffer);
    }

    if (chunks.length === 0) return { body: undefined };
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { body: undefined };
    }
  }

  server.on('clientError', (error, socket) => {
    options.onError?.(error);
    // A malformed request line never reaches the router, so the reply is
    // written by hand. Without this the socket is left open until it times out.
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    listen() {
      return new Promise<number>((resolve, reject) => {
        const onError = (error: unknown): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          startedAt = Date.now();
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : options.port);
        };
        // `once` on both, and each removes the other: a server that fails to
        // bind emits `error` and never `listening`, and one that binds may emit
        // `error` later for an unrelated reason — which must not reject a
        // promise that has already resolved.
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, host);
      });
    },

    close() {
      return new Promise<void>((resolve) => {
        // `close` waits for open connections, and a client holding a keep-alive
        // socket would otherwise keep the port bound indefinitely — which the
        // user reads as "Stop did nothing". `closeAllConnections` is what makes
        // stopping immediate.
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Chat completions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Run a turn, and answer with it — whole, or streamed.
 *
 * Every refusal happens before the run starts, and that ordering is the point:
 * an unsupported parameter, a route this connection may not use, a workspace
 * that has gone away. Once a run begins the user's plan is being spent, so
 * nothing that could have been caught first is allowed to be caught after.
 */
async function handleChatCompletions(
  request: ServerRequestInfo,
  context: ServerContext,
  connection: ServerConnection,
): Promise<ServerReply | ServerStreamReply> {
  const attribute = <T extends { status: number }>(reply: T): T & { connectionId: string } => ({
    ...reply,
    connectionId: connection.id,
  });

  if (context.runs === undefined || context.workspaces === undefined) {
    return attribute(
      fail(
        501,
        'invalid_request_error',
        'not_implemented',
        "This Artemis build serves its catalogue but cannot run turns.",
      ),
    );
  }

  const body = request.body;
  if (typeof body !== 'object' || body === null) {
    return attribute(
      fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.'),
    );
  }
  const chat = body as OpenAiChatRequest;

  if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
    return attribute(
      fail(400, 'invalid_request_error', 'invalid_body', '`messages` must be a non-empty array.'),
    );
  }
  if (typeof chat.model !== 'string' || chat.model.length === 0) {
    return attribute(
      fail(400, 'invalid_request_error', 'invalid_body', '`model` must be a route, e.g. `work-max/opus`.'),
    );
  }

  const extensions = readChatExtensions(body);
  /*
   * `ignoreUnsupported` is read here rather than in `readChatExtensions`
   * because it is not a *setting for the run* — it changes how this request is
   * validated, and nothing downstream should be able to see it and act on it.
   */
  const lenient =
    (body as { artemis?: { ignoreUnsupported?: unknown } }).artemis?.ignoreUnsupported === true;
  const review = reviewParameters(body, { lenient });
  if (review.rejected.length > 0) {
    return attribute(
      fail(
        400,
        'invalid_request_error',
        'unsupported_parameter',
        `Artemis cannot honour ${review.rejected.join(', ')}, and will not accept a request that would be silently changed by ignoring them. Send \`artemis.ignoreUnsupported: true\` to proceed anyway.`,
      ),
    );
  }

  // The route is resolved against what *this connection* may see, so a model
  // outside its allowance is indistinguishable from one that does not exist.
  const model = findModel(await visibleToConnection(connection, await context.catalogue.read({})), chat.model);
  if (model === undefined) {
    return attribute(modelNotFound(chat.model));
  }

  let workspace;
  try {
    workspace = await context.workspaces.resolve({
      connectionId: connection.id,
      workspace: connection.workspace,
      ...(extensions.sessionId === undefined ? {} : { sessionId: extensions.sessionId }),
    });
  } catch (error) {
    // A catalogue-only connection, or a folder the user has since deleted.
    // 403 rather than 500: the caller asked for something they are not allowed
    // or able to have, and the message says which.
    return attribute(
      fail(
        403,
        'invalid_request_error',
        'workspace_unavailable',
        error instanceof WorkspaceUnavailableError
          ? error.message
          : 'This connection has nowhere to run turns.',
      ),
    );
  }

  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const turn = {
    model,
    cwd: workspace.path,
    request: chat,
    extensions,
    ignored: review.ignored,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };

  if (chat.stream === true) {
    return {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        // The three headers an SSE stream needs. `no-transform` is the one
        // people forget: a proxy that gzips this will buffer it, and a stream
        // that arrives all at once is not a stream.
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
      connectionId: connection.id,
      stream: streamTurn({ id, created, turn, runs: context.runs, model }),
    };
  }

  let result: TurnResult | undefined;
  for await (const event of runTurn(context.runs, turn)) {
    if (event.kind === 'done') result = event.result;
  }

  if (result === undefined) {
    return attribute(
      fail(502, 'server_error', 'no_result', 'The run ended without producing a reply.'),
    );
  }
  if (result.error !== undefined && result.text.length === 0) {
    // A failure with nothing to show for it is an error; one that produced text
    // before failing is a reply with a reason attached, and throwing that away
    // would lose work the user has already paid for.
    return attribute(fail(502, 'server_error', 'run_failed', result.error));
  }

  return attribute({
    status: 200,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
    body: chatResponse({
      id,
      model: model.route,
      created,
      result,
      ignored: review.ignored,
      ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
    }),
  });
}

/**
 * The same turn, as Server-Sent Events.
 *
 * The shape is OpenAI's exactly: a first chunk carrying the role, then one per
 * text fragment, then a chunk with `finish_reason`, then `[DONE]`. Clients
 * depend on that order — several treat the first chunk as the signal that the
 * stream is live, and every one of them stops at the sentinel.
 */
async function* streamTurn(input: {
  readonly id: string;
  readonly created: number;
  readonly turn: Parameters<typeof runTurn>[1];
  readonly runs: RunSource;
  readonly model: ServerModel;
}): AsyncIterable<string> {
  const { id, created, model } = input;

  yield sseEvent(
    chatChunk({ id, model: model.route, created, delta: { role: 'assistant' } }),
  );

  try {
    for await (const event of runTurn(input.runs, input.turn)) {
      if (event.kind === 'text') {
        yield sseEvent(chatChunk({ id, model: model.route, created, delta: { content: event.text } }));
        continue;
      }

      if (event.kind === 'done') {
        const { result } = event;
        yield sseEvent(
          chatChunk({
            id,
            model: model.route,
            created,
            delta: {},
            finishReason: result.finishReason,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            artemis: {
              ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
              ...(result.activity.length === 0 ? {} : { activity: result.activity }),
              endReason: result.endReason,
            },
          }),
        );
      }
      // `activity` is not streamed as its own event: an OpenAI client parses
      // every `data:` line as a chunk, and one it cannot parse is a hard error
      // in most SDKs. It rides on the final chunk instead.
    }
  } catch (error) {
    /*
     * A stream cannot change its status code — the 200 went out with the
     * headers — so a mid-stream failure is reported *in* the stream, as a final
     * chunk that stops cleanly. A client that sees the socket close without
     * `[DONE]` reports a network error, which is the wrong diagnosis.
     */
    yield sseEvent(
      chatChunk({
        id,
        model: model.route,
        created,
        delta: {
          content: `\n\n[the run failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }]`,
        },
        finishReason: 'stop',
      }),
    );
  }

  yield sseEvent(SSE_DONE);
}
