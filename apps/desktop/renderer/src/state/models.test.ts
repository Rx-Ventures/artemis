/**
 * @vitest-environment jsdom
 *
 * A pinned model survives the catalogue it was pinned in.
 *
 * The failure this file exists for shipped: the composer's model picker stopped
 * offering Fable. Nothing was broken in the picker, in the fetch, or in the
 * account — the built-in list calls that model `fable` and the live one the CLI
 * publishes calls it `claude-fable-5[1m]`, so a pin stored against the first
 * matched nothing in the second and quietly dropped out of the shortlist. The
 * settings pane went on listing the model the whole time, which is exactly why
 * it took a while to see: the two surfaces disagreed and neither said anything.
 *
 * `refreshModels` is the only moment both catalogues exist, so it is the only
 * place the two vocabularies can be reconciled — hence the assertions here
 * rather than on a selector.
 *
 * Same caveat as `cwd.test.ts`: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type { ProviderDescriptor, ProviderModelOption } from '@rx-artemis/protocol';

import {
  activeModel,
  focusedPane,
  paneQuickModelIds,
  quickModels,
  refreshModels,
  setQuickModels,
  toggleQuickModel,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

/*
 * One column, and every assertion below is about it.
 *
 * Session state moved out of `useApp` into a pane when split view landed — see
 * `state/pane.ts`. These helpers are the whole difference: `pane()` is the
 * column the store's actions default to, and `session()` / `setSession()` read
 * and write what `useApp.getState()` used to hold.
 */
const pane = () => focusedPane();
const session = () => paneState(pane());
const setSession = (patch) => setPaneState(pane(), patch);


