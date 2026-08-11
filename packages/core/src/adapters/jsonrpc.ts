/**
 * A JSON-RPC client for line-delimited transports.
 *
 * The Claude adapter gets its transport for free: `@anthropic-ai/claude-agent-sdk`
 * owns the subprocess, the framing and the correlation, and hands the adapter an
 * async iterable of typed messages. Codex hands us a pipe. Everything the SDK
 * was doing has to exist somewhere, and this is that somewhere.
 *
 * ## Two layers, on purpose
 *
 * {@link JsonRpcConnection} is the **codec**: framing, id correlation, and the
 * routing of the three inbound message shapes. It never spawns anything — it is
 * handed a `send` function and fed lines through {@link JsonRpcConnection.handleLine}.
 * That is what makes the interesting half testable without a subprocess, the
 * same way `mapper.ts` is testable without the Agent SDK.
 *
 * {@link spawnJsonRpcSubprocess} is the **plumbing**: a child process, its
 * stdout split into lines, its stderr kept in a ring buffer for error messages,
 * and its exit wired to the connection's failure path.
 *
 * ## The dialect
 *
 * Codex's app-server speaks JSON-RPC 2.0 over newline-delimited JSON, with one
 * deviation: **it omits the `"jsonrpc": "2.0"` field**, on requests it sends and
 * on responses it accepts. So this client does not emit it either, and does not
 * require it on the way in. Everything else — `id`/`method`/`params`,
 * `id`/`result`, `id`/`error` with `{ code, message, data }` — is standard.
 *
 * Three inbound shapes have to be told apart, and the order of the checks
 * matters because a server-initiated *request* carries both `id` and `method`:
 *
 * | Shape                     | Meaning                    | Routed to           |
 * | ------------------------- | -------------------------- | ------------------- |
 * | `id` + `method`           | server-initiated request   | `onRequest`         |
 * | `method`, no `id`         | notification               | `onNotification`    |
 * | `id` + `result` / `error` | response to our request    | the pending promise |
 *
 * The server-initiated request is the one that matters most: it is how an
 * approval prompt arrives, which is what `Capabilities.interactivePermissions`
 * is built on. A client that only modelled request→response could not support
 * permissions at all.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { JsonValue } from '@rx-apollo/protocol';

import { createDeferred } from './stream.js';
import type { Deferred } from './stream.js';

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/** A JSON-RPC error object, as it arrives on the wire. */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}

/**
 * A server-initiated request, handed to {@link JsonRpcConnectionOptions.onRequest}.
 *
 * The `id` is deliberately not exposed as something the handler answers with:
 * the connection correlates the reply itself, so a handler can only ever answer
 * the request it was given. Answering the wrong id is a class of bug worth
 * making unrepresentable.
 */
export interface IncomingRequest {
  readonly method: string;
  readonly params: JsonValue | undefined;
}

/** Raised when the peer answers one of our requests with an `error`. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: JsonValue | undefined;
  /** The method that was called, for a message worth reading. */
  readonly method: string;

  constructor(method: string, error: JsonRpcErrorObject) {
    super(`${method} failed: ${error.message} (code ${String(error.code)})`);
    this.name = 'JsonRpcError';
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

/** True for a {@link JsonRpcError}, including across module realms. */
export function isJsonRpcError(value: unknown): value is JsonRpcError {
  return (
    value instanceof JsonRpcError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'JsonRpcError' &&
      typeof (value as { code?: unknown }).code === 'number')
  );
}

/**
 * Standard JSON-RPC error codes, plus the one Codex adds.
 *
 * `SERVER_OVERLOADED` is documented on the app-server's WebSocket transport,
 * which rejects with it when its request queue fills. It is the only code here
 * worth retrying on.
 */
export const JSON_RPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_OVERLOADED: -32001,
} as const;

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/** Options for {@link JsonRpcConnection}. */
export interface JsonRpcConnectionOptions {
  /**
   * Write one framed message. The connection appends the newline itself, so an
   * implementation only has to put the string on the wire.
   */
  readonly send: (line: string) => void;

  /**
   * Handle a server-initiated request.
   *
   * Resolving sends a `result`; rejecting sends an `error`. **A handler that
   * never settles parks the peer forever** — for an approval request that is
   * precisely the intended behaviour (the run waits for the user), which is why
   * there is no timeout here. The obligation to eventually settle belongs to
   * whoever owns the prompt, and `CodexRun.dispose()` discharges it by denying
   * everything outstanding.
   *
   * Absent means "we implement no server requests": anything that arrives is
   * answered with `METHOD_NOT_FOUND` rather than dropped, so the peer fails
   * fast instead of hanging.
   */
  readonly onRequest?: (request: IncomingRequest) => Promise<JsonValue>;

