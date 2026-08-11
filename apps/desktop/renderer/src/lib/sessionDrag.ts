/**
 * Dragging a session out of the sidebar.
 * ============================================================================
 *
 * The gesture that opens the split: pick a row up in the sidebar, drop it on a
 * half of the working area, get that session there. This module is the contract
 * between the two ends — the sidebar knows how to *pick up* a session and the
 * working area knows how to *recognise* one, and neither imports the other.
 *
 * ## Why a custom MIME type rather than `text/plain`
 *
 * Three reasons, in order of how badly each bites:
 *
 *  1. **`getData` is unreadable during `dragover`.** The drag data store is in
 *     "protected mode" for every event except `dragstart` and `drop`, so the
 *     only thing a drop target can ask mid-drag is *what types* are on offer.
 *     Deciding whether to accept a drop therefore has to be a question about
 *     the type, which means the type has to be specific enough to answer it.
 *  2. **Text dropped from anywhere else must not open a session.** A URL from
 *     the browser, a snippet from an editor, a file from Finder — all of those
 *     arrive as `text/plain` or `Files`, and a working area that accepted them
 *     would do something alarming with a stray drag.
 *  3. It keeps the payload out of the way of the OS's own drop handling.
 *
 * `text/plain` is set *as well*, carrying the session's title. That is purely
 * for dragging out of the app — into a note, an issue, a message — where the
 * useful thing to paste is the name of the session rather than its id.
 *
 * ## The payload is a key, not the session
 *
 * A `SessionSummary` serialised at `dragstart` would be a snapshot: by the time
 * it lands, the title may have been rewritten by the run that was in flight
 * when the drag began. So the wire carries the identity — profile and id — and
 * the drop resolves it against the live list. A row that vanished mid-drag
 * resolves to nothing and the drop is ignored, which is the correct outcome and
 * one a serialised copy would have papered over by opening a session that is no
 * longer there.
 */

import type { SessionSummary } from '@rx-artemis/protocol';

/**
 * The drag type the working area listens for.
 *
 * Lower-case, because the DataTransfer spec normalises type strings to
 * lower-case on the way in — comparing against a capitalised constant would
 * never match, silently, and only ever in the drop target.
 */
export const SESSION_DRAG_TYPE = 'application/x-artemis-session';

/** Identity of a session on the wire: unique across profiles, unlike an id. */
export interface SessionDragPayload {
  readonly profileId: string;
  readonly sessionId: string;
}

/** Put a session on a drag. Call from `dragstart`. */
export function writeSessionDrag(transfer: DataTransfer, session: SessionSummary): void {
  const payload: SessionDragPayload = {
    profileId: session.profileId,
    sessionId: session.id,
  };
  transfer.setData(SESSION_DRAG_TYPE, JSON.stringify(payload));
  // For drops outside Artemis. See the file header.
  transfer.setData('text/plain', session.title);
  // `move` rather than `copy`: dropping a session into a column *puts it
  // there*, it does not make a second one. The cursor should say so.
  transfer.effectAllowed = 'move';
}

/**
 * Is this drag carrying a session?
 *
 * Safe to call during `dragover`, which is the whole point — see the header.
 * `types` is a `DOMStringList`-alike without `includes` in some engines, so it
 * is walked rather than probed.
 */
export function isSessionDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  for (const type of Array.from(transfer.types)) {
    if (type === SESSION_DRAG_TYPE) return true;
  }
  return false;
}

/** Read the payload back. Only valid inside a `drop` handler. */
export function readSessionDrag(transfer: DataTransfer | null): SessionDragPayload | null {
  if (!transfer) return null;
  const raw = transfer.getData(SESSION_DRAG_TYPE);
  if (raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { profileId, sessionId } = parsed as Record<string, unknown>;
    if (typeof profileId !== 'string' || typeof sessionId !== 'string') return null;
    return { profileId, sessionId };
  } catch {
    // A malformed payload can only come from another application claiming our
    // type, which is not something to raise an error about — it is something to
    // decline.
    return null;
  }
}

/** Find the session a payload names in a live listing. */
export function resolveSessionDrag(
  payload: SessionDragPayload,
  sessions: readonly SessionSummary[],
): SessionSummary | undefined {
  return sessions.find((s) => s.id === payload.sessionId && s.profileId === payload.profileId);
}
