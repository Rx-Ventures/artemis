/**
 * `readTextFile`, which is the only thing that turns a path in an answer into
 * something on screen.
 *
 * Two of these are worth more than the rest. The **binary refusal** is what
 * keeps a click on `logo.png` from painting a pane with forty thousand
 * replacement glyphs, and it is content-based rather than extension-based, so
 * the test that matters is a file with no extension at all. The **truncation**
 * case pins the difference between this and `grantPreview`: an oversized preview
 * is refused, because half a page is a broken page, while an oversized file is
 * clipped and *says so*, because the first part of a log is what someone opening
 * a log wants.
 *
 * Real temp files throughout — the module is thirty lines of `fs` and mocking it
 * would leave nothing under test.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_BYTES, readTextFile } from './files';

async function fileWith(name: string, content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-test-files-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe('readTextFile', () => {
  it('reads a text file and reports what it is', async () => {
    const path = await fileWith('notes.txt', 'one\ntwo\n');
    const file = await readTextFile(path);

    expect(file.text).toBe('one\ntwo\n');
    expect(file.title).toBe('notes.txt');
    expect(file.path).toBe(path);
    expect(file.bytes).toBe(8);
    expect(file.truncated).toBe(false);
  });

  it('reads a file the preview could never open', async () => {
    // The whole point of the channel: `.ts` is not in `RENDERABLE`, and it is
    // the extension the conversation is most often about.
    const path = await fileWith('store.ts', 'export const answer = 42;\n');
    await expect(readTextFile(path)).resolves.toMatchObject({
      text: 'export const answer = 42;\n',
    });
  });

  it('reads a file with no extension, which an allow-list would have refused', async () => {
    const path = await fileWith('Makefile', 'build:\n\ttsc -b\n');
    await expect(readTextFile(path)).resolves.toMatchObject({ title: 'Makefile' });
  });

  it('refuses a binary file, by its content rather than its name', async () => {
    // No extension to go on: the NUL byte is the only signal, which is the
    // arrangement the heuristic was chosen for.
    const path = await fileWith('blob', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
    await expect(readTextFile(path)).rejects.toThrow(/binary file/);
  });

  it('refuses a folder, rather than failing differently per platform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-files-'));
    const inner = join(dir, 'src');
    await mkdir(inner);
    await expect(readTextFile(inner)).rejects.toThrow(/is a folder, not a file/);
  });

  it('says plainly when there is nothing there', async () => {
    await expect(readTextFile(join(tmpdir(), 'artemis-not-a-real-file-9182'))).rejects.toThrow(
      /There is no file at/,
    );
  });

  it('clips an oversized file and reports the size it really is', async () => {
    const size = MAX_BYTES + 4_096;
    const path = await fileWith('huge.log', 'x'.repeat(size));
    const file = await readTextFile(path);

    expect(file.truncated).toBe(true);
    expect(file.text.length).toBe(MAX_BYTES);
    // The caption's honesty depends on this: `bytes` is the file, not the read.
    expect(file.bytes).toBe(size);
  });

  it('does not claim truncation for a file that exactly fills the cap', async () => {
    const path = await fileWith('exact.log', 'y'.repeat(MAX_BYTES));
    const file = await readTextFile(path);

    expect(file.truncated).toBe(false);
    expect(file.text.length).toBe(MAX_BYTES);
  });

  it('reads an empty file as empty rather than failing', async () => {
    const path = await fileWith('empty.txt', '');
    await expect(readTextFile(path)).resolves.toMatchObject({ text: '', truncated: false });
  });
});
