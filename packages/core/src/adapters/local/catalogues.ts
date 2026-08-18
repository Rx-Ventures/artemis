/**
 * Model discovery for the local inference servers.
 * ============================================================================
 *
 * Three servers, one protocol. LM Studio, Ollama and llama.cpp's `llama-server`
 * all speak OpenAI's `/v1/chat/completions`, which is why they share an agent
 * loop and differ only here — in how you ask them what they can run.
 *
 * That asymmetry is the reason this file exists separately from the loop. The
 * chat path is one implementation for all three; discovery is three, because
 * each server answers a different question when asked for its models.
 *
 * ## Verification status — read this before trusting a reader
 *
 * The house rule is that a capability declared from an advertisement is an
 * affordance that fails in the user's hands. These readers are not equal on
 * that measure, and the difference is recorded per function rather than in a
 * changelog nobody opens:
 *
 * | Server        | Status                                                |
 * | ------------- | ----------------------------------------------------- |
 * | LM Studio     | **Verified** live, 2026-08-18, against a real server   |
 * | Ollama        | **Unverified** — written from documentation            |
 * | `llama-server`| **Unverified** — written from documentation            |
 *
 * Unverified does not mean untested — each has unit tests over the payload the
 * documentation describes. It means nobody has confirmed the documentation
 * matches the binary, which is a different and weaker claim. Neither server was
 * installed on the machine where this was written. Drive them and update the
 * table; do not quietly assume the rows are equal.
 */

import type { ProviderModelOption } from '@rx-artemis/protocol';

/** How confident we are that a reader matches the server it describes. */
export type Verification = 'verified' | 'unverified';

/** One server's discovery, and how much it should be trusted. */
export interface CatalogueReader {
  /** Path appended to the profile's base URL. */
  readonly path: string;
  readonly verification: Verification;
  readonly parse: (body: unknown) => readonly ProviderModelOption[];
}

/** Pull an array out of a JSON body under a named key, tolerating anything else. */
function arrayAt(body: unknown, key: string): readonly unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

/** The tail of a slash-separated id, which is the only short name available. */
function shortLabel(id: string): string {
  return id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
}

/* -------------------------------------------------------------------------- */
/* Ollama — UNVERIFIED                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ollama's `/api/tags`, from documentation. **Not driven against a server.**
 *
 * Documented to answer `{ models: [{ name, model, size, details: { … } }] }`,
 * where `name` is the pull tag — `llama3.2:3b` — and is what the chat endpoint
 * accepts as a model id. Parameter size and quantisation live under `details`
 * and are worth surfacing because on a local machine they are the difference
 * between a model that fits in memory and one that does not.
 *
 * Ollama also exposes `/v1/models`, which would work and says less. `/api/tags`
 * is preferred for the same reason LM Studio's native endpoint is: the OpenAI
 * shape has nowhere to put the facts that matter locally.
 *
 * What is *not* attempted: Ollama's list does not say which models can hold a
 * conversation, so unlike LM Studio nothing can be filtered. An embedding model
 * pulled into Ollama will be offered. That is a known hole, not an oversight,
 * and closing it needs a real server to find out what the payload actually
 * carries.
 */
export function parseOllamaTags(body: unknown): readonly ProviderModelOption[] {
  const options: ProviderModelOption[] = [];

  for (const entry of arrayAt(body, 'models')) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['name'] === 'string' ? record['name'] : undefined;
    if (id === undefined) continue;

    const details = (typeof record['details'] === 'object' && record['details'] !== null
      ? record['details']
      : {}) as Record<string, unknown>;

    const parts: string[] = [];
    if (typeof details['parameter_size'] === 'string') parts.push(details['parameter_size']);
    if (typeof details['quantization_level'] === 'string') {
      parts.push(details['quantization_level']);
    }
    if (typeof record['size'] === 'number') {
      parts.push(`${Math.round(record['size'] / 1e9)} GB on disk`);
    }

    options.push({
      id,
      // `llama3.2:3b` — the tag is already short, and the part before the colon
      // is the family rather than a directory, so it is kept whole.
      label: id,
      displayName: id,
      note: parts.length > 0 ? parts.join(' · ') : 'reported by the server',
    });
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* llama-server — UNVERIFIED                                                  */
/* -------------------------------------------------------------------------- */

/**
 * llama.cpp's `llama-server` `/v1/models`, from documentation. **Not driven.**
 *
 * The thinnest of the three, and the reason is structural rather than a gap in
 * the implementation: `llama-server` is normally started with *one* model on
 * the command line and serves that. So its list is usually a single row, the id
 * is often a filesystem path, and there is no type, no state and no size to
 * report.
 *
 * A picker with one row is not a bug here — it is the server saying it was
 * started with one model, and switching models means restarting it with
 * different arguments. Presenting that as a choice would be inventing one.
 */
export function parseLlamaServerModels(body: unknown): readonly ProviderModelOption[] {
  const options: ProviderModelOption[] = [];

  for (const entry of arrayAt(body, 'data')) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as Record<string, unknown>)['id'];
    if (typeof id !== 'string') continue;

    options.push({
      id,
      // Ids here are frequently a path to a .gguf file, so the basename is the
      // only thing that fits a 20px status line.
      label: shortLabel(id).replace(/\.gguf$/i, ''),
      displayName: id,
      note: 'the model this server was started with',
    });
  }

  return options;
}
