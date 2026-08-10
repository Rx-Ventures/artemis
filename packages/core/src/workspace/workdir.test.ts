/**
 * The working-directory check, against a real filesystem.
 *
 * Mocking `node:fs` here would test the mock. The whole point of this module is
 * that it reports what the operating system will actually do to a `spawn`, so
 * every case below is a real path in a real temporary directory — including the
 * permission case, which is skipped when the test happens to run as root
 * (`chmod 000` does not stop root from reading a directory, so the assertion
 * would be false rather than merely unverifiable).
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkWorkingDirectory } from './workdir.js';

let root: string;
/** An existing, readable directory. */
let good: string;
/** An existing regular file. */
let file: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'libra-workdir-'));
  good = join(root, 'project');
  file = join(root, 'notes.txt');
  await mkdir(good);
  await writeFile(file, 'not a directory');
});

afterAll(async () => {
  // Restore any permission bits the tests removed, or the cleanup itself fails.
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('checkWorkingDirectory', () => {
  it('accepts a directory that exists and can be read', async () => {
    const check = await checkWorkingDirectory(good);
    expect(check).toEqual({ ok: true, path: good });
  });

  it('rejects a relative path, and says what an absolute one looks like', async () => {
    const check = await checkWorkingDirectory('relative/path');

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe('not_absolute');
    expect(check.message).toContain('relative/path');
    // The message has to be actionable on its own: the user typed a folder
    // name and needs to learn what is wanted instead.
    expect(check.message).toMatch(/absolute path/i);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a non-string', 42],
    ['undefined', undefined],
  ])('treats %s as a missing working directory rather than throwing', async (_label, value) => {
    const check = await checkWorkingDirectory(value);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe('not_absolute');
  });

  it('reports a directory that does not exist, and names it', async () => {
    const missing = join(root, 'nope', 'still-nope');
    const check = await checkWorkingDirectory(missing);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe('does_not_exist');
    expect(check.errno).toBe('ENOENT');
    // This is the case that used to surface as a libc diagnostic. The path is
    // the single most important thing the message can contain.
    expect(check.message).toBe(`That directory does not exist: ${missing}`);
  });

  it('distinguishes a file from a missing directory', async () => {
    const check = await checkWorkingDirectory(file);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe('not_a_directory');
    expect(check.message).toContain(file);
  });

  it('reports a path whose parent is a file as not-a-directory, not as missing', async () => {
    // `/…/notes.txt/sub` can never resolve, and "does not exist" would send the
    // user looking one segment too deep.
    const check = await checkWorkingDirectory(join(file, 'sub'));

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe('not_a_directory');
    expect(check.errno).toBe('ENOTDIR');
  });

  it.skipIf(isRoot)('reports a directory it is not allowed to enter', async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const check = await checkWorkingDirectory(locked);

      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(check.problem).toBe('not_readable');
      expect(check.message).toContain(locked);
      expect(check.message).toMatch(/permission/i);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it.skipIf(isRoot)('rejects a directory that can be read but not entered', async () => {
    // Read without execute: `readdir` works, `chdir` does not — so `spawn`
    // fails even though a check of R_OK alone would have passed it.
    const noSearch = join(root, 'no-search');
    await mkdir(noSearch);
    await chmod(noSearch, 0o600);
    try {
      const check = await checkWorkingDirectory(noSearch);
      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(check.problem).toBe('not_readable');
    } finally {
      await chmod(noSearch, 0o700);
    }
  });

  it('follows a symlink to the directory the child process would actually get', async () => {
    const { symlink } = await import('node:fs/promises');
    const link = join(root, 'link-to-project');
    await symlink(good, link, 'dir');
    await expect(checkWorkingDirectory(link)).resolves.toEqual({ ok: true, path: link });
  });

  it('reports a dangling symlink as a missing directory', async () => {
    const { symlink } = await import('node:fs/promises');
    const dangling = join(root, 'dangling');
    await symlink(join(root, 'gone'), dangling, 'dir');

    const check = await checkWorkingDirectory(dangling);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe('does_not_exist');
  });
});
