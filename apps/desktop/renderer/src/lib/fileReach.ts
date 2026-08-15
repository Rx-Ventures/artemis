/**
 * Whether a path in an answer is a file that is actually there.
 * ============================================================================
 *
 * `filePaths.ts` decides whether a fragment of text is *shaped* like a path.
 * That is all it can decide — it has a string and no disk — and it is why the
 * first version of file links underlined everything path-shaped, including the
 * `foo.ts` an agent had only said it was going to write. This module is the
 * other half of the question, and it is the one that needs the main process.
 *
 * The rule the whole thing serves: **a link is drawn only where there is a file
 * to open.** Not "probably", not "the name looks right" — main was asked, and
 * said yes. Everything below follows from that plus one consequence of it: the
 * answer arrives a tick after the text does, so the honest initial state is *not
 * a link*, and a fragment becomes one when the answer comes back. The other
 * order would flash a link and take it away, which is the thing being fixed.
 *
 * ## One request per screenful, not one per word
 *
 * A settled answer mounts a few dozen `<code>` spans at once and a handful of
 * them are path-shaped. Each subscribes; the subscriptions all run in the same
 * commit; the flush is a `setTimeout(…, 0)`, so it happens after that commit and
 * sees all of them. One IPC call, however many paths — which is the reason
 * `files.check` takes a list at all.
 *
 * ## Cached, and re-asked exactly once per turn
 *
 * A path's verdict is kept, so scrolling a long transcript does not re-stat the
 * same twenty files. But a *negative* verdict has a shelf life that a positive
 * one does not, and the asymmetry is the whole point:
 *
 *  - **"It is there"** stays. Files are created far more often than deleted
 *    mid-conversation, and the rare stale yes costs one click and an honest
 *    sentence from the reader — `There is no file at …`, which is exactly true.
 *  - **"It is not there"** goes stale, because the commonest reason for one is
 *    an agent describing a file a moment before writing it. A verdict that never
 *    changed would leave that path as plain text for the rest of the session,
 *    which reads as the feature being broken rather than as it being careful.
 *
 * What re-asks them is deliberately not a timer. On every flush, the negatives
 * still on screen and older than {@link STALE_AFTER_MS} are swept into the batch
 * — and a flush happens because *new text arrived*, which is to say because the
 * agent did something. So the re-check rides along with the next answer, on the
 * one event that could have made it come out differently, and a window nobody is
 * typing into does no filesystem work at all. Polling would get the same result
 * by asking the disk about a transcript no one is looking at.
 *
 * ## Unknown means no
 *
 * Before an answer, on a transport failure, with no bridge at all: not a link.
 * The same way round as `parseFileReference`'s own rule — where it is unsure it
 * declines — and for the same reason. A word that was never a link costs a
 * reader nothing they did not already have.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { call, resolveBridge } from './bridge';

/**
 * How long a "there is no such file" is trusted for.
 *
 * Long enough that a scroll through a settled transcript re-asks nothing, short
 * enough that the file the agent promised in one turn is a link by the next. It
 * is a floor on how often a path *may* be re-asked and not a schedule: nothing
 * expires on its own, and a negative on a screen where nothing further is said
 * is never asked about again. See the header.
 */
const STALE_AFTER_MS = 30_000;

/**
 * Paths in one request.
 *
 * Matches the main process's own cap (`LIMITS.checkPaths`), so the renderer
 * splits a hundred-path transcript into requests that will be accepted rather
 * than discovering the limit as a validation failure. Anything over the cap
 * stays queued and goes out in the next flush.
 */
const MAX_PER_REQUEST = 256;

/** What is known about one path, and when it was learned. */
interface Verdict {
  readonly reachable: boolean;
  readonly at: number;
}

/** Answers main has given. */
const known = new Map<string, Verdict>();

/** Paths waiting for the next flush. */
const queued = new Set<string>();

/** Paths in a request that has not come back. */
const inflight = new Set<string>();

/** Who to wake when a path's verdict changes, by path. */
const listeners = new Map<string, Set<() => void>>();

