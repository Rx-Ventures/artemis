/**
 * Things sent alongside a prompt.
 *
 * Today that means images: a screenshot pasted into the composer, a mockup
 * dragged onto it, a file picked from disk. The union has one member, and is a
 * union anyway — `kind` is what lets a PDF or an audio clip land later without
 * every consumer having to be rewritten to stop assuming "attachment" means
 * "image".
 *
 * ## Bytes, not paths
 *
 * An attachment carries its own base64 payload rather than a path to a file the
 * main process would read. Two reasons, and the first is the one that matters:
 *
 *  1. **A path from the renderer is a request to read an arbitrary file.** The
 *     renderer is sandboxed and cannot open `~/.ssh/id_rsa`; if it could ask
 *     the main process to attach that path to a prompt, it would have got there
 *     anyway, by a route with no user in it. Bytes keep the boundary where it
 *     is: the renderer can only send what the OS already handed it through a
 *     paste, a drop or a file picker — every one of which is a user gesture.
 *  2. Pasted images have no path to begin with. The clipboard hands over a
 *     `Blob`, so a path-shaped protocol would need a second shape for the most
 *     common case.
 *
 * The cost is that images cross IPC as base64 and sit in memory twice for the
 * length of the call, which is why {@link IMAGE_ATTACHMENT_LIMITS} is small and
 * enforced at the boundary rather than left to good behaviour upstream.
 */

/**
 * Image formats every supported provider can read.
 *
 * The intersection of what the Anthropic Messages API accepts and what the
 * OpenAI models behind Codex accept, which is the same four. Anything else —
 * HEIC off an iPhone, a TIFF, an SVG — is rejected at the composer with a
 * sentence naming the formats, rather than sent and refused by the provider
 * halfway through a run.
 *
 * SVG's absence is not an oversight: it is a document that can carry script and
 * fetch remote resources, and no provider treats it as an image.
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Runtime type guard for {@link ImageMediaType}. */
export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * Ceilings on what one prompt may carry.
 *
 * These are product limits, not just guardrails, and the composer enforces them
 * *before* the send so the user finds out while they can still do something
 * about it. The main process enforces them again because a renderer is not a
 * trusted enforcer of its own limits.
 *
 * `bytesPerImage` is the decoded size. Five megabytes is Anthropic's documented
 * per-image request ceiling and comfortably above a retina screenshot; the
 * total is four of those, which is also `count`, so it binds only as a
 * backstop. An image over the per-image ceiling is a resize rather than an
 * error — see `readImageFile` in the renderer's `lib/attachments.ts` — so this
 * limit is only *reached* by something that will not shrink.
 */
export const IMAGE_ATTACHMENT_LIMITS = {
  /** How many images may ride along with one prompt. */
  count: 4,
  /** Decoded bytes, per image. */
  bytesPerImage: 5 * 1024 * 1024,
  /** Decoded bytes, summed across a single prompt. */
  bytesTotal: 20 * 1024 * 1024,
  /** Characters of `name`. A label, never a path. */
  nameLength: 200,
} as const;

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
   * A label for the user, and nothing else ever depends on it: it is not a
   * path, it is not unique, and the Codex adapter deliberately does not use it
   * to name the temp file it writes. Treat it as untrusted text — it came from
   * a filename, which can contain anything.
   */
  readonly name?: string;
  /** Pixel dimensions, when the renderer decoded them. Display only. */
  readonly width?: number;
  readonly height?: number;
}

/**
 * Anything that can ride along with a prompt.
 *
 * Discriminate on `kind` rather than assuming the single member — see the note
 * at the top of this file.
 */
export type Attachment = ImageAttachment;

/** Narrow an {@link Attachment} to the image case. */
export function isImageAttachment(value: Attachment): value is ImageAttachment {
  return value.kind === 'image';
}

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
