/**
 * Reading a file so it can be looked at.
 * ============================================================================
 *
 * The transcript is full of paths — the agent read this, edited that, and says
 * so in prose afterwards — and until this file existed every one of them was
 * inert text. `preview.ts` could open five extensions, all of them chosen for
 * being *renderable*; the `.ts` file the whole conversation was about was not
 * among them. This is the other half: not "render this as a browser would" but
 * "show me what is in it".
 *
 * ## Why this is a separate channel, and not a sixth entry in `RENDERABLE`
 *
 * Because the two make opposite promises about what comes back. A preview may
 * answer with a URL for a document that executes script, which is why it is
 * gated on a closed list of extensions and served from a scheme of its own. This
 * answers with **text, always** — there is no branch here that produces
 * something frameable — and that is precisely what lets it accept any file at
 * all. A `.html` read through this channel is source code on screen, not a page
 * running in a frame, and nothing downstream can confuse the two because the
 * response has no field that could carry one.
 *
 * ## Three gates, and what each is really for
 *
 * **It must be a file.** A directory read as a file fails with `EISDIR` on
 * Linux and succeeds with nonsense on macOS, so it is checked rather than
 * discovered.
 *
 * **It must be text.** {@link looksBinary} scans the head for a NUL byte, which
 * is the same heuristic `git` uses to decide whether to print a diff, and it is
 * chosen over an extension allow-list on purpose: the files people want here are
 * `Makefile`, `.env`, `justfile`, `foo.rs`, `query.sql` — an allow-list would
 * have to grow forever and would still be wrong on the day someone writes
 * `.mts`. Refusing on *content* asks the question that was actually meant.
 *
 * **It must be bounded.** {@link MAX_BYTES} of it is read and the rest is left
 * on disk. Note that this truncates rather than refusing, which is the opposite
 * of what `preview.ts` does with an oversized file, and deliberately: a preview
 * of half a page is a broken page, while the first two megabytes of a log is
 * exactly what someone opening a log wants. The response says which happened, so
 * the caption can be honest about it.
 *
 * ## What is deliberately not checked: where the file lives
 *
 * The same gap `preview.ts` records at length, for the same reasons, and it is
 * repeated here rather than cross-referenced because a reader arriving at this
 * file is entitled to know without going and finding the other one. Under the
 * compromised-renderer threat model in `validate.ts`, this channel is a read of
 * any text file on disk. It is not confined to a workspace because main holds no
 * honest set of roots to confine to — the directory picker retains nothing, a
 * run's cwd dies with the run while transcripts outlive it, and the paths worth
 * opening legitimately include `/tmp` and the user's dotfiles.
 *
 * What is different here, and worth weighing, is that text is a *broader* target
 * than the five renderable extensions: `~/.ssh/id_rsa` is text. Against that,
 * the renderer already relays the agent's own tool results, which is a strictly
 * larger read of the same disk through a channel that has to exist. So this adds
 * reach, not a new class of exposure, and the fix for both is the same one
 * `preview.ts` names: main remembering which paths it has seen the agent touch.
 * Until that exists, this paragraph is the record that the gap is known.
 *
 * ## And {@link checkFiles}, which is the same read with the file left out
 *
 * The renderer draws a path in an answer as a link, and the rule it uses to
 * spot one is a judgement about *text* — no whitespace, a filename-shaped tail.
 * That rule cannot tell a file the agent edited from one it has only proposed
 * writing, so before this existed every path-shaped fragment was underlined and
 * a good half of them opened onto "there is no file at …".
 *
 * So: a batch of paths in, the ones that are files out. It answers strictly less
 * than {@link readTextFile} about each path — a boolean where the other returns
 * the contents — and is reachable by exactly the same caller, which is what
 * makes it uninteresting from the threat model above. It is an existence oracle
 * for a renderer that already has a read oracle.
 *
 * It is `stat` and nothing else. Not the binary sniff, which would mean opening
 * and reading eight kilobytes of every path in a transcript to decide whether to
 * underline a word — and would be answering the wrong question anyway. `logo.png`
 * *is* there; the honest thing is to link it and let the read say what it is.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  DirectoryEntry,
  FilesCheckResponse,
  FilesListResponse,
  FilesReadResponse,
} from '@rx-artemis/protocol';

/**
 * How much of a file is read.
 *
 * Two megabytes is about 40,000 lines of source, which is past anything anyone
 * reads in a viewer with no search in it. The number is not precious; that the
 * read is *bounded* is, because the alternative is a renderer holding a 4GB
 * core dump as a JavaScript string.
 */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * How much of the head is scanned for the NUL that says "binary".
 *
 * `git` uses 8000 bytes for the same decision. Scanning the whole buffer would
 * catch a file that is text for a megabyte and then embeds a blob, at the cost
 * of a full pass over every file opened; the head is where an actual binary's
 * magic number and padding are, so it is where the answer almost always is.
 */
