import { describe, expect, it } from 'vitest';

import { mergePaths, parseShellPathOutput } from './shellPath';

describe('parseShellPathOutput', () => {
  it('takes the last line, surviving rc-file chatter above it', () => {
    const output = 'Welcome back!\nnvm loaded\n/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin\n';
    expect(parseShellPathOutput(output)).toBe('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin');
  });

  it('rejects output whose last line is not path-shaped', () => {
    expect(parseShellPathOutput('zsh: command not found: printf-oops')).toBeNull();
    expect(parseShellPathOutput('')).toBeNull();
    expect(parseShellPathOutput('\n\n')).toBeNull();
  });
});

describe('mergePaths', () => {
  it('leads with the login PATH, keeps existing entries, fills gaps from fallbacks', () => {
    expect(
      mergePaths('/a:/b', '/usr/bin:/b', ['/fallback', '/a']),
    ).toBe('/a:/b:/usr/bin:/fallback');
  });

  it('degrades to current + fallbacks when the shell gave nothing', () => {
    expect(mergePaths(null, '/usr/bin:/bin', ['/opt/homebrew/bin'])).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin',
    );
  });

  it('never produces empty segments', () => {
    expect(mergePaths('/a::/b', '', ['/c'])).toBe('/a:/b:/c');
  });
});
