/**
 * A typed client for one Artemis installation.
 * ============================================================================
 *
 * The server speaks two dialects — OpenAI's on `/v1`, Artemis's own on
 * `/api/v0` — and the split exists because they answer different questions. Use
 * the OpenAI SDK for the first: it is a solved problem, every ecosystem tool
 * already speaks it, and a hand-rolled competitor would be a worse version of
 * something that works.
 *
 * This is for the second, which has no SDK because it is Artemis's own API.
 * What lives there is the part that cannot be expressed in OpenAI's schema: a
 * model belongs to an *account*, it accepts a particular set of thinking
 * levels, and it may or may not accept fast mode or ultracode. A program that
 * cannot read those has to guess, and guessing wrong is silent — the run
 * accepts the setting and ignores it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 *
 * Not a wrapper around the OpenAI surface, and not a chat client. It reads a
 * catalogue. When completions land, they land here as their own methods and the
 * OpenAI SDK stays the better way to *run* a turn — the two are complements,
 * and a client that tried to be both would end up a worse `openai` package with
 * an Artemis logo.
 *
 * ---------------------------------------------------------------------------
 * NO DEPENDENCIES, ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * Global `fetch` and nothing else, so this runs unmodified in Node 18+, Deno,
 * Bun, a browser extension and a renderer process. `fetch` is injectable for the
 * cases where the global is not the right one — a test, a proxy agent, a
 * runtime that wants its own — and that injection point is the only seam.
 *
 * ---------------------------------------------------------------------------
 * THE PUBLIC TYPES NAME NO ENVIRONMENT
 * ---------------------------------------------------------------------------
 *
 * {@link FetchLike}, {@link FetchLikeResponse} and {@link AbortSignalLike} exist
 * because the first version of this file typed those three things as `typeof
 * globalThis.fetch`, `Response` and `AbortSignal` — the real DOM types — and the
 * emitted `.d.ts` therefore *required its consumers to include the DOM library*.
 * A plain Node project with `"lib": ["ES2023"]` could install this package and
 * then fail to compile with `Cannot find name 'AbortSignal'`, pointing inside
 * `node_modules` at a file it did not write. Caught by typechecking a scratch
 * project against it rather than by trusting that it built here.
 *
 * Each of the three is a *structural subset* of the real thing, so passing the
 * genuine global still satisfies it and no cast is needed at the call site. The
 * casts are in here instead, where the runtime really is known.
 */

import type {
  OpenAiModel,
  OpenAiModelList,
  ServerConnectionInfo,
  ServerErrorBody,
  ServerHealthBody,
  ServerModel,
  ServerModelsBody,
  ServerProfile,
  ServerProfilesBody,
} from '@rx-artemis/protocol';
import { DEFAULT_SERVER_PORT, SERVER_API_VERSION, SERVER_HOST } from '@rx-artemis/protocol';

/** The address of a default Artemis installation on this machine. */
export const DEFAULT_BASE_URL = `http://${SERVER_HOST}:${DEFAULT_SERVER_PORT}`;

/* -------------------------------------------------------------------------- */
/* Structural stand-ins for the runtime's own types                           */
/* -------------------------------------------------------------------------- */

/**
 * As much of a `Response` as this client reads.
 *
 * A real `Response` satisfies it, so `options.fetch = globalThis.fetch` still
 * typechecks — see the file comment for why the real type is not named here.
 */
export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * As much of an `AbortSignal` as a caller needs to hand over.
 *
 * Only `aborted` is named, which every real signal has. The client does not
 * read it — it forwards the signal to `fetch` — so a narrower shape here costs
 * nothing and buys a package that compiles in a project with no DOM lib.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/**
 * As much of `fetch` as this client calls.
 *
 * `init.signal` is `any` deliberately and in exactly one place. Parameters are
 * checked contravariantly, so a stricter type here would make the *real* global
 * `fetch` fail to be assignable to this — the opposite of what the seam is for.
 */
export type FetchLike = (
  url: string,
  init: {
    readonly headers: Record<string, string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    readonly signal?: any;
  },
) => Promise<FetchLikeResponse>;

