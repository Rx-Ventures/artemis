/**
 * Interrupt-on-disconnect, for runs a remote bridge started.
 * ============================================================================
 *
 * The completions surface already has this policy, structurally: the request
 * *is* the run, so a client that hangs up aborts the turn, and nothing is
 * spent on output nobody will read. A bridge-started run has no such request
 * to die with — it is started by one POST and watched over a separate event
 * stream — so the policy has to be rebuilt deliberately, and rebuilt with a
 * grace window, because the stream *drops* for reasons that are not
 * departures: a sleeping laptop lid, a switched Wi-Fi network, a proxy
 * recycling an idle socket. The client reconnects with a replay cursor in
 * seconds (see the renderer's pump); a client that stays gone for the whole
 * grace window has left, and its runs are interrupted rather than left
 * burning the plan.
 *
 * The guard also hears the feed, which buys two things for free: a run that
 * ends on its own stops being guarded, and the moment a tracked run announces
 * its session id the host can be told — which is how bridge-started
 * conversations get recorded into the session ledger with the connection that
 * started them, the id-level attribution remote control wants.
 */

import type { FeedEvent, PushFeed } from './feed.js';

/** Everything the guard needs to know about one bridge-started run. */
export interface TrackedRun {
  readonly runId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly workspaceKey: string;
  readonly cwd: string;
}

export interface RemoteRunGuard {
  /** An event stream for this connection opened. */
  attach(connectionId: string): void;
  /** One closed. The last one leaving arms the grace timer. */
  detach(connectionId: string): void;
  /** A bridge route started this run on this connection's behalf. */
  trackRun(run: TrackedRun): void;
  /** The run ended or was disposed; stop guarding it. */
  untrackRun(runId: string): void;
  /** Cancel every timer and subscription, for shutdown and tests. */
  dispose(): void;
}

/**
 * How long a connection may be streamless before its runs are stopped.
 *
 * Minutes-scale on purpose: the client reconnects on a five-second backoff,
 * so a minute is a dozen missed attempts — a departure, not a blip — while
 * still short enough that a laptop closed mid-run does not spend an hour of
 * plan on unread output.
 */
const DEFAULT_GRACE_MS = 60_000;

export interface RemoteRunGuardOptions {
  /** How to stop a run. Wired to the host's own interrupt. */
  readonly interrupt: (runId: string) => Promise<unknown>;
  /**
   * The push feed, for hearing tracked runs end and announce sessions.
   * Optional so the guard is testable without one; a host always passes it.
   */
  readonly feed?: PushFeed;
  /**
   * A tracked run announced (or ended with) its session id. The host wires
   * this to the session ledger, which is what makes a bridge-started
   * conversation listable and resumable by its own connection family later —
   * and attributable: the entry names the connection that started it.
   */
  readonly onSession?: (run: TrackedRun, sessionId: string) => void;
  readonly graceMs?: number;
  readonly onError?: (error: unknown) => void;
}

export function createRemoteRunGuard(options: RemoteRunGuardOptions): RemoteRunGuard {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  const attachments = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const runs = new Map<string, TrackedRun>();

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter that throws is not worth a second exception.
    }
  };

  function runsOf(connectionId: string): TrackedRun[] {
    return [...runs.values()].filter((run) => run.connectionId === connectionId);
  }

  function disarm(connectionId: string): void {
    const timer = timers.get(connectionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(connectionId);
    }
  }

  function arm(connectionId: string): void {
    if (timers.has(connectionId)) return;
    if (runsOf(connectionId).length === 0) return;
    const timer = setTimeout(() => {
      timers.delete(connectionId);
      // Checked again at fire time: an attach since arming disarms below, but
      // a race between the timer firing and a reconnect is settled in favour
      // of what is true now.
      if ((attachments.get(connectionId) ?? 0) > 0) return;
      for (const run of runsOf(connectionId)) {
        runs.delete(run.runId);
        options.interrupt(run.runId).catch(report);
      }
    }, graceMs);
    // Never hold a process open just to wait for a client that left.
    (timer as { unref?: () => void }).unref?.();
    timers.set(connectionId, timer);
  }

  const unsubscribe = options.feed?.subscribe((event: FeedEvent) => {
    if (event.channel !== 'artemis:push:agent-event') return;
    const payload = event.payload as {
      readonly type?: string;
      readonly runId?: string;
      readonly sessionId?: string;
    };
    if (typeof payload.runId !== 'string') return;
    const tracked = runs.get(payload.runId);
    if (tracked === undefined) return;

    if (
      (payload.type === 'session.started' || payload.type === 'run.end') &&
      typeof payload.sessionId === 'string' &&
      payload.sessionId.length > 0
    ) {
      try {
        options.onSession?.(tracked, payload.sessionId);
      } catch (error) {
        report(error);
      }
    }
    if (payload.type === 'run.end') {
      runs.delete(payload.runId);
      if (runsOf(tracked.connectionId).length === 0) disarm(tracked.connectionId);
    }
  });

  return {
    attach(connectionId): void {
      attachments.set(connectionId, (attachments.get(connectionId) ?? 0) + 1);
      disarm(connectionId);
    },

    detach(connectionId): void {
      const next = Math.max(0, (attachments.get(connectionId) ?? 0) - 1);
      if (next === 0) attachments.delete(connectionId);
      else attachments.set(connectionId, next);
      if (next === 0) arm(connectionId);
    },

    trackRun(run): void {
      runs.set(run.runId, run);
      // A caller that started a run without ever opening the stream gets the
      // same grace to open one — otherwise a control-only client could start
      // work no disconnect would ever stop.
      if ((attachments.get(run.connectionId) ?? 0) === 0) arm(run.connectionId);
    },

    untrackRun(runId): void {
      const tracked = runs.get(runId);
      runs.delete(runId);
      if (tracked !== undefined && runsOf(tracked.connectionId).length === 0) {
        disarm(tracked.connectionId);
      }
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      runs.clear();
      attachments.clear();
      unsubscribe?.();
    },
  };
}