const SNIFF_BYTES = 8_000;

/**
 * Does this look like something no one wants rendered as text?
 *
 * A NUL byte in the head. Crude, and correct for the thing it is asked: UTF-8
 * text cannot contain one, every common binary format has one within a few
 * hundred bytes, and the failure mode in the rare miss — a file of control
 * characters drawn as replacement glyphs — is ugly rather than harmful.
 */
function looksBinary(head: Buffer): boolean {
  return head.includes(0);
}

/**
 * Read the file at `path` as text.
 *
 * Throws a plain `Error` on anything that stops it, exactly as `grantPreview`
 * does: the IPC layer turns that into a typed failure, and every message here is
 * written to be read by the person who clicked the link rather than by whoever
 * is reading the log.
 */
export async function readTextFile(path: string): Promise<FilesReadResponse> {
  const info = await stat(path).catch(() => null);
  if (info === null) throw new Error(`There is no file at ${path}.`);
  if (info.isDirectory()) throw new Error(`${basename(path)} is a folder, not a file.`);
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);

  const handle = await open(path, 'r');
  try {
    /*
     * One allocation, capped, and filled by a single read — rather than
     * `readFile` followed by a slice, which would pull a 4GB file entirely into
     * memory in order to throw most of it away. `bytesRead` is what the file
     * actually had, which is not the same as the buffer's length for anything
     * smaller than the cap.
     */
    const buffer = Buffer.allocUnsafe(MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0);
    const body = buffer.subarray(0, bytesRead);

    if (looksBinary(body.subarray(0, SNIFF_BYTES))) {
      throw new Error(`${basename(path)} is a binary file, so there is nothing to show as text.`);
    }

    return {
      path,
      title: basename(path),
      // The size from the `stat`, not `bytesRead`: the caption's job is to say
      // how big the file is, and those two differ by exactly the amount that
      // makes `truncated` worth reporting.
      bytes: info.size,
      /*
       * A truncated read can end mid-character, and decoding one byte of a
       * three-byte glyph produces a replacement character at the very end of the
       * text. That is accepted rather than fixed: trimming back to a boundary
       * would mean decoding twice to find it, for one wrong glyph in a file
       * whose last forty megabytes are already missing.
       */
      text: body.toString('utf8'),
      truncated: bytesRead < info.size,
    };
  } finally {
    // Closed on the throw as well as on the return. A refused binary that leaked
    // its descriptor would take a few hundred mistaken clicks to exhaust the
    // process's table, which is exactly long enough to look like something else.
    await handle.close();
  }
}

/**
 * Which of `paths` are files that exist.
 *
 * Never throws for a path's sake — a missing file, a folder, a directory
 * component that is not one, a permission the user does not have: every one of
 * those is an answer rather than a fault, and the answer is "not that one". The
 * caller is deciding what to underline and has nothing to do with a reason.
 *
 * The whole batch is stat'd at once rather than in sequence. These are metadata
 * reads against a page cache that a transcript's worth of them will already be
 * warm in, and `Promise.all` over a few dozen of them is one tick; a loop with
 * an `await` in it is a few dozen. The count is bounded by the validator rather
 * than here, so this stays a function about the filesystem.
 */
