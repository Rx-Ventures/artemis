import { useCallback, useSyncExternalStore } from 'react';
import { transcript } from '../state/store';
import type { ToolGroup, TranscriptItem } from '../state/transcript';

/*
 * REMOVED: `useTranscriptIds`.
 *
 * It returned the raw item ids, and `useTranscriptRows` below replaced its only
 * caller when consecutive tool calls started folding into one marker. The two
 * differ solely in whether that folding has happened, so keeping both would
 * mean offering a subscription whose only distinguishing feature is that it
 * renders the pane the pane no longer looks like.
 *
 * The underlying `transcript.getListSnapshot` is untouched and still the
 * model's primitive read — that is what the model's own tests assert against.
 */

/**
 * The transcript's row ids.
 *
 * This subscription fires when the *shape* of the transcript changes — an item
 * appears or the transcript is reset — and not when text arrives. That is the
 * whole reason streaming stays cheap: the list component re-renders once per
 * new block, never once per token.
 *
 * A run of consecutive tool calls arrives as one `g:` group id rather than one
 * id per call; pass it to {@link useToolGroup} to read the summary.
 */
export function useTranscriptRows(): readonly string[] {
  return useSyncExternalStore(transcript.subscribeList, transcript.getRowsSnapshot);
}

/**
 * One tool group, subscribed by id.
 *
 * Fires when the group's membership or its members' statuses change — that is,
 * on `tool.start` and `tool.end` — and never on a text delta.
 */
export function useToolGroup(id: string): ToolGroup | undefined {
  const subscribe = useCallback((onChange: () => void) => transcript.subscribeGroup(id, onChange), [id]);
  const snapshot = useCallback(() => transcript.getGroup(id), [id]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * One item, subscribed by id.
 *
 * A `text.delta` notifies only the component holding that id, so a burst of
 * tokens re-renders one leaf rather than the list.
 */
export function useTranscriptItem(id: string): TranscriptItem | undefined {
  const subscribe = useCallback((onChange: () => void) => transcript.subscribeItem(id, onChange), [id]);
  const snapshot = useCallback(() => transcript.getItem(id), [id]);
  return useSyncExternalStore(subscribe, snapshot);
}
