/**
 * Putting a prompt's attachments where the agent can read them.
 *
 * Both adapters do the same three things with a file: write it to a directory
 * of their own, tell the provider that directory is readable, and name the
 * resulting paths in the prompt. Only the second of those differs between them,
 * so the other two live here.
 *
 * The mechanism is deliberately unglamorous — a temp directory and a sentence
 * of prose — and that is the point. The agent already has `Read`, `Grep` and a
 * shell; the only thing it was missing was the file being somewhere and knowing
 * that it is. See the note at the top of `protocol/attachment.ts` for why this
 * beats encoding the file into the prompt.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  ATTACHMENT_LIMITS,
  attachmentBytes,
  isFileAttachment,
  type Attachment,
  type FileAttachment,
  type ImageAttachment,
  type ImageMediaType,
} from '@rx-artemis/protocol';

import { adapterError } from './types.js';

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * File extension for an image, so a staged image's name matches its bytes.
 *
 * Codex re-encodes a `localImage` into a `data:<media-type>;base64,…` URL for
 * the model and derives that media type from the path, so a `.png` holding JPEG
 * bytes is not a cosmetic mismatch — it is a mislabelled image sent to the API.
 */
const IMAGE_EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Names Windows will not give a file, whatever the extension.
 *
 * `CON.txt` is still `CON`. Artemis is developed on macOS and this list has
 * never fired there, which is exactly why it is here: the failure it prevents
 * is one nobody testing this feature would ever see.
 */
const RESERVED_STEMS =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Windows forbids these outright; the rest are separators or control bytes. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f<>:"|?*\\\/]/g;

/**
 * Turn an attachment's name into one safe path component.
 *
 * The **only** place a user-supplied name is allowed to influence a path, and
 * the reason a file's name is allowed to influence one at all: an agent handed
 * `/tmp/…/quarterly-sales.csv` knows what it has before it opens anything,
 * where `/tmp/…/file-3` tells it nothing. That is worth a sanitizer.
 *
 * Everything that could make the name mean something other than "a file in this
 * directory" is removed rather than escaped — separators, traversal, control
 * characters, the Windows-reserved set, leading dashes that a shell would read
 * as a flag. What survives is truncated, and if nothing survives the caller's
 * fallback is used. The result is *checked* against the directory by
 * {@link stageAttachments} regardless, because a sanitizer is a nicer error
 * message than a containment check, not a substitute for one.
 */
export function safeFileName(name: string, fallback: string): string {
  // Basename first: a name of `../../etc/passwd` should become `passwd`, not
  // `......etcpasswd` — strip the structure, then clean what is left.
  const base = name.split(/[/\\]/).pop() ?? '';

  let cleaned = base
    .replace(UNSAFE_CHARACTERS, '')
    // A leading dash makes the path look like an option to any command the
    // agent runs over it; a leading dot only makes it hidden, which is fine.
    .replace(/^-+/, '')
    .trim()
    // Windows silently drops trailing dots and spaces, which turns two distinct
    // names into one file. Drop them here, where it is visible.
    .replace(/[. ]+$/, '');

  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  if (RESERVED_STEMS.test(cleaned)) cleaned = `_${cleaned}`;

  if (cleaned.length > ATTACHMENT_LIMITS.nameLength) {
    // Truncate the stem, keep the extension: the extension is what tells the
    // agent (and Codex's media-type sniffing) what the file is.
    const dot = cleaned.lastIndexOf('.');
    const extension = dot > 0 ? cleaned.slice(dot) : '';
    const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).slice(
      0,
      Math.max(1, ATTACHMENT_LIMITS.nameLength - extension.length),
    );
    cleaned = `${stem}${extension}`;
  }

  return cleaned;
}

/** `report.csv` → `report (2).csv`, so two attachments never collide. */
function disambiguate(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${String(n)})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/* -------------------------------------------------------------------------- */
/* Staging                                                                    */
/* -------------------------------------------------------------------------- */

/** One attachment, written to disk. */
export interface StagedAttachment {
  readonly attachment: Attachment;
  /** Absolute path to the written file. */
  readonly path: string;
}

/** Everything one run staged, and where. */
export interface StagedAttachments {
  /** The directory holding them, to be granted and later removed. */
  readonly directory: string;
  readonly items: readonly StagedAttachment[];
}

/** Create a directory for one run's attachments. Caller owns removing it. */
export async function createStagingDirectory(): Promise<string> {
  try {
    // `mkdtemp` rather than a fixed name: two runs staging at once must not
    // share a directory, or disposing the first deletes the second's files.
    return await mkdtemp(join(tmpdir(), 'artemis-attach-'));
  } catch (error) {
    throw adapterError(
      'transport',
      `Could not create a temporary directory to stage attachments: ${describeCause(error)}`,
      { cause: error },
    );
  }
}

