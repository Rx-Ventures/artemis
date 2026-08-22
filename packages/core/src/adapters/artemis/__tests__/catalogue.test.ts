/**
 * Reading a `ServerModelsBody` that may be older, newer or wrong.
 *
 * The serving Artemis is a separate build on a separate machine, so the parser
 * is exercised the way the local catalogue parsers are: a row it cannot read
 * is dropped, a body it cannot read is an empty list, and nothing throws.
 */

import { describe, expect, it } from 'vitest';

import { parseServerModels } from '../catalogue.js';

describe('parseServerModels', () => {
  it('maps a route onto a picker option, wire id first', () => {
    const options = parseServerModels({
      object: 'artemis.models',
      models: [
        {
          route: 'work/sonnet',
          id: 'sonnet',
          label: 'Sonnet 5',
          displayName: 'Claude Sonnet 5',
          resolvedModel: 'claude-sonnet-5',
          note: 'Fast and steady.',
          profileLabel: 'Work',
          tier: 1,
          fastMode: false,
          ultracode: true,
          adaptiveThinking: false,
        },
      ],
    });

    expect(options).toEqual([
      {
        id: 'work/sonnet',
        label: 'Sonnet 5',
        displayName: 'Claude Sonnet 5',
        resolvedModel: 'claude-sonnet-5',
        note: 'Work — Fast and steady.',
        tier: 1,
        supportsFastMode: false,
        supportsUltracode: true,
        adaptiveThinking: false,
      },
    ]);
  });

  it('drops a row with no route — it cannot be asked for', () => {
    const options = parseServerModels({
      models: [{ id: 'opus', label: 'Opus 5', note: '' }, { route: 'ok/opus', note: '' }],
    });
    expect(options.map((option) => option.id)).toEqual(['ok/opus']);
  });

  it('falls back through label, id and route for the display name', () => {
    const options = parseServerModels({
      models: [
        { route: 'a/x', note: '' },
        { route: 'b/y', id: 'y', note: '' },
      ],
    });
    expect(options.map((option) => option.label)).toEqual(['a/x', 'y']);
  });

  it('keeps the note bare when there is no profile label to prefix', () => {
    const options = parseServerModels({
      models: [{ route: 'a/x', label: 'X', note: 'A note.' }],
    });
    expect(options[0]?.note).toBe('A note.');
  });

  it('answers an empty list for a body it cannot read at all', () => {
    expect(parseServerModels(undefined)).toEqual([]);
    expect(parseServerModels('nonsense')).toEqual([]);
    expect(parseServerModels({ models: 'not-an-array' })).toEqual([]);
    expect(parseServerModels({ models: [null, 7, 'x'] })).toEqual([]);
  });
});
