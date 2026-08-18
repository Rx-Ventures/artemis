/**
 * The stand-in XDG roots.
 *
 * These tests are about one property: a single variable answering differently
 * for the provider than for everything else on the machine. Each case below is
 * a way that could stop being true.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildXdgFarm, describeFarm } from './xdgFarm.js';
import type { XdgRootSpec } from './xdgFarm.js';

const SPEC: XdgRootSpec = {
  variable: 'XDG_DATA_HOME',
  defaultSubpath: '.local/share',
  ownedEntry: 'opencode',
  farmSubpath: '.',
};

let root: string;
let home: string;
let realShare: string;
let profile: string;
let hostEnv: Record<string, string>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'artemis-xdg-'));
  home = path.join(root, 'home');
  realShare = path.join(home, '.local', 'share');
  profile = path.join(root, 'profiles', 'work');

  // What a real machine looks like: another provider's state, an unrelated
  // tool, and OpenCode's own.
  await mkdir(path.join(realShare, 'claude'), { recursive: true });
  await mkdir(path.join(realShare, 'uv'), { recursive: true });
  await mkdir(path.join(realShare, 'opencode'), { recursive: true });
  await writeFile(path.join(realShare, 'claude', 'creds.json'), '{"real":true}');

  hostEnv = { HOME: home };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildXdgFarm', () => {
  it('points the variable at the stand-in root', async () => {
    const env = await buildXdgFarm([SPEC], profile, hostEnv);

    expect(env['XDG_DATA_HOME']).toBe(profile);
  });

  it("ISOLATION: the provider's own entry is a real directory, not a link home", async () => {
    await buildXdgFarm([SPEC], profile, hostEnv);

    // The entire point. A link here would put every profile on one account.
    expect((await describeFarm(profile))['opencode']).toBeNull();
  });

  it('LEAK: every other entry resolves to the user’s real directory', async () => {
    await buildXdgFarm([SPEC], profile, hostEnv);
    const farm = await describeFarm(profile);

    expect(farm['claude']).toBe(path.join(realShare, 'claude'));
    expect(farm['uv']).toBe(path.join(realShare, 'uv'));
  });

  it('LEAK: a tool reading through the farm gets its real file', async () => {
    await buildXdgFarm([SPEC], profile, hostEnv);

    // What the leak actually cost: an agent running the Claude CLI under a
    // naive override found an empty directory where its state should be.
    const seen = await readFile(path.join(profile, 'claude', 'creds.json'), 'utf8');
    expect(seen).toBe('{"real":true}');
  });

  it('writes nothing into the user’s directories', async () => {
    await buildXdgFarm([SPEC], profile, hostEnv);

    // Only links point outward; nothing is created, moved or deleted out there.
    expect((await describeFarm(realShare))['opencode']).toBeNull();
    await expect(readFile(path.join(realShare, 'claude', 'creds.json'), 'utf8')).resolves.toBe(
      '{"real":true}',
    );
  });

  it('picks up a tool installed since the last run', async () => {
    await buildXdgFarm([SPEC], profile, hostEnv);
    await mkdir(path.join(realShare, 'gh'), { recursive: true });

    await buildXdgFarm([SPEC], profile, hostEnv);

    // The farm is a view of a directory that changes, which is why it is built
    // per run rather than once.
    expect((await describeFarm(profile))['gh']).toBe(path.join(realShare, 'gh'));
  });

  it('drops a link to a tool that has gone away', async () => {
    await buildXdgFarm([SPEC], profile, hostEnv);
    await rm(path.join(realShare, 'uv'), { recursive: true, force: true });

    await buildXdgFarm([SPEC], profile, hostEnv);

    expect('uv' in (await describeFarm(profile))).toBe(false);
  });

  it('SAFETY: rebuilding never removes the owned directory or its contents', async () => {
    await buildXdgFarm([SPEC], profile, hostEnv);
    await writeFile(path.join(profile, 'opencode', 'auth.json'), '{"token":"kept"}');

    await buildXdgFarm([SPEC], profile, hostEnv);

    // The stale-link sweep removes symlinks only. Deleting the owned entry
    // would sign the profile out on every run.
    await expect(readFile(path.join(profile, 'opencode', 'auth.json'), 'utf8')).resolves.toBe(
      '{"token":"kept"}',
    );
  });

  it('honours an already-exported root rather than assuming HOME', async () => {
    const elsewhere = path.join(root, 'exported');
    await mkdir(path.join(elsewhere, 'fish'), { recursive: true });

    await buildXdgFarm([SPEC], profile, { ...hostEnv, XDG_DATA_HOME: elsewhere });

    expect((await describeFarm(profile))['fish']).toBe(path.join(elsewhere, 'fish'));
  });

  it('a machine with no such root still gets an isolated profile', async () => {
    await rm(realShare, { recursive: true, force: true });

    const env = await buildXdgFarm([SPEC], profile, hostEnv);

    expect(env['XDG_DATA_HOME']).toBe(profile);
    expect((await describeFarm(profile))['opencode']).toBeNull();
  });

  it('leaves an existing link alone rather than failing the run', async () => {
    await mkdir(profile, { recursive: true });
    await symlink(path.join(realShare, 'claude'), path.join(profile, 'claude'));

    await expect(buildXdgFarm([SPEC], profile, hostEnv)).resolves.toBeDefined();
    expect((await describeFarm(profile))['claude']).toBe(path.join(realShare, 'claude'));
  });

  it('builds each declared root independently', async () => {
    const config: XdgRootSpec = {
      variable: 'XDG_CONFIG_HOME',
      defaultSubpath: '.config',
      ownedEntry: 'opencode',
      farmSubpath: 'xdg-config',
    };
    await mkdir(path.join(home, '.config', 'gh'), { recursive: true });

    const env = await buildXdgFarm([SPEC, config], profile, hostEnv);

    expect(env['XDG_DATA_HOME']).toBe(profile);
    expect(env['XDG_CONFIG_HOME']).toBe(path.join(profile, 'xdg-config'));
    expect((await describeFarm(path.join(profile, 'xdg-config')))['gh']).toBe(
      path.join(home, '.config', 'gh'),
    );
  });

  it('a provider that names its own variable touches no disk', async () => {
    const env = await buildXdgFarm([], profile, hostEnv);

    expect(env).toEqual({});
    await expect(describeFarm(profile)).rejects.toThrow();
  });
});
