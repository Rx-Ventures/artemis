import { delimiter } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loginShellProbe, mergePaths, parseShellPathOutput, wellKnownBinDirs } from './shellPath';

/** An `exists` for {@link loginShellProbe}: only these paths are installed. */
const installed =
  (...paths: readonly string[]) =>
  (path: string): boolean =>
    paths.includes(path);

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

describe('wellKnownBinDirs', () => {
  it('offers Homebrew on macOS and the Linux package roots on Linux', () => {
    expect(wellKnownBinDirs('darwin', '/Users/ada')).toContain('/opt/homebrew/bin');
    const linux = wellKnownBinDirs('linux', '/home/ada');
    expect(linux).not.toContain('/opt/homebrew/bin');
    expect(linux).toContain('/home/ada/.local/bin');
    expect(linux).toContain('/var/lib/flatpak/exports/bin');
    expect(linux).toContain('/home/ada/.local/share/flatpak/exports/bin');
    expect(linux).toContain('/home/linuxbrew/.linuxbrew/bin');
  });

  it('builds every home-relative entry from the home it is given', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const dir of wellKnownBinDirs(platform, '/home/ada')) {
        if (dir.includes('ada')) expect(dir.startsWith('/home/ada/')).toBe(true);
      }
    }
  });
});

describe('loginShellProbe', () => {
  it('asks $SHELL when it is one it understands and the binary is there', () => {
    expect(
      loginShellProbe('linux', { SHELL: '/usr/bin/zsh' }, installed('/usr/bin/zsh')),
    ).toEqual({ file: '/usr/bin/zsh', args: ['-i', '-l', '-c', 'printf "%s" "$PATH"'] });
  });

  /*
   * A fish `$PATH` is a list, so the sh-like `printf "%s" "$PATH"` would join
   * it with spaces and hand back one absurd directory. Fish gets fish's own
   * spelling — and it matters most on exactly the distros this pass is for.
   */
  it('asks fish in fish, not in sh', () => {
    const probe = loginShellProbe('linux', { SHELL: '/usr/bin/fish' }, installed('/usr/bin/fish'));
    expect(probe).toEqual({
      file: '/usr/bin/fish',
      args: ['-i', '-l', '-c', 'string join : $PATH'],
    });
  });

  /*
   * The bug this function was extracted to fix. `$SHELL` is a shell we have no
   * probe for, and the old code fell back to `/bin/zsh` on every platform —
   * which on a stock Fedora or Ubuntu box is not installed, so the probe threw
   * and the app adopted no PATH at all.
   */
  it('falls past an unknown $SHELL to a shell the machine actually has', () => {
    const probe = loginShellProbe(
      'linux',
      { SHELL: '/usr/bin/nu' },
      installed('/bin/sh'), // no bash, no zsh — a minimal image, or NixOS
    );
    expect(probe?.file).toBe('/bin/sh');
  });

  it('falls past a $SHELL that is named but not installed', () => {
    const probe = loginShellProbe('linux', { SHELL: '/usr/bin/fish' }, installed('/bin/bash'));
    expect(probe?.file).toBe('/bin/bash');
  });

  it('prefers zsh on macOS and bash on Linux when $SHELL says nothing', () => {
    const everywhere = installed('/bin/zsh', '/bin/bash', '/bin/sh');
    expect(loginShellProbe('darwin', {}, everywhere)?.file).toBe('/bin/zsh');
    expect(loginShellProbe('linux', {}, everywhere)?.file).toBe('/bin/bash');
    expect(loginShellProbe('linux', { SHELL: '' }, everywhere)?.file).toBe('/bin/bash');
  });

  /*
   * Not an error: a container can genuinely have no shell. The caller still
   * has the well-known directories, and says so rather than throwing.
   */
  it('returns null when no shell on the machine can be asked', () => {
    expect(loginShellProbe('linux', { SHELL: '/usr/bin/fish' }, installed())).toBeNull();
  });
});
