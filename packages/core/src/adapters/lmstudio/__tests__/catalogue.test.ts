/**
 * Reading a local server's catalogue.
 *
 * The fixtures are real payloads captured from LM Studio on 2026-08-18, not
 * invented ones — including the case that motivated the module: a machine whose
 * only downloaded model is an embedding model.
 */

import { describe, expect, it } from 'vitest';

import { parseNativeCatalogue, parseOpenAiCatalogue } from '../catalogue.js';

/** `/api/v0/models` as the machine actually answered it. */
const NATIVE_EMBEDDING_ONLY = {
  data: [
    {
      id: 'text-embedding-nomic-embed-text-v1.5',
      type: 'embeddings',
      state: 'not-loaded',
    },
  ],
};

const NATIVE_MIXED = {
  data: [
    { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', state: 'not-loaded' },
    { id: 'mistralai/ministral-3-3b', type: 'llm', state: 'loaded', max_context_length: 131072 },
    { id: 'qwen/qwen2-vl-7b', type: 'vlm', state: 'not-loaded' },
  ],
};

describe('parseNativeCatalogue', () => {
  it('FILTER: an embedding model is not offered as something to talk to', () => {
    // The failure this module exists to prevent. Offering this row would hand
    // the user a model the server refuses to chat with, and the picker would
    // have been the thing that lied.
    expect(parseNativeCatalogue(NATIVE_EMBEDDING_ONLY)).toEqual([]);
  });

  it('keeps llm and vlm, drops embeddings', () => {
    const ids = parseNativeCatalogue(NATIVE_MIXED).map((m) => m.id);

    expect(ids).toEqual(['mistralai/ministral-3-3b', 'qwen/qwen2-vl-7b']);
  });

  it('says whether a model is loaded, because a cold start reads gigabytes', () => {
    const [ministral] = parseNativeCatalogue(NATIVE_MIXED);

    expect(ministral?.note).toContain('loaded');
    expect(ministral?.note).toContain('131k context');
  });

  it('says a vision model accepts images without claiming it provider-wide', () => {
    const vlm = parseNativeCatalogue(NATIVE_MIXED).find((m) => m.id === 'qwen/qwen2-vl-7b');

    expect(vlm?.note).toContain('accepts images');
    expect(vlm?.note).toContain('not loaded');
  });

  it('shortens the id for dense chrome but keeps the full one addressable', () => {
    const [ministral] = parseNativeCatalogue(NATIVE_MIXED);

    // The status line is 20px tall; `mistralai/ministral-3-3b` does not fit.
    expect(ministral?.label).toBe('ministral-3-3b');
    expect(ministral?.displayName).toBe('mistralai/ministral-3-3b');
    expect(ministral?.id).toBe('mistralai/ministral-3-3b');
  });

  it('keeps a model whose type the server did not report', () => {
    // Unknown is not the same as embeddings. Dropping it would hide a usable
    // model because a field was missing.
    const models = parseNativeCatalogue({ data: [{ id: 'mystery-7b' }] });

    expect(models.map((m) => m.id)).toEqual(['mystery-7b']);
  });

  it('invents nothing from the name', () => {
    const [coder] = parseNativeCatalogue({
      data: [{ id: 'qwen/qwen3-coder-30b', type: 'llm', state: 'loaded' }],
    });

    // "coder" is a marketing string, not a measurement. The note says only what
    // the server reported.
    expect(coder?.note).toBe('loaded');
  });

  it.each([
    ['not an object', 42],
    ['null', null],
    ['no data array', { models: [] }],
    ['data is not an array', { data: 'nope' }],
    ['entries without ids', { data: [{ type: 'llm' }, null, 7] }],
  ])('survives a body that is %s', (_label, body) => {
    expect(parseNativeCatalogue(body)).toEqual([]);
  });
});

describe('parseOpenAiCatalogue', () => {
  it('reads the fallback endpoint', () => {
    const models = parseOpenAiCatalogue({
      data: [{ id: 'text-embedding-nomic-embed-text-v1.5', object: 'model' }],
    });

    // No `type` here, so nothing can be filtered — an embedding model reaching
    // this path *is* offered. That is the documented cost of the fallback and
    // the reason the native endpoint is preferred.
    expect(models.map((m) => m.id)).toEqual(['text-embedding-nomic-embed-text-v1.5']);
  });

  it('says only that the server reported it', () => {
    const [only] = parseOpenAiCatalogue({ data: [{ id: 'mystery-7b' }] });

    expect(only?.note).toBe('reported by the server');
  });

  it('survives a malformed body', () => {
    expect(parseOpenAiCatalogue({ data: [{ nope: true }] })).toEqual([]);
  });
});
