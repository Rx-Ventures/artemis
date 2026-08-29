/**
 * What survives a restart, and what deliberately does not.
 *
 * The design claim under test is that the dock stores an *arrangement* rather
 * than a session: a browser is a URL and comes back as the same page, a
 * terminal is a live process and comes back as a count of empty shells. Most of
 * these exist to keep the second half honest, and the rest to keep a
 * hand-edited preferences file from doing anything alarming at launch.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_DOCK_LAYOUT,
  MAX_RESTORED_BROWSERS,
  MAX_RESTORED_FILES,
  MAX_RESTORED_TERMINALS,
  MAX_STORED_ARRANGEMENTS,
  parseDockArrangements,
  parseDockLayout,
  type DockTab,
} from './dock';

describe('parseDockLayout', () => {
  it('reads a layout this build wrote', () => {
    const layout = parseDockLayout({
      browsers: ['https://example.com', 'http://localhost:3000'],
      terminals: 2,
      files: ['src/store.ts', 'src/dock.ts'],
      preview: 'out/report.html',
      activeKind: 'terminal',
    });

    expect(layout).toEqual({
      browsers: ['https://example.com', 'http://localhost:3000'],
      terminals: 2,
      files: ['src/store.ts', 'src/dock.ts'],
      preview: 'out/report.html',
      activeKind: 'terminal',
    });
  });

  it.each([
    ['nothing at all', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['an empty object', {}],
  ])('restores nothing from %s', (_label, value) => {
    // Which is the state the app was in before any of this existed — never a
    // reason to fail a launch.
    expect(parseDockLayout(value)).toEqual(EMPTY_DOCK_LAYOUT);
  });

  it('drops browser entries that are not usable urls', () => {
    const layout = parseDockLayout({ browsers: ['https://ok.example', '', 42, null] });

    expect(layout.browsers).toEqual(['https://ok.example']);
  });

  it('SAFETY: clamps a terminal count, so a typo cannot spawn a thousand shells', () => {
    // Reopening happens before the user can intervene, which is the whole
    // reason there is a ceiling rather than trust.
    expect(parseDockLayout({ terminals: 9999 }).terminals).toBe(MAX_RESTORED_TERMINALS);
    expect(parseDockLayout({ browsers: Array(500).fill('https://x.example') }).browsers).toHaveLength(
      MAX_RESTORED_BROWSERS,
    );
  });

  it.each([
    ['negative', -3],
    ['fractional', 2.7],
    ['not a number', 'two'],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a %s terminal count', (_label, terminals) => {
    const parsed = parseDockLayout({ terminals }).terminals;

    expect(Number.isInteger(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(0);
    expect(parsed).toBeLessThanOrEqual(MAX_RESTORED_TERMINALS);
  });

  it('rounds a fractional count down rather than to the nearest', () => {
    expect(parseDockLayout({ terminals: 2.9 }).terminals).toBe(2);
  });

  it('ignores a tab kind that is not one', () => {
    // A stored kind from a future build, or a typo. Null puts nothing in front,
    // which `reconcileDock` already knows how to handle.
    expect(parseDockLayout({ activeKind: 'wormhole' }).activeKind).toBeNull();
    expect(parseDockLayout({ activeKind: 7 }).activeKind).toBeNull();
  });

  /*
   * A `Record` over the union rather than a list copied from `dock.ts`, so the
   * next kind added to `DockTab` fails this file at compile time instead of
   * failing the user at restore time. That is exactly how `'files'` slipped
   * through: `captureDockLayout` wrote whatever kind was in front, the
   * validator only knew the kinds it was born with, and a layout saved with
   * the folder browser in front restored with nothing in front at all.
   */
  const EVERY_TAB_KIND: Record<DockTab['kind'], true> = {
    preview: true,
    file: true,
    files: true,
    terminal: true,
    browser: true,
    tasks: true,
    agent: true,
  };

  it.each(Object.keys(EVERY_TAB_KIND))(
    'round-trips %s as a stored active kind',
    (kind) => {
      expect(parseDockLayout({ activeKind: kind }).activeKind).toBe(kind);
    },
  );

  it('treats an empty path as no path', () => {
    const layout = parseDockLayout({ files: ['', 'real.ts', ''], preview: '' });

    expect(layout.files).toEqual(['real.ts']);
    expect(layout.preview).toBeNull();
  });

  it('bounds how many files a launch will reopen', () => {
    // Not a guess at what is reasonable. This is the one list a hand-edited
    // preferences file can make the app read from disk before anyone can
    // intervene.
    const layout = parseDockLayout({
      files: Array.from({ length: 40 }, (_unused, index) => `f${String(index)}.ts`),
    });

    expect(layout.files).toHaveLength(MAX_RESTORED_FILES);
  });

  it('keeps the fields it understands when others are broken', () => {
    // A partially-corrupt layout should not cost the parts that are fine.
    const layout = parseDockLayout({ browsers: 'not-an-array', terminals: 1, files: ['a.ts'] });

    expect(layout.browsers).toEqual([]);
    expect(layout.terminals).toBe(1);
    expect(layout.files).toEqual(['a.ts']);
  });

  it('ARRANGEMENT: stores no terminal titles, because a restored shell is not the old one', () => {
    // A tab that says `vim` and holds a fresh `zsh` is a claim; a count is a
    // fact. The type has nowhere to put a title, and that is deliberate.
    const layout = parseDockLayout({
      terminals: 3,
      terminalTitles: ['vim', 'pnpm dev', 'zsh'],
    } as Record<string, unknown>);

    expect(layout).not.toHaveProperty('terminalTitles');
    expect(layout.terminals).toBe(3);
  });
});

