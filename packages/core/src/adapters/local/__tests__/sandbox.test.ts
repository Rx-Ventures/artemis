/**
 * The boundary a tool cannot reach past.
 *
 * These are the tests that matter most in the local provider, because every
 * policy above them assumes they hold. Each escape below is one somebody has
 * actually used: traversal, an absolute path, a symlink out, a prefix that
 * merely looks like the root, and a null byte.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { confine, confineToRoots, sandboxEnv, SandboxViolation } from '../sandbox.js';

/**
 * Can this machine create a real symlink?
 *
 * Windows grants that only to an admin (junctions and hardlinks it grants to
 * anyone), so the symlink-specific case added below skips rather than fails
 * where the OS withholds it — the realpath containment it checks is exercised
 * by the non-symlink escapes regardless. Probed once, synchronously, before any
 * test runs. The pre-existing `confine` symlink tests make the same OS call and
 * are left as they are.
 */
const CAN_SYMLINK = ((): boolean => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artemis-symlink-probe-'));
  try {
    symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

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

describe('confineToRoots — additional directories, read-only', () => {
  // A second directory outside the working root — the shape of a team memory
  // bank kept in ~/Documents. Granted read-only, so a read lands there and a
  // write does not.
  let bank: string;
  const writable = (p: string): { path: string; writable: boolean } => ({ path: p, writable: true });
  const readOnly = (p: string): { path: string; writable: boolean } => ({ path: p, writable: false });

  beforeEach(async () => {
    bank = path.join(base, 'cortex');
    await mkdir(path.join(bank, 'notes'), { recursive: true });
    await writeFile(path.join(bank, 'notes', 'memory.md'), '# remember this\n');
  });

  it('MULTI-ROOT: reads a file inside an additional directory', async () => {
    const target = path.join(bank, 'notes', 'memory.md');
    const at = await confineToRoots(target, [writable(root), readOnly(bank)], 'read');

    expect(at.real).toBe(await realpath(target));
  });

  it('MULTI-ROOT: still reads inside the working directory', async () => {
    const at = await confineToRoots('src/index.ts', [writable(root), readOnly(bank)], 'read');

    expect(at.relative).toBe(path.join('src', 'index.ts'));
  });

  it('READ-ONLY: refuses a write that resolves into an additional directory', async () => {
    await expect(
      confineToRoots(path.join(bank, 'notes', 'memory.md'), [writable(root), readOnly(bank)], 'write'),
    ).rejects.toThrow(/read-only additional directory/);
  });

  it('READ-ONLY: the very path a write was refused for still reads', async () => {
    // The distinction the message draws has to be real: refusing the write and
    // then also refusing the read would make "read-only" a lie.
    const target = path.join(bank, 'notes', 'memory.md');
    await expect(
      confineToRoots(target, [writable(root), readOnly(bank)], 'write'),
    ).rejects.toThrow(SandboxViolation);

    const at = await confineToRoots(target, [writable(root), readOnly(bank)], 'read');
    expect(at.real).toBe(await realpath(target));
  });

  it('writes inside the working directory as normal, additional roots or not', async () => {
    const at = await confineToRoots('src/new.ts', [writable(root), readOnly(bank)], 'write');

    expect(at.relative).toBe(path.join('src', 'new.ts'));
  });

  it('ESCAPE: refuses an absolute path outside every root, read or write', async () => {
    const secret = path.join(outside, 'id_rsa');
    await expect(confineToRoots(secret, [writable(root), readOnly(bank)], 'read')).rejects.toThrow(
      SandboxViolation,
    );
    await expect(confineToRoots(secret, [writable(root), readOnly(bank)], 'write')).rejects.toThrow(
      SandboxViolation,
    );
  });

  it('ESCAPE: traversal out of the working directory is still refused with extra roots present', async () => {
    // Collapsed, `../secrets/id_rsa` is inside neither the working directory nor
    // the bank. Adding roots must not open a way around the primitive.
    await expect(
      confineToRoots('../secrets/id_rsa', [writable(root), readOnly(bank)], 'read'),
    ).rejects.toThrow(SandboxViolation);
  });

  it.skipIf(!CAN_SYMLINK)('ESCAPE: refuses a symlink that points out of an additional root', async () => {
    // The reason containment is decided on the real path holds for the extra
    // roots too: a symlink inside the bank pointing at secrets is not the bank.
    await symlink(outside, path.join(bank, 'escape'));

    await expect(
      confineToRoots(path.join(bank, 'escape', 'id_rsa'), [writable(root), readOnly(bank)], 'read'),
    ).rejects.toThrow(SandboxViolation);
  });

  it('resolves a relative path against the working directory, not an additional one', async () => {
    // The bank has notes/memory.md; the working directory does not. A bare
    // relative path belongs to the working directory, so it resolves there —
    // reaching the bank's copy takes the bank's absolute path.
    const at = await confineToRoots('notes/memory.md', [writable(root), readOnly(bank)], 'read');

    expect(at.real).toBe(path.join(await realpath(root), 'notes', 'memory.md'));
    expect(at.real).not.toContain('cortex');
  });

  it('EMPTY: a single writable root matches `confine` to the letter', async () => {
    // The byte-for-byte promise: with no additional directories, both the
    // result and the refusal wording are the single-root primitive's exactly.
    expect(await confineToRoots('src/index.ts', [writable(root)], 'read')).toEqual(
      await confine('src/index.ts', root),
    );
    await expect(confineToRoots('../secrets/id_rsa', [writable(root)], 'write')).rejects.toThrow(
      /outside this run's directory/,
    );
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
