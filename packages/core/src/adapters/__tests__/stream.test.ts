/**
 * Tests for the async plumbing every adapter is built on.
 *
 * These cover the three properties `Run.events` promises: consumable exactly
 * once, lossless when the consumer is slower than the producer, and terminating.
 */

import { describe, expect, it, vi } from 'vitest';

import { AsyncQueue, QueueAlreadyConsumedError, createDeferred } from '../stream.js';

/** Drain an async iterable into an array. */
async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

describe('createDeferred', () => {
  it('resolves from the outside', async () => {
    const deferred = createDeferred<number>();
    expect(deferred.settled).toBe(false);
    deferred.resolve(42);
    expect(deferred.settled).toBe(true);
    await expect(deferred.promise).resolves.toBe(42);
  });

  it('settles exactly once, whichever path gets there first', async () => {
    const deferred = createDeferred<string>();
    deferred.resolve('user answered');
    deferred.resolve('abort signal');
    deferred.reject(new Error('dispose'));
    await expect(deferred.promise).resolves.toBe('user answered');
  });

  it('rejects from the outside', async () => {
    const deferred = createDeferred<void>();
    deferred.reject(new Error('nope'));
    await expect(deferred.promise).rejects.toThrow('nope');
  });
});

describe('AsyncQueue', () => {
  it('buffers everything pushed before a consumer arrives', async () => {
    const queue = new AsyncQueue<number>();
    for (let i = 0; i < 5; i += 1) queue.push(i);
    queue.close();

    expect(queue.size).toBe(5);
    await expect(drain(queue)).resolves.toEqual([0, 1, 2, 3, 4]);
  });

  it('loses nothing when the producer outruns the consumer', async () => {
    const queue = new AsyncQueue<number>();
    const total = 1_000;

    // Consumer that yields to the event loop on every item, while the producer
    // pushes synchronously as fast as it can.
    const consumed = (async () => {
      const seen: number[] = [];
      for await (const value of queue) {
        await Promise.resolve();
        seen.push(value);
      }
      return seen;
    })();

    for (let i = 0; i < total; i += 1) queue.push(i);
    queue.close();

    const seen = await consumed;
    expect(seen).toHaveLength(total);
    expect(seen[0]).toBe(0);
    expect(seen[total - 1]).toBe(total - 1);
  });

  it('delivers a value pushed while the consumer is parked', async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    const pending = iterator.next();
    queue.push('late arrival');
    await expect(pending).resolves.toEqual({ value: 'late arrival', done: false });
  });

  it('drains the buffer before reporting done', async () => {
    const queue = new AsyncQueue<string>();
    queue.push('a');
    queue.push('b');
    queue.close();

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 'a', done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 'b', done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('terminates a parked consumer on close', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.close();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it('can only be consumed once', () => {
    const queue = new AsyncQueue<number>();
    queue[Symbol.asyncIterator]();
    expect(() => queue[Symbol.asyncIterator]()).toThrow(QueueAlreadyConsumedError);
    expect(queue.consumed).toBe(true);
  });

  it('ignores pushes after close rather than throwing at the producer', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);
    expect(queue.size).toBe(0);
    await expect(drain(queue)).resolves.toEqual([]);
  });

  it('discards the buffer and notifies when the consumer breaks out early', async () => {
    const onAbandoned = vi.fn();
    const queue = new AsyncQueue<number>({ onAbandoned });
    queue.push(1);
    queue.push(2);
    queue.push(3);

    for await (const value of queue) {
      expect(value).toBe(1);
      break;
    }

    expect(onAbandoned).toHaveBeenCalledTimes(1);
    expect(queue.closed).toBe(true);
    expect(queue.size).toBe(0);
  });

  it('does not report abandonment when the stream had already ended', async () => {
    const onAbandoned = vi.fn();
    const queue = new AsyncQueue<number>({ onAbandoned });
    queue.push(1);
    queue.close();

    await drain(queue);
    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('delivers buffered values before a failure', async () => {
    const queue = new AsyncQueue<string>();
    queue.push('before');
    queue.fail(new Error('transport died'));

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 'before', done: false });
    await expect(iterator.next()).rejects.toThrow('transport died');
  });

  it('rejects a parked consumer on failure', async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.fail(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
  });

  it('rejects concurrent next() calls from one consumer', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toThrow(/concurrent next/);
    queue.close();
    await expect(first).resolves.toEqual({ value: undefined, done: true });
  });
});
