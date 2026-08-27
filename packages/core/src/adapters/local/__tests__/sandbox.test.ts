/**
 * The boundary a tool cannot reach past.
 *
 * These are the tests that matter most in the local provider, because every
 * policy above them assumes they hold. Each escape below is one somebody has
 * actually used: traversal, an absolute path, a symlink out, a prefix that
 * merely looks like the root, and a null byte.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { confine, sandboxEnv, SandboxViolation } from '../sandbox.js';

/**
 * The link type a directory link needs here. Windows refuses an unprivileged
 * symlink to a directory; a junction is the same reparse point and `realpath`
 * resolves through it identically, so the escape below is the same escape.
 */
const DIRECTORY_LINK = process.platform === 'win32' ? 'junction' : undefined;

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'artemis-sandbox-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'secrets');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), 'export {}');
  await writeFile(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('confine — paths that are allowed', () => {
  it('accepts a relative path inside the root', async () => {
    const at = await confine('src/index.ts', root);

    expect(at.relative).toBe(path.join('src', 'index.ts'));
    // Compared against the *resolved* root: on macOS `/var` is a symlink to
    // `/private/var`, so the real path legitimately differs from the string the
    // test handed in. That is the module working, not drifting.
    const realRoot = await realpath(root);
    expect(at.real.startsWith(realRoot)).toBe(true);
  });

  it('accepts the root itself', async () => {
    expect((await confine('.', root)).relative).toBe('.');
  });

  it('accepts a file that does not exist yet, so a tool can create one', async () => {
    // Checked before the write, when `realpath` cannot resolve the leaf.
    const at = await confine('src/new-file.ts', root);

    expect(at.relative).toBe(path.join('src', 'new-file.ts'));
  });

  it('accepts a deep path whose parent directories do not exist yet', async () => {
    const at = await confine('a/b/c/deep.ts', root);

    expect(at.relative).toBe(path.join('a', 'b', 'c', 'deep.ts'));
  });

  it('accepts traversal that stays inside after collapsing', async () => {
    // `src/../src` is inside; refusing it would break ordinary path building.
    expect((await confine('src/../src/index.ts', root)).relative).toBe(
      path.join('src', 'index.ts'),
    );
  });
});

describe('confine — escapes that must be refused', () => {
  it('ESCAPE: refuses traversal out of the root', async () => {
    await expect(confine('../secrets/id_rsa', root)).rejects.toThrow(SandboxViolation);
  });

  it('ESCAPE: refuses an absolute path outside the root', async () => {
    await expect(confine(path.join(outside, 'id_rsa'), root)).rejects.toThrow(SandboxViolation);
  });

  it('ESCAPE: refuses a symlink that points out — the one string checks miss', async () => {
    // Textually `<root>/escape` is inside the root. It is not, and this is the
    // reason containment is decided on the real path.
    await symlink(outside, path.join(root, 'escape'), DIRECTORY_LINK);

    await expect(confine('escape/id_rsa', root)).rejects.toThrow(SandboxViolation);
  });

  it('ESCAPE: refuses a symlinked directory even when only the directory is named', async () => {
    await symlink(outside, path.join(root, 'escape'), DIRECTORY_LINK);

    await expect(confine('escape', root)).rejects.toThrow(SandboxViolation);
  });

  it('ESCAPE: refuses a sibling whose name merely starts with the root', async () => {
    // `/…/project-notes` is not inside `/…/project`, though it starts with it.
    const sibling = path.join(base, 'project-notes');
    await mkdir(sibling, { recursive: true });

    await expect(confine(sibling, root)).rejects.toThrow(SandboxViolation);
  });

  it('ESCAPE: refuses a null byte, which can make one string look like two', async () => {
    await expect(confine('src/index.ts\0.png', root)).rejects.toThrow(SandboxViolation);
  });

  it('refuses an empty path', async () => {
    await expect(confine('   ', root)).rejects.toThrow(SandboxViolation);
  });

  it('says where tools may reach, since the user has to act on the refusal', async () => {
    await expect(confine('../secrets/id_rsa', root)).rejects.toThrow(/outside this run's directory/);
  });
});

describe('confine — what callers must use', () => {
  it('returns the resolved path, which is what closes the check/use race', async () => {
    await mkdir(path.join(root, 'real'), { recursive: true });
    await symlink(path.join(root, 'real'), path.join(root, 'link'), DIRECTORY_LINK);

    const at = await confine('link', root);

    // Operating on `at.real` rather than on "link" means the path cannot be
    // swapped between the check and the write.
    expect(at.real).toBe(await realpath(path.join(root, 'real')));
  });
});

describe('sandboxEnv', () => {
  it('keeps what a shell needs to work at all', () => {
    const env = sandboxEnv({ PATH: '/usr/bin', HOME: '/Users/me' }, []);

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/me' });
  });

  it('BILLING: strips the provider keys the run already refuses to emit', () => {
    // A tool that can read this out of its own shell has undone the trap the
    // seam exists to make structural.
    const env = sandboxEnv({ ANTHROPIC_API_KEY: 'sk-ant-…', PATH: '/usr/bin' }, [
      'ANTHROPIC_API_KEY',
    ]);

    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('strips credential-shaped names the scrub list has never heard of', () => {
    const env = sandboxEnv(
      { ACME_API_KEY: 'x', GH_TOKEN: 'y', DB_PASSWORD: 'z', EDITOR: 'vim' },
      [],
    );

    expect(Object.keys(env)).toEqual(['EDITOR']);
  });

  it('drops unset variables rather than passing undefined through', () => {
    expect(sandboxEnv({ NOPE: undefined, OK: '1' }, [])).toEqual({ OK: '1' });
  });
});