/** Remove a staging directory. Best effort — never throws. */
export async function removeStagingDirectory(
  directory: string,
  onFailure?: (message: string) => void,
): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    onFailure?.(
      `Could not remove the attachment staging directory ${directory}: ${describeCause(error)}`,
    );
  }
}

/**
 * Write attachments into `directory` and report where each one landed.
 *
 * ## Why a failure here fails the turn
 *
 * A prompt that says "why is this button misaligned?" is not a prompt without
 * its screenshot; it is a question about nothing, and the answer will be
 * confident and useless. The same goes for "summarise the attached report".
 * Staging failures are rare and loud — no writable temp directory, a full disk
 * — and every one of them is worth interrupting for, so this throws rather than
 * dropping the attachment and sending the text alone.
 *
 * `startIndex` continues the caller's numbering so a mid-run steer does not
 * overwrite what the opening prompt staged.
 */
export async function stageAttachments(
  directory: string,
  attachments: readonly Attachment[],
  startIndex = 0,
): Promise<readonly StagedAttachment[]> {
  const taken = new Set<string>();
  const root = resolve(directory);

  return Promise.all(
    attachments.map(async (attachment, offset): Promise<StagedAttachment> => {
      const index = startIndex + offset + 1;
      const name = disambiguate(fileNameFor(attachment, index), taken);
      taken.add(name.toLowerCase());

      const path = join(root, name);
      // Belt and braces. `safeFileName` should make this unreachable, and an
      // unreachable check on the one path built from user input is the check
      // worth keeping: if the sanitizer is ever wrong, this is what stops the
      // write from landing outside the directory the run is allowed to touch.
      if (path !== root && !path.startsWith(root + sep)) {
        throw adapterError(
          'invalid_request',
          `Refusing to stage an attachment outside its own directory (${name}).`,
        );
      }

      try {
        await writeFile(path, Buffer.from(attachment.data, 'base64'));
      } catch (error) {
        throw adapterError(
          'transport',
          `Could not stage an attachment at ${path}: ${describeCause(error)}`,
          { cause: error },
        );
      }

      return { attachment, path };
    }),
  );
}

/** The name one attachment is written under, before collision handling. */
function fileNameFor(attachment: Attachment, index: number): string {
  if (isFileAttachment(attachment)) {
    return safeFileName(attachment.name, `attachment-${String(index)}`);
  }
  // Images are named by a counter, never by `attachment.name`: that string is
  // a label the transcript shows, nothing reads the staged image back by name,
  // and a counter cannot traverse.
  return `image-${String(index)}.${IMAGE_EXTENSIONS[attachment.mediaType]}`;
}

/* -------------------------------------------------------------------------- */
/* Telling the agent                                                          */
/* -------------------------------------------------------------------------- */

/** Human-readable size, for the note the agent reads. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The sentence that makes staging work.
 *
 * Without it the files are on disk and nobody knows, which is the entire
 * failure mode this feature has: a user attaches a CSV, the agent answers from
 * the prompt text alone, and nothing anywhere reports that a file was ignored.
 *
 * Written as prose with the paths in it rather than as a machine-readable
 * envelope, because the audience is a model that reads English and already
 * knows what to do with a path. The size is included so the agent can choose
 * between reading a file and grepping it without opening it first — which is
 * the whole reason this is cheaper than inlining the bytes.
 *
 * Images are excluded: they are already *in* the message as content blocks, and
 * pointing an agent at a staged copy invites it to spend a tool call opening a
 * picture it can already see. The Codex adapter is the exception — it stages
 * images because that is its only image transport — and it passes only its
 * non-image attachments here for exactly this reason.
 *
 * Returns an empty string for an empty list, so callers can concatenate.
 */
export function describeStagedAttachments(staged: readonly StagedAttachment[]): string {
  if (staged.length === 0) return '';

  const lines = staged.map(({ attachment, path }) => {
    const size = formatBytes(attachmentBytes(attachment));
    return `- ${path} (${size})`;
  });

  const noun = staged.length === 1 ? 'file' : 'files';
  return [
    `The user attached ${String(staged.length)} ${noun}, saved outside the working directory at:`,
    ...lines,
    '',
    `Read ${staged.length === 1 ? 'it' : 'them'} if the request depends on the contents. Large files are worth searching rather than reading whole.`,
  ].join('\n');
}

/**
 * Prepend the note to a prompt.
 *
 * Before the text, matching how images are ordered and for the same reason: a
 * question asked before its context is answered worse. The blank line matters —
 * without it the user's first sentence runs on from the last path.
 */
export function withAttachmentNote(prompt: string, note: string): string {
  if (note === '') return prompt;
  return prompt === '' ? note : `${note}\n\n${prompt}`;
}

/* -------------------------------------------------------------------------- */

/** Local copy of the adapters' error describer, to keep this module leaf-level. */
function describeCause(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Re-exported for adapters that need the narrowed types alongside staging. */
export type { FileAttachment, ImageAttachment };
