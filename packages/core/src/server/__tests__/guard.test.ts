import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPushFeed } from '../feed.js';
import { createRemoteRunGuard, type TrackedRun } from '../guard.js';

const RUN: TrackedRun = {
  runId: 'run-1',
  connectionId: 'conn-1',
  profileId: 'prof-a',
  workspaceKey: 'dir:/w',
  cwd: '/w',
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRemoteRunGuard', () => {
  it('interrupts a run whose client never attached, after the grace', async () => {
    const interrupted: string[] = [];
    const guard = createRemoteRunGuard({
      interrupt: async (runId) => {
        interrupted.push(runId);
      },
      graceMs: 1_000,
    });
    guard.trackRun(RUN);
    await vi.advanceTimersByTimeAsync(999);
    expect(interrupted).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(interrupted).toEqual(['run-1']);
    guard.dispose();
  });

  it('does not fire while a stream is attached', async () => {
    const interrupted: string[] = [];
    const guard = createRemoteRunGuard({
      interrupt: async (runId) => {
        interrupted.push(runId);
      },
      graceMs: 1_000,
    });
    guard.attach('conn-1');
    guard.trackRun(RUN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(interrupted).toEqual([]);
    guard.dispose();
  });

  it('arms on the last detach, and a reconnect inside the grace disarms', async () => {
    const interrupted: string[] = [];
    const guard = createRemoteRunGuard({
      interrupt: async (runId) => {
        interrupted.push(runId);
      },
      graceMs: 1_000,
    });
    guard.attach('conn-1');
    guard.trackRun(RUN);
    guard.detach('conn-1');
    await vi.advanceTimersByTimeAsync(500);
    // The blip: the client is back before the grace closes.
    guard.attach('conn-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(interrupted).toEqual([]);
    // The departure: gone, and it stays gone.
    guard.detach('conn-1');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(interrupted).toEqual(['run-1']);
    guard.dispose();
  });

  it('two overlapping streams count separately — one closing is not a departure', async () => {
    const interrupted: string[] = [];
    const guard = createRemoteRunGuard({
      interrupt: async (runId) => {
        interrupted.push(runId);
      },
      graceMs: 1_000,
    });
    guard.attach('conn-1');
    guard.attach('conn-1');
    guard.trackRun(RUN);
    guard.detach('conn-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(interrupted).toEqual([]);
    guard.dispose();
  });

  it('stops guarding a run the feed says has ended, and reports its session', async () => {
    const interrupted: string[] = [];
    const sessions: Array<{ runId: string; sessionId: string }> = [];
    const feed = createPushFeed();
    const guard = createRemoteRunGuard({
      interrupt: async (runId) => {
        interrupted.push(runId);
      },
      feed,
      onSession: (run, sessionId) => sessions.push({ runId: run.runId, sessionId }),
      graceMs: 1_000,
    });
    guard.trackRun(RUN);
    feed.publish('artemis:push:agent-event', {
      type: 'session.started',
      runId: 'run-1',
      sessionId: 'sess-9',
      seq: 0,
      ts: 0,
    });
    feed.publish('artemis:push:agent-event', {
      type: 'run.end',
      runId: 'run-1',
      sessionId: 'sess-9',
      reason: 'completed',
      seq: 1,
      ts: 0,
    });
    expect(sessions).toEqual([
      { runId: 'run-1', sessionId: 'sess-9' },
      { runId: 'run-1', sessionId: 'sess-9' },
    ]);
    // The run ended on its own; the grace expiring later must not interrupt.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(interrupted).toEqual([]);
    guard.dispose();
  });

  it('untracking the last run disarms the clock', async () => {
    const interrupted: string[] = [];
    const guard = createRemoteRunGuard({
      interrupt: async (runId) => {
        interrupted.push(runId);
      },
      graceMs: 1_000,
    });
    guard.trackRun(RUN);
    guard.untrackRun('run-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(interrupted).toEqual([]);
    guard.dispose();
  });
});
