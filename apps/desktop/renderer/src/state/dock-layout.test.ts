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
  MAX_RESTORED_TERMINALS,
  parseDockLayout,
} from './dock';

describe('parseDockLayout', () => {
  it('reads a layout this build wrote', () => {
    const layout = parseDockLayout({
      browsers: ['https://example.com', 'http://localhost:3000'],
      terminals: 2,
      file: 'src/store.ts',
      preview: 'out/report.html',
      activeKind: 'terminal',
    });

    expect(layout).toEqual({
      browsers: ['https://example.com', 'http://localhost:3000'],
      terminals: 2,
      file: 'src/store.ts',
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

  it.each(['preview', 'file', 'terminal', 'browser', 'tasks', 'agent'])(
    'accepts %s as a tab kind',
    (kind) => {
      expect(parseDockLayout({ activeKind: kind }).activeKind).toBe(kind);
    },
  );

  it('treats an empty path as no path', () => {
    const layout = parseDockLayout({ file: '', preview: '' });

    expect(layout.file).toBeNull();
    expect(layout.preview).toBeNull();
  });

  it('keeps the fields it understands when others are broken', () => {
    // A partially-corrupt layout should not cost the parts that are fine.
    const layout = parseDockLayout({ browsers: 'not-an-array', terminals: 1, file: 'a.ts' });

    expect(layout.browsers).toEqual([]);
    expect(layout.terminals).toBe(1);
    expect(layout.file).toBe('a.ts');
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
