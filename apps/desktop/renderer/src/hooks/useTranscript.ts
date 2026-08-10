import { useCallback, useSyncExternalStore } from 'react';
import { transcript } from '../state/store';
import type { TranscriptItem } from '../state/transcript';

/**
 * The transcript's item ids.
 *
 * This subscription fires when the *shape* of the transcript changes — an item
 * appears or the transcript is reset — and not when text arrives. That is the
 * whole reason streaming stays cheap: the list component re-renders once per
 * new block, never once per token.
 */
export function useTranscriptIds(): readonly string[] {
  return useSyncExternalStore(transcript.subscribeList, transcript.getListSnapshot);
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