export async function checkFiles(paths: readonly string[]): Promise<FilesCheckResponse> {
  const results = await Promise.all(
    paths.map(async (path) => {
      const info = await stat(path).catch(() => null);
      // `isFile`, not merely "the stat succeeded". A directory passes an
      // existence check and then fails the read with `is a folder, not a file`,
      // which is precisely the dead link this exists to prevent. `stat` follows
      // symlinks, so a link to a real file answers yes — which is what the read
      // will do with it too.
      return info?.isFile() === true ? path : null;
    }),
  );

  return { reachable: results.filter((path): path is string => path !== null) };
}

/**
 * How many entries one listing will report.
 *
 * A bound on work rather than on reach, exactly like `LIMITS.checkPaths`. The
 * renderer draws a scrolling list, so the cap is generous enough that no
 * ordinary project reaches it — and `node_modules` at the wrong moment is why
 * there is one at all.
 */
export const MAX_ENTRIES = 2_000;

/**
 * List the directory at `path`.
 * ============================================================================
 *
 * The other half of {@link readTextFile}, and deliberately the *smaller* half:
 * it answers with names and kinds and never with contents. Whatever this can
 * see, `readTextFile` could already read in full through the same validator —
 * which is the same argument `checkFiles` makes for itself, and the reason this
 * adds nothing to how far the channel reaches.
 *
 * ## What a symlink is reported as
 *
 * What it points at, because that is what clicking it will do. `withFileTypes`
 * answers `isSymbolicLink()` for the link itself, which would put a symlinked
 * directory in the file half of the list and open it as text. So links are
 * resolved with a `stat`, and one that resolves to nothing is `other` rather
 * than dropped: a broken link is a real thing in the directory and hiding it
 * would make the list a lie about what is there.
 *
 * ## Order
 *
 * Directories first, then files, each alphabetically and case-insensitively.
 * That is what every file browser on the machine does, and a listing in
 * `readdir` order — which is the filesystem's, not anybody's — reads as
 * unsorted rather than as differently sorted.
 */
export async function listDirectory(path: string): Promise<FilesListResponse> {
  const info = await stat(path).catch(() => null);
  if (info === null) throw new Error(`There is no folder at ${path}.`);
  if (!info.isDirectory()) throw new Error(`${basename(path)} is a file, not a folder.`);

  const raw = await readdir(path, { withFileTypes: true }).catch(() => {
    // The message is for the person who clicked, and the only cause they can
    // act on is permission — every other failure of `readdir` on a directory
    // that just stat'ed is a race not worth naming.
    throw new Error(`Could not read ${basename(path)}. Check its permissions.`);
  });

  const truncated = raw.length > MAX_ENTRIES;
  const entries: DirectoryEntry[] = [];

  for (const item of raw.slice(0, MAX_ENTRIES)) {
    // A `stat` per entry only where it is needed: `withFileTypes` already
    // answers for everything that is not a link, and a project of a thousand
    // files should not cost a thousand syscalls to list.
    let kind: DirectoryEntry['kind'];
    let bytes: number | undefined;

    if (item.isSymbolicLink()) {
      const target = await stat(join(path, item.name)).catch(() => null);
      kind = target === null ? 'other' : target.isDirectory() ? 'directory' : 'file';
      if (target?.isFile() === true) bytes = target.size;
    } else if (item.isDirectory()) {
      kind = 'directory';
    } else if (item.isFile()) {
      kind = 'file';
      // Deliberately not stat'ed. The size is a nicety on a row, and paying a
      // syscall per file to caption one would make listing a large directory
      // slower than reading a file in it.
    } else {
      kind = 'other';
    }

    entries.push({ name: item.name, kind, ...(bytes === undefined ? {} : { bytes }) });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === 'directory') return -1;
      if (b.kind === 'directory') return 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return { path, entries, truncated };
}
