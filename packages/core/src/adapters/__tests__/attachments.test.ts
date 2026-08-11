/**
 * Tests for attachment staging.
 *
 * Against the real filesystem, in a real temp directory. Mocking `node:fs` here
 * would test the mock — the whole point of this code is that a byte payload
 * becomes a file another process can open, and only the filesystem can say
 * whether it did.
 *
 * `safeFileName` gets the most attention of anything in this file, and it earns
 * it: a file attachment's name is the one piece of user-supplied text that is
 * allowed to influence a path, and the consequence of getting it wrong is a
 * write outside the directory the run is allowed to touch.
 */

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FileAttachment, ImageAttachment } from '@rx-artemis/protocol';

import {
  createStagingDirectory,
  describeStagedAttachments,
  removeStagingDirectory,
  safeFileName,
  stageAttachments,
  withAttachmentNote,
} from '../attachments.js';
import { isAdapterError } from '../types.js';

/** "hello" in base64, so a staged file's contents are checkable by eye. */
const HELLO = 'aGVsbG8=';

const file = (over: Partial<FileAttachment> = {}): FileAttachment => ({
  kind: 'file',
  id: 'file-1',
  name: 'notes.md',
  data: HELLO,
  ...over,
});

const image = (over: Partial<ImageAttachment> = {}): ImageAttachment => ({
  kind: 'image',
  id: 'img-1',
  mediaType: 'image/png',
  data: HELLO,
  ...over,
});

async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-attach-test-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('safeFileName', () => {
  it('keeps an ordinary name intact, because the name is the point', () => {
    // An agent handed `…/quarterly-sales.csv` knows what it has before it opens
    // anything. Sanitizing that into `file-3` would defeat the feature.
    expect(safeFileName('quarterly-sales.csv', 'fallback')).toBe('quarterly-sales.csv');
    expect(safeFileName('.eslintrc.json', 'fallback')).toBe('.eslintrc.json');
  });

  it('reduces traversal to its basename', () => {
    expect(safeFileName('../../etc/passwd', 'fallback')).toBe('passwd');
    expect(safeFileName('/etc/passwd', 'fallback')).toBe('passwd');
    expect(safeFileName('..\\..\\windows\\system32\\config', 'fallback')).toBe('config');
  });

  it('falls back when nothing survives', () => {
    expect(safeFileName('..', 'fallback')).toBe('fallback');
    expect(safeFileName('.', 'fallback')).toBe('fallback');
    expect(safeFileName('', 'fallback')).toBe('fallback');
    expect(safeFileName('///', 'fallback')).toBe('fallback');
    expect(safeFileName('   ', 'fallback')).toBe('fallback');
  });

  it('strips NUL and control bytes', () => {
    // A NUL truncates the path in any syscall that takes a C string, which is
    // how `evil.txt\u0000.png` becomes `evil.txt` somewhere below this code.
    expect(safeFileName("evil\u0000.txt", "fallback")).toBe("evil.txt");
    expect(safeFileName("a\u001fb\u007fc.txt", "fallback")).toBe("abc.txt");
  });

  it('strips a leading dash, which a shell would read as a flag', () => {
    expect(safeFileName('-rf.txt', 'fallback')).toBe('rf.txt');
    expect(safeFileName('--output=/etc/hosts', 'fallback')).toBe('hosts');
  });

  it('sidesteps the Windows reserved names', () => {
    // `CON.txt` is still `CON` on Windows, whatever the extension.
    expect(safeFileName('CON', 'fallback')).toBe('_CON');
    expect(safeFileName('con.txt', 'fallback')).toBe('_con.txt');
    expect(safeFileName('LPT1.log', 'fallback')).toBe('_LPT1.log');
    // Not reserved — only the exact stems are.
    expect(safeFileName('console.log', 'fallback')).toBe('console.log');
  });

  it('drops trailing dots and spaces, which Windows silently eats', () => {
    // Left alone, `report.txt.` and `report.txt` are two names for one file.
    expect(safeFileName('report.txt.', 'fallback')).toBe('report.txt');
    expect(safeFileName('report.txt   ', 'fallback')).toBe('report.txt');
  });

  it('truncates a long name but keeps its extension', () => {
    // The extension is what tells the agent — and Codex's media-type sniffing —
    // what the file is, so it is the last thing to go.
    const long = `${'a'.repeat(400)}.csv`;
    const result = safeFileName(long, 'fallback');
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('.csv')).toBe(true);
  });
});

