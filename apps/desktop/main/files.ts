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
 */

import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { FilesReadResponse } from '@rx-artemis/protocol';

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
