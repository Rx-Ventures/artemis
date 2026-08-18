/**
 * Discovery for the local servers.
 *
 * A note on what these tests are worth. The LM Studio fixtures elsewhere are
 * payloads captured from a running server. **These are not.** They are the
 * shapes the documentation describes, which makes every test here a check that
 * the parser matches the *docs* — not that the docs match the binary.
 *
 * So a green run proves the reader is internally consistent and survives
 * malformed input. It does not prove Ollama or `llama-server` answer this way.
 * That claim needs one of them installed, and neither was.
 */

import { describe, expect, it } from 'vitest';

import { parseLlamaServerModels, parseOllamaTags } from '../catalogues.js';

describe('parseOllamaTags — UNVERIFIED against a real server', () => {
  const TAGS = {
    models: [
      {
        name: 'llama3.2:3b',
        model: 'llama3.2:3b',
        size: 2019393189,
        details: { parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
      },
      { name: 'qwen2.5-coder:7b', size: 4683087332, details: { parameter_size: '7.6B' } },
    ],
  };

  it('uses the pull tag as the id, which is what the chat endpoint accepts', () => {
    expect(parseOllamaTags(TAGS).map((m) => m.id)).toEqual(['llama3.2:3b', 'qwen2.5-coder:7b']);
  });

  it('keeps the tag whole rather than splitting on the colon', () => {
    // `llama3.2` is a family and `3b` a size; showing either alone would name a
    // model the server does not have.
    expect(parseOllamaTags(TAGS)[0]?.label).toBe('llama3.2:3b');
  });

  it('surfaces the facts that decide whether a model fits in memory', () => {
    expect(parseOllamaTags(TAGS)[0]?.note).toBe('3.2B · Q4_K_M · 2 GB on disk');
  });

  it('falls back when details are missing rather than inventing them', () => {
    const [only] = parseOllamaTags({ models: [{ name: 'mystery:latest' }] });

    expect(only?.note).toBe('reported by the server');
  });

  it('KNOWN HOLE: cannot filter embeddings, because the payload does not say', () => {
    // LM Studio's native endpoint reports a type and this one does not, so an
    // embedding model pulled into Ollama *will* be offered. Documented as a
    // hole rather than hidden — closing it needs a real server to find out what
    // the payload actually carries.
    const models = parseOllamaTags({ models: [{ name: 'nomic-embed-text:latest' }] });

    expect(models).toHaveLength(1);
  });

  it.each([
    ['not an object', 7],
    ['null', null],
    ['no models key', { data: [] }],
    ['entries without names', { models: [{ size: 1 }, null] }],
  ])('survives a body that is %s', (_label, body) => {
    expect(parseOllamaTags(body)).toEqual([]);
  });
});

describe('parseLlamaServerModels — UNVERIFIED against a real server', () => {
  it('reads the OpenAI-shaped list', () => {
    const models = parseLlamaServerModels({
      data: [{ id: '/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf', object: 'model' }],
    });

    expect(models[0]?.id).toBe('/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf');
  });

  it('shortens a filesystem path to something a 20px bar can hold', () => {
    const [only] = parseLlamaServerModels({
      data: [{ id: '/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf' }],
    });

    expect(only?.label).toBe('qwen2.5-coder-7b-instruct-q4_k_m');
    // The full path stays addressable — it is what the server was started with.
    expect(only?.displayName).toBe('/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf');
  });

  it('says the single row is the server’s doing, not a truncated list', () => {
    const [only] = parseLlamaServerModels({ data: [{ id: 'model.gguf' }] });

    // One row here is the server saying it was started with one model, which is
    // a different thing from a picker that failed to load.
    expect(only?.note).toBe('the model this server was started with');
  });

  it('survives a malformed body', () => {
    expect(parseLlamaServerModels({ data: [{ nope: true }] })).toEqual([]);
  });
});