  /** Handle a notification. Errors thrown here are reported, never propagated. */
  readonly onNotification?: (method: string, params: JsonValue | undefined) => void;

  /** Sink for malformed frames and other things not worth failing over. */
  readonly onDiagnostic?: (message: string, detail?: unknown) => void;
}

/** One outstanding outbound request. */
interface PendingRequest {
  readonly deferred: Deferred<JsonValue>;
  readonly method: string;
}

/**
 * A JSON-RPC peer over a line-delimited transport.
 *
 * Owns nothing but its pending-request table: no process, no socket, no timers.
 * Feed it lines, call {@link request} and {@link notify}, and settle it with
 * {@link fail} when the transport underneath goes away.
 */
export class JsonRpcConnection {
  readonly #options: JsonRpcConnectionOptions;
  readonly #pending = new Map<number, PendingRequest>();

  #nextId = 0;
  #failure: unknown | undefined;

  constructor(options: JsonRpcConnectionOptions) {
    this.#options = options;
  }

  /** Requests sent and not yet answered. Diagnostics and tests only. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** True once {@link fail} has been called. */
  get closed(): boolean {
    return this.#failure !== undefined;
  }

  /**
   * Call a method and wait for its answer.
   *
   * Rejects with a {@link JsonRpcError} when the peer answers with an `error`,
   * and with whatever was passed to {@link fail} when the transport dies with
   * this request still outstanding. Deliberately has **no timeout**: the app
   * server legitimately takes minutes on a `turn/start`, and a timeout here
   * would abandon a request whose answer is still coming. Callers that need a
   * deadline impose their own.
   */
  request(method: string, params?: JsonValue): Promise<JsonValue> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);

    const id = this.#nextId++;
    const deferred = createDeferred<JsonValue>();
    this.#pending.set(id, { deferred, method });

    try {
      this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.#pending.delete(id);
      return Promise.reject(error);
    }

    return deferred.promise;
  }

  /**
   * Send a notification — a call with no id and therefore no answer.
   *
   * Silently does nothing once the connection has failed. A notification is by
   * definition something nobody is waiting on, so there is no one to tell.
   */
  notify(method: string, params?: JsonValue): void {
    if (this.#failure !== undefined) return;
    try {
      this.#write({ method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.#options.onDiagnostic?.(`Failed to send notification "${method}".`, error);
    }
  }

  /**
   * Feed one inbound line.
   *
   * Never throws. A frame that is not JSON, or is JSON of no recognised shape,
   * is reported through `onDiagnostic` and dropped — the peer is a separate
   * process whose output we do not control, and one unparseable line must not
   * take the connection down. This mirrors the rule the Claude mapper follows
   * for unrecognised SDK messages.
   */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // The app server writes human-readable warnings to stdout on some paths.
      this.#options.onDiagnostic?.('Dropped a non-JSON line from the provider.', truncate(trimmed));
      return;
    }

    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.#options.onDiagnostic?.('Dropped a JSON frame that was not an object.', truncate(trimmed));
      return;
    }

    const frame = message as Record<string, unknown>;
    const hasId = frame['id'] !== undefined && frame['id'] !== null;
    const method = typeof frame['method'] === 'string' ? frame['method'] : undefined;

    // Order matters: a server-initiated request carries *both* `id` and
    // `method`, so it has to be recognised before the response branch.
    if (method !== undefined && hasId) {
      this.#dispatchRequest(frame['id'] as JsonValue, method, frame['params'] as JsonValue | undefined);
      return;
    }

    if (method !== undefined) {
      try {
        this.#options.onNotification?.(method, frame['params'] as JsonValue | undefined);
      } catch (error) {
        // A consumer bug must not kill the transport that feeds every other
        // notification.
        this.#options.onDiagnostic?.(`Notification handler for "${method}" threw.`, error);
      }
      return;
    }

    if (hasId) {
      this.#dispatchResponse(frame);
      return;
    }

    this.#options.onDiagnostic?.('Dropped a frame with neither method nor id.', truncate(trimmed));
  }

  /**
   * Fail every outstanding request and refuse new ones.
   *
   * Idempotent, and the only way this object ends. Called when the subprocess
   * exits, when its stdio errors, and on deliberate teardown. The first reason
   * wins — a process that dies of one cause and is then torn down should report
   * the cause, not the teardown.
   */
  fail(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;

    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.deferred.reject(error);
  }

  /* -------------------------------- internals ------------------------------ */

  #dispatchResponse(frame: Record<string, unknown>): void {
    const id = frame['id'];
    if (typeof id !== 'number') {
      // We only ever mint numeric ids, so a response keyed by anything else is
      // not ours to route.
      this.#options.onDiagnostic?.('Dropped a response with a non-numeric id.', id);
      return;
    }

    const entry = this.#pending.get(id);
    if (entry === undefined) {
      // Late answer to something already failed, or a duplicate. Harmless.
      this.#options.onDiagnostic?.(`Dropped a response for unknown request id ${String(id)}.`);
      return;
    }
    this.#pending.delete(id);

    const error = frame['error'];
    if (error !== undefined && error !== null) {
      entry.deferred.reject(new JsonRpcError(entry.method, toErrorObject(error)));
      return;
    }

    // A response with neither `result` nor `error` is malformed, but `result:
    // null` is perfectly legal and common for void methods — so the check is
    // for the *property*, not for a truthy value.
    entry.deferred.resolve(
      Object.hasOwn(frame, 'result') ? (frame['result'] as JsonValue) : null,
    );
  }

  #dispatchRequest(id: JsonValue, method: string, params: JsonValue | undefined): void {
    const handler = this.#options.onRequest;
    if (handler === undefined) {
      this.#write({
        id,
        error: { code: JSON_RPC_CODES.METHOD_NOT_FOUND, message: `Unhandled request "${method}".` },
      });
      return;
    }

    // Deliberately not awaited: an approval request parks until the user
    // answers, and blocking the line reader on it would stall every other
    // notification arriving in the meantime — including the ones the UI needs
    // to render the prompt being waited on.
    void handler({ method, params }).then(
      (result) => {
        this.#writeIfOpen({ id, result });
      },
      (error: unknown) => {
        this.#writeIfOpen({
          id,
          error: {
            code: JSON_RPC_CODES.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
  }

  #write(frame: Record<string, unknown>): void {
    this.#options.send(JSON.stringify(frame));
  }

  /**
   * Write unless the transport has already gone.
   *
   * Used for the two replies to a server request: by the time a user answers an
   * approval prompt the subprocess may have exited, and writing to a dead pipe
   * would throw from a promise callback nobody is watching.
   */
  #writeIfOpen(frame: Record<string, unknown>): void {
    if (this.#failure !== undefined) return;
    try {
      this.#write(frame);
    } catch (error) {
      this.#options.onDiagnostic?.('Failed to answer a server request.', error);
    }
  }
}

