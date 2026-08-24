/**
 * @vitest-environment jsdom
 *
 * The model on the wire is the model that was chosen.
 *
 * The defect this pins was silent and expensive. The built-in catalogue and the
 * live one the CLI publishes use different vocabularies — `opus` versus
 * `opus[1m]`, `fable` versus `claude-fable-5[1m]` — and the live one only
 * exists once `refreshModels` has landed. Until then (and forever, if that
 * fetch fails) a conversation pinned to `opus[1m]` matched nothing and
 * `activeModel` fell through to the catalogue's *first row*.
 *
 * That row is Fable. So the status bar read "Fable 5" over a conversation whose
 * run reported Opus — and because the same value is what `startRun` puts on the
 * wire, the next prompt did not merely *display* the wrong model, it **ran on
 * it**. A conversation silently changed model, on nobody's instruction.
 *
 * `models.test.ts` covers the selector and the `refreshModels` reconciliation.
 * This covers the consequence: what main is actually handed.
 *
 * Same caveat as the neighbouring suites: `renderer/tsconfig.json` excludes
 * test files, so these assertions are behavioural rather than typechecked.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type { ProviderModelOption } from '@rx-artemis/protocol';

import { focusedPane, setModel, submitPrompt, useApp } from './store';
import { setPaneState } from './pane';

/** The model id on every `runs.start` input main was handed. */
let started: (string | undefined)[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    send: async () => ({ ok: true, value: { runId: 'r1', deliveredImmediately: true } }),
    start: async ({ input }: { input: { runId: string; model?: string } }) => {
      // Presence, not just value: an absent model means "the provider's
      // default", which is a different instruction from naming one.
      started.push('model' in input ? input.model : undefined);
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'running',
            capabilities: NO_CAPABILITIES,
            startedAt: 1,
            sessionId: 'sess-new',
          },
        },
      };
    },
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

/** The Claude adapter's built-in list, in its real order — Fable first. */
const BUILT_IN: readonly ProviderModelOption[] = [
  { id: 'fable', label: 'Fable 5', resolvedModel: 'claude-fable-5' },
  { id: 'opus', label: 'Opus 5', resolvedModel: 'claude-opus-5' },
  { id: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
] as never;

beforeEach(() => {
  started = [];
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    activeProfileId: 'p1',
    activeProviderId: 'claude',
    cwd: '/repo',
    run: null,
    permissionQueue: [],
    promptHistory: [],
    // Empty: the pane has not fetched a live catalogue, which is the state
    // every column boots in and the one this suite is about.
    models: [],
    model: null,
  } as never);
  useApp.setState({
    providers: [
      { id: 'claude', label: 'Claude', capabilities: NO_CAPABILITIES, models: BUILT_IN },
    ] as never,
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude' }] as never,
    banners: [],
  });
});

describe('the model a prompt is sent with', () => {
  it('is the live id the conversation was pinned to, not the first built-in row', async () => {
    // What David's preferences actually hold: ids from the CLI's catalogue,
    // stored while it was loaded, read back before it is.
    setModel('opus[1m]');

    await submitPrompt('carry on');

    expect(started).toEqual(['opus[1m]']);
    // The failure this replaces, named so a regression reads plainly.
    expect(started).not.toEqual(['fable']);
  });

  it('holds for the other renamed model too', async () => {
    setModel('claude-fable-5[1m]');

    await submitPrompt('carry on');

    expect(started).toEqual(['claude-fable-5[1m]']);
  });

  it('sends the catalogue id when the catalogue does have it', async () => {
    setModel('sonnet');

    await submitPrompt('carry on');

    expect(started).toEqual(['sonnet']);
  });

  it('falls back to the first row only when nothing was ever chosen', async () => {
    // `null` is the genuinely absent choice, and its contract is unchanged:
    // the catalogue's first entry is the provider's own default.
    setModel(null);

    await submitPrompt('carry on');

    expect(started).toEqual(['fable']);
  });
});
