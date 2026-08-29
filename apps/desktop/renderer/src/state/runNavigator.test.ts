/**
 * @vitest-environment jsdom
 *
 * The run navigator's state logic: which columns are revealed, which footer
 * toggles exist, and which model rows a query shows.
 *
 * These are the rules the surface renders from (`RunNavigator.tsx`), held to
 * account without mounting a menu — column reveal is "picks landing", not
 * clicks, so it is a pure function of the pane and testable as one. The
 * component tests next door (`capability-gating.test.tsx` and the profile
 * picker suites) cover the same rules through the DOM.
 *
 * Same caveat as `cwd.test.ts`: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type {
  Capabilities,
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderModelOption,
} from '@rx-artemis/protocol';

import { activeModel, quickModels } from './store';
import { appSession, capabilities, seedApp } from './testkit';
import {
  hiddenModelCount,
  navigatorColumns,
  navigatorFooter,
  navigatorModelRows,
} from './runNavigator';

const MODELS: readonly ProviderModelOption[] = [
  {
    id: 'fable',
    label: 'Fable 5',
    resolvedModel: 'claude-fable-5',
    note: '',
    supportsFastMode: true,
    supportsUltracode: true,
  },
  { id: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5', note: '' },
  { id: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001', note: '' },
];

const EFFORTS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: '' },
  { id: 'high', label: 'High', note: '' },
];

function provider(extra?: Partial<ProviderDescriptor>, caps?: Partial<Capabilities>): ProviderDescriptor {
  return {
    id: 'claude',
    label: 'Claude',
    capabilities: capabilities(caps),
    models: MODELS,
    effortLevels: EFFORTS,
    available: true,
    ...extra,
  };
}

function seed(overrides: Parameters<typeof seedApp>[0] = {}): void {
  seedApp({
    providers: [provider()],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/u/.claude' }],
    activeProfileId: 'p1',
    models: [],
    model: null,
    effort: null,
    fastMode: false,
    ultracode: false,
    run: null,
    quickModelIdsByProfile: {},
    ...overrides,
  });
}

beforeEach(() => seed());

/* -------------------------------------------------------------------------- */
/* Column reveal                                                              */
/* -------------------------------------------------------------------------- */