export interface ArtemisClientOptions {
  /**
   * Where the server is, with or without a trailing slash — `http://127.0.0.1:6472`.
   *
   * Defaults to {@link DEFAULT_BASE_URL}. Point it at the port shown in
   * Settings → Server; a user who chose `0` gets a different one each launch,
   * which is why this is a required consideration rather than a constant.
   */
  readonly baseUrl?: string;
  /**
   * The bearer token from Settings → Server.
   *
   * Every path but `/health` needs it. Omitting it is legal and gives a client
   * that can only check liveness — occasionally what you want, and never a
   * surprise, because everything else answers {@link ArtemisAuthError}.
   */
  readonly token?: string;
  /**
   * How long any one request may take, in milliseconds. Defaults to 30s.
   *
   * The first catalogue read of a cold server asks every account's CLI what it
   * offers, which is seconds rather than milliseconds — so this is generous by
   * default and worth raising rather than lowering on a machine with many
   * accounts.
   */
  readonly timeoutMs?: number;
  /** Injected for tests, proxies, and runtimes whose global is not the one you want. */
  readonly fetch?: FetchLike;
}

/** Options every request accepts. */
export interface RequestOptions {
  /**
   * Abort this request. Composed with the client's timeout rather than
   * replacing it, so a caller's signal cannot accidentally disable the timeout.
   */
  readonly signal?: AbortSignalLike;
}

export interface ListModelsOptions extends RequestOptions {
  /**
   * Only routes belonging to this account. Its slug (`work-max`) or its id.
   *
   * Filtered by the server rather than here: an installation with several
   * accounts publishes a catalogue per account, and a client pinned to one
   * should not receive — or have to hold in memory — everyone else's.
   */
  readonly profile?: string;
  /**
   * Make the server re-ask every provider instead of answering from its cache.
   *
   * Expensive, and it is the server's CPU you are spending: one subprocess per
   * account. For a program that polls, leave it off — the cache exists for you.
   */
  readonly refresh?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The server answered, and the answer was a refusal.
 *
 * Carries the status and the machine-readable `code` rather than only a
 * message, because the four failures a program meets here need four different
 * responses from it, and matching on prose is how that goes wrong.
 */
export class ArtemisServerError extends Error {
  readonly status: number;
  /** `invalid_api_key`, `model_not_found`, `not_implemented`, … */
  readonly code: string | undefined;
  readonly type: string | undefined;

  constructor(status: number, body: Partial<ServerErrorBody['error']>, fallback: string) {
    super(body.message ?? fallback);
    this.name = 'ArtemisServerError';
    this.status = status;
    this.code = body.code;
    this.type = body.type;
  }
}

/** 401 — the token is missing or wrong. Its own class so a caller can catch just this. */
export class ArtemisAuthError extends ArtemisServerError {
  constructor(status: number, body: Partial<ServerErrorBody['error']>) {
    super(status, body, 'The Artemis server refused this token.');
    this.name = 'ArtemisAuthError';
  }
}

/**
 * 501 — the endpoint is one this server intends to have and does not have yet.
 *
 * Distinct from a 404 because the two ask different things of a program:
 * "you asked for something that does not exist" versus "you asked for something
 * this build cannot do yet", and only the second is worth telling a user about
 * as a version problem.
 */
export class ArtemisNotImplementedError extends ArtemisServerError {
  constructor(status: number, body: Partial<ServerErrorBody['error']>) {
    super(status, body, 'This Artemis build does not serve that endpoint yet.');
    this.name = 'ArtemisNotImplementedError';
  }
}

/** The server could not be reached at all — wrong port, not running, no network path. */
export class ArtemisUnreachableError extends Error {
  readonly baseUrl: string;

  constructor(baseUrl: string, cause: unknown) {
    super(
      `Could not reach an Artemis server at ${baseUrl}. Is it running? Settings → Server has the address and the token.`,
      { cause },
    );
    this.name = 'ArtemisUnreachableError';
    this.baseUrl = baseUrl;
  }
}

/* -------------------------------------------------------------------------- */
/* The client                                                                 */
/* -------------------------------------------------------------------------- */

export interface ArtemisClient {
  /** Where this client is pointed. */
  readonly baseUrl: string;

  /**
   * Is a server listening, and which build?
   *
   * The only call that works without a token, which makes it the right thing to
   * poll while waiting for an installation to come up.
   */
  health(options?: RequestOptions): Promise<ServerHealthBody>;

