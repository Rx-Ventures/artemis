/**
 * Using Artemis through an OpenAI client.
 * ============================================================================
 *
 * The Artemis server speaks OpenAI's dialect on `/v1`, so the way to *run* a
 * turn is the OpenAI SDK — not a chat client reimplemented here. This module is
 * the seam between the two: it configures that SDK, and it builds the request
 * body for it.
 *
 * There is deliberately no dependency on the `openai` package. It is a peer
 * concern — the caller brings their own version, or the Vercel AI SDK, or
 * `fetch` — and a hard dependency would pin a major version on every consumer
 * to save them four lines of configuration.
 *
 * ---------------------------------------------------------------------------
 * THE POINT OF {@link buildChatRequest}
 * ---------------------------------------------------------------------------
 *
 * A caller can always spread `{ artemis: { thinking: 'max' } }` into a request
 * by hand. What they cannot easily do is know whether *this* route accepts it —
 * and a setting the model does not accept is dropped in silence, leaving the
 * caller believing they asked for maximum reasoning and paid for it.
 *
 * So this refuses. Every capability on the request is checked against the
 * catalogue entry for the route, and a mismatch throws {@link UnsupportedSettingError}
 * before the request leaves the process. That is the same rule the settings UI
 * follows for the same reason: refusing beats accepting-and-ignoring.
 */

import type { ArtemisChatExtensions, ServerModel } from '@rx-artemis/protocol';
import { CHAT_EXTENSIONS_FIELD } from '@rx-artemis/protocol';

import { acceptsThinkingLevel, deepestThinkingLevel, type ArtemisClient } from './client.js';

/* -------------------------------------------------------------------------- */
/* Configuring an OpenAI client                                               */
/* -------------------------------------------------------------------------- */

/**
 * What `new OpenAI(...)` needs to talk to an Artemis installation.
 *
 * Shaped to be spread rather than named field by field, so it also fits the
 * Vercel AI SDK's `createOpenAI({ baseURL, apiKey })` and anything else that
 * takes the same two.
 */
export interface OpenAiCompatibleOptions {
  /** `http://127.0.0.1:6472/v1` — the `/v1` is included, which is what OpenAI clients expect. */
  readonly baseURL: string;
  /** The Artemis server token. It rides in the `Authorization: Bearer` header, exactly as an OpenAI key does. */
  readonly apiKey: string;
}

/**
 * Point an OpenAI client at an Artemis server.
 *
 * ```ts
 * import OpenAI from 'openai';
 * const openai = new OpenAI(openAiOptions(artemis, token));
 * ```
 *
 * The token is a separate argument rather than read off the client, and that is
 * a deliberate refusal: {@link ArtemisClient} holds its token privately, and a
 * function here that could extract it would turn the SDK into a way to read a
 * credential out of an object someone else configured.
 */
export function openAiOptions(
  client: Pick<ArtemisClient, 'baseUrl'>,
  token: string,
): OpenAiCompatibleOptions {
  return { baseURL: `${client.baseUrl}/v1`, apiKey: token };
}

/* -------------------------------------------------------------------------- */
/* Building a request                                                         */
/* -------------------------------------------------------------------------- */

/** A setting was asked for on a route that does not accept it. */
export class UnsupportedSettingError extends Error {
  /** `thinking`, `fastMode` or `ultracode`. */
  readonly setting: string;
  /** The route that refused it. */
  readonly route: string;

  constructor(setting: string, route: string, detail: string) {
    super(`${route} does not accept ${setting}: ${detail}`);
    this.name = 'UnsupportedSettingError';
    this.setting = setting;
    this.route = route;
  }
}

