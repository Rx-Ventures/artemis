import { describe, expect, it } from 'vitest';

import { createPushFeed } from '../feed.js';

const CHANNEL = 'artemis:push:agent-event' as const;

describe('createPushFeed', () => {
  it('numbers events densely from 1 and reports the head', () => {
    const feed = createPushFeed();
    expect(feed.head()).toBe(0);
    const seen: number[] = [];
    feed.subscribe((event) => seen.push(event.seq));
    feed.publish(CHANNEL, { a: 1 });
    feed.publish(CHANNEL, { a: 2 });
    expect(seen).toEqual([1, 2]);
    expect(feed.head()).toBe(2);
  });

  it('replays everything after a seq, untruncated while retention holds', () => {
    const feed = createPushFeed();
    feed.publish(CHANNEL, 'a');
    feed.publish(CHANNEL, 'b');
    feed.publish(CHANNEL, 'c');
    const replay = feed.since(1);
    expect(replay.events.map((event) => event.payload)).toEqual(['b', 'c']);
    expect(replay.truncated).toBe(false);
  });

  it('reports truncation once retention has dropped what was asked for', () => {
    const feed = createPushFeed({ retention: 2 });
    for (const payload of ['a', 'b', 'c', 'd']) feed.publish(CHANNEL, payload);
    const replay = feed.since(1);
    expect(replay.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(replay.truncated).toBe(true);
    expect(replay.firstSeq).toBe(3);
    // Asking from exactly the edge is not a gap: nothing asked for is missing.
    expect(feed.since(2).truncated).toBe(false);
  });

  it('never claims a gap before anything was published', () => {
    const feed = createPushFeed();
    expect(feed.since(0).truncated).toBe(false);
    expect(feed.since(-1).truncated).toBe(false);
  });

  it('carries the scope publishers stamp', () => {
    const feed = createPushFeed();
    feed.publish(CHANNEL, 'x', { profileId: 'p1' });
    expect(feed.since(0).events[0]?.scope).toEqual({ profileId: 'p1' });
  });

  it('contains a listener that throws', () => {
    const errors: unknown[] = [];
    const feed = createPushFeed({ onError: (error) => errors.push(error) });
    const seen: unknown[] = [];
    feed.subscribe(() => {
      throw new Error('bad listener');
    });
    feed.subscribe((event) => seen.push(event.payload));
    feed.publish(CHANNEL, 'x');
    expect(seen).toEqual(['x']);
    expect(errors).toHaveLength(1);
  });

  it('unsubscribes cleanly', () => {
    const feed = createPushFeed();
    const seen: unknown[] = [];
    const unsubscribe = feed.subscribe((event) => seen.push(event.payload));
    feed.publish(CHANNEL, 'a');
    unsubscribe();
    feed.publish(CHANNEL, 'b');
    expect(seen).toEqual(['a']);
  });
});
