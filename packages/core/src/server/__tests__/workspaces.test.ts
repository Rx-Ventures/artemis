/**
 * Where a turn runs, and what is cleaned up afterwards.
 *
 * Against the real filesystem rather than a mocked `fs`: every property worth
 * having here is a property of the disk — that a directory exists, that it is
 * owner-only, that two callers did not land in the same one, that it is gone
 * afterwards — and a mock would agree with whatever the implementation did.
 */

import { mkdtemp, rm, stat, writeFile, readdir, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkspaceResolver,
  sweepStaleWorkspaces,
  STALE_WORKSPACE_MS,
  WorkspaceUnavailableError,
} from '../workspaces.js';

let root = '';
let scratch = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-ws-root-'));
  scratch = await mkdtemp(join(tmpdir(), 'artemis-ws-real-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

const resolver = () => createWorkspaceResolver({ root });

describe('a directory workspace', () => {
  it('runs in the folder the connection was bound to', async () => {
    const resolved = await resolver().resolve({
      connectionId: 'c1',
      workspace: { kind: 'directory', path: scratch },
    });

    expect(resolved).toEqual({ path: scratch, ephemeral: false });
  });

  it('fails loudly when the folder is gone rather than running elsewhere', async () => {
    // The folder was chosen once and may since have moved. A turn that quietly
    // ran somewhere else would be worse than one that failed.
    await rm(scratch, { recursive: true, force: true });

    await expect(
      resolver().resolve({ connectionId: 'c1', workspace: { kind: 'directory', path: scratch } }),
    ).rejects.toBeInstanceOf(WorkspaceUnavailableError);
  });

  it('refuses a path that exists but is a file', async () => {
    const file = join(scratch, 'not-a-dir');
    await writeFile(file, 'x', 'utf8');

    await expect(
      resolver().resolve({ connectionId: 'c1', workspace: { kind: 'directory', path: file } }),
    ).rejects.toBeInstanceOf(WorkspaceUnavailableError);
  });

  it('is never deleted by Artemis', async () => {
    const one = resolver();
    await one.resolve({ connectionId: 'c1', workspace: { kind: 'directory', path: scratch } });
    await one.disposeAll();

    // The user's own folder, which this module has no business removing.
    await expect(stat(scratch)).resolves.toBeTruthy();
  });
});

describe('a catalogue-only workspace', () => {
  it('cannot run a turn, and says why', async () => {
    await expect(
      resolver().resolve({ connectionId: 'c1', workspace: { kind: 'none' } }),
    ).rejects.toThrow(/catalogue-only/i);
  });
});

describe('an ephemeral workspace', () => {
  it('creates a directory the agent can actually work in', async () => {
    const resolved = await resolver().resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's1',
    });

    expect(resolved.ephemeral).toBe(true);
    const entry = await stat(resolved.path);
    expect(entry.isDirectory()).toBe(true);
    // Owner-only: what an agent writes here is the user's work.
    expect(entry.mode & 0o777).toBe(0o700);
  });

  it('keeps one directory per conversation, so a follow-up turn sees its own files', async () => {
    // The failure this prevents: turn one writes `notes.md`, turn two finds an
    // empty directory and the agent's own work has vanished mid-thought.
    const one = resolver();
    const first = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's1',
    });
    await writeFile(join(first.path, 'notes.md'), 'from turn one', 'utf8');

    const second = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's1',
    });

    expect(second.path).toBe(first.path);
    expect(await readdir(second.path)).toEqual(['notes.md']);
  });

  it('gives different conversations different directories', async () => {
    // One agent's `rm -rf build` must not take out another's work.
    const one = resolver();
    const a = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's1',
    });
    const b = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's2',
    });

    expect(a.path).not.toBe(b.path);
  });

  it('gives every turn its own directory when perSession is off', async () => {
    const one = resolver();
    const a = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: false },
      sessionId: 's1',
    });
    const b = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: false },
      sessionId: 's1',
    });

    expect(a.path).not.toBe(b.path);
  });

  it('gives a one-off turn its own directory', async () => {
    const one = resolver();
    const a = await one.resolve({ connectionId: 'c1', workspace: { kind: 'ephemeral' } });
    const b = await one.resolve({ connectionId: 'c1', workspace: { kind: 'ephemeral' } });

    expect(a.path).not.toBe(b.path);
  });

  it('removes a conversation’s directory when it is released', async () => {
    const one = resolver();
    const resolved = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's1',
    });
    await writeFile(join(resolved.path, 'scratch.txt'), 'x', 'utf8');

    await one.release('s1');

    // "Nothing it writes is kept" is the promise the type makes.
    await expect(stat(resolved.path)).rejects.toBeTruthy();
  });

  it('is safe to release a session twice, or one that never had a directory', async () => {
    const one = resolver();
    await expect(one.release('never-existed')).resolves.toBeUndefined();
    await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's1',
    });
    await one.release('s1');
    await expect(one.release('s1')).resolves.toBeUndefined();
  });

  it('removes everything it made when the server stops', async () => {
    const one = resolver();
    const a = await one.resolve({
      connectionId: 'c1',
      workspace: { kind: 'ephemeral', perSession: true },
      sessionId: 's1',
    });
    const b = await one.resolve({ connectionId: 'c2', workspace: { kind: 'ephemeral' } });

    await one.disposeAll();

    await expect(stat(a.path)).rejects.toBeTruthy();
    await expect(stat(b.path)).rejects.toBeTruthy();
  });

  it('names the connection in the path, without trusting the id', async () => {
    const resolved = await resolver().resolve({
      // A hostile id: if this reached the path unfiltered it would be traversal.
      connectionId: '../../etc/passwd',
      workspace: { kind: 'ephemeral' },
    });

    expect(resolved.path.startsWith(root)).toBe(true);
    expect(resolved.path).not.toContain('..');
  });
});

describe('sweeping what a crash left behind', () => {
  it('removes directories older than a day', async () => {
    // A killed process releases nothing, and /tmp outlives it until reboot.
    const stale = join(root, 'conn-stale');
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - STALE_WORKSPACE_MS - 60_000);
    await utimes(stale, old, old);

    expect(await sweepStaleWorkspaces({ root })).toBe(1);
    await expect(stat(stale)).rejects.toBeTruthy();
  });

  it('leaves recent ones alone, because a second Artemis may own them', async () => {
    // Deleting a live agent's working directory is the one harm this could do.
    const fresh = join(root, 'conn-fresh');
    await mkdir(fresh, { recursive: true });

    expect(await sweepStaleWorkspaces({ root })).toBe(0);
    await expect(stat(fresh)).resolves.toBeTruthy();
  });

  it('does nothing when there is no root yet', async () => {
    await expect(
      sweepStaleWorkspaces({ root: join(root, 'never-created') }),
    ).resolves.toBe(0);
  });
});
