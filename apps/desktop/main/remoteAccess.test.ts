/**
 * The remote-origin grant: what is accepted, and what survives a relaunch.
 *
 * `normalizeRemoteOrigin` is the gate between "a string the user typed" and "a
 * value interpolated into a CSP directive", so the refusals matter as much as
 * the acceptances: a scheme that is not http(s), embedded credentials, or
 * something that is not an address at all must come back null rather than
 * adjacent-to-right.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRemoteAccess, normalizeRemoteOrigin, REMOTE_ACCESS_FILE } from './remoteAccess';

describe('normalizeRemoteOrigin', () => {
  it('reduces a pasted URL to its origin', () => {
    expect(normalizeRemoteOrigin('http://kronos.tail1234.ts.net:6472/')).toBe(
      'http://kronos.tail1234.ts.net:6472',
    );
    expect(normalizeRemoteOrigin('https://kronos.example:6472/api/v0/profiles?x=1')).toBe(
      'https://kronos.example:6472',
    );
  });

  it('accepts the host:port shorthand people actually type', () => {
    expect(normalizeRemoteOrigin('kronos:6472')).toBe('http://kronos:6472');
    expect(normalizeRemoteOrigin('100.64.0.7:6472')).toBe('http://100.64.0.7:6472');
  });

  it('refuses schemes that are not http(s)', () => {
    expect(normalizeRemoteOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeRemoteOrigin('ws://kronos:6472')).toBeNull();
    expect(normalizeRemoteOrigin('artemis-preview://x')).toBeNull();
  });

  it('refuses embedded credentials — the token travels in a header, never a URL', () => {
    expect(normalizeRemoteOrigin('http://user:secret@kronos:6472')).toBeNull();
  });

  it('refuses emptiness and noise', () => {
    expect(normalizeRemoteOrigin('')).toBeNull();
    expect(normalizeRemoteOrigin('   ')).toBeNull();
    expect(normalizeRemoteOrigin('not a url at all')).toBeNull();
  });
});

describe('createRemoteAccess', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('starts null, stores a normalized grant, and survives a reload', async () => {
    dir = await mkdtemp(join(tmpdir(), 'artemis-remote-'));
    const access = createRemoteAccess(dir);
    await access.load();
    expect(access.origin()).toBeNull();

    const stored = await access.configure('http://kronos:6472/');
    expect(stored).toBe('http://kronos:6472');
    expect(access.origin()).toBe('http://kronos:6472');

    // The file holds the normalized form, not the typed one.
    const raw = JSON.parse(await readFile(join(dir, REMOTE_ACCESS_FILE), 'utf8')) as {
      origin: string;
    };
    expect(raw.origin).toBe('http://kronos:6472');

    const second = createRemoteAccess(dir);
    await second.load();
    expect(second.origin()).toBe('http://kronos:6472');
  });

  it('withdraws a grant with null, durably', async () => {
    dir = await mkdtemp(join(tmpdir(), 'artemis-remote-'));
    const access = createRemoteAccess(dir);
    await access.configure('http://kronos:6472');
    await access.configure(null);
    expect(access.origin()).toBeNull();

    const second = createRemoteAccess(dir);
    await second.load();
    expect(second.origin()).toBeNull();
  });

  it('reads a corrupt file as no grant at all', async () => {
    dir = await mkdtemp(join(tmpdir(), 'artemis-remote-'));
    const access = createRemoteAccess(dir);
    await access.configure('javascript:alert(1)' as never);
    // A refused origin stores null rather than the refuse-worthy string.
    expect(access.origin()).toBeNull();
  });
});
