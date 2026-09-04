import { describe, expect, it } from 'vitest';

import { COMMANDS, completeCommand, parseCommand } from './commands.js';

describe('parseCommand', () => {
  it('recognises every listed command by name', () => {
    for (const spec of COMMANDS) {
      expect(parseCommand(`/${spec.name}`)).toEqual({ name: spec.name, args: '' });
    }
  });

  it('keeps arguments, trimmed, with their case', () => {
    expect(parseCommand('/model  Fable  ')).toEqual({ name: 'model', args: 'Fable' });
    expect(parseCommand('/mode plan')).toEqual({ name: 'mode', args: 'plan' });
  });

  it('is case-insensitive on the word and tolerates leading whitespace', () => {
    expect(parseCommand('  /QUIT')).toEqual({ name: 'quit', args: '' });
  });

  it('resolves aliases', () => {
    expect(parseCommand('/exit')?.name).toBe('quit');
    expect(parseCommand('/q')?.name).toBe('quit');
    expect(parseCommand('/?')?.name).toBe('help');
    expect(parseCommand('/account')?.name).toBe('profile');
  });

  it("leaves messages and the provider's own slash commands alone", () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/compact')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/ model')).toBeNull();
    expect(parseCommand('a /model')).toBeNull();
  });
});

describe('completeCommand', () => {
  it('lists everything for an empty prefix and narrows by name', () => {
    expect(completeCommand('')).toHaveLength(COMMANDS.length);
    expect(completeCommand('/mo').map((command) => command.name)).toEqual(['model', 'mode']);
    expect(completeCommand('zzz')).toEqual([]);
  });
});
