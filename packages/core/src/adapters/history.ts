/**
 * Replaying a past session into the live event stream.
 *
 * Clicking a session in the sidebar used to resume it against an empty
 * transcript: the agent had the full conversation in its context, but the user
 * could not see any of it. The history was on disk the whole time — nothing
 * read it.
 *
 * The design decision here is that history produces **the same
 * {@link AgentEvent}s a live run produces**, rather than a second "historical
 * message" shape. One rendering path means a replayed tool call collapses,
 * expands and diffs exactly like a live one, and it means no component has to
 * know whether what it is drawing already happened.
 *
 * ## What is deliberately lost
 *
 * A transcript is a lossy record of a run, and pretending otherwise would be
 * worse than admitting it:
 *
 *  - **Timestamps are the read time, not the original.** Stored messages carry
 *    no wall-clock time, so every replayed event is stamped with when it was
 *    read. Ordering is preserved, which is what the transcript actually uses;
 *    a fabricated original time would be a lie the UI would happily print.
 *  - **Streaming is gone.** Text arrives as one `text.complete` per block, not
 *    as deltas. There is nothing to stream — it finished.
 *  - **Permission prompts are gone.** They were answered long ago, and
 *    replaying one would offer the user a decision that cannot be made.
 */

import type { AgentEvent, RunId, SessionId } from '@rx-artemis/protocol';

import { toJsonObject, toJsonValue } from './mapper.js';

/** A stored message, in the shape the provider hands back. */
export interface StoredMessage {
  readonly type: 'user' | 'assistant' | 'system';
  readonly uuid: string;
  readonly message: unknown;
}

/** Envelope fields every replayed event needs. */
export interface ReplayContext {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** Read time. Every replayed event carries it — see the note above. */
  readonly ts: number;
  /** Sequence counter, continuing from wherever the caller is. */
  next(): number;
}

/** Content blocks as the API writes them, narrowed only as far as we read them. */
interface ContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
}

/** `message.content` is a string or a block array, depending on the message. */
function contentBlocks(message: unknown): readonly ContentBlock[] {
  if (message === null || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;

  // A bare string is shorthand for a single text block.
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => block !== null && typeof block === 'object');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Text the harness wrote into a user slot, recognised by its own frame.
 *
 * `role: "user"` is an addressing slot, not a claim of authorship — the CLI
 * writes its own prompts there too, and the live mapper drops those by reading
 * the message's `origin`. That field never reaches this module: the SDK's
 * stored-session read strips everything but the message body, and the one
 * harness turn it does not filter out on its own is the task notification —
 * `origin: { kind: 'task-notification' }` on disk, but *not* `isMeta`, so it
 * comes back looking exactly like something the person typed. Replayed as a
 * user row it dumps `<task-notification><task-id>…` into the transcript as
 * though the user had said it, which is the bug this exists to stop.
 *
 * So the check here is on the text itself, and deliberately narrow: the
 * notification's opening tag, and the interrupt markers the CLI records when a
 * turn is stopped. All three are the harness's own fixed frames, not shapes a
 * person's message could drift into by accident — a real message *quoting* one
 * would have to start with the tag character-for-character.
 */
function isHarnessNote(text: string): boolean {
  if (text.startsWith('<task-notification>')) return true;
  return text === '[Request interrupted by user]' || text === '[Request interrupted by user for tool use]';
}

/**
 * The provider's message id out of a stored record, when it has one.
 *
 * Deliberately narrow: only a non-empty string counts, so a malformed record
 * falls back to the envelope uuid rather than keying blocks on `undefined`.
 */
function storedMessageId(stored: StoredMessage): string | undefined {
  if (typeof stored.message !== 'object' || stored.message === null) return undefined;
  return asString((stored.message as { readonly id?: unknown }).id);
}

/**
 * Turn one stored message into the events it would have emitted live.
 *
 * Returns an empty array for anything unrecognised rather than throwing: a
 * transcript written by a newer provider version must still render the parts
 * this build understands. Dropping one block beats failing the whole replay.
 */
export function replayStoredMessage(
  stored: StoredMessage,
  context: ReplayContext,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  const envelope = (): { runId: RunId; seq: number; ts: number } => ({
    runId: context.runId,
    seq: context.next(),
    ts: context.ts,
  });

  // System messages are provider bookkeeping — compact boundaries, notices.
  // They were never shown live, so showing them now would be new noise.
  if (stored.type === 'system') return events;

  // The provider's own message id, so replayed blocks from one message group
  // together exactly as live ones do.
  //
  // This has to be `message.id` and not the envelope's `uuid`, because the live
  // mapper keys blocks on `message.id`. Keying replay on `uuid` gave every
  // replayed turn an identity its live counterpart could never match, so a turn
  // that was both replayed and live rendered twice.
  const messageId = storedMessageId(stored) ?? stored.uuid;

  contentBlocks(stored.message).forEach((block, blockIndex) => {
    const type = asString(block.type);

    if (type === 'text') {
      const text = asString(block.text);
      if (text === undefined) return;
      // A harness note in a user slot is not the person talking. See
      // {@link isHarnessNote} for why this is a shape check rather than a flag.
      if (stored.type === 'user' && isHarnessNote(text)) return;
      events.push({
        ...envelope(),
        type: 'text.complete',
        messageId,
        role: stored.type === 'user' ? 'user' : 'assistant',
        text,
        blockIndex,
        // The protocol has a flag for precisely this, so the UI can tell
        // "already happened" from "just generated" without inferring it.
        replay: true,
      });
      return;
    }

    if (type === 'thinking') {
      const text = asString(block.thinking);
      // A stored thinking block is very often `thinking: ''` beside a full
      // signature — the provider kept the block and withheld its content. It
      // replays as nothing worth a row, so it does not get one.
      if (text === undefined || text === '') return;
      events.push({ ...envelope(), type: 'thinking.delta', messageId, blockIndex, text });
      return;
    }

    if (type === 'tool_use') {
      const id = asString(block.id);
      const name = asString(block.name);
      if (id === undefined || name === undefined) return;
      events.push({
        ...envelope(),
        type: 'tool.start',
        toolCallId: id,
        name,
        input: toJsonObject(block.input),
        messageId,
      });
      return;
    }

    if (type === 'tool_result') {
      const id = asString(block.tool_use_id);
      if (id === undefined) return;
      events.push({
        ...envelope(),
        type: 'tool.end',
        toolCallId: id,
        // A stored transcript records success or failure, never a denial or a
        // cancellation — those end a call before a result is written.
        status: block.is_error === true ? 'error' : 'ok',
        result: toJsonValue(block.content),
      });
      return;
    }
  });

  return events;
}

/**
 * Replay a whole stored session.
 *
 * Ordering is the provider's, preserved exactly: a transcript re-sorted by
 * anything other than its original sequence would interleave tool calls with
 * the wrong results.
 */
export function replayStoredSession(
  messages: readonly StoredMessage[],
  context: ReplayContext,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const message of messages) events.push(...replayStoredMessage(message, context));
  return events;
}

