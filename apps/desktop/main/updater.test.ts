/**
 * The updater's testable seams.
 *
 * The swap itself — two renames over /Applications — is exercised by release
 * builds, not by this file. What lives here are the pieces that were moved to
 * module scope precisely so they could be pinned:
 *
 *  - `fetchAnonymously` must give up on a server that stalls, whether it
 *    stalls before the headers or drips after them. Before it had a deadline,
 *    a slow-drip feed held `checking` set until relaunch, with the menu item
 *    greyed out for the duration.
 *  - `fetchAsset` must reduce a feed-controlled `path` to a bare filename
 *    before it becomes a local one, so `path: ../../x.zip` cannot write
 *    outside the staging directory.
 *  - `sha512Of` must produce the same digest streaming that `readFile` did in
 *    one piece.
 *  - `dismiss` must persist only a version that is actually on offer — the
 *    renderer-supplied string used to be written down unconditionally, which
 *    let a compromised renderer pre-silence a release nobody had seen.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.1.0',
    relaunch: vi.fn(),
    quit: vi.fn(),
  },
}));

const { createUpdater, fetchAnonymously, fetchAsset, sha512Of } = await import('./updater');

const servers: Server[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A local HTTP server whose whole personality is its request handler. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

function stubFetchWith(body: string): void {
  vi.stubGlobal('fetch', (() => Promise.resolve(new Response(body))) as typeof fetch);
}

describe('fetchAnonymously', () => {
  it('gives up on a server that accepts the connection and never answers', async () => {
    const origin = await serve(() => {
      // Never respond: the connection sits open with no headers.
    });
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-fetch-'));
    await expect(
      fetchAnonymously(`${origin}/feed.yml`, join(dir, 'feed.yml'), 200),
    ).rejects.toThrow(/timeout|abort/i);
  });

  it('gives up on a slow drip — headers, one byte, then silence', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('a');
      // ...and nothing more, ever. This is the shape of the failure the
      // deadline exists for: `fetch` has resolved, the body never ends.
    });
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-fetch-'));
    await expect(
      fetchAnonymously(`${origin}/big.zip`, join(dir, 'big.zip'), 200),
    ).rejects.toThrow(/timeout|abort/i);
  });
});

describe('fetchAsset', () => {
  it('reduces a feed-controlled path to its basename before it touches disk', async () => {
    stubFetchWith('zip-bytes');
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-asset-'));

    const destination = await fetchAsset('../../evil.zip', 'v1.0.0', dir, 1_000);

    expect(destination).toBe(join(dir, 'evil.zip'));
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(resolve(dir, '..', '..', 'evil.zip'))).toBe(false);
  });
});

describe('sha512Of', () => {
  it('digests a file identically to the whole-buffer hash it replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-sha-'));
    const file = join(dir, 'blob.bin');
    const payload = randomBytes(64 * 1024);
    await writeFile(file, payload);

    expect(await sha512Of(file)).toBe(createHash('sha512').update(payload).digest('base64'));
  });
});

describe('dismiss', () => {
  const settingsIn = (dir: string): string => join(dir, 'update-settings.json');

  it('does not persist a version nobody offered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-dismiss-'));
    const updater = createUpdater({ userDataDir: dir, broadcast: () => undefined });

    const state = await updater.dismiss('9.9.9');

    expect(state.phase).toBe('idle');
    expect(existsSync(settingsIn(dir))).toBe(false);
  });

  // The offer is produced by a real (manual) check against a stubbed feed, so
  // this needs the platform the updater actually supports.
  it.runIf(process.platform === 'darwin')(
    'persists exactly the version on offer, and only that one',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'artemis-test-dismiss-'));
      const updater = createUpdater({ userDataDir: dir, broadcast: () => undefined });
      stubFetchWith('version: 9.9.9\npath: Artemis-9.9.9-arm64-mac.zip\nsha512: irrelevant\n');

      await expect(updater.checkNow()).resolves.toEqual({ kind: 'offered', version: '9.9.9' });

      // A version that is not the one on the card changes nothing: no file,
      // and the offer stays up.
      await updater.dismiss('1.2.3');
      expect(updater.state().phase).toBe('available');
      expect(existsSync(settingsIn(dir))).toBe(false);

      // The offered version is a real decision: recorded, and the card comes
      // down.
      const state = await updater.dismiss('9.9.9');
      expect(state.phase).toBe('idle');
      expect(JSON.parse(await readFile(settingsIn(dir), 'utf8'))).toEqual({
        dismissedVersion: '9.9.9',
      });
    },
  );
});
