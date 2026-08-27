import { delimiter } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mergePaths, parseShellPathOutput } from './shellPath';

/**
 * A PATH in this platform's spelling.
 *
 * `mergePaths` splits and joins on `path.delimiter`, which is the right
 * separator on every platform and is `;` rather than `:` on one of them. The
 * directories stay POSIX because the claims below are about order and dedupe,
 * not about what a directory is called.
 */
const PATH = (...dirs: readonly string[]): string => dirs.join(delimiter);

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
      mergePaths(PATH('/a', '/b'), PATH('/usr/bin', '/b'), ['/fallback', '/a']),
    ).toBe(PATH('/a', '/b', '/usr/bin', '/fallback'));
  });

  it('degrades to current + fallbacks when the shell gave nothing', () => {
    expect(mergePaths(null, PATH('/usr/bin', '/bin'), ['/opt/homebrew/bin'])).toBe(
      PATH('/usr/bin', '/bin', '/opt/homebrew/bin'),
    );
  });

  it('never produces empty segments', () => {
    expect(mergePaths(PATH('/a', '', '/b'), '', ['/c'])).toBe(PATH('/a', '/b', '/c'));
  });
});
