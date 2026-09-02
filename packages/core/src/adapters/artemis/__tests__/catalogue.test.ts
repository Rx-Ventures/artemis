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
        accountSlug: 'work',
        accountLabel: 'Work',
        tier: 1,
        supportsFastMode: false,
        supportsUltracode: true,
        adaptiveThinking: false,
      },
    ]);
  });

  it('carries the serving profile whole — id, slug and label', () => {
    const [option] = parseServerModels({
      models: [
        {
          route: 'work-max/opus',
          label: 'Opus 5',
          note: 'Deep work.',
          profileId: 'e4966faa-6e1a-4713-afb9-292dea6a05a7',
          profileSlug: 'work-max',
          profileLabel: 'work max',
        },
      ],
    });
    expect(option?.accountId).toBe('e4966faa-6e1a-4713-afb9-292dea6a05a7');
    expect(option?.accountSlug).toBe('work-max');
    expect(option?.accountLabel).toBe('work max');
  });

  it('carries the account’s provider, so the picker can group by it', () => {
    // The server has always sent this — `ServerModel.providerId` is required —
    // and the parser dropped it, which is why a server's accounts were the one
    // account list in the app that could not be grouped by provider.
    const [option] = parseServerModels({
      models: [
        {
          route: 'rx-codex/gpt-5.2',
          label: 'GPT-5.2',
          note: '',
          profileId: 'p1',
          providerId: 'codex',
        },
      ],
    });
    expect(option?.accountProviderId).toBe('codex');
  });

  it('drops a provider id it does not recognise rather than inventing a section', () => {
    // A server one version ahead may serve a provider this build has no name
    // for. Absent lands as "ungrouped", which the picker draws bare.
    const [ahead, older] = parseServerModels({
      models: [
        { route: 'a/m', label: 'M', note: '', providerId: 'something-new' },
        { route: 'b/m', label: 'M', note: '' },
      ],
    });
    expect(ahead !== undefined && 'accountProviderId' in ahead).toBe(false);
    expect(older !== undefined && 'accountProviderId' in older).toBe(false);
  });

  it('reads the slug off the route against a server that never sent one', () => {
    const [prefixed, bare] = parseServerModels({
      models: [
        { route: 'work-max/opus', label: 'Opus 5', note: '' },
        { route: 'no-slash', label: 'Odd', note: '' },
      ],
    });
    expect(prefixed?.accountSlug).toBe('work-max');
    expect(prefixed !== undefined && 'accountId' in prefixed).toBe(false);
    expect(prefixed !== undefined && 'accountLabel' in prefixed).toBe(false);
    // A route with no prefix names no account, and must not invent one.
    expect(bare !== undefined && 'accountSlug' in bare).toBe(false);
  });

  it('maps thinkingLevels to the effort ids each route accepts', () => {
    const [withLevels, noLevels] = parseServerModels({
      models: [
        {
          route: 'work/opus',
          label: 'Opus',
          note: '',
          thinkingLevels: [
            { id: 'low', label: 'Low', note: '' },
            { id: 'high', label: 'High', note: '' },
          ],
        },
        { route: 'work/haiku', label: 'Haiku', note: '', thinkingLevels: [] },
      ],
    });
    expect(withLevels?.effortLevels).toEqual(['low', 'high']);
    // An empty list is a real answer — "this model takes no thinking setting" —
    // and is carried through as `[]` rather than dropped.
    expect(noLevels?.effortLevels).toEqual([]);
  });

  it('omits effortLevels for a row that never sent thinkingLevels', () => {
    const [option] = parseServerModels({ models: [{ route: 'a/x', note: '' }] });
    expect(option !== undefined && 'effortLevels' in option).toBe(false);
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
