/**
 * `grantPreview`, which turns a path the model named into something a frame
 * can show.
 *
 * The case that earned this file is the size ceiling's second half: the 8MB
 * cap used to be checked against `stat` alone, and a file replaced between
 * the stat and the read arrived in memory at whatever size the replacement
 * chose. The ceiling is now enforced against the bytes actually read, and the
 * race is pinned here by letting the two calls disagree — which is the only
 * honest way to test a TOCTOU without losing one.
 *
 * Electron is mocked because `preview.ts` imports `protocol` at module scope
 * for the two registration functions; `grantPreview` itself never touches it.
 * `node:fs/promises` is wrapped (not replaced) so that most tests run against
 * real temp files and only the race test forces the disagreement.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) };
});

const { grantPreview } = await import('./preview');
const { stat, readFile } = await import('node:fs/promises');

const MAX_BYTES = 8 * 1024 * 1024;

async function fileWith(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-test-preview-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe('grantPreview', () => {
  it('serves an HTML file as a framed snapshot with a token URL', async () => {
    const path = await fileWith('page.html', '<!doctype html><p>hi</p>');
    const preview = await grantPreview(path);

    expect(preview.kind).toBe('frame');
    if (preview.kind !== 'frame') return;
    expect(preview.url).toMatch(/^artemis-preview:\/\/[0-9a-f]{32}\/$/);
    expect(preview.title).toBe('page.html');
    expect(preview.bytes).toBe('<!doctype html><p>hi</p>'.length);
  });

  it('hands markdown back as text rather than a URL', async () => {
    const path = await fileWith('notes.md', '# hello');
    const preview = await grantPreview(path);

    expect(preview.kind).toBe('markdown');
    if (preview.kind !== 'markdown') return;
    expect(preview.text).toBe('# hello');
  });

  it('refuses an extension it cannot render, naming the file', async () => {
    const path = await fileWith('app.js', 'alert(1)');
    await expect(grantPreview(path)).rejects.toThrow(/app\.js is none of those/);
  });

  it('refuses a path with no file behind it', async () => {
    await expect(grantPreview('/nowhere/at/all.html')).rejects.toThrow(/no file at/);
  });

  it('refuses a file the stat already shows is oversized, without reading it', async () => {
    vi.mocked(stat).mockResolvedValueOnce({
      isFile: () => true,
      size: MAX_BYTES + 1,
    } as never);

    await expect(grantPreview('/somewhere/big.html')).rejects.toThrow(/too large to preview/);
    expect(vi.mocked(readFile)).not.toHaveBeenCalledWith('/somewhere/big.html');
  });

  it('refuses a file that grew between the stat and the read', async () => {
    // The race, made deterministic: the stat answers with an innocent size and
    // the read hands back more than the cap — which is exactly what a file
    // swapped between the two calls looks like from here.
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => true, size: 10 } as never);
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.alloc(MAX_BYTES + 1) as never);

    await expect(grantPreview('/somewhere/swapped.html')).rejects.toThrow(/too large to preview/);
  });
});
