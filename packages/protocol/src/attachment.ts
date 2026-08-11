/**
 * Things sent alongside a prompt.
 *
 * Two kinds, and the split is not cosmetic — it is the difference between two
 * ways of getting something in front of a model.
 *
 * ## Images go *into* the prompt; files go *next to* it
 *
 * An **image** becomes a content block on the wire. The model sees the pixels
 * as part of the message, because there is no other way for it to see them:
 * neither provider has a tool that can look at a picture.
 *
 * A **file** is staged to disk and named in the prompt, and the agent opens it
 * with the tools it already has. That is the whole mechanism, and it is the
 * right one for a coding agent for a reason worth writing down: inlining a 5MB
 * CSV costs on the order of a million tokens and *answers worse* than letting
 * the agent run `head` on it, infer the schema, and grep the twelve rows that
 * matter. The agent reading the file is not a fallback for not being able to
 * send it — it is the better outcome.
 *
 * PDFs are where both are true at once. Claude's `document` block gives the
 * model vision over the rendered pages — layout, tables, charts, scanned text —
 * which no amount of reading the file as bytes recovers. So a PDF sent to
 * Claude is *both*: a document block for the eyes, and a staged path for the
 * tools. See `stageAttachments` in `@rx-artemis/core`.
 *
 * ## Bytes, not paths
 *
 * Both kinds carry their own base64 payload rather than a path the main process
 * would read. Two reasons, and the first is the one that matters:
 *
 *  1. **A path from the renderer is a request to read an arbitrary file.** The
 *     renderer is sandboxed and cannot open `~/.ssh/id_rsa`; if it could ask
 *     the main process to attach that path to a prompt, it would have got there
 *     anyway, by a route with no user in it. Bytes keep the boundary where it
 *     is: the renderer can only send what the OS already handed it through a
 *     paste, a drop or a file picker — every one of which is a user gesture.
 *  2. Pasted images have no path to begin with, so a path-shaped protocol would
 *     need a second shape for the most common case.
 *
 * Electron's `webUtils.getPathForFile` would give a real path for a dropped
 * file without that first problem — the renderer cannot fabricate a `File` for
 * a path the user did not choose. It is still not what this does, because the
 * agent has to be able to *read* wherever the file lives: honouring the
 * original path means granting the agent the user's whole Downloads folder,
 * where staging a copy grants it one temp directory holding exactly the files
 * that were attached.
 *
 * The cost is that everything crosses IPC as base64 and sits in memory twice
 * for the length of the call, which is why {@link ATTACHMENT_LIMITS} exists and
 * is enforced at the boundary rather than left to good behaviour upstream.
 */

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Image formats every supported provider can read as an image.
 *
 * The intersection of what the Anthropic Messages API accepts and what the
 * models behind Codex accept, which is the same four. Anything else — HEIC off
 * an iPhone, a TIFF, a PSD — is not rejected: it is simply *not an image* as
 * far as this app is concerned, and rides along as a file instead, which is a
 * better answer than refusing it.
 *
 * SVG's absence is deliberate rather than an oversight: it is a document that
 * can carry script and fetch remote resources, and no provider treats it as an
 * image. As a file it is exactly what it is — text the agent can read.
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Runtime type guard for {@link ImageMediaType}. */
export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * PDF, named once.
 *
 * The one media type that is neither an image nor plain text to a provider, and
 * the only file kind that gets a native content block as well as a staged path.
 */
export const PDF_MEDIA_TYPE = 'application/pdf';

/**
 * One image travelling with a prompt.
 *
 * `id` is minted by the renderer and is what the transcript keys its thumbnail
 * off, so an attachment stays identifiable after the send without the renderer
 * having to match on payloads.
 */