  /**
   * What this connection is, and where its turns run.
   *
   * The call to make at startup. Without it a program knows its token works and
   * nothing else — not whether it may run turns at all, and not which directory
   * it was bound to when a person created it. A client that renders a "working
   * in …" line, or that refuses to offer a Run button on a catalogue-only
   * token, needs exactly this.
   */
  connection(options?: RequestOptions): Promise<ServerConnectionInfo>;

  /**
   * Every account, with its capabilities and the models it offers.
   *
   * The account is the unit worth branching on: two profiles offering the same
   * model are two plans and two bills, and `live` tells you whether the account
   * confirmed its own catalogue or the server is quoting built-in names.
   */
  profiles(options?: RequestOptions): Promise<readonly ServerProfile[]>;

  /** Every route, flattened, with the thinking levels and flags each accepts. */
  models(options?: ListModelsOptions): Promise<readonly ServerModel[]>;

  /**
   * One route — `work-max/opus` — or `undefined` if this installation has no
   * such thing.
   *
   * Absent rather than thrown, because "does this machine have that model?" is
   * a question, and a program asking it is usually about to fall back to
   * another route rather than fail.
   */
  model(route: string, options?: RequestOptions): Promise<ServerModel | undefined>;

  /**
   * The OpenAI-shaped listing, for a program that only wants ids.
   *
   * Here for completeness; if you are talking to `/v1` for anything else, use
   * the OpenAI SDK against `${baseUrl}/v1` instead — it is the same endpoint and
   * it comes with everything else that surface will grow.
   */
  openaiModels(options?: RequestOptions): Promise<readonly OpenAiModel[]>;
}

export function createArtemisClient(options: ArtemisClientOptions = {}): ArtemisClient {
  // One trailing slash here becomes a double slash in every path built below,
  // and `//api/v0/models` is a 404 that looks like a server fault.
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  // The cast is the one place the real global meets the structural type. A real
  // `fetch` satisfies `FetchLike` in every way that matters here; TypeScript
  // cannot see that through `globalThis` without the DOM lib this package
  // deliberately does not put in its public types.
  const resolved: FetchLike | undefined =
    options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;

  if (typeof resolved !== 'function') {
    // Better here than as `undefined is not a function` from inside a request:
    // the fix is a runtime upgrade or an injected fetch, and neither is
    // guessable from the stack trace this would otherwise produce.
    throw new TypeError(
      'No global fetch is available. Pass one as `fetch` (Node 18+, Deno, Bun and browsers have it built in).',
    );
  }

  // Re-bound after the guard so the narrowing survives into the closure below.
  const doFetch: FetchLike = resolved;

  async function request<T>(path: string, requestOptions?: RequestOptions): Promise<T> {
    /*
     * The caller's signal and the timeout are composed, not chosen between.
     *
     * `AbortSignal.any` is the whole of it: pass only the caller's and a hung
     * server hangs the program; pass only the timeout and a caller's own
     * cancellation is ignored. `any` is ES2024 in the runtimes this targets, so
     * it is used through a guard rather than assumed.
     */
    const timeout = AbortSignal.timeout(timeoutMs);
    // Cast back to the runtime's own type: the public parameter is structural
    // (see `AbortSignalLike`), and what a caller actually passes is a real
    // signal, which is what `AbortSignal.any` requires.
    const caller = requestOptions?.signal as AbortSignal | undefined;
    const signal =
      caller === undefined
        ? timeout
        : typeof AbortSignal.any === 'function'
          ? AbortSignal.any([timeout, caller])
          : caller;

    let response: FetchLikeResponse;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        headers: {
          accept: 'application/json',
          // Only when there is one. An `Authorization: Bearer undefined` header
          // is a wrong token rather than an absent one, and the server would be
          // right to count it as a refusal.
          ...(options.token === undefined || options.token.length === 0
            ? {}
            : { authorization: `Bearer ${options.token}` }),
        },
        signal,
      });
    } catch (cause) {
      // A timeout is a reachability problem from the caller's point of view —
      // they cannot act on the distinction — so both arrive as one error.
      throw new ArtemisUnreachableError(baseUrl, cause);
    }

    if (!response.ok) throw await toError(response);

    return (await response.json()) as T;
  }

  return {
    baseUrl,

    health: (requestOptions) => request<ServerHealthBody>('/health', requestOptions),

    connection: (requestOptions) =>
      request<ServerConnectionInfo>(`/api/${SERVER_API_VERSION}/connection`, requestOptions),

    profiles: async (requestOptions) =>
      (await request<ServerProfilesBody>(`/api/${SERVER_API_VERSION}/profiles`, requestOptions))
        .profiles,

    models: async (listOptions) => {
      const query = new URLSearchParams();
      if (listOptions?.profile !== undefined) query.set('profile', listOptions.profile);
      if (listOptions?.refresh === true) query.set('refresh', '1');
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return (
        await request<ServerModelsBody>(
          `/api/${SERVER_API_VERSION}/models${suffix}`,
          listOptions,
        )
      ).models;
    },

    model: async (route, requestOptions) => {
      try {
        // Encoded whole: a route contains a separator by construction, and a
        // model id may contain another (`library/llama3:8b`).
        return await request<ServerModel>(
          `/api/${SERVER_API_VERSION}/models/${encodeURIComponent(route)}`,
          requestOptions,
        );
      } catch (error) {
        if (error instanceof ArtemisServerError && error.status === 404) return undefined;
        throw error;
      }
    },

    openaiModels: async (requestOptions) =>
      (await request<OpenAiModelList>('/v1/models', requestOptions)).data,
  };
}

