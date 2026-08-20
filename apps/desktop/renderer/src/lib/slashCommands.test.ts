/**
 * Slash command matching.
 * ============================================================================
 *
 * The ranking is the whole point of the module, so most of this is about order
 * rather than membership. The case that drove the design is `/cer` finding
 * `artemis-skills:cerebro`: bridged commands are prefixed, the bare name is
 * refused by the provider, and nobody types `artemis-skills:` — so a matcher
 * that only anchored at the head would make every bridged command unreachable.
 */

import { describe, expect, it } from 'vitest';

import { applySlashCommand, matchSlashCommands, SLASH_RANKS } from './slashCommands';

/** The real shape of the list: built-ins alongside bridged, prefixed entries. */
const COMMANDS = [
  'compact',
  'clear',
  'review',
  'artemis-skills:cerebro',
  'artemis-skills:use-railway',
];

const names = (draft: string, commands: readonly string[] = COMMANDS): readonly string[] =>
  (matchSlashCommands(commands, draft)?.matches ?? []).map((m) => m.name);

describe('matchSlashCommands', () => {
  describe('when the menu opens', () => {
    it('offers everything for a bare slash', () => {
      expect(names('/')).toHaveLength(COMMANDS.length);
      expect(matchSlashCommands(COMMANDS, '/')?.query).toBe('');
    });

    it('stays shut for prose that merely contains a slash', () => {
      expect(matchSlashCommands(COMMANDS, 'fix /this typo')).toBeNull();
      expect(matchSlashCommands(COMMANDS, 'and/or')).toBeNull();
    });

    it('closes once the name is complete and arguments begin', () => {
      // The space is the boundary: past it the user is writing arguments, and a
      // menu over their sentence is in the way.
      expect(matchSlashCommands(COMMANDS, '/compact ')).toBeNull();
      expect(matchSlashCommands(COMMANDS, '/artemis-skills:cerebro what changed')).toBeNull();
    });

    it('stays shut when the provider reported no commands', () => {
      // Codex: no user-authored command surface, so nothing to offer and no
      // check needed at the call site.
      expect(matchSlashCommands(undefined, '/c')).toBeNull();
      expect(matchSlashCommands([], '/c')).toBeNull();
    });

    it('closes rather than showing an empty box when nothing matches', () => {
      expect(matchSlashCommands(COMMANDS, '/zzzz')).toBeNull();
    });
  });

  describe('ranking', () => {
    it('finds a bridged command by the name the user knows', () => {
      // The case the ranking exists for.
      expect(names('/cer')).toEqual(['artemis-skills:cerebro']);
    });

    it('puts a full-name prefix above a segment match', () => {
      const matches = matchSlashCommands(['artemis-skills:cerebro', 'artemis-tool'], '/artemis')!;
      expect(matches.matches.map((m) => m.rank)).toEqual([
        SLASH_RANKS.fullPrefix,
        SLASH_RANKS.fullPrefix,
      ]);
    });

    it('puts a segment prefix above a loose substring hit', () => {
      const matches = matchSlashCommands(['artemis-skills:railway', 'derail-something'], '/rail')!;
      expect(matches.matches.map((m) => [m.name, m.rank])).toEqual([
        ['artemis-skills:railway', SLASH_RANKS.segmentPrefix],
        ['derail-something', SLASH_RANKS.contains],
      ]);
    });

    it('sorts equal ranks by the part being read, not by the prefix', () => {
      // Sorting on the full name would file every bridged command under `a`,
      // which is the prefix's fault and not the reader's problem.
      expect(names('/')).toEqual([
        'artemis-skills:cerebro',
        'clear',
        'compact',
        'review',
        'artemis-skills:use-railway',
      ]);
    });

    it('is case-insensitive', () => {
      expect(names('/CER')).toEqual(['artemis-skills:cerebro']);
      expect(names('/Compact')).toEqual(['compact']);
    });
  });

  describe('labelling', () => {
    it('splits a prefixed name into what to read and where it came from', () => {
      const [match] = matchSlashCommands(COMMANDS, '/cer')!.matches;
      expect(match).toMatchObject({
        name: 'artemis-skills:cerebro',
        label: 'cerebro',
        prefix: 'artemis-skills',
      });
    });

    it('leaves a built-in without a prefix', () => {
      const [match] = matchSlashCommands(COMMANDS, '/compact')!.matches;
      expect(match!.label).toBe('compact');
      expect(match!.prefix).toBeUndefined();
    });
  });

  it('inserts the canonical name and a space, so the menu closes', () => {
    const draft = applySlashCommand('artemis-skills:cerebro');
    expect(draft).toBe('/artemis-skills:cerebro ');
    // The trailing space is what makes Enter send on the next press rather than
    // re-accepting the highlighted row.
    expect(matchSlashCommands(COMMANDS, draft)).toBeNull();
  });
});