export interface ImageAttachment {
  readonly kind: 'image';
  readonly id: string;
  readonly mediaType: ImageMediaType;
  /**
   * Base64, standard alphabet, no `data:` prefix and no whitespace — exactly
   * what the Anthropic Messages API's `source.data` wants, so no consumer has
   * to strip a prefix it did not expect.
   */
  readonly data: string;
  /**
   * The file's own name, when it had one. Pasted images have none.
   *
   * A label for the user, and nothing else depends on it: it is not a path, it
   * is not unique, and image staging deliberately does not use it to name the
   * file it writes. Treat it as untrusted text — it came from a filename, which
   * can contain anything.
   */
  readonly name?: string;
  /** Pixel dimensions, when the renderer decoded them. Display only. */
  readonly width?: number;
  readonly height?: number;
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One file travelling with a prompt, to be staged where the agent can read it.
 *
 * Any format at all. There is no allow-list, on purpose: the agent has `Read`,
 * `Grep` and a shell, so the set of files it can do something useful with is
 * far wider than any list this package could keep current, and a user who
 * attaches a `.parquet` or a `.sqlite` is better served by an agent that tries
 * than by a dialog explaining that the format is unsupported.
 */
export interface FileAttachment {
  readonly kind: 'file';
  readonly id: string;
  /**
   * The filename, and unlike an image's it is **load-bearing**: the staged file
   * is named after it, so the path the agent is given reads as
   * `…/quarterly-sales.csv` rather than `…/file-3`, and the agent knows what it
   * has before it opens anything.
   *
   * Which makes it the one field here an attacker upstream could shape into a
   * path, so it is sanitized to a single safe path component before it is used
   * — see `safeFileName` in `@rx-artemis/core`. Everything reading it for
   * display should still treat it as untrusted text.
   */
  readonly name: string;
  /**
   * The media type the OS reported, when it reported one. Advisory: browsers
   * routinely hand over an empty string for anything they do not recognise, and
   * the agent works out what a file is by reading it. Only
   * {@link PDF_MEDIA_TYPE} changes behaviour.
   */
  readonly mediaType?: string;
  /** Base64, standard alphabet, no `data:` prefix and no whitespace. */
  readonly data: string;
}

/* -------------------------------------------------------------------------- */
/* The union                                                                  */
/* -------------------------------------------------------------------------- */

/** Anything that can ride along with a prompt. Discriminate on `kind`. */
export type Attachment = ImageAttachment | FileAttachment;

/** Narrow an {@link Attachment} to the image case. */
export function isImageAttachment(value: Attachment): value is ImageAttachment {
  return value.kind === 'image';
}

/** Narrow an {@link Attachment} to the file case. */
export function isFileAttachment(value: Attachment): value is FileAttachment {
  return value.kind === 'file';
}

/** True for a file the providers can also render as a document block. */
export function isPdf(value: Attachment): value is FileAttachment {
  return value.kind === 'file' && value.mediaType === PDF_MEDIA_TYPE;
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ceilings on what one prompt may carry.
 *
 * Product limits, not just guardrails: the composer enforces them *before* the
 * send so the user finds out while they can still do something about it, and
 * the main process enforces them again because a renderer is not a trusted
 * enforcer of its own limits.
 *
 * The two byte ceilings differ by an order of magnitude because the two kinds
 * are spent differently. An image's bytes become tokens in the request, so five
 * megabytes is already generous — and it is Anthropic's own per-image ceiling.
 * A file's bytes become a file on disk; nothing reads it unless the agent
 * chooses to, and a 30MB log is a perfectly reasonable thing to hand someone
 * whose first move will be to grep it. What bounds the file ceiling is the
 * base64 round-trip through IPC, not the model's context.
 */
export const ATTACHMENT_LIMITS = {
  /** How many images may ride along with one prompt. */
  images: 4,
  /** How many files may ride along with one prompt. */
  files: 10,
  /** Decoded bytes, per image. */
  bytesPerImage: 5 * 1024 * 1024,
  /** Decoded bytes, per file. */
  bytesPerFile: 32 * 1024 * 1024,
  /** Decoded bytes, summed across everything on a single prompt. */
  bytesTotal: 64 * 1024 * 1024,
  /** Characters of `name`. */
  nameLength: 200,
} as const;

/**
 * Decoded size of a base64 payload, without decoding it.
 *
 * Every size check in the app runs on this rather than on `data.length`, so the
 * number the user is shown, the number the composer refuses on and the number
 * the main process refuses on are all the same number.
 */
export function base64Bytes(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Decoded size of one attachment. @see base64Bytes */
export function attachmentBytes(attachment: Attachment): number {
  return base64Bytes(attachment.data);
}