/**
 * Turn a failed response into the narrowest error that fits.
 *
 * The body is read defensively: this is the path that runs when something has
 * already gone wrong, and a client that threw a `SyntaxError` while parsing an
 * error page would replace a useful 502 with a meaningless one.
 */
async function toError(response: FetchLikeResponse): Promise<ArtemisServerError> {
  let body: Partial<ServerErrorBody['error']> = {};
  try {
    const parsed = (await response.json()) as Partial<ServerErrorBody>;
    if (parsed !== null && typeof parsed === 'object' && parsed.error !== undefined) {
      body = parsed.error;
    }
  } catch {
    // Not JSON, or no body at all. The status still says something true.
  }

  if (response.status === 401 || response.status === 403) {
    return new ArtemisAuthError(response.status, body);
  }
  if (response.status === 501) return new ArtemisNotImplementedError(response.status, body);
  return new ArtemisServerError(response.status, body, `The Artemis server answered ${response.status}.`);
}

/* -------------------------------------------------------------------------- */
/* Reading a catalogue                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Does this model accept this thinking level?
 *
 * A function rather than a note in the docs, because the failure it prevents is
 * the quiet one. A provider publishes a scale, a *model* accepts part of it, and
 * a level outside that part is dropped by the run without complaint — the
 * caller believes it asked for deep reasoning and got the default. Ask before
 * sending, and fall back to {@link deepestThinkingLevel} when the answer is no.
 */
export function acceptsThinkingLevel(model: ServerModel, level: string): boolean {
  return model.thinkingLevels.some((candidate) => candidate.id === level);
}

/**
 * The most effort this model will accept, or `undefined` if it takes none.
 *
 * The levels arrive ordered least-to-most by the adapter that published them —
 * that ordering is part of the contract — so this is the last one rather than a
 * search for a name. Nothing here knows what any provider calls its levels, and
 * a client that hard-coded `'max'` would be wrong on the first provider that
 * stops at `'high'`.
 */
export function deepestThinkingLevel(model: ServerModel): string | undefined {
  return model.thinkingLevels.at(-1)?.id;
}

/**
 * Can this connection run a turn at all?
 *
 * A one-liner over {@link ServerConnectionInfo.canRunTurns}, worth having
 * because the alternative is every caller reaching for `workspace.kind !==
 * 'none'` and duplicating a rule that belongs to the server.
 */
export function canRunTurns(connection: ServerConnectionInfo): boolean {
  return connection.canRunTurns;
}

/**
 * Routes that can actually be used right now.
 *
 * Filters out accounts whose provider is unavailable in that installation.
 * Hidden profiles are *kept*: a user hiding an account from Artemis's own
 * picker has said nothing about the program they configured against it, and a
 * route that vanished for that reason is the harder failure to diagnose.
 */
export function usableModels(profiles: readonly ServerProfile[]): readonly ServerModel[] {
  return profiles.filter((profile) => profile.available).flatMap((profile) => profile.models);
}
