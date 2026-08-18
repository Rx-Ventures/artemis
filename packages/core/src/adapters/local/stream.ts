/**
 * Reading an OpenAI-compatible streaming completion.
 * ============================================================================
 *
 * The one piece all three local servers share exactly. LM Studio, Ollama and
 * `llama-server` differ in how they list models and agree completely on how
 * they stream a reply, because all three implement the same wire format:
 * `text/event-stream`, one JSON object per `data:` line, terminated by a
 * literal `data: [DONE]`.
 *
 * Kept apart from the transport so it can be tested without a socket. Everything
 * here is a pure function of the bytes that arrived.
 *
 * ## Why the parser is deliberately forgiving
 *
 * This code reads output from three separate implementations of a spec none of
 * them authored, on a machine where the user may also be running a fourth. The
 * failure that matters is not a malformed chunk — it is one malformed chunk
 * killing a reply that was otherwise arriving fine. So an unparseable line is
 * skipped rather than thrown, and the stream continues.
 *
 * The exception is a chunk carrying an explicit `error`, which is the server
 * telling us the generation failed. That is not noise and must surface.
 *
 * ## Reasoning content
 *
 * Local reasoning models emit their thinking in a field the OpenAI spec does not
 * define, and the servers disagree on its name: `reasoning_content` and
 * `reasoning` are both in the wild. Both are read, because a model whose
 * thinking silently vanished would look like a model that stalled before
 * answering.
 */

/** One delta lifted out of a stream chunk. */
export interface StreamDelta {
  /** Visible assistant text. */
  readonly text?: string;
  /** Model reasoning, when the server reports it under any known name. */
  readonly thinking?: string;
  /** Why generation stopped, on the final chunk that carries one. */
  readonly finishReason?: string;
  /** Token counts, which most servers put only on the last chunk. */
  readonly usage?: StreamUsage;
  /** The server reporting a failed generation. */
  readonly error?: string;
}

export interface StreamUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** Terminator every implementation sends. Not JSON, so it is matched literally. */
const DONE = '[DONE]';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Pull the interesting parts out of one parsed chunk.
 *
 * Returns `undefined` for a chunk that carries nothing worth emitting — a
 * keep-alive, or a role-only opening delta — so callers can ignore it without
 * having to know which shapes are empty.
 */
export function readChunk(chunk: unknown): StreamDelta | undefined {
  const record = asRecord(chunk);
  if (record === undefined) return undefined;

  // An error object anywhere in the chunk means the generation failed. Checked
  // first: a chunk carrying both an error and a partial delta is a failure, not
  // a delta.
  const error = asRecord(record['error']);
  if (error !== undefined) {
    return { error: asString(error['message']) ?? 'The server reported an error.' };
  }

  const delta: { -readonly [K in keyof StreamDelta]: StreamDelta[K] } = {};

  const usage = asRecord(record['usage']);
  if (usage !== undefined) {
    const prompt = usage['prompt_tokens'];
    const completion = usage['completion_tokens'];
    if (typeof prompt === 'number' || typeof completion === 'number') {
      delta.usage = {
        promptTokens: typeof prompt === 'number' ? prompt : 0,
        completionTokens: typeof completion === 'number' ? completion : 0,
      };
    }
  }

  const choices = record['choices'];
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  if (choice !== undefined) {
    const finish = asString(choice['finish_reason']);
    if (finish !== undefined) delta.finishReason = finish;

    const body = asRecord(choice['delta']) ?? asRecord(choice['message']);
    if (body !== undefined) {
      const text = asString(body['content']);
      if (text !== undefined) delta.text = text;
      // Two spellings, both in the wild. See the module header.
      const thinking = asString(body['reasoning_content']) ?? asString(body['reasoning']);
      if (thinking !== undefined) delta.thinking = thinking;
    }
  }

  return Object.keys(delta).length > 0 ? delta : undefined;
}

/**
 * Split a server-sent-events buffer into complete lines and a remainder.
 *
 * The remainder matters: a chunk boundary lands mid-line often enough that
 * treating each network read as whole lines drops text at random. The caller
 * keeps the tail and prepends it to the next read.
 */
export function splitEvents(buffer: string): { lines: readonly string[]; rest: string } {
  const parts = buffer.split('\n');
  // The last element is either an incomplete line or '' when the buffer ended
  // on a newline. Either way it is not ready to parse.
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

/**
 * Turn one SSE line into a delta.
 *
 * `null` means "nothing to emit, keep going"; `'done'` means the server said the
 * stream is finished. Comments (`:` lines), blank lines and non-`data:` fields
 * are all "keep going" — they are part of the format, not errors.
 */
export function readEventLine(line: string): StreamDelta | null | 'done' {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice('data:'.length).trim();
  if (payload === DONE) return 'done';

  try {
    return readChunk(JSON.parse(payload)) ?? null;
  } catch {
    // A malformed chunk must not kill a reply that is otherwise arriving. See
    // the module header.
    return null;
  }
}
