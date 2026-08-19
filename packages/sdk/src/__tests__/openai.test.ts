/**
 * The OpenAI interop layer.
 *
 * Two things are worth pinning here, and the second is the one that would
 * otherwise rot silently.
 *
 * **It refuses what the route would drop.** A setting a model does not accept
 * is not an error anywhere in HTTP — the run simply ignores it — so the only
 * place it can be caught is before the request leaves. Every branch of that
 * refusal is tested.
 *
 * **The writer and the reader agree.** `buildChatRequest` composes the body and
 * `readChatExtensions` (which the server will use) takes it apart. They live in
 * different packages and are one key name away from failing in the quietest
 * possible way: a request that looks accepted, runs, and honours nothing. So
 * they are tested against each other rather than each against a fixture.
 */

import { describe, expect, it } from 'vitest';

import type { ServerModel } from '@rx-artemis/protocol';
import { readChatExtensions } from '@rx-artemis/protocol';

import {
  buildChatRequest,
  checkChatSettings,
  openAiOptions,
  UnsupportedSettingError,
} from '../openai.js';

const OPUS: ServerModel = {
  route: 'work-max/opus',
  id: 'opus',
  label: 'Opus',
  note: '.',
  profileId: 'p' as ServerModel['profileId'],
  profileSlug: 'work-max',
  profileLabel: 'Work Max',
  providerId: 'claude',
  thinkingLevels: [
    { id: 'low', label: 'Low', note: '.' },
    { id: 'high', label: 'High', note: '.' },
    { id: 'max', label: 'Max', note: '.' },
  ],
  adaptiveThinking: false,
  fastMode: true,
  ultracode: true,
};

/** A Codex-shaped route: a shorter scale, and neither flag. */
const GPT: ServerModel = {
  ...OPUS,
  route: 'codex/gpt-5.6-sol',
  id: 'gpt-5.6-sol',
  providerId: 'codex',
  thinkingLevels: [
    { id: 'low', label: 'Low', note: '.' },
    { id: 'xhigh', label: 'Extra high', note: '.' },
  ],
  fastMode: false,
  ultracode: false,
};

/** A model that takes no thinking setting at all. */
const FLAT: ServerModel = { ...OPUS, route: 'work-max/haiku', id: 'haiku', thinkingLevels: [] };

describe('openAiOptions', () => {
  it('appends /v1, which is what an OpenAI client expects to be given', () => {
    expect(openAiOptions({ baseUrl: 'http://127.0.0.1:6472' }, 'tok')).toEqual({
      baseURL: 'http://127.0.0.1:6472/v1',
      apiKey: 'tok',
    });
  });
});

describe('buildChatRequest', () => {
  it('sends the route as `model`, and nothing else when nothing was asked for', () => {
    // No empty namespace: a server should not have to interpret `artemis: {}`.
    expect(buildChatRequest(OPUS)).toEqual({ model: 'work-max/opus' });
  });

  it('namespaces the settings it does send', () => {
    expect(buildChatRequest(OPUS, { thinking: 'high', ultracode: true })).toEqual({
      model: 'work-max/opus',
      artemis: { thinking: 'high', ultracode: true },
    });
  });

  it('resolves "deepest" per route rather than hard-coding a provider’s word', () => {
    // The reason this exists: `max` is a Claude word. A caller that hard-coded
    // it would throw on every Codex route.
    expect(buildChatRequest(OPUS, { thinking: 'deepest' }).artemis?.thinking).toBe('max');
    expect(buildChatRequest(GPT, { thinking: 'deepest' }).artemis?.thinking).toBe('xhigh');
  });

  it('refuses a level this model does not have, and names the ones it does', () => {
    expect(() => buildChatRequest(GPT, { thinking: 'max' })).toThrow(UnsupportedSettingError);
    expect(() => buildChatRequest(GPT, { thinking: 'max' })).toThrow(/low, xhigh/);
  });

  it('refuses any level on a model that takes none', () => {
    expect(() => buildChatRequest(FLAT, { thinking: 'low' })).toThrow(
      /no thinking setting at all/,
    );
  });

  it('refuses fast mode and ultracode the route does not offer', () => {
    expect(() => buildChatRequest(GPT, { fastMode: true })).toThrow(UnsupportedSettingError);
    expect(() => buildChatRequest(GPT, { ultracode: true })).toThrow(/does not offer it/);
  });

  it('accepts an explicit false on a model that lacks the capability', () => {
    // Asking for it to be off is agreement, not a conflict.
    expect(buildChatRequest(GPT, { fastMode: false }).artemis).toEqual({ fastMode: false });
  });

  it('carries a session id, the only turn state a caller supplies', () => {
    expect(buildChatRequest(OPUS, { sessionId: 'sess-1' }).artemis?.sessionId).toBe('sess-1');
  });

  it('has no way to name a working directory', () => {
    // The connection decides where turns run, and a field here would be a way
    // around a decision a person made when the token was issued.
    expect(Object.keys(buildChatRequest(OPUS, { thinking: 'high' }).artemis ?? {})).toEqual([
      'thinking',
    ]);
  });
});

describe('checkChatSettings', () => {
  it('answers with reasons instead of throwing, for input that came from a person', () => {
    expect(checkChatSettings(OPUS, { thinking: 'high' })).toEqual([]);
    expect(checkChatSettings(GPT, { ultracode: true })[0]).toMatch(/does not offer it/);
  });
});

describe('the writer and the server’s reader agree', () => {
  it('round-trips every setting through the parser the server will use', () => {
    const body = buildChatRequest(OPUS, {
      thinking: 'high',
      fastMode: true,
      sessionId: 'sess-1',
    });

    // One key name apart and this would still "work" — the request would be
    // accepted and every setting on it ignored.
    expect(readChatExtensions(body)).toEqual({
      thinking: 'high',
      fastMode: true,
      sessionId: 'sess-1',
    });
  });

  it('reads nothing out of a request that asked for nothing', () => {
    expect(readChatExtensions(buildChatRequest(OPUS))).toEqual({});
  });

  it('accepts reasoning_effort from an off-the-shelf client as an alias', () => {
    // A client that already sets OpenAI's field meant what Artemis means.
    expect(readChatExtensions({ model: 'x', reasoning_effort: 'high' })).toEqual({
      thinking: 'high',
    });
  });

  it('prefers the namespace when a caller set both', () => {
    expect(
      readChatExtensions({ reasoning_effort: 'low', artemis: { thinking: 'max' } }),
    ).toEqual({ thinking: 'max' });
  });

  it('drops unknown keys so a newer client degrades against an older server', () => {
    expect(
      readChatExtensions({ artemis: { thinking: 'high', somethingNew: 'value' } }),
    ).toEqual({ thinking: 'high' });
  });

  it('ignores values of the wrong type rather than coercing them', () => {
    expect(readChatExtensions({ artemis: { thinking: 5, fastMode: 'yes' } })).toEqual({});
  });
});
