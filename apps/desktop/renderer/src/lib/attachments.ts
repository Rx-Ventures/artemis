/**
 * Turning what the OS hands over into something a provider can use.
 *
 * A paste, a drop and a file picker all produce the same thing — a `File`, or
 * near enough — and all three arrive here. What comes out is an `Attachment`,
 * and which kind it is depends on one question: can a provider *look* at it?
 *
 *  - The four image formats every provider reads become `ImageAttachment`s and
 *    are sent as content blocks, because no tool an agent has can look at a
 *    picture.
 *  - **Everything else** becomes a `FileAttachment`, is staged to disk by the
 *    adapter, and is read by the agent with the tools it already has.
 *
 * There is no allow-list on that second branch, deliberately. The agent has
 * `Read`, `Grep` and a shell, so the set of files it can do something useful
 * with is far wider than any list this file could keep current — and a user who
 * attaches a `.parquet` is better served by an agent that tries than by a
 * dialog explaining that the format is unsupported.
 *
 * ## Downscaling images is not an optimisation
 *
 * A screenshot from a retina display is routinely 8–12 megabytes of PNG, which
 * is over the per-image ceiling before the user has done anything unusual. The
 * options were to refuse those or to resize them; refusing the single most
 * common thing anyone will ever paste is not a real option, so an oversized
 * image is resized and the user is told.
 *
 * The re-encode is deliberately conservative: it only ever shrinks, it keeps
 * the aspect ratio, and it leaves anything already inside the limits completely
 * untouched — bytes in, same bytes out, no generation loss on an image that did
 * not need it. Files are never transformed at all; a file is its bytes.
 */

import {
  ATTACHMENT_LIMITS,
  base64Bytes,
  isImageMediaType,
  PDF_MEDIA_TYPE,
  type Attachment,
  type FileAttachment,
  type ImageAttachment,
  type ImageMediaType,
} from '@rx-artemis/protocol';

import { newId } from './id';

/**
 * Longest edge, in pixels, that an oversized image is fitted into.
 *
 * 1568 is the point past which the Anthropic API resizes server-side anyway —
 * sending more costs upload time and buys nothing. Codex's models are happy at
 * this size too, so there is one number rather than one per provider.
 */
const MAX_EDGE = 1568;

/** Re-encode quality for the lossy fallback. High enough that text stays sharp. */
const JPEG_QUALITY = 0.9;

export interface AttachmentRejection {
  /** The file's own name, for the message shown to the user. */
  readonly name: string;
  readonly reason: string;
}

export interface AttachmentIntake {
  readonly accepted: readonly Attachment[];
  /** Files that could not become attachments, each with a sentence saying why. */
  readonly rejected: readonly AttachmentRejection[];
}

/** How many of each kind the composer still has room for. */
export interface AttachmentSlots {
  readonly images: number;
  readonly files: number;
}

/** Human-readable size. Exported because the file chips show it too. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pull the files out of a paste or a drop.
 *
 * `DataTransfer.files` is the right list to read for both. `items` is the older
 * one and is tempting because it also carries the non-file entries, but a
 * screenshot pasted on macOS shows up in `files` with an empty `name`, and that
 * is the case this has to get right.
 */
export function filesFrom(transfer: DataTransfer | null): readonly File[] {
  if (!transfer) return [];
  return Array.from(transfer.files);
}

/** Base64 for a blob, without the `data:` prefix `readAsDataURL` puts on it. */
async function toBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked rather than `String.fromCharCode(...bytes)`: spreading a
  // multi-megabyte array into an argument list overflows the call stack, and it
  // does it at exactly the size where a screenshot lives.
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** Decode a blob far enough to know its pixel dimensions and draw it. */
async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);

  // jsdom has no `createImageBitmap`; the element path keeps this module
  // testable, and is a real fallback on any engine that lacks it.
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        resolve(image);
      };
      image.onerror = () => {
        reject(new Error('The file could not be decoded as an image.'));
      };
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Fit an image inside {@link MAX_EDGE} and the per-image byte ceiling.
 *
 * Returns `null` when the canvas is unavailable or refuses to export, which is
 * a real state in a locked-down renderer and has to be a rejection with a
 * sentence rather than a crash.
 */
