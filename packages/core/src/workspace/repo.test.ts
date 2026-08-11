/**
 * Naming a directory, against a real filesystem.
 *
 * Same reasoning as `workdir.test.ts`: mocking `node:fs` would test the mock,
 * and the claim this module makes is about what is actually on disk. The two
 * shapes of `.git` — a directory in a clone, a file in a linked worktree — are
 * both built here rather than asserted about, because "we also accept the file"
 * is exactly the sort of statement that is true in a comment and false in code.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeWorkspace } from './repo.js';

let root: string;
/** A clone: `.git` is a directory at its root. */
let clone: string;
/** A directory several levels inside that clone. */
let nested: string;
/** A linked worktree: `.git` is a file holding a `gitdir:` pointer. */
let worktree: string;
/** An ordinary directory, in no repository at all. */
let plain: string;

beforeAll(async () => {
  // `mkdtemp` under `/var` on macOS, which is a symlink to `/private/var`. The
  // paths compared below all come back out of the same string, so the symlink
  // never enters the assertions.
  root = await mkdtemp(join(tmpdir(), 'apollo-repo-'));

  clone = join(root, 'apollo');
  nested = join(clone, 'apps', 'desktop');
  await mkdir(join(clone, '.git'), { recursive: true });
  await mkdir(nested, { recursive: true });

  worktree = join(root, 'apollo-fix-thing');
  await mkdir(worktree);
  await writeFile(join(worktree, '.git'), `gitdir: ${join(clone, '.git', 'worktrees', 'fix')}\n`);

  plain = join(root, 'notes');
  await mkdir(plain);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('describeWorkspace', () => {
  it('names the repository when the directory is its root', async () => {
    const result = await describeWorkspace(clone);
    expect(result).toEqual({
      path: clone,
      name: 'apollo',
      repoRoot: clone,
      repoName: 'apollo',
    });
  });

  it('names the repository from several levels inside it', async () => {
    // The case the whole module exists for: `name` is the directory, `repoName`
    // is what the person would say they are working on.
    const result = await describeWorkspace(nested);
    expect(result.name).toBe('desktop');
    expect(result.repoName).toBe('apollo');
    expect(result.repoRoot).toBe(clone);
  });

  it('accepts a `.git` file, so a linked worktree is a repository too', async () => {
    const result = await describeWorkspace(worktree);
    expect(result.repoRoot).toBe(worktree);
    // Its own name, deliberately — two checkouts of one repository are two
    // different places to be working, and the sidebar is naming a place.
    expect(result.repoName).toBe('apollo-fix-thing');
  });

  it('reports no repository for an ordinary directory', async () => {
    const result = await describeWorkspace(plain);
    expect(result).toEqual({ path: plain, name: 'notes' });
    expect(result.repoName).toBeUndefined();
  });

  it('stops at the filesystem root rather than walking off the top', async () => {
    const result = await describeWorkspace('/');
    expect(result.repoName).toBeUndefined();
    expect(result.name).toBe('/');
  });

  it('describes a path that does not exist, without failing', async () => {
    // A stale `cwd` from a restored session is ordinary. The header still needs
    // a label, and "the last segment" is the right one.
    const missing = join(root, 'gone', 'missing');
    const result = await describeWorkspace(missing);
    expect(result).toEqual({ path: missing, name: 'missing' });
  });

  it('describes a relative path by name only', async () => {
    // Resolving it against *this* process's cwd would answer about a directory
    // the user never named.
    const result = await describeWorkspace('src/components');
    expect(result).toEqual({ path: 'src/components', name: 'components' });
  });

  it('survives a value that is not a string', async () => {
    expect(await describeWorkspace(undefined)).toEqual({ path: '', name: '' });
    expect(await describeWorkspace(42)).toEqual({ path: '', name: '' });
  });
});