export interface ChatSettings {
  /**
   * A thinking level, or `'deepest'` for whatever this model's top level is.
   *
   * `'deepest'` exists because the alternative is every caller hard-coding
   * `'max'`, which is a Claude word — a Codex route stops at `xhigh` and would
   * throw. Resolved against the model's own list, so it is correct per route.
   */
  readonly thinking?: string | 'deepest';
  readonly fastMode?: boolean;
  readonly ultracode?: boolean;
  /**
   * Continue an earlier conversation, by the id a previous response returned.
   *
   * Note what is *not* here: a working directory. Where a turn runs is fixed to
   * the connection whose token you are using, chosen by a person in the Server
   * tab when that token was created — see `ServerWorkspace`. A setting here
   * would be a way around that decision.
   */
  readonly sessionId?: string;
}

/** The body fields to spread into an OpenAI `chat.completions.create` call. */
export interface ChatRequestBody {
  /** The route, which is what OpenAI clients call `model`. */
  readonly model: string;
  /** Artemis's own settings, namespaced. See {@link ArtemisChatExtensions}. */
  readonly artemis?: ArtemisChatExtensions;
}

/**
 * Build the Artemis-specific half of a chat request, refusing anything the
 * route would ignore.
 *
 * ```ts
 * const model = await artemis.model('work-max/opus');
 * const completion = await openai.chat.completions.create({
 *   ...buildChatRequest(model, { thinking: 'deepest', ultracode: true }),
 *   messages: [{ role: 'user', content: 'Refactor this module.' }],
 * });
 * ```
 *
 * @throws {UnsupportedSettingError} when a setting is not accepted by the route
 */
export function buildChatRequest(model: ServerModel, settings: ChatSettings = {}): ChatRequestBody {
  const extensions: {
    thinking?: string;
    fastMode?: boolean;
    ultracode?: boolean;
    sessionId?: string;
  } = {};

  if (settings.thinking !== undefined) {
    if (model.thinkingLevels.length === 0) {
      throw new UnsupportedSettingError(
        'thinking',
        model.route,
        'this model takes no thinking setting at all',
      );
    }

    const level =
      settings.thinking === 'deepest' ? deepestThinkingLevel(model) : settings.thinking;

    // `deepest` cannot fail here — the empty case is handled above — but the
    // narrowing has to be closed for a caller who passed a literal.
    if (level === undefined || !acceptsThinkingLevel(model, level)) {
      throw new UnsupportedSettingError(
        'thinking',
        model.route,
        `"${String(level)}" is not one of ${model.thinkingLevels.map((l) => l.id).join(', ')}`,
      );
    }
    extensions.thinking = level;
  }

  // `=== true` rather than truthiness, and only then: passing `fastMode: false`
  // to a model that cannot do fast mode is not an error — it is agreement.
  if (settings.fastMode === true) {
    if (!model.fastMode) {
      throw new UnsupportedSettingError('fastMode', model.route, 'this model does not offer it');
    }
    extensions.fastMode = true;
  } else if (settings.fastMode === false) {
    extensions.fastMode = false;
  }

  if (settings.ultracode === true) {
    if (!model.ultracode) {
      throw new UnsupportedSettingError('ultracode', model.route, 'this model does not offer it');
    }
    extensions.ultracode = true;
  } else if (settings.ultracode === false) {
    extensions.ultracode = false;
  }

  if (settings.sessionId !== undefined) extensions.sessionId = settings.sessionId;

  return {
    model: model.route,
    // Omitted entirely when there is nothing to say, so a request carries no
    // empty namespace for a server to interpret.
    ...(Object.keys(extensions).length === 0 ? {} : { [CHAT_EXTENSIONS_FIELD]: extensions }),
  };
}

/**
 * Would this request be accepted, without throwing to find out?
 *
 * For a caller assembling settings from user input — a CLI flag, a config file
 * — where the answer is a message to a person rather than an exception. Returns
 * the reasons, empty when the request is fine.
 */
export function checkChatSettings(
  model: ServerModel,
  settings: ChatSettings = {},
): readonly string[] {
  try {
    buildChatRequest(model, settings);
    return [];
  } catch (error) {
    return error instanceof UnsupportedSettingError ? [error.message] : [];
  }
}
