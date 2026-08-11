/**
 * Model identity across catalogues.
 *
 * The bug these guard against is silent and looks like nothing: a model the user
 * pinned disappears from their picker the moment a live catalogue replaces the
 * built-in one, because the two lists call the same model by different ids.
 * Nothing throws, nothing logs, and the settings pane still lists the model —
 * only the shortlist built from stored ids comes up short.
 *
 * The pairs below are transcribed from a real `supportedModels()` response and
 * the Claude adapter's built-in list, which is where the mismatch actually
 * lives: `fable` against `claude-fable-5[1m]`, `opus` against `opus[1m]`.
 */

import { describe, expect, it } from 'vitest';

import { isSameModel, lowestTierModel, modelIdentity } from './provider.js';
import type { ProviderModelOption } from './provider.js';

function option(id: string, resolvedModel?: string): ProviderModelOption {
  return { id, label: id, note: '', ...(resolvedModel === undefined ? {} : { resolvedModel }) };
}

function tiered(id: string, tier?: number): ProviderModelOption {
  return { id, label: id, note: '', ...(tier === undefined ? {} : { tier }) };
}

describe('modelIdentity', () => {
  it('keeps the id and its resolution', () => {
    expect(modelIdentity(option('sonnet', 'claude-sonnet-5'))).toEqual([
      'sonnet',
      'claude-sonnet-5',
    ]);
  });

  it('drops a bracketed variant, which qualifies a model rather than naming one', () => {
    expect(modelIdentity(option('opus[1m]', 'claude-opus-5[1m]'))).toEqual([
      'opus',
      'claude-opus-5',
    ]);
  });

  it('drops a dated snapshot, which is the release rather than the model', () => {
    expect(modelIdentity(option('haiku', 'claude-haiku-4-5-20251001'))).toEqual([
      'haiku',
      'claude-haiku-4-5',
    ]);
  });

  it('does not repeat a key when the id is already its own resolution', () => {
    expect(modelIdentity(option('claude-fable-5[1m]', 'claude-fable-5'))).toEqual([
      'claude-fable-5',
    ]);
  });

  it('survives an option with no resolution published', () => {
    expect(modelIdentity(option('gpt-5.5'))).toEqual(['gpt-5.5']);
  });
});

describe('isSameModel', () => {
  it('matches an alias against the live row it resolves to', () => {
    // The exact pair that took Fable out of the picker: nothing about these two
    // ids is comparable, and only `resolvedModel` connects them.
    const builtIn = option('fable', 'claude-fable-5');
    const live = option('claude-fable-5[1m]', 'claude-fable-5');
    expect(isSameModel(builtIn, live)).toBe(true);
  });

  it('matches across a variant suffix', () => {
    expect(isSameModel(option('opus', 'claude-opus-5'), option('opus[1m]', 'claude-opus-5[1m]'))).toBe(
      true,
    );
  });

  it('matches across a dated snapshot', () => {
    // Ids share nothing here either, so the date-stripped resolution is the only
    // thing carrying the match.
    expect(
      isSameModel(option('claude-haiku-4-5-20251001'), option('haiku', 'claude-haiku-4-5')),
    ).toBe(true);
  });

  it('keeps different models apart', () => {
    expect(isSameModel(option('opus', 'claude-opus-5'), option('sonnet', 'claude-sonnet-5'))).toBe(
      false,
    );
    // Two generations of one family are different models, and a picker that
    // conflated them would send the wrong one.
    expect(
      isSameModel(option('sonnet', 'claude-sonnet-4-5'), option('sonnet-5', 'claude-sonnet-5')),
    ).toBe(false);
  });

  it('does not match two providers that happen to publish no resolution', () => {
    expect(isSameModel(option('gpt-5.5'), option('gpt-5.4-mini'))).toBe(false);
  });
});

/**
 * Picking the model background work is billed to.
 *
 * The failure mode this guards is a charge rather than a wrong pixel: get it
 * wrong and every new session is named by a frontier model. Display order is
 * specifically not the answer — both real catalogues lead with their flagship.
 */
describe('lowestTierModel', () => {
  it('ignores display order and takes the smallest tier', () => {
    // Claude's own order: flagship first, cheapest last.
    const models = [tiered('fable', 3), tiered('opus', 2), tiered('sonnet', 1), tiered('haiku', 0)];
    expect(lowestTierModel(models)?.id).toBe('haiku');
  });

  it('still finds it when the cheapest model is listed first', () => {
    expect(lowestTierModel([tiered('mini', 0), tiered('frontier', 1)])?.id).toBe('mini');
  });

  it('answers nothing when no row declares a tier', () => {
    // A live catalogue full of models this build has never heard of. Guessing
    // here would bill an account to save a lookup.
    expect(lowestTierModel([option('who-knows'), option('nor-this')])).toBeUndefined();
  });

  it('skips untiered rows rather than treating them as cheapest', () => {
    const models = [option('unplaceable'), tiered('sonnet', 1)];
    expect(lowestTierModel(models)?.id).toBe('sonnet');
  });

  it('breaks a tie on display order, which is the provider’s own preference', () => {
    expect(lowestTierModel([tiered('first', 0), tiered('second', 0)])?.id).toBe('first');
  });

  it('answers nothing for an empty or absent catalogue', () => {
    expect(lowestTierModel([])).toBeUndefined();
    expect(lowestTierModel(undefined)).toBeUndefined();
  });
});
