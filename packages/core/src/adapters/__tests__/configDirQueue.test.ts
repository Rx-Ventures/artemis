/**
 * Queue-depth instrumentation on the config-dir lock.
 *
 * `withClaudeConfigDir` serialises every stored-history operation process-wide
 * — reads for different profiles queue behind each other, and one slow read
 * stalls the sidebar, the pane re-reads and the resume path all at once. The
 * instrumentation's contract: silent at and below the threshold, a report per
 * arrival above it naming what joined and what was holding the lock, and no
 * effect whatsoever on the calls themselves.
 *
 * These tests drive the lock directly with deferred functions rather than
 * mocking the SDK behind ten adapter methods: the subject is the queue, not
 * the reads it carries.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD,
  setClaudeConfigDirQueueReporter,
  withClaudeConfigDir,
} from '../claude.js';
import type { ClaudeConfigDirQueueReport } from '../claude.js';

/** A call whose completion the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  setClaudeConfigDirQueueReporter(undefined);
});

/** Queue `count` calls that stay pending until their gate opens. */
function occupy(count: number, labels: (index: number) => string = (i) => `op-${i + 1}`) {
  const gate = deferred();
  const settled = Array.from({ length: count }, (_, index) =>
    withClaudeConfigDir('/cfg', () => gate.promise, labels(index)),
  );
  return { gate, settled: Promise.all(settled) };
}

describe('the config-dir lock queue', () => {
  it('reports nothing while the queue stays at the threshold', async () => {
    const reports: ClaudeConfigDirQueueReport[] = [];
    setClaudeConfigDirQueueReporter((report) => reports.push(report));

    const { gate, settled } = occupy(CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD);
    gate.resolve();
    await settled;

    expect(reports).toEqual([]);
  });

  it('reports each arrival past the threshold, with depth, the joiner and the holder', async () => {
    const reports: ClaudeConfigDirQueueReport[] = [];
    setClaudeConfigDirQueueReporter((report) => reports.push(report));

    const { gate, settled } = occupy(CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD);
    // Let the chain start executing, so the holder is known by name.
    await Promise.resolve();

    const late = deferred();
    const lateCall = withClaudeConfigDir('/cfg', () => late.promise, 'getSessionMessages');

    expect(reports).toEqual([
      {
        depth: CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD + 1,
        waiting: 'getSessionMessages',
        holding: 'op-1',
      },
    ]);

    gate.resolve();
    late.resolve();
    await Promise.all([settled, lateCall]);
  });

  it('sees the queue drain: a call after the burst reports nothing', async () => {
    const reports: ClaudeConfigDirQueueReport[] = [];
    setClaudeConfigDirQueueReporter((report) => reports.push(report));

    const first = occupy(CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD + 1);
    first.gate.resolve();
    await first.settled;
    reports.length = 0;

    await withClaudeConfigDir('/cfg', () => Promise.resolve(), 'listSessions');
    expect(reports).toEqual([]);
  });

  it('keeps counting a call that failed as departed, not stuck', async () => {
    const reports: ClaudeConfigDirQueueReport[] = [];
    setClaudeConfigDirQueueReporter((report) => reports.push(report));

    await expect(
      withClaudeConfigDir('/cfg', () => Promise.reject(new Error('unreadable')), 'listSessions'),
    ).rejects.toThrow('unreadable');

    // The failure left the counter clean: filling the queue back to the
    // threshold still reports nothing.
    const { gate, settled } = occupy(CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD);
    gate.resolve();
    await settled;
    expect(reports).toEqual([]);
  });

  it('never lets the reporter interfere with the read it observes', async () => {
    setClaudeConfigDirQueueReporter(() => {
      throw new Error('reporter exploded');
    });

    const { gate, settled } = occupy(CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD + 2);
    gate.resolve();
    await expect(settled).resolves.toBeDefined();
  });

  it('still swaps and restores the config directory around every queued call', async () => {
    // The instrumentation must not have touched the lock's actual job. Two
    // profiles' reads see their own directory, and the ambient value returns.
    const previous = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = '/ambient';
    const seen: (string | undefined)[] = [];

    await Promise.all([
      withClaudeConfigDir('/profile-a', () => {
        seen.push(process.env['CLAUDE_CONFIG_DIR']);
        return Promise.resolve();
      }, 'listSessions'),
      withClaudeConfigDir('/profile-b', () => {
        seen.push(process.env['CLAUDE_CONFIG_DIR']);
        return Promise.resolve();
      }, 'listSessions'),
    ]);

    expect(seen).toEqual(['/profile-a', '/profile-b']);
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe('/ambient');
    if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = previous;
  });
});