describe('column reveal', () => {
  it('reveals all three columns once profile and model picks have landed', () => {
    // The ordinary state: a pane opened with a profile and model already
    // chosen shows everything — those picks landed long ago.
    expect(navigatorColumns(appSession())).toEqual({ model: true, effort: true });
  });

  it('shows only the profile column while no profile is picked', () => {
    seed({ activeProfileId: null });
    expect(navigatorColumns(appSession())).toEqual({ model: false, effort: false });
  });

  it('reveals the model column even when the catalogue is empty', () => {
    // Revealed-but-dead: the column carries the disabled-with-reason sentence.
    // Hiding it would break the rule every degraded control follows.
    seed({ providers: [provider({ models: [] })] });
    expect(navigatorColumns(appSession()).model).toBe(true);
  });

  it('withholds the effort column when the catalogue is empty', () => {
    // No model resolves, so no model pick has landed — there is no ladder to
    // narrow and nothing for a rung to describe.
    seed({ providers: [provider({ models: [] })] });
    expect(navigatorColumns(appSession()).effort).toBe(false);
  });

  it('withholds the effort column on a provider with no effort scale', () => {
    // The old model popover's carve-out, kept: absent rather than
    // present-and-dead, because there is nothing for a reason to attach to.
    seed({ providers: [provider({ effortLevels: [] })] });
    expect(navigatorColumns(appSession()).effort).toBe(false);
  });

  it('withholds the effort column for a model that takes no effort setting', () => {
    seed({
      providers: [
        provider({
          models: [{ id: 'sonnet', label: 'Sonnet', note: '', effortLevels: [] }],
        }),
      ],
      model: 'sonnet',
    });
    expect(navigatorColumns(appSession()).effort).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Footer gating                                                              */
/* -------------------------------------------------------------------------- */

describe('footer gating', () => {
  it('offers fast mode when the picked model supports it', () => {
    seed({ model: 'fable' });
    expect(navigatorFooter(appSession()).fastMode).toBe('offered');
  });

  it('disables fast mode on a model without it, so switching lights it up', () => {
    seed({ model: 'sonnet' });
    expect(navigatorFooter(appSession()).fastMode).toBe('disabled');
  });

  it('drops the switch entirely when no model of the provider has the concept', () => {
    // The narrow carve-out from "never hide a control": a permanently dead
    // switch could never light up and teaches nothing.
    seed({
      providers: [
        provider({ models: [{ id: 'sonnet', label: 'Sonnet', note: '' }] }),
      ],
    });
    expect(navigatorFooter(appSession()).fastMode).toBe('absent');
  });

  it('never shows the flag as on when the run would ignore it', () => {
    // Preference survives; the display does not lie. Same `on && available`
    // expression as the chip's zap, so the two cannot disagree.
    seed({ model: 'sonnet', fastMode: true });
    expect(navigatorFooter(appSession()).fastModeOn).toBe(false);

    seed({ model: 'fable', fastMode: true });
    expect(navigatorFooter(appSession()).fastModeOn).toBe(true);
  });

  it('lists exactly the permission modes the provider accepts', () => {
    seed({ providers: [provider(undefined, { permissionModes: ['plan', 'default'] })] });
    expect(navigatorFooter(appSession()).permissionModes).toEqual(['plan', 'default']);
  });

  it('reports no permission control when the concept does not apply', () => {
    seed({ providers: [provider(undefined, { ...NO_CAPABILITIES })] });
    expect(navigatorFooter(appSession()).permissionModes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The model column's rows                                                    */
/* -------------------------------------------------------------------------- */

describe('navigatorModelRows', () => {
  it('lists the pins when nothing is typed', () => {
    seed({ quickModelIdsByProfile: { p1: ['sonnet'] } });
    const s = appSession();
    const rows = navigatorModelRows(MODELS, quickModels(s), activeModel(s), '');
    // Fable is appended despite not being pinned: it is the selected model
    // (the catalogue's first entry, with no stored preference), and a radio
    // group whose value names no row paints no check.
    expect(rows.map((m) => m.id)).toEqual(['sonnet', 'fable']);
  });

  it('stands the whole catalogue in for an uncurated shortlist', () => {
    const s = appSession();
    const rows = navigatorModelRows(MODELS, quickModels(s), activeModel(s), '');
    expect(rows.map((m) => m.id)).toEqual(['fable', 'sonnet', 'haiku']);
  });

  it('searches the whole catalogue, not the shortlist', () => {
    // A shortlist you have to search is not a search: the box exists to reach
    // the models the pins left out.
    seed({ quickModelIdsByProfile: { p1: ['fable'] } });
    const s = appSession();
    const rows = navigatorModelRows(MODELS, quickModels(s), activeModel(s), 'haiku');
    expect(rows.map((m) => m.id)).toEqual(['haiku']);
  });

  it('finds a model by its wire id as well as its name', () => {
    const rows = navigatorModelRows(MODELS, MODELS, undefined, 'claude-sonnet-5');
    expect(rows.map((m) => m.id)).toEqual(['sonnet']);
  });

  it('returns nothing rather than everything for a query with no match', () => {
    expect(navigatorModelRows(MODELS, MODELS, undefined, 'gpt')).toEqual([]);
  });
});

describe('hiddenModelCount', () => {
  it('counts what the shortlist is not showing', () => {
    expect(hiddenModelCount(10, 3)).toBe(7);
  });

  it('never goes negative when the search shows more than the shortlist held', () => {
    expect(hiddenModelCount(3, 3)).toBe(0);
    expect(hiddenModelCount(2, 3)).toBe(0);
  });
});