/*
 * The per-session map — the shape ADR 0002's restart rule persists through.
 * Each entry is a `DockLayout` and inherits every guard above; what is new is
 * the map itself, which is one more thing a hand-edited preferences file gets
 * to be wrong about, and one more list that must not grow without bound.
 */
describe('parseDockArrangements', () => {
  it('reads a map this build wrote, entry by entry', () => {
    const map = parseDockArrangements({
      'sess-a': { browsers: ['https://a.example'], terminals: 1, files: [], preview: null, activeKind: 'terminal' },
      'sess-b': { browsers: [], terminals: 0, files: ['notes.md'], preview: null, activeKind: null },
    });

    expect(Object.keys(map)).toEqual(['sess-a', 'sess-b']);
    expect(map['sess-a']?.terminals).toBe(1);
    expect(map['sess-b']?.files).toEqual(['notes.md']);
  });

  it.each([
    ['nothing at all', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['an array', [{ terminals: 3 }]],
  ])('restores nothing from %s', (_label, value) => {
    expect(parseDockArrangements(value)).toEqual({});
  });

  it('drops a malformed entry without costing its neighbours', () => {
    const map = parseDockArrangements({
      'sess-good': { terminals: 2 },
      'sess-bad': 'not-a-layout',
    });

    // The bad entry parses to an empty layout, and an empty layout restores
    // nothing — storing it would only crowd real entries out of the cap.
    expect(Object.keys(map)).toEqual(['sess-good']);
  });

  it('drops entries with nothing to restore', () => {
    const map = parseDockArrangements({
      'sess-empty': { browsers: [], terminals: 0, files: [], preview: null, activeKind: 'terminal' },
    });

    expect(map).toEqual({});
  });

  it('SAFETY: clamps every entry the way the single layout is clamped', () => {
    // The per-session map multiplies the launch-time blast radius of a
    // hostile file by the number of entries, so each entry keeps the same
    // ceilings — and the map itself is capped below.
    const map = parseDockArrangements({ 'sess-a': { terminals: 9999 } });

    expect(map['sess-a']?.terminals).toBe(MAX_RESTORED_TERMINALS);
  });

  it('SAFETY: keeps only the most recent conversations past the cap', () => {
    const grown: Record<string, unknown> = {};
    for (let i = 0; i < MAX_STORED_ARRANGEMENTS + 5; i += 1) {
      grown[`sess-${String(i)}`] = { terminals: 1 };
    }

    const map = parseDockArrangements(grown);

    // Last entries win, because the capture appends most-recently-touched
    // last: the stalest conversations are the ones a bounded map should shed.
    expect(Object.keys(map)).toHaveLength(MAX_STORED_ARRANGEMENTS);
    expect(map['sess-0']).toBeUndefined();
    expect(map[`sess-${String(MAX_STORED_ARRANGEMENTS + 4)}`]).toBeDefined();
  });
});
