import { describe, expect, it, vi } from 'vitest';

import type {
  ProfileId,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderModelOption,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { createCatalogue, type CatalogueSource } from '../catalogue.js';

const profile = (id: string, label: string, providerId = 'claude' as const): ProfileMetadata => ({
  id: id as ProfileId,
  label,
  providerId,
  configDir: `/tmp/${id}`,
});

const descriptor = (models: readonly ProviderModelOption[]): ProviderDescriptor => ({
  id: 'claude',
  kind: 'hosted',
  label: 'Claude',
  capabilities: NO_CAPABILITIES,
  models,
  effortLevels: [
    { id: 'low', label: 'Low', note: 'Fast.' },
    { id: 'high', label: 'High', note: 'Deep.' },
    { id: 'max', label: 'Max', note: 'Deepest.' },
  ],
  available: true,
});

function source(overrides: Partial<CatalogueSource> = {}): CatalogueSource {
  return {
    listProfiles: async () => [profile('a', 'Work Max')],
    listProviders: async () => [
      descriptor([
        {
          id: 'opus',
          label: 'Opus 5',
          note: 'The big one.',
          effortLevels: ['low', 'high'],
          supportsFastMode: true,
        },
      ]),
    ],
    listModels: async () => ({ models: [], live: false }),
    ...overrides,
  };
}

describe('createCatalogue', () => {
  it('routes every model under its account', async () => {
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => ({
          models: [{ id: 'opus', label: 'Opus 5', note: 'The big one.' }],
          live: true,
        }),
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.slug).toBe('work-max');
    expect(entry?.models[0]?.route).toBe('work-max/opus');
    expect(entry?.live).toBe(true);
  });

  it('publishes only the thinking levels the model actually accepts', async () => {
    // The provider offers three; this model takes two. Publishing all three
    // would offer callers a level the run silently drops.
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => ({
          models: [
            { id: 'opus', label: 'Opus 5', note: '.', effortLevels: ['low', 'high'] },
            { id: 'flat', label: 'Flat', note: '.', effortLevels: [] },
          ],
          live: true,
        }),
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models[0]?.thinkingLevels.map((level) => level.id)).toEqual(['low', 'high']);
    // An empty array on the option means "no thinking setting at all", which is
    // not the same as an absent one.
    expect(entry?.models[1]?.thinkingLevels).toEqual([]);
  });

  it('turns absent capability flags into false rather than leaving them undefined', async () => {
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => ({
          models: [
            { id: 'opus', label: 'Opus 5', note: '.', supportsFastMode: true },
            { id: 'plain', label: 'Plain', note: '.' },
          ],
          live: true,
        }),
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models[0]).toMatchObject({ fastMode: true, ultracode: false });
    // A JSON consumer cannot tell a missing field from a false one, so the
    // distinction has to be closed here.
    expect(entry?.models[1]).toMatchObject({
      fastMode: false,
      ultracode: false,
      adaptiveThinking: false,
    });
  });

  it('serves a cached catalogue until it goes stale', async () => {
    const listModels = vi.fn(async () => ({ models: [], live: true }));
    let now = 1_000;
    const catalogue = createCatalogue({
      source: source({ listModels }),
      ttlMs: 60_000,
      now: () => now,
    });

    await catalogue.read();
    await catalogue.read();
    expect(listModels).toHaveBeenCalledTimes(1);

    now += 60_001;
    await catalogue.read();
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('re-reads on demand, and forgets when invalidated', async () => {
    const listModels = vi.fn(async () => ({ models: [], live: true }));
    const catalogue = createCatalogue({ source: source({ listModels }), now: () => 0 });

    await catalogue.read();
    await catalogue.read({ refresh: true });
    expect(listModels).toHaveBeenCalledTimes(2);

    catalogue.invalidate();
    await catalogue.read();
    expect(listModels).toHaveBeenCalledTimes(3);
  });

  it('builds once for callers that arrive together', async () => {
    // The single most important property in the file: each build spawns a
    // provider CLI per account, so N concurrent clients must not mean N builds.
    let builds = 0;
    const catalogue = createCatalogue({
      source: source({
        listModels: async () => {
          builds += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { models: [], live: true };
        },
      }),
    });

    await Promise.all([catalogue.read(), catalogue.read(), catalogue.read()]);
    expect(builds).toBe(1);
  });

  it('keeps one broken account from emptying the whole catalogue', async () => {
    const catalogue = createCatalogue({
      source: source({
        listProfiles: async () => [profile('a', 'Work'), profile('b', 'Home')],
        listModels: async ({ profileId }) => {
          if (profileId === ('a' as ProfileId)) throw new Error('the CLI exploded');
          return { models: [{ id: 'opus', label: 'Opus 5', note: '.' }], live: true };
        },
      }),
    });

    const profiles = await catalogue.read();
    expect(profiles).toHaveLength(2);
    // The failed one falls back to the descriptor's built-in list, unconfirmed.
    expect(profiles[0]?.live).toBe(false);
    expect(profiles[0]?.models[0]?.route).toBe('work/opus');
    expect(profiles[1]?.live).toBe(true);
  });

  it('keeps the built-in list when an unconfirmed answer comes back empty', async () => {
    // "Could not enumerate" is not "this account has no models". Taking the
    // empty answer would publish an account with no routes at all.
    const catalogue = createCatalogue({
      source: source({ listModels: async () => ({ models: [], live: false }) }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models.map((model) => model.route)).toEqual(['work-max/opus']);
    expect(entry?.live).toBe(false);
  });

  it('takes a confirmed empty answer at its word', async () => {
    // The other direction: a local endpoint with nothing loaded really does
    // offer nothing, and publishing names it has never heard of would give
    // clients routes that cannot run.
    const catalogue = createCatalogue({
      source: source({ listModels: async () => ({ models: [], live: true }) }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.models).toEqual([]);
    expect(entry?.live).toBe(true);
  });

  it('describes an account whose provider this build cannot drive', async () => {
    const catalogue = createCatalogue({
      source: source({
        listProfiles: async () => [profile('a', 'Codex', 'codex')],
        listProviders: async () => [],
      }),
    });

    const [entry] = await catalogue.read();
    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReason).toMatch(/no adapter/i);
    expect(entry?.models).toEqual([]);
  });
});
