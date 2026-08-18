/**
 * The Seatbelt profile.
 *
 * The profile *contents* are asserted here; that it actually confines anything
 * was established by driving `sandbox-exec` on macOS on 2026-08-18 — writes
 * outside refused, network refused, writes inside allowed once the workspace
 * path was resolved through symlinks. These tests keep the generated policy
 * from drifting away from the one that was verified.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildProfile,
  confinedArgv,
  DEFAULT_SANDBOX_MODE,
  describeMode,
  SANDBOX_MODES,
  seatbeltAvailable,
} from '../seatbelt.js';

describe('buildProfile', () => {
  it('denies everything before allowing anything', () => {
    // Order matters in a Seatbelt profile: a `deny default` after an allow
    // would not take the allow back, but reading it would suggest it did.
    const lines = buildProfile('read-only', []).split('\n');

    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(deny default)');
  });

  it('NETWORK: never grants it, in any confining mode', () => {
    // The difference between a run that damaged a file and one that posted a
    // repository somewhere.
    for (const mode of ['read-only', 'workspace-write'] as const) {
      expect(buildProfile(mode, ['/work'])).not.toContain('network');
    }
  });

  it('read-only grants no write anywhere', () => {
    expect(buildProfile('read-only', ['/work'])).not.toContain('file-write*');
  });

  it('workspace-write grants writes only under the roots it was given', () => {
    const profile = buildProfile('workspace-write', ['/work/project']);

    expect(profile).toContain('(allow file-write* (subpath "/work/project"))');
  });

  it('allows reads broadly, because a tool that cannot read is not useful', () => {
    expect(buildProfile('read-only', [])).toContain('(allow file-read*)');
  });

  it('allows the temp directories a toolchain writes to without asking', () => {
    // Denying these turns "the sandbox works" into "the build is broken for no
    // visible reason".
    const profile = buildProfile('workspace-write', ['/work']);

    expect(profile).toContain('/private/tmp');
    expect(profile).toContain('/private/var/folders');
  });

  it('escapes a quote in a path rather than ending the literal early', () => {
    const profile = buildProfile('workspace-write', ['/work/we"rd']);

    expect(profile).toContain('we\\"rd');
  });

  it('refuses to build a profile for the mode that has none', () => {
    expect(() => buildProfile('danger-full-access', [])).toThrow(/unconfined/);
  });
});

describe('confinedArgv', () => {
  it('SYMLINK: resolves the workspace, which is what makes writes work at all', async () => {
    // The failure this guards: Seatbelt matches the real path, so a profile
    // naming `/tmp/x` denies writes the shell thinks are to `/tmp/x`, because
    // the kernel sees `/private/tmp/x`. It fails closed and looks like nothing
    // is wrong. Verified live before this was written.
    const given = await mkdtemp(path.join(tmpdir(), 'artemis-sb-'));
    const real = await realpath(given);
    let written = '';

    try {
      const argv = await confinedArgv('workspace-write', 'echo hi', given, async (contents) => {
        written = contents;
        return '/tmp/profile.sb';
      });

      if (seatbeltAvailable()) {
        expect(written).toContain(`(subpath "${real}")`);
        expect(argv).toEqual(['/usr/bin/sandbox-exec', '-f', '/tmp/profile.sb', '/bin/sh', '-c', 'echo hi']);
      }
    } finally {
      await rm(given, { recursive: true, force: true });
    }
  });

  it('returns null for the unconfined mode, rather than quietly running it', async () => {
    // Null forces the decision back to the call site, where the approval policy
    // can see that a command is about to run with no confinement.
    const argv = await confinedArgv('danger-full-access', 'echo hi', process.cwd(), async () => '/x');

    expect(argv).toBeNull();
  });

  it('returns null off macOS, where there is no Seatbelt to use', () => {
    expect(seatbeltAvailable('linux')).toBe(false);
    expect(seatbeltAvailable('win32')).toBe(false);
    expect(seatbeltAvailable('darwin')).toBe(true);
  });
});

describe('the modes themselves', () => {
  it('defaults to confining writes and the network', () => {
    // Artemis is an app someone downloaded, not a CLI they typed. The default
    // carries that difference.
    expect(DEFAULT_SANDBOX_MODE).toBe('workspace-write');
  });

  it('describes every mode, since the UI offers the choice', () => {
    for (const mode of SANDBOX_MODES) {
      expect(describeMode(mode).length).toBeGreaterThan(20);
    }
  });

  it('says plainly that the dangerous mode is dangerous', () => {
    expect(describeMode('danger-full-access')).toMatch(/no confinement/i);
  });
});