/** Coerce whatever arrived in an `error` field into something with the right shape. */
function toErrorObject(value: unknown): JsonRpcErrorObject {
  if (typeof value !== 'object' || value === null) {
    return { code: JSON_RPC_CODES.INTERNAL_ERROR, message: String(value) };
  }
  const raw = value as Record<string, unknown>;
  return {
    code: typeof raw['code'] === 'number' ? raw['code'] : JSON_RPC_CODES.INTERNAL_ERROR,
    message: typeof raw['message'] === 'string' ? raw['message'] : 'Unknown error',
    ...(raw['data'] === undefined ? {} : { data: raw['data'] as JsonValue }),
  };
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/* -------------------------------------------------------------------------- */
/* Line splitting                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reassemble newline-delimited frames from arbitrarily-chunked stream data.
 *
 * A pipe delivers bytes, not messages: one `data` event can carry half a frame,
 * three frames, or three and a half. Getting this wrong produces a bug that
 * only shows up under load, when a message finally gets large enough to split —
 * so it is a separate, testable object rather than four lines inlined in a
 * `data` handler.
 *
 * `\r` is stripped so a peer using CRLF does not leave a stray carriage return
 * on the end of every frame.
 */
export class LineSplitter {
  #buffer = '';
  readonly #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  /** Bytes held back waiting for their newline. Diagnostics and tests only. */
  get buffered(): number {
    return this.#buffer.length;
  }

  push(chunk: string): void {
    this.#buffer += chunk;

    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      if (line !== '') this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  /**
   * Deliver whatever is left as a final frame.
   *
   * A well-behaved peer terminates its last message with a newline, but a
   * process killed mid-write does not, and the partial frame it left behind is
   * often the only evidence of what it was doing.
   */
  flush(): void {
    const rest = this.#buffer.trim();
    this.#buffer = '';
    if (rest !== '') this.#onLine(rest);
  }
}

/* -------------------------------------------------------------------------- */
/* Subprocess plumbing                                                        */
/* -------------------------------------------------------------------------- */

/** How many stderr lines to keep for diagnosing a failed launch. */
const STDERR_TAIL_LINES = 40;

/** Options for {@link spawnJsonRpcSubprocess}. */
export interface SpawnJsonRpcOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The complete environment. Built by `composeProviderEnv`, never `process.env`. */
  readonly env: Record<string, string>;
  readonly onRequest?: JsonRpcConnectionOptions['onRequest'];
  readonly onNotification?: JsonRpcConnectionOptions['onNotification'];
  readonly onDiagnostic?: JsonRpcConnectionOptions['onDiagnostic'];
  /**
   * Called when the process exits for any reason, with a message naming the
   * cause. Fires exactly once, after the connection has been failed, so a
   * handler can rely on every pending request already having settled.
   */
  readonly onExit?: (reason: string) => void;
}

/** A live subprocess and the connection speaking to it. */
export interface JsonRpcSubprocess {
  readonly connection: JsonRpcConnection;
  /** The most recent stderr output, newest last. Empty when the peer said nothing. */
  stderrTail(): string;
  /** True until the process exits or {@link dispose} is called. */
  readonly alive: boolean;
  /**
   * Terminate the process and fail the connection. Idempotent, never rejects.
   * Sends `SIGTERM`, then `SIGKILL` if the process is still up after
   * `graceMs`.
   */
  dispose(graceMs?: number): Promise<void>;
}

/**
 * Spawn a subprocess and speak JSON-RPC to it over stdio.
 *
 * Throws synchronously only if `spawn` itself fails to produce a process
 * object; everything else — a missing binary, an unusable cwd — arrives
 * asynchronously as an `error` event and is reported by failing the connection,
 * because that is the path callers already handle.
 */
export function spawnJsonRpcSubprocess(options: SpawnJsonRpcOptions): JsonRpcSubprocess {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // `spawn` throws synchronously for a malformed invocation (a cwd that is
    // not a string, say) rather than emitting `error`. Nothing exists to tear
    // down in that case, so it is the caller's to handle.
    throw error instanceof Error ? error : new Error(String(error));
  }

  const stderrTail: string[] = [];
  let alive = true;
  let exitReported = false;
  let disposing: Promise<void> | undefined;

  const connection = new JsonRpcConnection({
    send: (line) => {
      if (!alive) throw new Error('The provider process is no longer running.');
      child.stdin.write(`${line}\n`);
    },
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
    ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });

  const splitter = new LineSplitter((line) => {
    connection.handleLine(line);
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    splitter.push(chunk);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      stderrTail.push(trimmed);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  });

  const finish = (reason: string): void => {
    alive = false;
    splitter.flush();
    connection.fail(new Error(reason));
    if (exitReported) return;
    exitReported = true;
    options.onExit?.(reason);
  };

  child.on('error', (error) => {
    finish(`The provider process could not be started: ${error.message}`);
  });

  child.on('close', (code, signal) => {
    const tail = stderrTail.length > 0 ? ` ${stderrTail.slice(-3).join(' ')}` : '';
    finish(
      signal !== null
        ? `The provider process was terminated by ${signal}.${tail}`
        : `The provider process exited with code ${String(code ?? 0)}.${tail}`,
    );
  });

  // A pipe write can race the process exiting. EPIPE here is expected, not
  // exceptional, and an unhandled 'error' on a stream is a hard crash in Node.
  child.stdin.on('error', () => {
    /* handled by 'close' */
  });

  return {
    connection,
    stderrTail: () => stderrTail.join('\n'),
    get alive(): boolean {
      return alive;
    },
    dispose(graceMs = 2000): Promise<void> {
      disposing ??= (async () => {
        if (!alive) {
          finish('The provider process was disposed.');
          return;
        }

        const exited = new Promise<void>((resolve) => {
          child.once('close', () => {
            resolve();
          });
        });

        try {
          child.stdin.end();
        } catch {
          // Already gone.
        }
        child.kill('SIGTERM');

        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }, graceMs);

        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
        finish('The provider process was disposed.');
      })();

      return disposing;
    },
  };
}
