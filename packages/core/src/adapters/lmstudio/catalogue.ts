/**
 * Reading a local inference server's model list.
 * ============================================================================
 *
 * The first provider whose catalogue is a property of *this machine* rather
 * than of an account. Nothing is signed in; the question is only which models
 * have been downloaded and which of those can hold a conversation.
 *
 * ## Why `/api/v0/models` and not `/v1/models`
 *
 * Both answer. Verified against LM Studio on 2026-08-18:
 *
 * - `/v1/models` is the OpenAI-compatible endpoint and lists **servable**
 *   models — on a machine with four downloaded it reported one.
 * - `/api/v0/models` lists everything downloaded and adds two fields the
 *   OpenAI shape has nowhere to put: `type` (`llm` / `vlm` / `embeddings`) and
 *   `state` (`loaded` / `not-loaded`).
 *
 * `type` is the one that matters, because without it an embedding model is
 * indistinguishable from a chat model and gets offered as something to talk to.
 * A user selecting `text-embedding-nomic-embed-text-v1.5` would get a failure
 * from the server rather than a conversation, and the picker would have been
 * the thing that lied.
 *
 * So the richer endpoint is preferred and the OpenAI one is the fallback — in
 * that order, because a server that answers only `/v1/models` is still usable
 * and one whose every model is filtered out is not.
 *
 * ## What is deliberately not inferred
 *
 * Nothing here guesses a model's abilities from its name. A model called
 * `…-coder-…` is not known to be better at code, and `…-instruct` is not known
 * to follow instructions — those are marketing strings, and presenting a guess
 * as a fact is the failure this file exists to avoid. The only claim made is
 * the one the server itself reports: what type it is, and whether it is loaded.
 */

import type { ProviderModelOption } from '@rx-artemis/protocol';

/** What LM Studio's native endpoint reports per model. */
interface NativeModel {
  readonly id: string;
  readonly type?: string;
  readonly state?: string;
  readonly max_context_length?: number;
}

/** Model types that can hold a conversation. Everything else is filtered out. */
const CONVERSATIONAL = new Set(['llm', 'vlm']);

/**
 * A vision-capable type.
 *
 * Surfaced in the note rather than as a flag, because `imageInput` is a
 * *provider-wide* capability and vision here is per model — the descriptor has
 * nowhere to say "this one model takes images". Saying it in prose is honest;
 * turning the provider-wide flag on because one model is a `vlm` would not be.
 */
const VISION = 'vlm';

/**
 * Turn one native record into a picker row.
 *
 * The note says only what the server reported. "Loaded" is worth surfacing
 * because it is the difference between a first token in a second and a first
 * token after a multi-gigabyte read from disk, which a user waiting on a cold
 * model would otherwise experience as the app having hung.
 */
function toOption(model: NativeModel): ProviderModelOption {
  const loaded = model.state === 'loaded';
  const vision = model.type === VISION;
  const parts = [loaded ? 'loaded' : 'not loaded'];
  if (vision) parts.push('accepts images');
  if (model.max_context_length !== undefined) {
    parts.push(`${Math.round(model.max_context_length / 1000)}k context`);
  }

  return {
    id: model.id,
    // The tail of the id is the only short name available — LM Studio publishes
    // no display name — so it stands in for one rather than being invented.
    label: model.id.includes('/') ? model.id.slice(model.id.lastIndexOf('/') + 1) : model.id,
    displayName: model.id,
    note: parts.join(' · '),
  } satisfies ProviderModelOption;
}

/**
 * Every model on this server that can hold a conversation.
 *
 * Embeddings are dropped rather than shown-and-disabled: a disabled row invites
 * the question "why can I not use this", and the answer — "it is not that kind
 * of model" — is not something the user can act on. The rule the settings pane
 * follows for provider-wide flags applies here for the same reason.
 */
export function conversationalModels(models: readonly NativeModel[]): readonly ProviderModelOption[] {
  return models
    .filter((model) => model.type === undefined || CONVERSATIONAL.has(model.type))
    .map(toOption);
}

/** Parse `/api/v0/models`, tolerating a body that is not the shape expected. */
export function parseNativeCatalogue(body: unknown): readonly ProviderModelOption[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const models: NativeModel[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] !== 'string') continue;
    models.push({
      id: record['id'],
      ...(typeof record['type'] === 'string' ? { type: record['type'] } : {}),
      ...(typeof record['state'] === 'string' ? { state: record['state'] } : {}),
      ...(typeof record['max_context_length'] === 'number'
        ? { max_context_length: record['max_context_length'] }
        : {}),
    });
  }
  return conversationalModels(models);
}

/**
 * Parse `/v1/models`, the OpenAI-compatible fallback.
 *
 * Carries no `type`, so nothing can be filtered and nothing can be said about a
 * model beyond its id. That is the cost of the fallback and the reason it is
 * second: an embedding model reaching this path is indistinguishable from a
 * chat model and will be offered. Preferring the native endpoint is what
 * normally prevents it.
 */
export function parseOpenAiCatalogue(body: unknown): readonly ProviderModelOption[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const options: ProviderModelOption[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as Record<string, unknown>)['id'];
    if (typeof id !== 'string') continue;
    options.push({
      id,
      label: id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id,
      displayName: id,
      // Deliberately bare. This endpoint reports nothing else, and filling the
      // gap with a guess is what the module header refuses.
      note: 'reported by the server',
    });
  }
  return options;
}
