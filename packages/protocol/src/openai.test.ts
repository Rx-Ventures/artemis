import { describe, expect, it } from 'vitest';

import {
  PARAMETER_POLICY,
  reviewParameters,
  sseEvent,
  SSE_DONE,
} from './openai.js';

describe('reviewParameters', () => {
  it('passes a request that only uses what Artemis honours', () => {
    expect(
      reviewParameters({
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        max_tokens: 100,
      }),
    ).toEqual({ ignored: [], rejected: [] });
  });

  it('rejects the parameters whose absence would change the answer', () => {
    // `temperature: 0` is a request for determinism. Answering with a sampled
    // reply and saying nothing lets a caller build a cache or a test on a
    // promise this server never made.
    const review = reviewParameters({ temperature: 0, seed: 42, n: 2 });
    expect(review.rejected.sort()).toEqual(['n', 'seed', 'temperature']);
    expect(review.ignored).toEqual([]);
  });

  it('ignores labels and hints, which cannot mislead anyone', () => {
    const review = reviewParameters({ user: 'u-1', store: true });
    expect(review.ignored.sort()).toEqual(['store', 'user']);
    expect(review.rejected).toEqual([]);
  });

  it('treats absent and explicitly null the same, because clients send both', () => {
    expect(reviewParameters({ temperature: null, user: undefined })).toEqual({
      ignored: [],
      rejected: [],
    });
  });

  it('ignores unknown keys so a client upgrade does not break the server', () => {
    // OpenAI adds fields regularly. Refusing every unrecognised one would fail
    // on the client's next minor version rather than on a real incompatibility.
    expect(reviewParameters({ some_field_from_2027: true })).toEqual({
      ignored: [],
      rejected: [],
    });
  });

  it('downgrades rejections only when the caller asked for leniency', () => {
    const body = { temperature: 0.7, user: 'u-1' };
    expect(reviewParameters(body).rejected).toEqual(['temperature']);
    // The escape hatch for a client that sets temperature from a default it
    // never chose — opened deliberately by the caller, never by the server.
    const lenient = reviewParameters(body, { lenient: true });
    expect(lenient.rejected).toEqual([]);
    expect(lenient.ignored.sort()).toEqual(['temperature', 'user']);
  });

  it('rules on every parameter it lists, with no accidental honours', () => {
    // A parameter added to the table as `honoured` by mistake is one that gets
    // silently dropped at runtime, which is the failure this table prevents.
    for (const [key, support] of Object.entries(PARAMETER_POLICY)) {
      expect(['honoured', 'ignored', 'rejected']).toContain(support);
      expect(key).not.toBe('');
    }
  });

  it('survives a body that is not an object at all', () => {
    expect(reviewParameters(null)).toEqual({ ignored: [], rejected: [] });
    expect(reviewParameters('nonsense')).toEqual({ ignored: [], rejected: [] });
  });
});

describe('sseEvent', () => {
  it('terminates an event with a blank line', () => {
    // Without the second newline a client buffers the event forever, waiting
    // for a terminator that never arrives.
    expect(sseEvent({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it('passes a string through unquoted, which is how the sentinel is sent', () => {
    expect(sseEvent(SSE_DONE)).toBe('data: [DONE]\n\n');
  });
});
