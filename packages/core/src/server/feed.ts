/**
 * The push feed: one sequenced stream of everything the server pushes.
 * ============================================================================
 *
 * The desktop delivers pushes with `webContents.send`, which needs no ordering
 * and no memory — a window is either there to hear an event or it is not. An
 * HTTP client is different in exactly two ways, and this module exists for
 * both: the connection *drops* (a sleeping laptop, a switched Wi-Fi network,
 * a proxy timeout), and the client that comes back needs to know what it
 * missed. So every published event takes a **sequence number** from one
 * process-wide counter, a bounded tail is **retained** for replay, and a
 * replay that reaches past the tail says so instead of quietly starting late —
 * the same honesty contract `RunRegistry.eventsSince` keeps for a reloaded
 * window, applied to the wire.
 *
 * The feed knows nothing about HTTP, connections or tokens. It carries an
 * optional {@link FeedScope} per event — which account the event concerns,
 * which workspace pin it belongs to — and the route layer decides what each
 * authenticated connection may hear. Publishing is fire-and-forget and cheap:
 * one array push and a fan-out, on the same hot path as the registry's own
 * event pump, so nothing here may block or throw.
 */

import type { RemoteStreamChannel } from '@rx-artemis/protocol';

/**
 * What an event is *about*, for the route layer's visibility filter.
 *
 * Absent fields mean "not scoped by this axis". An event with no scope at all
 * is visible to every authenticated connection — which is right for nothing
 * the feed currently carries, so publishers are expected to say what they
 * know: agent events carry the run's profile, terminal events the workspace
 * pin of the connection family that opened the shell.
 */
export interface FeedScope {
  /** The account this event concerns. Filtered by the connection's allowance. */
  readonly profileId?: string;
  /** The workspace pin this event belongs to. Filtered by the connection's own. */
  readonly workspaceKey?: string;
}

/** One retained push: the payload, its channel, and where it stands. */
export interface FeedEvent {
  /** Monotonic across the whole feed, starting at 1. */
  readonly seq: number;
  /** The push channel's own name — see `REMOTE_STREAM_CHANNELS`. */
  readonly channel: RemoteStreamChannel;
  /** The exact object `IPC_PUSH` would have carried. JSON-serialisable. */
  readonly payload: unknown;
  readonly scope: FeedScope;
}

/** What a replay request comes back with. */
export interface FeedReplay {
  /** Retained events with `seq` greater than the one asked after, in order. */
  readonly events: readonly FeedEvent[];
  /**
   * True when events the caller asked for had already been dropped, so
   * {@link events} starts later than the caller's `afterSeq + 1`.
   */
  readonly truncated: boolean;
  /** The oldest seq still retained (or `head + 1` when nothing is). */
  readonly firstSeq: number;
}

export interface PushFeed {
  /** Record and fan out one push. Never throws; a bad listener is contained. */
  publish(channel: RemoteStreamChannel, payload: unknown, scope?: FeedScope): void;
  /** Hear every future publish. Unsubscribing is safe at any time. */
  subscribe(listener: (event: FeedEvent) => void): () => void;
  /** Everything retained after `afterSeq`, with the honest-gap flag. */
  since(afterSeq: number): FeedReplay;
  /** The seq of the newest event ever published — `0` before the first. */
  head(): number;
}

/**
 * How many events the feed keeps for replay.
 *
 * Sized like the registry's own per-run buffer (1000) with headroom for the
 * feed being *global*: several concurrent runs interleave here. A client gone
 * longer than this buffer's worth of traffic gets a gap report and re-syncs
 * through `runs:list` + `runs:events`, which is the same recovery a reloaded
 * desktop window performs.
 */
const DEFAULT_RETENTION = 4000;

export interface PushFeedOptions {
  /** Override retention. `0` keeps nothing — every reconnect reports a gap. */
  readonly retention?: number;
  /** Hears about listeners that threw. Defaults to silence. */
  readonly onError?: (error: unknown) => void;
}

export function createPushFeed(options: PushFeedOptions = {}): PushFeed {
  const retention = Math.max(0, options.retention ?? DEFAULT_RETENTION);
  const retained: FeedEvent[] = [];
  const listeners = new Set<(event: FeedEvent) => void>();
  let seq = 0;
  /** Seq of the oldest event ever dropped, +1 — i.e. the oldest replayable. */
  let firstRetained = 1;

  return {
    publish(channel, payload, scope = {}): void {
      seq += 1;
      const event: FeedEvent = { seq, channel, payload, scope };
      if (retention > 0) {
        retained.push(event);
        const overflow = retained.length - retention;
        if (overflow > 0) {
          retained.splice(0, overflow);
          firstRetained = retained[0]?.seq ?? seq + 1;
        }
      } else {
        firstRetained = seq + 1;
      }
      // A copy, so a listener that unsubscribes mid-notification does not
      // disturb this pass — the same rule every fan-out in the app states.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          try {
            options.onError?.(error);
          } catch {
            // A reporter that throws is not worth a second exception.
          }
        }
      }
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    since(afterSeq): FeedReplay {
      const events = retained.filter((event) => event.seq > afterSeq);
      return {
        events,
        // The caller wants everything from `afterSeq + 1`; if the oldest
        // replayable seq is newer than that, something they asked for is
        // gone. A negative `afterSeq` is clamped: seqs start at 1, so "from
        // the beginning" cannot be truncated by events that never existed.
        truncated: Math.max(0, afterSeq) + 1 < firstRetained,
        firstSeq: retained[0]?.seq ?? seq + 1,
      };
    },

    head(): number {
      return seq;
    },
  };
}