describe('stageAttachments', () => {
  it('writes the decoded bytes under the attachment name', async () => {
    await withTempDir(async (dir) => {
      const [staged] = await stageAttachments(dir, [file({ name: 'notes.md' })]);
      expect(staged?.path).toBe(join(dir, 'notes.md'));
      expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('hello');
    });
  });

  it('names images by counter and extension, never by their label', async () => {
    // An image's `name` is display text only — nothing reads the staged file
    // back by name, so a counter is both sufficient and untraversable.
    await withTempDir(async (dir) => {
      const staged = await stageAttachments(dir, [
        image({ mediaType: 'image/jpeg', name: '../../etc/passwd' }),
        image({ id: 'img-2', mediaType: 'image/webp' }),
      ]);
      expect(staged.map((entry) => entry.path)).toEqual([
        join(dir, 'image-1.jpg'),
        join(dir, 'image-2.webp'),
      ]);
    });
  });

  it('never writes outside the directory, whatever the name', async () => {
    await withTempDir(async (dir) => {
      await stageAttachments(dir, [
        file({ name: '../escaped.txt' }),
        file({ id: 'f2', name: '/etc/passwd' }),
      ]);
      // The proof is the directory listing: if either had escaped, the parent
      // would hold a file and this directory would not.
      expect((await readdir(dir)).sort()).toEqual(['escaped.txt', 'passwd']);
    });
  });

  it('disambiguates two attachments with the same name', async () => {
    // Dropping two `report.csv`s from different folders is an ordinary thing to
    // do, and silently keeping only the second would be a data-loss bug.
    await withTempDir(async (dir) => {
      const staged = await stageAttachments(dir, [
        file({ name: 'report.csv' }),
        file({ id: 'f2', name: 'report.csv' }),
        file({ id: 'f3', name: 'report.csv' }),
      ]);
      expect(staged.map((entry) => entry.path)).toEqual([
        join(dir, 'report.csv'),
        join(dir, 'report (2).csv'),
        join(dir, 'report (3).csv'),
      ]);
      expect((await readdir(dir)).length).toBe(3);
    });
  });

  it('continues numbering from an offset, so a steer cannot overwrite a prompt', async () => {
    await withTempDir(async (dir) => {
      await stageAttachments(dir, [image()]);
      const [second] = await stageAttachments(dir, [image({ id: 'img-2' })], 1);
      expect(second?.path).toBe(join(dir, 'image-2.png'));
      expect((await readdir(dir)).sort()).toEqual(['image-1.png', 'image-2.png']);
    });
  });

  it('writes an empty payload as an empty file rather than failing', async () => {
    await withTempDir(async (dir) => {
      const [staged] = await stageAttachments(dir, [file({ name: 'empty.txt', data: '' })]);
      expect((await stat(staged?.path ?? '')).size).toBe(0);
    });
  });

  it('fails loudly when the directory cannot be written to', async () => {
    // Rather than dropping the attachment and sending the text: a question
    // about a file the agent never received gets a confident, useless answer.
    const missing = join(tmpdir(), 'artemis-attach-does-not-exist', 'nested');
    await expect(stageAttachments(missing, [file()])).rejects.toSatisfy(isAdapterError);
  });
});

describe('the staging directory', () => {
  it('is unique per call, so one run disposing cannot delete another’s', async () => {
    const a = await createStagingDirectory();
    const b = await createStagingDirectory();
    try {
      expect(a).not.toBe(b);
    } finally {
      await removeStagingDirectory(a);
      await removeStagingDirectory(b);
    }
  });

  it('is removed with its contents, and removing it twice is not an error', async () => {
    const dir = await createStagingDirectory();
    await stageAttachments(dir, [file()]);
    await removeStagingDirectory(dir);
    await expect(stat(dir)).rejects.toThrow();
    // Dispose can run after a teardown that already cleaned up.
    await expect(removeStagingDirectory(dir)).resolves.toBeUndefined();
  });
});

describe('describeStagedAttachments', () => {
  it('names every path and size, because nothing else tells the agent', async () => {
    // This sentence is the entire mechanism. Without it the files are on disk
    // and nobody knows — the agent answers from the prompt text alone and
    // nothing anywhere reports that an attachment was ignored.
    await withTempDir(async (dir) => {
      const staged = await stageAttachments(dir, [file({ name: 'sales.csv' })]);
      const note = describeStagedAttachments(staged);

      expect(note).toContain(join(dir, 'sales.csv'));
      expect(note).toContain('5 B');
      expect(note).toMatch(/attached 1 file/);
    });
  });

  it('is empty for an empty list, so callers can concatenate blindly', () => {
    expect(describeStagedAttachments([])).toBe('');
  });

  it('pluralises, because a model reads this as English', async () => {
    await withTempDir(async (dir) => {
      const staged = await stageAttachments(dir, [file(), file({ id: 'f2', name: 'b.md' })]);
      expect(describeStagedAttachments(staged)).toMatch(/attached 2 files/);
    });
  });
});

describe('withAttachmentNote', () => {
  it('puts the note before the prompt, separated by a blank line', () => {
    // Leading, matching how images are ordered and for the same reason: a
    // question asked before its context is answered worse. The blank line stops
    // the user's first sentence running on from the last path.
    expect(withAttachmentNote('what changed?', 'NOTE')).toBe('NOTE\n\nwhat changed?');
  });

  it('leaves the prompt alone when there is no note', () => {
    expect(withAttachmentNote('what changed?', '')).toBe('what changed?');
  });

  it('does not leave leading blank lines on an empty prompt', () => {
    expect(withAttachmentNote('', 'NOTE')).toBe('NOTE');
  });
});