/* -------------------------------------------------------------------------- */
/* Rewind                                                                     */
/* -------------------------------------------------------------------------- */

/** Where a truncating resume should re-enter the chain. */
export interface RewindPoint {
  /** The chain uuid of the last entry the resumed session keeps. */
  readonly resumeSessionAt: string;
  /**
   * The prompt uuid of the turn being discarded — present only when the
   * discarded range is that one turn, which is the only shape the provider's
   * `--resume-drops-turn` acknowledgement can vouch for. A deeper rewind omits
   * it and takes its chances with the provider's own guard.
   */
  readonly dropsTurn?: string;
}

/**
 * Whether a stored entry is something the user actually asked — the start of a
 * turn — as opposed to the other things that arrive in a user-typed envelope:
 * tool results, and the harness notes {@link isHarnessNote} names.
 */
function isPromptEntry(stored: StoredMessage): boolean {
  if (stored.type !== 'user') return false;
  const blocks = contentBlocks(stored.message);
  if (blocks.some((block) => block.type === 'tool_result')) return false;
  return blocks.some(
    (block) =>
      block.type === 'text' && typeof block.text === 'string' && !isHarnessNote(block.text),
  );
}

/**
 * Resolve "rewind to just before this prompt" against the stored chain.
 *
 * The renderer knows which prompt the user pointed at — its uuid rides the
 * transcript — but a truncating resume re-enters the chain at the entry
 * *before* it, and only the stored file knows what that was. `null` when the
 * uuid is not in the chain or has nothing before it; the caller turns that
 * into an error worth reading, because both mean the rewind cannot happen.
 */
export function resolveRewindPoint(
  messages: readonly StoredMessage[],
  promptUuid: string,
): RewindPoint | null {
  const at = messages.findIndex((stored) => stored.uuid === promptUuid);
  if (at <= 0) return null;

  const before = messages[at - 1];
  if (before === undefined) return null;

  // One turn, or more? The provider's drops-turn acknowledgement names a
  // single prompt, so a range holding a second prompt cannot be declared.
  const laterPrompts = messages
    .slice(at + 1)
    .some((stored) => isPromptEntry(stored));

  return {
    resumeSessionAt: before.uuid,
    ...(laterPrompts ? {} : { dropsTurn: promptUuid }),
  };
}
