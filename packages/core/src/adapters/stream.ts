/**
 * Async primitives shared by every adapter.
 *
 * Two tiny things, both of which every transport in the seam needs:
 *
 *  - {@link AsyncQueue} — a push-driven, unbounded, single-consumer async
 *    iterable. It is the backbone of {@link import('./types.js').Run.events}
 *    (the adapter pushes normalized events, the main process pulls them) and
 *    of the Claude adapter's *input pump* (Apollo pushes user messages, the
 *    Agent SDK pulls them as the `prompt` iterable). A subprocess adapter would
 *    use one per direction too.
 *  - {@link createDeferred} — a promise whose settlement is handed to someone
 *    else. The permission flow is built on it: `canUseTool` blocks on a
 *    deferred, `respondToPermission` resolves it.
 *
 * Neither imports a provider SDK, so both are testable on their own.
 */

/** A promise plus the handles to settle it, settle-once. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  /** True once {@link resolve} or {@link reject} has been called. */
  readonly settled: boolean;
  /** Resolve. A second call (of either kind) is a no-op. */
  resolve(value: T | PromiseLike<T>): void;
  /** Reject. A second call (of either kind) is a no-op. */
  reject(reason: unknown): void;
}

/**
 * Create a {@link Deferred}.
 *
 * Settlement is idempotent on purpose. A permission prompt can be answered by
 * the user, cancelled by the provider's abort signal, and force-denied by
 * `dispose()` — potentially in the same tick. Exactly one of those wins and the
 * others are harmless.
 */
export function createDeferred<T>(): Deferred<T> {
  let isSettled = false;
  let resolveFn!: (value: T | PromiseLike<T>) => void;
  let rejectFn!: (reason: unknown) => void;

  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  return {
    promise,
    get settled(): boolean {
      return isSettled;
    },
    resolve(value: T | PromiseLike<T>): void {
      if (isSettled) return;
      isSettled = true;
      resolveFn(value);
    },
    reject(reason: unknown): void {
      if (isSettled) return;
      isSettled = true;
      rejectFn(reason);
    },
  };
}

/** Raised when an {@link AsyncQueue} is iterated a second time. */
export class QueueAlreadyConsumedError extends Error {
  constructor(message = 'This async stream can only be consumed once.') {
    super(message);
    this.name = 'QueueAlreadyConsumedError';
  }
}

/** Options for {@link AsyncQueue}. */
export interface AsyncQueueOptions {
  /**
   * Called when the consumer abandons the iterator early — a `break` out of a
   * `for await`, or an explicit `.return()`. Buffered values are discarded at
   * that point, so this is the hook for tearing down whatever was filling the
   * queue.
   */
  readonly onAbandoned?: () => void;
}

/**
 * An unbounded, push-driven, single-consumer async iterable.
 *
 * ## Why unbounded
 *
 * The producer is a provider that is already running: a model streaming
 * tokens, a subprocess writing JSONL. There is nothing useful to do with
 * backpressure — we cannot ask the model to slow down, and dropping events
 * would corrupt the transcript, since `text.delta` is additive and `tool.start`
 * without `tool.end` leaves a spinner the UI can never clear. So the queue
 * buffers without limit and the consumer catches up.
 *
 * ## Why single-consumer
 *
 * Two consumers pulling from one queue would each get *some* of the events,
 * which is never what anyone wants. Fan-out is a policy decision (which window,
 * what buffering, what happens on reload) and belongs above the seam, so a
 * second `[Symbol.asyncIterator]()` throws {@link QueueAlreadyConsumedError}
 * rather than silently splitting the stream.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  readonly #onAbandoned: (() => void) | undefined;

  #pendingResolve: ((result: IteratorResult<T, undefined>) => void) | null = null;
  #pendingReject: ((reason: unknown) => void) | null = null;
  #closed = false;
  #failure: { readonly error: unknown } | null = null;
  #iterated = false;

  constructor(options?: AsyncQueueOptions) {
    this.#onAbandoned = options?.onAbandoned;
  }

  /** Values buffered and not yet delivered. Diagnostics and tests only. */
  get size(): number {
    return this.#buffer.length;
  }

  /** True once {@link close} or {@link fail} has been called. */
  get closed(): boolean {
    return this.#closed;
  }

  /** True once a consumer has started iterating. */
  get consumed(): boolean {
    return this.#iterated;
  }

  /**
   * Append a value.
   *
   * Silently ignored after {@link close} — the alternative is throwing from a
   * provider callback that has no way to handle it, and after `run.end` there
   * is by definition nothing left to say.
   */
  push(value: T): void {
    if (this.#closed) return;

    const resolve = this.#pendingResolve;
    if (resolve !== null) {
      this.#pendingResolve = null;
      this.#pendingReject = null;
      resolve({ value, done: false });
      return;
    }

    this.#buffer.push(value);
  }

  /**
   * End the stream. Buffered values are still delivered before the consumer
   * sees `done`. Idempotent.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    const resolve = this.#pendingResolve;
    if (resolve !== null) {
      this.#pendingResolve = null;
      this.#pendingReject = null;
      resolve({ value: undefined, done: true });
    }
  }

  /**
   * End the stream by rejecting the consumer's pending (or next) `next()`.
   *
   * Adapters should almost never use this for the *event* stream:
   * `Run.events` must not reject, because a thrown error cannot be rendered in
   * a transcript — emit a `run.end` with `reason: 'error'` instead. It exists
   * for internal streams, where a rejection is the right signal.
   */
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = { error };

    const reject = this.#pendingReject;
    if (reject !== null && this.#buffer.length === 0) {
      this.#pendingResolve = null;
      this.#pendingReject = null;
      this.#failure = null;
      reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    if (this.#iterated) throw new QueueAlreadyConsumedError();
    this.#iterated = true;

    return {
      next: (): Promise<IteratorResult<T, undefined>> => this.#next(),
      return: (): Promise<IteratorResult<T, undefined>> => {
        const wasOpen = !this.#closed;
        this.close();
        this.#buffer.length = 0;
        if (wasOpen) this.#onAbandoned?.();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error?: unknown): Promise<IteratorResult<T, undefined>> => {
        this.close();
        this.#buffer.length = 0;
        return Promise.reject(error);
      },
    };
  }

  #next(): Promise<IteratorResult<T, undefined>> {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift() as T;
      return Promise.resolve({ value, done: false });
    }

    if (this.#failure !== null) {
      const { error } = this.#failure;
      this.#failure = null;
      return Promise.reject(error);
    }

    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    if (this.#pendingResolve !== null) {
      return Promise.reject(
        new Error('AsyncQueue does not support concurrent next() calls from one consumer.'),
      );
    }

    return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
      this.#pendingResolve = resolve;
      this.#pendingReject = reject;
    });
  }
}
