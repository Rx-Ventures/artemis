/**
 * Confining a command on whichever platform this is.
 *
 * The binary probe is injected, which is the only reason the Linux path can be
 * exercised from a machine that is not Linux. What that buys is real but
 * limited: these prove the *policy* is right — which flags, which order, which
 * refusals — not that bubblewrap confines anything.
 *
 * That second half is `scripts/sandbox-check.ts`, which CI runs on Linux. The
 * division is not academic: the mount-ordering defect these tests now cover
 * shipped *past* a green suite here, because every flag it looked for was
 * present and only their order was wrong. A unit test can hold the shape of an
 * argv; only a kernel can say what it does.
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
  type ResolvedSandbox,
  type SandboxProbeEnv,
} from '../commandSandbox.js';

/** Everything is installed, and everything it is asked to run works. */
const yes: SandboxProbeEnv = { has: async () => true, succeeds: async () => true };
/** Nothing is installed. `succeeds` is unreachable and says so if reached. */
const no: SandboxProbeEnv = {
  has: async () => false,
  succeeds: async () => {
    throw new Error('a backend must not try to run a binary it could not find');
  },
};
/**
 * The case the old probe could not express: bubblewrap is installed and the
 * kernel will not let it do the thing the policy needs. See BUBBLEWRAP.
 */
const installedButBlocked: SandboxProbeEnv = { has: async () => true, succeeds: async () => false };

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
    // risk than an unverified model list — so the field exists and every
    // backend has to answer it. bubblewrap wore `unverified` until it was
    // driven on 2026-08-31; see the note on BUBBLEWRAP for what that proved
    // and what it did not.
    expect(BUBBLEWRAP.verification).toBe('verified');
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

  /*
   * The gap the old probe had, found by CI rather than by review. A GitHub
   * ubuntu runner has bubblewrap installed and refuses to let it unshare the
   * network — `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` —
   * and `--unshare-net` is the load-bearing flag, so bwrap exits 1 and nothing
   * runs. Probing only for the binary reported `workspace`, handed back an argv
   * that could never work, and turned every shell command into bubblewrap's
   * error text instead of Artemis's refusal.
   */
  it('MACHINE: bwrap installed but unable to unshare is a box that cannot confine', async () => {
    expect(await resolveSandbox('linux', installedButBlocked)).toMatchObject({
      confinement: 'none',
    });
  });

  it('asks bwrap to prove it, with the namespace flags that matter and no mounts', async () => {
    const attempted: string[][] = [];
    await resolveSandbox('linux', {
      has: async () => true,
      succeeds: async (argv) => {
        attempted.push([...argv]);
        return true;
      },
    });

    expect(attempted).toHaveLength(1);
    const argv = attempted[0] as string[];
    expect(argv[0]).toBe('bwrap');
    // The flag whose denial is the whole failure mode.
    expect(argv).toContain('--unshare-net');
    // No `--bind`: this asks whether the namespaces are permitted at all, not
    // whether some particular path can be mounted.
    expect(argv).not.toContain('--bind');
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

describe('the bubblewrap invocation', () => {
  const argv = BUBBLEWRAP.wrap('npm test', ['/work/project']);

  it('NETWORK: unshares it, which is the load-bearing flag', () => {
    expect(argv).toContain('--unshare-net');
  });

  it('binds the whole filesystem read-only and the workspace writable', () => {
    const line = argv.join(' ');

    expect(line).toContain('--ro-bind / /');
    expect(line).toContain('--bind /work/project /work/project');
  });

  /*
   * The defect that made "unverified" worth having. bwrap applies mounts in
   * argv order, so `--tmpfs /tmp` after a writable root under `/tmp` mounts an
   * empty filesystem straight over it — and on Linux `os.tmpdir()` is `/tmp`,
   * so a run's scratch directory is *always* under it. Driven on 2026-08-31,
   * the old order failed with `Can't chdir to …: No such file or directory`
   * and ran nothing at all.
   *
   * Asserted as positions rather than presence, because presence is exactly
   * what the broken version also had.
   */
  it('MOUNT ORDER: scaffolds /tmp, /proc and /dev before binding the roots over them', () => {
    // Both roots under /tmp: the scratch directory always is on Linux, and a
    // workspace often is.
    const scratchArgv = BUBBLEWRAP.wrap('npm test', ['/tmp/work/project', '/tmp/run-scratch']);
    const lastScaffold = Math.max(
      scratchArgv.indexOf('--tmpfs'),
      scratchArgv.indexOf('--proc'),
      scratchArgv.indexOf('--dev'),
    );

    for (const root of ['/tmp/work/project', '/tmp/run-scratch']) {
      const bind = scratchArgv.findIndex(
        (arg, index) => arg === '--bind' && scratchArgv[index + 1] === root,
      );
      expect(bind).toBeGreaterThan(lastScaffold);
    }
  });

  it('dies with its parent, so a command cannot outlive the run', () => {
    // Without this a command nobody is watching keeps running after the user
    // has stopped the turn.
    expect(argv).toContain('--die-with-parent');
  });

  it('takes no controlling terminal, closing the TIOCSTI route back to ours', () => {
    expect(argv).toContain('--new-session');
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

  /*
   * The caveat outlives the backend that needed it. bubblewrap wore
   * `unverified` until it was driven on 2026-08-31, so Linux no longer gets
   * this sentence — but the machinery that produces it is what a *future*
   * backend gets to wear while it is being written, and a test that only
   * asserted "Linux warns" would have been deleted along with the label.
   * So it is asserted against a backend that is unverified by construction.
   */
  it('WARNS the user when the backend is unproven, not just the code reader', () => {
    const unproven: ResolvedSandbox = {
      backend: { ...BUBBLEWRAP, verification: 'unverified' },
      confinement: 'workspace',
    };
    const text = describeConfinement(unproven);

    expect(text).toMatch(/not been verified/);
    expect(text).toMatch(/unproven/);
  });

  it('and says nothing of the sort once a backend has been driven', async () => {
    const text = describeConfinement(await resolveSandbox('linux', yes));

    expect(text).toContain('bubblewrap');
    expect(text).not.toMatch(/unproven/);
  });

  /*
   * Both causes, because by the time confinement reads `none` the reason is
   * gone — and since the probe runs bwrap rather than looking for it, "not
   * installed" stopped being the only way to get here. Telling someone on a
   * hardened kernel to install the thing they already have sends them the
   * wrong way.
   */
  it('tells a Linux user both ways bwrap can fail to confine', async () => {
    for (const env of [no, installedButBlocked]) {
      const text = describeConfinement(await resolveSandbox('linux', env));
      expect(text).toMatch(/install it/i);
      expect(text).toMatch(/namespaces/);
      expect(text).toMatch(/commands will not be run/);
    }
  });

  it('tells a Windows user why, rather than leaving it mysterious', async () => {
    expect(describeConfinement(await resolveSandbox('win32', yes))).toMatch(/native code/);
  });

  it('covers every backend that exists', () => {
    expect(BACKENDS.map((b) => b.platform)).toEqual(['darwin', 'linux', 'win32']);
  });
});
