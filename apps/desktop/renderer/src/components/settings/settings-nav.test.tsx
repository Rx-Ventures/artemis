/**
 * @vitest-environment jsdom
 *
 * The nav's shape, and the promise that ids are addresses.
 *
 * Two different contracts live in the settings nav and they fail differently,
 * which is why both are pinned here rather than left to review:
 *
 *  1. **The shape** — which bands exist, which sections sit in each, in what
 *     order, under what labels. This is design intent, and the file that
 *     declares it argues every position in comments; a reorder should be a
 *     decision someone makes against this test, not a merge accident.
 *  2. **The resolution map** — every id the app has ever exported as a deep
 *     link (`openSettings('cerebro')`, a persisted `settingsSection`, a
 *     palette row) must keep landing on a pane that exists. A future rename
 *     that forgets the map should break an assertion here, in a file that
 *     explains why, instead of breaking a caller that was never wrong.
 *
 * Same caveat as the sibling component tests: `renderer/tsconfig.json`
 * excludes test files, so the assertions are behavioural.
 */

import { describe, expect, it } from 'vitest';

import { SETTINGS_NAV } from '@/components/settings/SettingsDialog';
import {
  openSettings,
  resolveSettingsSection,
  useApp,
  type SettingsSection,
} from '@/state/store';

/** Every address in the union, spelled out so a new id must be considered here. */
const ALL_SECTIONS: readonly SettingsSection[] = [
  'profiles',
  'models',
  'runs',
  'appearance',
  'browser',
  'permissions',
  'agents',
  'cerebro',
  'server',
  'remote',
  'routines',
  'advanced',
  'about',
];

const navIds = (): readonly SettingsSection[] =>
  SETTINGS_NAV.flatMap((band) => band.sections.map((section) => section.id));

describe('the two-band nav', () => {
  it('is two labelled bands: the settings, then this machine', () => {
    expect(SETTINGS_NAV.map((band) => band.label)).toEqual(['Settings', 'This machine']);
  });

  it('holds the sections in their argued order', () => {
    expect(SETTINGS_NAV.map((band) => band.sections.map((s) => s.id))).toEqual([
      ['profiles', 'models', 'runs', 'agents', 'permissions', 'appearance'],
      // Remote directly under Server: the same grant model, mirrored — one
      // pane lends this machine out, the next borrows another one. About is
      // last of everything: it is the only pane that decides nothing, and the
      // bottom of the list is where people look for it unprompted.
      ['server', 'remote', 'routines', 'advanced', 'about'],
    ]);
  });

  it('labels the renamed panes without renaming their ids', () => {
    const labels = new Map(
      SETTINGS_NAV.flatMap((band) => band.sections.map((s) => [s.id, s.label] as const)),
    );
    // The label moved; the address did not. That asymmetry is the whole design.
    expect(labels.get('agents')).toBe('Instructions');
    expect(labels.get('permissions')).toBe('Permissions & access');
    expect(labels.get('advanced')).toBe('This machine');
  });

});

describe('ids are frozen addresses', () => {
  it('resolves every address to a pane the nav actually shows', () => {
    const shown = new Set(navIds());
    for (const id of ALL_SECTIONS) {
      expect(shown.has(resolveSettingsSection(id))).toBe(true);
    }
  });

  it('sends the historical addresses to their merged homes', () => {
    // The browser switches are permission questions now; the banks are the
    // instance half of Instructions. Everything else answers for itself.
    expect(resolveSettingsSection('browser')).toBe('permissions');
    expect(resolveSettingsSection('cerebro')).toBe('agents');
    for (const id of ALL_SECTIONS) {
      if (id === 'browser' || id === 'cerebro') continue;
      expect(resolveSettingsSection(id)).toBe(id);
    }
  });

  it('never lists a historical address as a nav row', () => {
    // One room, one door: the old ids resolve, they do not duplicate.
    const ids = navIds();
    expect(ids).not.toContain('browser');
    expect(ids).not.toContain('cerebro');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('openSettings, aimed at an address', () => {
  it('opens the resolved pane, not the address', () => {
    openSettings('cerebro');
    expect(useApp.getState().screen).toBe('profiles');
    expect(useApp.getState().settingsSection).toBe('agents');
  });

  it('carries a row anchor when given one, and drops it when not', () => {
    openSettings('models', { row: 'quick-access' });
    expect(useApp.getState().settingsRow).toBe('quick-access');

    // A plain reopen must not inherit the old intention: the anchor describes
    // one click, not a preference.
    openSettings();
    expect(useApp.getState().settingsRow).toBeNull();
  });
});