/** The Claude adapter's built-in list, trimmed to the ids that matter here. */
const BUILT_IN: readonly ProviderModelOption[] = [
  { id: 'fable', label: 'Fable 5', resolvedModel: 'claude-fable-5', note: '' },
  { id: 'opus', label: 'Opus 5', resolvedModel: 'claude-opus-5', note: '' },
  { id: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5', note: '' },
  { id: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001', note: '' },
];

/** What `supportedModels()` actually answers, transcribed from a live call. */
const LIVE: readonly ProviderModelOption[] = [
  { id: 'opus[1m]', label: 'Opus 5', resolvedModel: 'claude-opus-5[1m]', note: '' },
  { id: 'claude-fable-5[1m]', label: 'Fable 5', resolvedModel: 'claude-fable-5', note: '' },
  { id: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5', note: '' },
  { id: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001', note: '' },
];

const CLAUDE: ProviderDescriptor = {
  id: 'claude',
  label: 'Claude',
  capabilities: NO_CAPABILITIES,
  models: BUILT_IN,
  effortLevels: [],
  available: true,
};

/**
 * What the next `providers:models` call answers.
 *
 * A mutable box rather than a fresh stub per test, because `resolveBridge`
 * memoises the binding on its first call — a second `window.artemis` would be
 * installed after the first test had already captured the first one.
 */
let answer: { models: readonly ProviderModelOption[]; live: boolean } = { models: LIVE, live: true };

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  providers: { models: async () => ({ ok: true, value: answer }) },
};

/** A bridge that answers `providers:models` and nothing else. */
function bridgeReturning(models: readonly ProviderModelOption[], live = true): void {
  answer = { models, live };
}

/** The app as it boots: no live catalogue yet, so the built-in list is in force. */
function booted(quickModelIds: readonly string[], model: string | null = null): void {
  // Split across the two stores the way the app does: the catalogue of
  // providers and the pinned shortlists are the window's, the selection is the
  // column's. The mirror carries the first pair into the pane on its own.
  // The shortlist is keyed by profile, and this pane's profile is `p1`.
  useApp.setState({ providers: [CLAUDE], quickModelIdsByProfile: { p1: quickModelIds } });
  setSession({
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    models: [],
    model,
    cwd: '',
  });
}

beforeEach(() => {
  globalThis.localStorage?.clear();
});

/**
 * The other half of the same vocabulary problem.
 *
 * `refreshModels` reconciles the two catalogues when both exist. These cover
 * every moment one of them does not — before the live fetch lands, and forever
 * if it fails — where a pin like `opus[1m]` matches nothing in the built-in
 * list. Resolving that to the first row was a silent lie with teeth: the bar
 * read "Fable 5" over a conversation the run reported as Opus, and because
 * this is the value `startRun` sends, the next prompt actually switched the
 * conversation to Fable.
 */
describe('a chosen model the catalogue does not list', () => {
  it('keeps the choice rather than resolving to the first row', () => {
    // The state on boot: built-in list in force, live ids stored from a
    // previous session that did have the live catalogue.
    booted([], 'opus[1m]');

    expect(activeModel(session())?.id).toBe('opus[1m]');
    // The failure this replaces — `fable` is BUILT_IN[0].
    expect(activeModel(session())?.id).not.toBe('fable');
  });

  it('claims no capability it could not look up', () => {
    // Fast mode and ultracode are facts a catalogue would have told us. A row
    // we could not find must not put toggles on screen the run may reject.
    booted([], 'opus[1m]');
    const model = activeModel(session());

    expect(model?.supportsFastMode).toBeUndefined();
    expect(model?.supportsUltracode).toBeUndefined();
    expect(model?.effortLevels).toBeUndefined();
  });

  it('is stable between reads, so selectors do not loop', () => {
    // Read through zustand hooks, which re-render on identity — see the
    // memoisation note in the store.
    booted([], 'opus[1m]');

    expect(activeModel(session())).toBe(activeModel(session()));
  });

  it('still takes the first row when nothing was ever chosen', () => {
    // `null` is the genuinely absent case, and the contract for it is
    // unchanged: the catalogue's first entry is the provider's own default.
    booted([], null);

    expect(activeModel(session())?.id).toBe('fable');
  });

  it('prefers the catalogue whenever it does have the id', () => {
    booted([], 'sonnet');

    expect(activeModel(session())?.label).toBe('Sonnet 5');
  });
});

describe('refreshModels', () => {
  it('carries pinned ids onto the live catalogue that renamed them', async () => {
    bridgeReturning(LIVE);
    booted(['opus', 'fable']);

    await refreshModels();

    // Both pins were stored in the built-in vocabulary and neither id exists in
    // the live one. Before this was fixed they both matched nothing, `fable`
    // included, and the picker fell back to a single row.
    expect(useApp.getState().quickModelIdsByProfile['p1']).toEqual(['opus[1m]', 'claude-fable-5[1m]']);
    expect(quickModels(session()).map((m) => m.label)).toEqual(['Opus 5', 'Fable 5']);
  });

  it('collapses two stale ids that land on one row', async () => {
    bridgeReturning(LIVE);
    // What a user ends up with after pinning Opus from the built-in list and
    // again from the live one: two ids, one model.
    booted(['opus', 'fable', 'opus[1m]']);

    await refreshModels();

    expect(useApp.getState().quickModelIdsByProfile['p1']).toEqual(['opus[1m]', 'claude-fable-5[1m]']);
  });

  it('carries the selected model too, rather than dropping to the first row', async () => {
    bridgeReturning(LIVE);
    booted([], 'fable');

    await refreshModels();

    expect(session().model).toBe('claude-fable-5[1m]');
    // The run sends the resolved option's id, so this is what would actually be
    // asked for. Falling through to `models[0]` would silently start Opus.
    expect(activeModel(session())?.label).toBe('Fable 5');
  });

  it('carries the id in the conversation’s own record too', async () => {
    bridgeReturning(LIVE);
    booted([], 'fable');
    // A column showing a conversation, which is what gives the record a key.
    setSession({ resumeSessionId: 'sess-a' });
    useApp.setState({
      modelBySession: { 'sess-a': { model: 'fable', effort: null, fastMode: false, ultracode: false } },
    });

    await refreshModels();

    // The record is stored in whichever vocabulary was current when it was
    // written, so it goes stale the same way the pins and the selection do.
    // Left alone, reopening this conversation would restore an id the live
    // catalogue has never heard of and the bar would read "(unavailable)".
    expect(useApp.getState().modelBySession['sess-a']?.model).toBe('claude-fable-5[1m]');
  });

  it('persists the carried ids, so the migration runs once', async () => {
    bridgeReturning(LIVE);
    booted(['fable']);

    await refreshModels();

    const saved = JSON.parse(globalThis.localStorage.getItem('artemis.prefs.v1') ?? '{}');
    expect(saved.quickModelIdsByProfile?.['p1']).toEqual(['claude-fable-5[1m]']);
  });

  it('leaves ids alone when the new catalogue already has them', async () => {
    bridgeReturning(LIVE);
    const pins = ['sonnet', 'haiku'];
    booted(pins);

    await refreshModels();

    // Identity, not just equality: `quickModels` memoises on this array, and a
    // fresh copy on every background refresh would defeat the memo.
    expect(useApp.getState().quickModelIdsByProfile['p1']).toBe(pins);
    expect(globalThis.localStorage.getItem('artemis.prefs.v1')).toBeNull();
  });

  it('leaves a pin from another provider untouched', async () => {
    bridgeReturning(LIVE);
    // A Codex pin surviving in the prefs while Claude is active. It matches
    // nothing in either Claude list, and deleting it would lose the shortlist
    // the user curated over there.
    booted(['gpt-5.5', 'fable']);

    await refreshModels();

    expect(useApp.getState().quickModelIdsByProfile['p1']).toEqual(['gpt-5.5', 'claude-fable-5[1m]']);
  });

  it('does not migrate against a catalogue nobody confirmed', async () => {
    // `live: false` is the handler saying "this is the built-in list back at
    // you". Rewriting stored ids from it would be migrating onto a guess.
    bridgeReturning(BUILT_IN, false);
    booted(['fable']);

    await refreshModels();

    expect(useApp.getState().quickModelIdsByProfile['p1']).toEqual(['fable']);
  });
});

/* -------------------------------------------------------------------------- */
/* One shortlist per profile                                                  */
/* -------------------------------------------------------------------------- */

describe('pinned shortlists are per profile', () => {
  it('two accounts do not share one shortlist', () => {
    booted(['fable']);
    useApp.setState({
      quickModelIdsByProfile: { p1: ['fable'], p2: ['opus'] },
    });

    // The pane is on p1, so that is the shortlist it resolves — p2's pins are
    // in the same map and must not leak into this column.
    expect(paneQuickModelIds(paneState(focusedPane()))).toEqual(['fable']);
  });

  it('a profile with no entry gets the whole catalogue, not an empty picker', () => {
    booted([]);
    useApp.setState({ quickModelIdsByProfile: { p2: ['opus'] } });

    // Not curated is not the same as "pinned nothing": a user who has never
    // opened settings must still get a usable picker.
    expect(paneQuickModelIds(paneState(focusedPane()))).toEqual([]);
    expect(quickModels(paneState(focusedPane())).length).toBeGreaterThan(0);
  });

  it('editing one profile leaves the other alone', () => {
    booted(['fable']);
    useApp.setState({ quickModelIdsByProfile: { p1: ['fable'], p2: ['opus'] } });

    setQuickModels(['opus[1m]']);

    expect(useApp.getState().quickModelIdsByProfile['p1']).toEqual(['opus[1m]']);
    expect(useApp.getState().quickModelIdsByProfile['p2']).toEqual(['opus']);
  });

  it('emptying a shortlist drops the key rather than storing an empty array', () => {
    booted(['fable']);

    toggleQuickModel('fable');

    // Both states mean "not curated", and a prefs file carrying an empty array
    // for every profile ever opened would grow without saying anything.
    expect('p1' in useApp.getState().quickModelIdsByProfile).toBe(false);
  });

  it('a pane with no profile cannot strand pins under a null key', () => {
    booted(['fable']);
    setPaneState(focusedPane(), { activeProfileId: null });

    toggleQuickModel('opus');

    expect(useApp.getState().quickModelIdsByProfile['p1']).toEqual(['fable']);
    expect(Object.keys(useApp.getState().quickModelIdsByProfile)).toEqual(['p1']);
  });
});
