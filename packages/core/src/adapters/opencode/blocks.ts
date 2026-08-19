/**
 * Turning a prompt and its attachments into ACP content blocks.
 * ============================================================================
 *
 * Written because the adapter was sending `[{ type: 'text', text: prompt }]` and
 * nothing else, while declaring `imageInput: true`. Attachments were dropped on
 * the floor — so an image a user attached vanished silently and the model
 * answered a question about a picture it had never seen.
 *
 * That is the failure the OpenCode adapter's own header warns about, one level
 * in: *a capability declared from an advertisement is an affordance that fails
 * in the user's hands.* The advertisement was right — OpenCode really does
 * accept images — and Artemis simply never sent them.
 *
 * ## What the agent said it takes
 *
 * Verified against `opencode acp` 1.18.18 on 2026-08-18, from the handshake:
 *
 * ```json
 * "promptCapabilities": { "embeddedContext": true, "image": true }
 * ```
 *
 * `image` is what makes an image block legal. **`embeddedContext` is what makes
 * a file one** — it says the agent accepts a `resource` block carrying content
 * inline, rather than only a link to something it must go and fetch. That is
 * the whole of why `fileInput` can be true here: not new adapter machinery, a
 * capability the agent was advertising that nothing read.
 *
 * ## Why a file is embedded rather than staged
 *
 * The Claude and Codex adapters write attachments into a granted temporary
 * directory and name the paths in the prompt, because those providers take
 * files by path. ACP has somewhere to put the *bytes*, so there is no directory
 * to grant, nothing to clean up afterwards, and no window where a staged file
 * exists on disk. Fewer moving parts and a smaller blast radius, from using the
 * mechanism the protocol actually offers.
 */

import { isImageAttachment } from '@rx-artemis/protocol';
import type { Attachment } from '@rx-artemis/protocol';

import type { AcpContentBlock } from '../acp/protocol.js';

/** What the agent said it accepts, from the handshake. */
export interface PromptSupport {
  readonly image: boolean;
  readonly embeddedContext: boolean;
}

/**
 * A URI for an embedded file.
 *
 * `attachment:` rather than `file:` because nothing is on the filesystem — a
 * `file:` URI would name a path that does not exist and invite the agent to go
 * and read it. The id keeps two attachments with the same display name apart.
 */
function attachmentUri(id: string, name: string): string {
  return `attachment:${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

/**
 * Build the blocks for one prompt.
 *
 * Attachments the agent cannot take are **named in the text** rather than
 * dropped. A model that is told "an image was attached but this agent cannot
 * accept images" can say so; one sent nothing answers confidently about
 * something it never received, which is the worse failure by far.
 *
 * Text goes first. Every provider treats the leading block as the instruction,
 * and burying it under six attachments reads as an afterthought.
 */
export function buildPromptBlocks(
  prompt: string,
  attachments: readonly Attachment[] | undefined,
  support: PromptSupport,
): readonly AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  const refused: string[] = [];

  for (const attachment of attachments ?? []) {
    if (isImageAttachment(attachment)) {
      if (support.image) {
        blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.mediaType });
      } else {
        refused.push('an image');
      }
      continue;
    }

    if (support.embeddedContext) {
      blocks.push({
        type: 'resource',
        resource: {
          uri: attachmentUri(attachment.id, attachment.name),
          // The agent needs a name to refer to the file by; `mediaType` is
          // optional on the attachment and omitted rather than guessed at,
          // since a wrong content type is worse than an absent one.
          ...(attachment.mediaType === undefined ? {} : { mimeType: attachment.mediaType }),
          text: attachment.data,
        },
      });
    } else {
      refused.push(attachment.name);
    }
  }

  const text =
    refused.length === 0
      ? prompt
      : `${prompt}\n\n[Artemis could not attach ${refused.join(', ')}: this agent does not accept them.]`;

  // Unshifted rather than pushed, so the instruction leads.
  blocks.unshift({ type: 'text', text });
  return blocks;
}
