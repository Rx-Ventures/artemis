/**
 * Where the pull requests linked in a transcript stand.
 * ============================================================================
 *
 * `fileReach.ts`'s sibling, and deliberately built the same way: a module-level
 * cache, a batched flush, and one subscription per key so an answer about one
 * pull request re-renders the links naming that pull request and nothing else.
 * Read that file's header for the shape; this one records where the two differ,
 * because the differences are the whole design.
 *
 * ## It asks when the reader asks, not when the text arrives
 *
 * `fileReach` checks every path-shaped fragment on screen, eagerly, because the
 * answer decides whether to draw a link at all and because a `stat` is free.
 * Neither is true here. A reading costs a `gh` subprocess and a network round
 * trip, and a settled transcript can carry a dozen PR links — so an eager sweep
 * would spawn a dozen processes to fill in popovers nobody opened.
 *
 * So the link is a link from the moment it renders, and the reading is taken
 * when the popover opens. {@link usePullRequest} takes an `active` flag for
 * exactly that: subscribing without it is how a component says "tell me if you
 * already know, but do not go and find out".
 *
 * That is also why there is no negative-staleness sweep. `fileReach` re-asks its
 * "no"s because an agent describes a file just before writing it; nothing here
 * changes on its own between one hover and the next, and the reading that does
 * go stale — an open PR whose checks are still running — is re-taken the next
 * time somebody looks, which is the only moment it matters.
 *
 * ## Two caches, and the one here is the smaller
 *
 * `main/github.ts` holds the real one, with lifetimes that know a merged pull
 * request cannot become unmerged. This one exists to keep a re-render or a
 * second hover from crossing the IPC boundary at all, and it defers on
 * everything else: {@link STALE_AFTER_MS} is a floor on how often a *hover* may
 * ask, not a claim about how long a reading is good for.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  pullRequestKey,
  type PullRequestRef,
  type PullRequestResult,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from './bridge';

/**
 * How long before a hover may ask again.
 *
 * Long enough that moving the pointer on and off a link does not re-spawn `gh`,
 * short enough that coming back to a PR after a coffee shows what CI decided
 * while you were away. A settled pull request is held longer than this by main's
 * own cache, so the cost of the short window here is one IPC round trip that
 * main answers from memory.
 */
const STALE_AFTER_MS = 30_000;

/**
 * Refs in one request.
 *
 * Matches `LIMITS.pullRequests`, so the renderer splits a transcript full of
 * links into requests that will be accepted rather than discovering the cap as a
 * validation failure — the same arrangement `fileReach` keeps with
 * `LIMITS.checkPaths`.
 */
const MAX_PER_REQUEST = 64;

interface Entry {
  readonly result: PullRequestResult;
  readonly at: number;
}

/** Answers main has given, by {@link pullRequestKey}. */
const known = new Map<string, Entry>();

/** Refs waiting for the next flush. Keyed so a duplicate cannot queue twice. */
const queued = new Map<string, PullRequestRef>();

/** Keys in a request that has not come back. */
const inflight = new Set<string>();

/** Who to wake when a key's answer changes. */
const listeners = new Map<string, Set<() => void>>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function wantsAsking(key: string): boolean {
  if (queued.has(key) || inflight.has(key)) return false;
  const entry = known.get(key);
  if (entry === undefined) return true;
  return Date.now() - entry.at >= STALE_AFTER_MS;
}

function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => void flush(), 0);
}

/**
 * Ask main about everything queued.
 *
 * No sweep of what is already on screen, unlike `fileReach`'s flush — see the
 * header. What is queued is what somebody asked for.
 */
async function flush(): Promise<void> {
  flushTimer = null;

  const batch = [...queued.entries()].slice(0, MAX_PER_REQUEST);
  for (const [key] of batch) {
    queued.delete(key);
    inflight.add(key);
  }
  // Anything over the cap goes out behind this request rather than being
  // dropped, which is the difference between a slow popover and one that never
  // fills in.
  if (queued.size > 0) scheduleFlush();
  if (batch.length === 0) return;

  const { bridge } = resolveBridge();
  if (bridge === null) {
    settle(batch.map(([key]) => ({ key, problem: 'failed' as const })));
    return;
  }

  const res = await call(() => bridge.github.pullRequests({ refs: batch.map(([, ref]) => ref) }));
  // A failed call is recorded rather than left unknown, so a dead main process
  // produces "could not read this" once instead of a retry on every hover. The
  // staleness rule is what lets it be asked about again.
  settle(
    res.ok ? res.value.results : batch.map(([key]) => ({ key, problem: 'failed' as const })),
  );
}

/** Record answers and wake only the links whose answer moved. */
function settle(results: readonly PullRequestResult[]): void {
  const at = Date.now();
  const wake = new Set<() => void>();

  for (const result of results) {
    inflight.delete(result.key);
    const before = known.get(result.key)?.result;
    known.set(result.key, { result, at });
    // A re-read that says the same thing changes nothing on screen, and waking
    // its links would re-render a paragraph to draw it identically. Compared
    // field-wise rather than by identity because every reply is a fresh object
    // off the IPC boundary.
    if (before !== undefined && sameResult(before, result)) continue;
    for (const listener of listeners.get(result.key) ?? []) wake.add(listener);
  }

  for (const listener of wake) listener();
}

function sameResult(a: PullRequestResult, b: PullRequestResult): boolean {
  if (a.problem !== b.problem) return false;
  const x = a.summary;
  const y = b.summary;
  if (x === undefined || y === undefined) return x === y;
  return (
    x.state === y.state &&
    x.checks === y.checks &&
    x.title === y.title &&
    x.author === y.author &&
    x.additions === y.additions &&
    x.deletions === y.deletions &&
    x.changedFiles === y.changedFiles
  );
}

function watch(key: string, ref: PullRequestRef, active: boolean, onChange: () => void): () => void {
  let group = listeners.get(key);
  if (group === undefined) {
    group = new Set();
    listeners.set(key, group);
  }
  group.add(onChange);

  // The `active` gate. An inactive watcher still subscribes — so a reading that
  // arrives for another reason paints immediately — it just does not go and get
  // one. See the header.
  if (active && wantsAsking(key)) {
    queued.set(key, ref);
    scheduleFlush();
  }

  return () => {
    group.delete(onChange);
    if (group.size === 0) listeners.delete(key);
  };
}

/** What is known about this pull request, which before an answer is nothing. */
export function pullRequestResult(key: string): PullRequestResult | null {
  return known.get(key)?.result ?? null;
}

/**
 * Subscribe to one pull request's standing.
 *
 * `null` for a link that is not a pull request, which is most of them — the hook
 * still runs, because hooks must, and costs a no-op subscription rather than a
 * branch at every call site.
 *
 * `active` is what turns a subscription into a request. Pass `false` until the
 * reader has actually asked — see the header for why this differs from
 * `useReachableFile`, which asks for everything on screen.
 */
export function usePullRequest(
  ref: PullRequestRef | null,
  active: boolean,
): PullRequestResult | null {
  const key = ref === null ? null : pullRequestKey(ref);

  const subscribe = useCallback(
    (onChange: () => void) =>
      key === null || ref === null ? () => undefined : watch(key, ref, active, onChange),
    [key, active, ref],
  );
  const snapshot = useCallback(() => (key === null ? null : pullRequestResult(key)), [key]);

  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Forget everything. For tests, which share a module registry across cases and
 * would otherwise see one pull request's answer decide another's assertions.
 */
export function resetPullRequests(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  known.clear();
  queued.clear();
  inflight.clear();
  listeners.clear();
}
