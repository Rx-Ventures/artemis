/**
 * Confining a command on whichever platform this is.
 *
 * The binary probe is injected, which is the only reason the Linux path can be
 * exercised from a machine that is not Linux. What that buys is real but
 * limited: these prove the *policy* is right — which flags, which refusals —
 * not that bubblewrap confines anything. Only the macOS backend has been driven.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BACKENDS,
  backendFor,
  BUBBLEWRAP,
  describeConfinement,
  resolveSandbox,
  SEATBELT,
  seatbeltProfile,
  WINDOWS_UNCONFINED,
  wrapCommand,
} from '../commandSandbox.js';

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

describe('choosing a backend', () => {
  it.each([
    ['darwin', SEATBELT],
    ['linux', BUBBLEWRAP],
    ['win32', WINDOWS_UNCONFINED],
  ] as const)('has one for %s', (platform, expected) => {
    expect(backendFor(platform)).toBe(expected);
  });

  it('has none for a platform nobody wrote one for', () => {
    expect(backendFor('freebsd')).toBeUndefined();
  });

  it('says which backends are unproven, rather than treating them as equal', () => {
    // A sandbox written from documentation can fail *open*, which is a heavier
    // risk than an unverified model list.
    expect(BUBBLEWRAP.verification).toBe('unverified');
    expect(SEATBELT.verification).toBe('verified');
  });
});

describe('resolveSandbox', () => {
  it('confines on macOS when sandbox-exec is present', async () => {
    expect(await resolveSandbox('darwin', yes)).toMatchObject({ confinement: 'workspace' });
  });

  it('MACHINE: a Linux box without bwrap cannot confine, platform notwithstanding', async () => {
    // The platform says what is possible; the probe says what is installed.
    expect(await resolveSandbox('linux', no)).toMatchObject({ confinement: 'none' });
    expect(await resolveSandbox('linux', yes)).toMatchObject({ confinement: 'workspace' });
  });

  it('WINDOWS: never claims confinement, because nothing shipped can provide it', async () => {
    // Job objects and restricted tokens need native code. Claiming otherwise
    // would be the one lie a security boundary must not tell.
    expect(await resolveSandbox('win32', yes)).toMatchObject({ confinement: 'none' });
  });

  it('an unwritten platform confines nothing', async () => {
    expect(await resolveSandbox('freebsd', yes)).toEqual({ backend: undefined, confinement: 'none' });
  });
});

describe('wrapCommand', () => {
  it('REFUSAL: returns null whenever nothing can confine, so the caller must refuse', async () => {
    // The whole safety property. Returning a bare command would make an
    // unconfined execution indistinguishable from a confined one.
    for (const resolved of [
      await resolveSandbox('win32', yes),
      await resolveSandbox('linux', no),
      await resolveSandbox('freebsd', yes),
    ]) {
      expect(await wrapCommand(resolved, 'echo hi', process.cwd())).toBeNull();
    }
  });

  // Not on Windows: `mkdtemp` there hands back a path `realpath` already agrees
  // with, so nothing would be resolved, and the profile escapes the separators
  // of the one it names — neither half of the claim can be seen from there.
  it.skipIf(process.platform === 'win32')(
    'SYMLINK: resolves the workspace, which is what makes writes work at all',
    async () => {
      const given = await mkdtemp(path.join(tmpdir(), 'artemis-cs-'));
      const real = await realpath(given);

      try {
        const argv = await wrapCommand(await resolveSandbox('darwin', yes), 'echo hi', given);

        // Seatbelt matches the real path; naming the unresolved one denies every
        // write and looks like nothing is wrong.
        expect(argv?.join(' ')).toContain(real);
        expect(argv?.[0]).toBe('/usr/bin/sandbox-exec');
        expect(argv?.at(-1)).toBe('echo hi');
      } finally {
        await rm(given, { recursive: true, force: true });
      }
    },
  );

  it('passes the command through unaltered, rather than quoting it into a new one', async () => {
    const argv = await wrapCommand(await resolveSandbox('darwin', yes), 'ls "a b" | wc -l', process.cwd());

    expect(argv?.at(-1)).toBe('ls "a b" | wc -l');
  });
});

describe('the Seatbelt profile', () => {
  it('denies everything before allowing anything', () => {
    const profile = seatbeltProfile(['/work']);

    expect(profile.indexOf('(deny default)')).toBeLessThan(profile.indexOf('(allow'));
  });

  it('NETWORK: grants none', () => {
    expect(seatbeltProfile(['/work'])).not.toContain('network');
  });

  it('SCOPE: grants no blanket temp access — a check found what that let escape', () => {
    // `/var/folders` holds every per-user temp dir on macOS, so allowing it
    // wholesale made another application's scratch space writable and let a
    // command leave the workspace. Found by `pnpm sandbox:check`.
    const profile = seatbeltProfile(['/work/project']);

    expect(profile).not.toContain('/private/var/folders');
    expect(profile).not.toContain('(subpath "/private/tmp")');
  });

  it('grants writes under every root it was given, and no others', () => {
    const profile = seatbeltProfile(['/work/project', '/scratch/run-1']);

    expect(profile).toContain('(allow file-write* (subpath "/work/project"))');
    expect(profile).toContain('(allow file-write* (subpath "/scratch/run-1"))');
  });

  it('grants writes only under the root it was given', () => {
    expect(seatbeltProfile(['/work/project'])).toContain('(allow file-write* (subpath "/work/project"))');
  });

  it('escapes a quote rather than ending the literal early', () => {
    expect(seatbeltProfile(['/work/we"rd'])).toContain('we\\"rd');
  });
});

describe('the bubblewrap invocation — UNVERIFIED', () => {
  const argv = BUBBLEWRAP.wrap('npm test', ['/work/project']);

  it('NETWORK: unshares it, which is the load-bearing flag', () => {
    expect(argv).toContain('--unshare-net');
  });

  it('binds the whole filesystem read-only and the workspace writable', () => {
    const line = argv.join(' ');

    expect(line).toContain('--ro-bind / /');
    expect(line).toContain('--bind /work/project /work/project');
  });

  it('dies with its parent, so a command cannot outlive the run', () => {
    // Without this a command nobody is watching keeps running after the user
    // has stopped the turn.
    expect(argv).toContain('--die-with-parent');
  });

  it('runs in the workspace and passes the command through', () => {
    expect(argv.slice(-5)).toEqual(['--chdir', '/work/project', '/bin/sh', '-c', 'npm test']);
  });
});

describe('describeConfinement', () => {
  it('says what is protecting the user when something is', async () => {
    const text = describeConfinement(await resolveSandbox('darwin', yes));

    expect(text).toContain('Seatbelt');
    expect(text).toMatch(/network blocked/);
  });

  it('WARNS the user when the backend is unproven, not just the code reader', async () => {
    const text = describeConfinement(await resolveSandbox('linux', yes));

    expect(text).toMatch(/not been verified/);
    expect(text).toMatch(/unproven/);
  });

  it('tells a Linux user the fix is to install bwrap', async () => {
    expect(describeConfinement(await resolveSandbox('linux', no))).toMatch(/Install it/);
  });

  it('tells a Windows user why, rather than leaving it mysterious', async () => {
    expect(describeConfinement(await resolveSandbox('win32', yes))).toMatch(/native code/);
  });

  it('covers every backend that exists', () => {
    expect(BACKENDS.map((b) => b.platform)).toEqual(['darwin', 'linux', 'win32']);
  });
});
