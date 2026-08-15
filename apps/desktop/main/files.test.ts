/**
 * `readTextFile`, which is the only thing that turns a path in an answer into
 * something on screen — and `checkFiles`, which decides whether that path was
 * ever drawn as something to click.
 *
 * Two of the read's cases are worth more than the rest. The **binary refusal**
 * is what keeps a click on `logo.png` from painting a pane with forty thousand
 * replacement glyphs, and it is content-based rather than extension-based, so
 * the test that matters is a file with no extension at all. The **truncation**
 * case pins the difference between this and `grantPreview`: an oversized preview
 * is refused, because half a page is a broken page, while an oversized file is
 * clipped and *says so*, because the first part of a log is what someone opening
 * a log wants.
 *
 * For the check, the case that earns its keep is the **folder**. A directory
 * passes any test spelled "does this path exist" and then fails the read with
 * `is a folder, not a file` — which is exactly the dead link the check exists to
 * prevent, arrived at by the one route a careless implementation takes.
 *
 * Real temp files throughout — the module is fifty lines of `fs` and mocking it
 * would leave nothing under test.
 */

import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkFiles, MAX_BYTES, readTextFile } from './files';

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

describe('checkFiles', () => {
  it('answers with the files that are there, and drops the ones that are not', async () => {
    const real = await fileWith('store.ts', 'export const answer = 42;\n');
    const absent = join(tmpdir(), 'artemis-not-a-real-file-4471.ts');

    const { reachable } = await checkFiles([real, absent]);
    expect(reachable).toEqual([real]);
  });

  it('says no to a folder, which a bare existence check would have said yes to', async () => {
    // The case the whole channel turns on. `src/` exists, so anything asking
    // "is this path there" links it — and the read then refuses it as a folder,
    // which is the dead link this is meant to stop.
    const dir = await mkdtemp(join(tmpdir(), 'artemis-test-files-'));
    const inner = join(dir, 'src');
    await mkdir(inner);

    await expect(checkFiles([inner])).resolves.toEqual({ reachable: [] });
  });

  it('follows a symlink to a real file, the way the read will', async () => {
    const real = await fileWith('store.ts', 'export const answer = 42;\n');
    const link = join(tmpdir(), `artemis-test-link-${String(process.pid)}.ts`);
    await symlink(real, link);

    // The two have to agree: a link that resolves is a file the read opens, so
    // refusing it here would leave a readable file as plain text.
    await expect(checkFiles([link])).resolves.toEqual({ reachable: [link] });
    await expect(readTextFile(link)).resolves.toMatchObject({ text: 'export const answer = 42;\n' });
  });

  it('says no to a binary file’s absence and yes to its presence', async () => {
    // Deliberately *not* the read's rule. `logo.png` is there, so it is a link,
    // and clicking it gets the honest sentence about what it is. Sniffing every
    // path in a transcript to decide whether to underline a word would be eight
    // kilobytes of read per word to answer a question nobody asked.
    const binary = await fileWith('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    await expect(checkFiles([binary])).resolves.toEqual({ reachable: [binary] });
    await expect(readTextFile(binary)).rejects.toThrow(/binary file/);
  });

  it('takes an empty batch, which is what a deduplicated request can become', async () => {
    await expect(checkFiles([])).resolves.toEqual({ reachable: [] });
  });

  it('answers about a whole batch rather than stopping at the first miss', async () => {
    const one = await fileWith('one.ts', 'a');
    const two = await fileWith('two.ts', 'b');
    const gone = join(tmpdir(), 'artemis-not-a-real-file-4472.ts');

    const { reachable } = await checkFiles([gone, one, gone, two]);
    expect([...reachable].sort()).toEqual([one, two].sort());
  });
});