async function downscale(
  blob: Blob,
): Promise<{ readonly blob: Blob; readonly mediaType: ImageMediaType } | null> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await decode(blob);
  } catch {
    return null;
  }

  const width = source.width;
  const height = source.height;
  if (width === 0 || height === 0) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ('close' in source) source.close();

  /*
   * PNG first, JPEG second.
   *
   * A screenshot is mostly flat colour and text, which PNG encodes both smaller
   * and sharper than JPEG does. But a *photograph* scaled to 1568px can still
   * exceed the ceiling as a PNG, and for a photograph JPEG is both the smaller
   * and the more faithful format. So: try the lossless one, and fall back only
   * when it did not fit.
   *
   * GIF and WebP are re-encoded to PNG rather than back to themselves — canvas
   * cannot write GIF at all, and an animated one has already lost its animation
   * by being drawn to a canvas. A still frame the model can see beats an
   * animation it cannot.
   */
  const png = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (png && png.size <= ATTACHMENT_LIMITS.bytesPerImage) {
    return { blob: png, mediaType: 'image/png' };
  }

  const jpeg = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
  });
  if (jpeg && jpeg.size <= ATTACHMENT_LIMITS.bytesPerImage) {
    return { blob: jpeg, mediaType: 'image/jpeg' };
  }

  // Both are still too big. Hand back the smaller one and let the caller
  // reject it with a size in the message — silently sending something the main
  // process will refuse is worse than saying so here.
  const candidates = [png, jpeg].filter((candidate): candidate is Blob => candidate !== null);
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (a.size <= b.size ? a : b));
  return { blob: best, mediaType: best.type === 'image/jpeg' ? 'image/jpeg' : 'image/png' };
}

