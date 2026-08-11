/**
 * Turning what the OS hands over into something a provider can read.
 *
 * A paste, a drop and a file picker all produce the same thing — a `File`, or
 * near enough — and all three arrive here. What comes out is an
 * `ImageAttachment`: base64 bytes with a media type, sized to fit the limits in
 * `@rx-artemis/protocol`.
 *
 * ## Downscaling is not an optimisation
 *
 * A screenshot from a retina display is routinely 8–12 megabytes of PNG, which
 * is over the per-image ceiling before the user has done anything unusual. The
 * options were to refuse those, or to resize them; refusing the single most
 * common thing anyone will ever paste is not a real option, so an oversized
 * image is resized and the user is told.
 *
 * The re-encode is deliberately conservative: it only ever shrinks, it keeps
 * the aspect ratio, and it leaves anything already inside the limits completely
 * untouched — bytes in, same bytes out, no generation loss on an image that did
 * not need it.
 */

import {
  IMAGE_ATTACHMENT_LIMITS,
  base64Bytes,
  isImageMediaType,
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
  readonly accepted: readonly ImageAttachment[];
  /** Files that could not become attachments, each with a sentence saying why. */
  readonly rejected: readonly AttachmentRejection[];
}

/** Human-readable size, for the messages this module produces. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Is this something we can even try to read? */
export function isSupportedImageFile(file: File): boolean {
  return isImageMediaType(file.type);
}

/**
 * Pull the image files out of a paste or a drop.
 *
 * `DataTransfer.files` is the right list to read for both. `items` is the older
 * one and is tempting because it also carries the non-file entries, but a
 * screenshot pasted on macOS shows up in `files` with an empty `name` and that
 * is the case this has to get right.
 */
export function imageFilesFrom(transfer: DataTransfer | null): readonly File[] {
  if (!transfer) return [];
  return Array.from(transfer.files).filter((file) => file.type.startsWith('image/'));
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
  mediaType: ImageMediaType,
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
  if (png && png.size <= IMAGE_ATTACHMENT_LIMITS.bytesPerImage) {
    return { blob: png, mediaType: 'image/png' };
  }

  const jpeg = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
  });
  if (jpeg && jpeg.size <= IMAGE_ATTACHMENT_LIMITS.bytesPerImage) {
    return { blob: jpeg, mediaType: 'image/jpeg' };
  }

  // Both are still too big. Hand back the smaller one and let the caller
  // reject it with a size in the message — silently sending something the main
  // process will refuse is worse than saying so here.
  const smallest = [png, jpeg].filter((candidate): candidate is Blob => candidate !== null);
  if (smallest.length === 0) return null;
  const best = smallest.reduce((a, b) => (a.size <= b.size ? a : b));
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

/**
 * Read one file into an attachment, resizing it if it is too big.
 *
 * Rejections carry a sentence, never a code: every one of them is going to be
 * shown to someone who just tried to paste a picture and wants to know whether
 * to try something else.
 */
export async function readImageFile(
  file: File,
): Promise<{ readonly attachment: ImageAttachment } | { readonly rejection: AttachmentRejection }> {
  const name = file.name.length > 0 ? file.name : 'pasted image';

  if (!isImageMediaType(file.type)) {
    return {
      rejection: {
        name,
        reason: file.type.startsWith('image/')
          ? `${file.type} is not a format the providers read — PNG, JPEG, GIF or WebP.`
          : 'That is not an image.',
      },
    };
  }

  let blob: Blob = file;
  let mediaType: ImageMediaType = file.type;
  let resized = false;

  if (file.size > IMAGE_ATTACHMENT_LIMITS.bytesPerImage) {
    const smaller = await downscale(file, mediaType);
    if (!smaller) {
      return {
        rejection: {
          name,
          reason: `It is ${formatBytes(file.size)} and could not be resized to fit under ${formatBytes(IMAGE_ATTACHMENT_LIMITS.bytesPerImage)}.`,
        },
      };
    }
    if (smaller.blob.size > IMAGE_ATTACHMENT_LIMITS.bytesPerImage) {
      return {
        rejection: {
          name,
          reason: `It is ${formatBytes(file.size)}, and even resized it is ${formatBytes(smaller.blob.size)} — over the ${formatBytes(IMAGE_ATTACHMENT_LIMITS.bytesPerImage)} limit.`,
        },
      };
    }
    blob = smaller.blob;
    mediaType = smaller.mediaType;
    resized = true;
  }

  let data: string;
  try {
    data = await toBase64(blob);
  } catch {
    return { rejection: { name, reason: 'It could not be read.' } };
  }

  // The one check that is not about the file: `toBase64` is where a decoded
  // size becomes knowable for certain, and it is cheap to be sure.
  if (base64Bytes(data) > IMAGE_ATTACHMENT_LIMITS.bytesPerImage) {
    return {
      rejection: {
        name,
        reason: `It is ${formatBytes(base64Bytes(data))}, over the ${formatBytes(IMAGE_ATTACHMENT_LIMITS.bytesPerImage)} limit.`,
      },
    };
  }

  const size = await dimensions(blob);

  return {
    attachment: {
      kind: 'image',
      // `newId` produces a uuid, which passes the main process's `ID_PATTERN`.
      id: newId('img'),
      mediaType,
      data,
      name: resized ? `${name} (resized)` : name,
      ...(size ?? {}),
    },
  };
}

/**
 * Read a batch, respecting how many slots are left.
 *
 * The count limit is enforced here rather than at the call site so that the
 * files which *do* fit are still read: dropping six images onto a composer that
 * can take four should attach four and say so, not attach none.
 */
export async function readImageFiles(
  files: readonly File[],
  slotsRemaining: number,
): Promise<AttachmentIntake> {
  const accepted: ImageAttachment[] = [];
  const rejected: AttachmentRejection[] = [];

  for (const file of files) {
    if (accepted.length >= slotsRemaining) {
      rejected.push({
        name: file.name.length > 0 ? file.name : 'pasted image',
        reason: `A prompt can carry ${String(IMAGE_ATTACHMENT_LIMITS.count)} images.`,
      });
      continue;
    }
    // Sequential on purpose. Each of these decodes a bitmap and may paint a
    // canvas; four at once on the renderer's single thread is how you drop
    // frames in the composer the user is still typing into.
    const result = await readImageFile(file);
    if ('attachment' in result) accepted.push(result.attachment);
    else rejected.push(result.rejection);
  }

  return { accepted, rejected };
}

/** A `data:` URL for an attachment, for `<img src>`. */
export function attachmentSrc(attachment: ImageAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`;
}