/** The pending flush, or `null` when none is scheduled. */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Is this path worth asking about right now?
 *
 * No if it is already on its way, and no if we have a fresh answer — where
 * "fresh" means anything at all for a yes, and {@link STALE_AFTER_MS} for a no.
 */
function wantsAsking(path: string): boolean {
  if (queued.has(path) || inflight.has(path)) return false;
  const verdict = known.get(path);
  if (verdict === undefined) return true;
  return !verdict.reachable && Date.now() - verdict.at >= STALE_AFTER_MS;
}

function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => void flush(), 0);
}

/**
 * Ask main about everything queued, and about the stale negatives on screen.
 *
 * The sweep is the second half and the less obvious one: this runs because some
 * new path wanted checking, which means new text arrived, which is the one
 * moment a previous "no" is worth doubting. See the header.
 */
async function flush(): Promise<void> {
  flushTimer = null;

  for (const path of listeners.keys()) {
    if (wantsAsking(path)) queued.add(path);
  }

  const batch = [...queued].slice(0, MAX_PER_REQUEST);
  for (const path of batch) {
    queued.delete(path);
    inflight.add(path);
  }
  // A transcript with more paths than one request may carry: the rest go out
  // behind this one rather than being dropped, which is the difference between
  // a slow answer and a permanently plain link.
  if (queued.size > 0) scheduleFlush();
  if (batch.length === 0) return;

  const { bridge } = resolveBridge();
  if (bridge === null) {
    settle(batch, () => false);
    return;
  }

  const res = await call(() => bridge.files.check({ paths: batch }));
  // A failed call is recorded as "not there" rather than left unknown, so a
  // dead main process produces plain text instead of a retry loop against it.
  // The staleness rule above is what lets the paths be asked about again.
  const reachable = new Set(res.ok ? res.value.reachable : []);
  settle(batch, (path) => reachable.has(path));
}

/** Record a batch's answers and wake only the spans whose verdict moved. */
function settle(batch: readonly string[], verdictFor: (path: string) => boolean): void {
  const at = Date.now();
  const wake = new Set<() => void>();

  for (const path of batch) {
    inflight.delete(path);
    const reachable = verdictFor(path);
    const before = known.get(path);
    known.set(path, { reachable, at });
    // A re-checked negative that is still negative changes nothing on screen,
    // and waking its spans would re-render a paragraph to draw it identically.
    if (before?.reachable === reachable) continue;
    for (const listener of listeners.get(path) ?? []) wake.add(listener);
  }

  for (const listener of wake) listener();
}

/**
 * Watch one path, asking about it if we do not have a fresh answer.
 *
 * The asking lives here rather than in the snapshot read because React calls a
 * snapshot during render, as often as it likes; a subscription is the one part
 * of `useSyncExternalStore` that is allowed to have an effect.
 */
function watch(path: string, onChange: () => void): () => void {
  let group = listeners.get(path);
  if (group === undefined) {
    group = new Set();
    listeners.set(path, group);
  }
  group.add(onChange);

  if (wantsAsking(path)) {
    queued.add(path);
    scheduleFlush();
  }

  return () => {
    group.delete(onChange);
    if (group.size === 0) listeners.delete(path);
  };
}

/** What is known about this path, which before an answer is nothing. */
export function isReachable(path: string): boolean {
  return known.get(path)?.reachable === true;
}

/**
 * Subscribe to whether `path` is a file that exists.
 *
 * `null` for a fragment that is not a path at all, which is most of them — the
 * hook still runs, because hooks must, and costs a no-op subscription rather
 * than a branch at the call site.
 *
 * Note what this is *not*: a subscription to a store. Waking is per path, so an
 * answer about one file re-renders the spans naming that file and no others.
 * That is what makes a hook per `<code>` element affordable where a hundred
 * subscriptions to the app store would not be.
 */
export function useReachableFile(path: string | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => (path === null ? () => undefined : watch(path, onChange)),
    [path],
  );
  const snapshot = useCallback(() => (path === null ? false : isReachable(path)), [path]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Forget everything. For tests, which share a module registry across cases and
 * would otherwise see one file's verdicts decide another file's assertions.
 */
export function resetFileReach(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  known.clear();
  queued.clear();
  inflight.clear();
  listeners.clear();
}