/** Pixel dimensions, for display. Best effort — a thumbnail renders without them. */
async function dimensions(
  blob: Blob,
): Promise<{ readonly width: number; readonly height: number } | undefined> {
  try {
    const source = await decode(blob);
    const size = { width: source.width, height: source.height };
    if ('close' in source) source.close();
    return size.width > 0 && size.height > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

type Read<T> = { readonly attachment: T } | { readonly rejection: AttachmentRejection };

/** Read one image, resizing it if it is too big. */
async function readImage(file: File, mediaType: ImageMediaType): Promise<Read<ImageAttachment>> {
  const name = file.name.length > 0 ? file.name : 'pasted image';

  let blob: Blob = file;
  let type: ImageMediaType = mediaType;
  let resized = false;

  if (file.size > ATTACHMENT_LIMITS.bytesPerImage) {
    const smaller = await downscale(file);
    if (!smaller) {
      return {
        rejection: {
          name,
          reason: `It is ${formatBytes(file.size)} and could not be resized to fit under ${formatBytes(ATTACHMENT_LIMITS.bytesPerImage)}.`,
        },
      };
    }
    if (smaller.blob.size > ATTACHMENT_LIMITS.bytesPerImage) {
      return {
        rejection: {
          name,
          reason: `It is ${formatBytes(file.size)}, and even resized it is ${formatBytes(smaller.blob.size)} — over the ${formatBytes(ATTACHMENT_LIMITS.bytesPerImage)} limit.`,
        },
      };
    }
    blob = smaller.blob;
    type = smaller.mediaType;
    resized = true;
  }

  let data: string;
  try {
    data = await toBase64(blob);
  } catch {
    return { rejection: { name, reason: 'It could not be read.' } };
  }

  const size = await dimensions(blob);

  return {
    attachment: {
      kind: 'image',
      // `newId` produces a uuid, which passes the main process's `ID_PATTERN`.
      id: newId('img'),
      mediaType: type,
      data,
      name: resized ? `${name} (resized)` : name,
      ...(size ?? {}),
    },
  };
}

/**
 * Read one file, untransformed.
 *
 * The only thing that can go wrong is size, and the ceiling here is not about
 * the model's context — nothing sends these bytes to a model — but about the
 * base64 round-trip through IPC. A file over it is refused with its size in the
 * message, because there is no equivalent of resizing that would not corrupt
 * it.
 */
async function readFile(file: File): Promise<Read<FileAttachment>> {
  const name = file.name.length > 0 ? file.name : 'attachment';

  if (file.size > ATTACHMENT_LIMITS.bytesPerFile) {
    return {
      rejection: {
        name,
        reason: `It is ${formatBytes(file.size)}, over the ${formatBytes(ATTACHMENT_LIMITS.bytesPerFile)} limit for a single file.`,
      },
    };
  }

  let data: string;
  try {
    data = await toBase64(file);
  } catch {
    return { rejection: { name, reason: 'It could not be read.' } };
  }

  if (base64Bytes(data) > ATTACHMENT_LIMITS.bytesPerFile) {
    return {
      rejection: {
        name,
        reason: `It is ${formatBytes(base64Bytes(data))}, over the ${formatBytes(ATTACHMENT_LIMITS.bytesPerFile)} limit for a single file.`,
      },
    };
  }

  return {
    attachment: {
      kind: 'file',
      id: newId('file'),
      name,
      // `file.type` is empty for anything the browser does not recognise, which
      // is most of what a developer attaches. Omitted rather than guessed —
      // only `application/pdf` changes any behaviour, and the agent works out
      // what everything else is by reading it.
      ...(file.type.length > 0 ? { mediaType: file.type } : {}),
      data,
    },
  };
}

/** Read one file into whichever kind of attachment it should become. */
export async function readAttachment(file: File): Promise<Read<Attachment>> {
  return isImageMediaType(file.type) ? readImage(file, file.type) : readFile(file);
}

/**
 * Read a batch, respecting how many slots of each kind are left.
 *
 * The count limits are enforced here rather than at the call site so that the
 * files which *do* fit are still read: dropping six images onto a composer that
 * can take four should attach four and say so, not attach none. The two kinds
 * have separate budgets, so a full image strip never blocks a CSV.
 */
export async function readAttachments(
  files: readonly File[],
  slots: AttachmentSlots,
): Promise<AttachmentIntake> {
  const accepted: Attachment[] = [];
  const rejected: AttachmentRejection[] = [];
  let images = 0;
  let others = 0;

  for (const file of files) {
    const isImage = isImageMediaType(file.type);
    const name = file.name.length > 0 ? file.name : isImage ? 'pasted image' : 'attachment';

    if (isImage ? images >= slots.images : others >= slots.files) {
      rejected.push({
        name,
        reason: isImage
          ? `A prompt can carry ${String(ATTACHMENT_LIMITS.images)} images.`
          : `A prompt can carry ${String(ATTACHMENT_LIMITS.files)} files.`,
      });
      continue;
    }

    // Sequential on purpose. Reading a file is a main-thread base64 encode, and
    // an image additionally decodes a bitmap and paints a canvas; ten at once
    // is how you drop frames in the composer the user is still typing into.
    const result = await readAttachment(file);
    if ('attachment' in result) {
      accepted.push(result.attachment);
      if (isImage) images += 1;
      else others += 1;
    } else {
      rejected.push(result.rejection);
    }
  }

  return { accepted, rejected };
}

/** A `data:` URL for an image attachment, for `<img src>`. */
export function attachmentSrc(attachment: ImageAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`;
}

/** A short label for a file chip: the extension, or PDF, or just "file". */
export function fileKindLabel(attachment: FileAttachment): string {
  if (attachment.mediaType === PDF_MEDIA_TYPE) return 'PDF';
  const dot = attachment.name.lastIndexOf('.');
  if (dot > 0 && dot < attachment.name.length - 1) {
    return attachment.name.slice(dot + 1).toUpperCase().slice(0, 8);
  }
  return 'FILE';
}
