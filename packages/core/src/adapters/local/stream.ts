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
  /**
   * Tool-call fragments. Arrive split across chunks like everything else — the
   * name in one, the arguments a character at a time after it — so they are
   * accumulated by index rather than used as they land.
   */
  readonly toolCalls?: readonly ToolCallDelta[];
}

/** One fragment of a tool call, identified by its position in the array. */
export interface ToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  /** A slice of the JSON arguments, which are streamed as text. */
  readonly argumentsFragment?: string;
}

/** A tool call once every fragment has arrived. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON text. Parsed by the caller, which knows what shape to expect. */
  readonly argumentsJson: string;
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

      const calls = body['tool_calls'];
      if (Array.isArray(calls)) {
        const fragments: ToolCallDelta[] = [];
        for (const raw of calls) {
          const call = asRecord(raw);
          if (call === undefined) continue;
          const fn = asRecord(call['function']);
          // Index is how fragments are matched to each other. Servers that omit
          // it are sending one call at a time, so zero is the honest default.
          const index = typeof call['index'] === 'number' ? call['index'] : 0;
          fragments.push({
            index,
            ...(asString(call['id']) === undefined ? {} : { id: asString(call['id']) as string }),
            ...(fn === undefined || asString(fn['name']) === undefined
              ? {}
              : { name: asString(fn['name']) as string }),
            ...(fn === undefined || typeof fn['arguments'] !== 'string'
              ? {}
              : { argumentsFragment: fn['arguments'] }),
          });
        }
        if (fragments.length > 0) delta.toolCalls = fragments;
      }
    }
  }

  return Object.keys(delta).length > 0 ? delta : undefined;
}

/**
 * Accumulate tool-call fragments into whole calls.
 *
 * Stateful because the wire format is: a chunk carries a name, later chunks
 * carry slices of the arguments, and only the finish reason says they are
 * complete. Nothing can be executed until then, so this collects rather than
 * emits.
 */
export class ToolCallAccumulator {
  readonly #calls = new Map<number, { id: string; name: string; args: string }>();

  add(fragments: readonly ToolCallDelta[]): void {
    for (const fragment of fragments) {
      const existing = this.#calls.get(fragment.index) ?? { id: '', name: '', args: '' };
      this.#calls.set(fragment.index, {
        id: fragment.id ?? existing.id,
        name: fragment.name ?? existing.name,
        args: existing.args + (fragment.argumentsFragment ?? ''),
      });
    }
  }

  /**
   * The completed calls, in the order the server indexed them.
   *
   * A call with no name is dropped: it is a fragment that never completed, and
   * executing something unnamed is not a recoverable state.
   */
  take(): readonly ToolCall[] {
    const calls = [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name !== '')
      .map(([index, call]) => ({
        // Some servers omit the id entirely; the protocol needs one to match
        // the result back, so the index stands in.
        id: call.id === '' ? `call_${index}` : call.id,
        name: call.name,
        argumentsJson: call.args === '' ? '{}' : call.args,
      }));
    this.#calls.clear();
    return calls;
  }

  get size(): number {
    return this.#calls.size;
  }
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
