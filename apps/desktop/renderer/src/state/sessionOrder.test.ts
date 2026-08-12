/**
 * @vitest-environment jsdom
 *
 * Where a row sits while its agent is working.
 * ============================================================================
 *
 * The sidebar orders by `updatedAt`, which is the transcript file's mtime, and
 * the session feed re-reads it every four seconds while anything is live. With
 * one session running that is invisible — it is already at the top. With two or
 * three, every poll re-answered "who wrote most recently" with a different name,
 * so rows swapped places and whole project groups jumped the queue while the
 * user was reading them. Rows are positioned by index, so they teleport; a list
 * that reshuffles under the pointer also opens the wrong session when clicked.
 *
 * The fix is to hold a session's sort key still for as long as it is being
 * written — `AppState.sessionOrderHold`, minted when a run starts and dropped
 * when it ends. These pin down the three properties that makes it worth having:
 *
 *  1. Starting a run **lifts** the row (the hold is stamped now, not with the
 *     mtime the session was carrying from yesterday).
 *  2. While it runs the row **does not move**, whatever the mtime does.
 *  3. Ending the run **releases** it, back onto a mtime that is by then seconds
 *     old — so the row stays where it was rather than lurching.
 *
 * Same caveat as the rest of this directory: `renderer/tsconfig.json` excludes
 * test files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Capabilities, SessionId, SessionSummary } from '@rx-artemis/protocol';

import { closePane, focusedPane, sessionOrderKey, splitPane, useApp } from './store';
import { paneState, setPaneState } from './pane';
import { groupSessionsByProject } from '../lib/sessionGroups';

const CAPS = { permissionModes: ['default'] } as unknown as Capabilities;

function liveRun(runId: string, sessionId: string) {
  return {
    runId,
    status: 'running',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    capabilities: CAPS,
    startedAt: 1_000,
    sessionId,
  } as const;
}

/** A summary with only the fields the ordering reads. */
function summary(id: string, updatedAt: number, cwd = '/a'): SessionSummary {
  return { id, title: id, cwd, profileId: 'p1', updatedAt, providerId: 'claude' } as SessionSummary;
}

const hold = (): Readonly<Record<SessionId, number>> => useApp.getState().sessionOrderHold;

/** The sidebar's order, for a listing, right now. */
const order = (sessions: readonly SessionSummary[]): readonly string[] =>
  groupSessionsByProject(sessions, { orderKey: (s) => sessionOrderKey(s, hold()) }).flatMap((g) =>
    g.sessions.map((s) => s.id),
  );

beforeEach(() => {
  for (const extra of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    setPaneState(extra, { run: null });
    closePane(extra.id);
  }
  setPaneState(focusedPane(), { run: null, resumeSessionId: null });
  useApp.setState({ background: [], runningSessions: [], sessionOrderHold: {} });
});

describe('holding a running session’s place', () => {
  it('stamps a hold when a run starts and drops it when the run ends', () => {
    const before = Date.now();
    setPaneState(focusedPane(), { run: liveRun('run-a', 'sess-a') });

    expect(Object.keys(hold())).toEqual(['sess-a']);
    expect(hold()['sess-a' as SessionId]).toBeGreaterThanOrEqual(before);

    setPaneState(focusedPane(), { run: { ...liveRun('run-a', 'sess-a'), status: 'ended' } });

    expect(hold()).toEqual({});
  });

  it('lifts a resumed session to the top rather than holding it where it was', () => {
    // `sess-old` was last written long before `sess-new`. Resuming it and
    // sending a prompt has to bring it up — holding it at its own stale mtime
    // would leave the row the user is typing into buried down the list.
    const listing = [summary('sess-old', 1_000), summary('sess-new', 9_000)];
    expect(order(listing)).toEqual(['sess-new', 'sess-old']);

    setPaneState(focusedPane(), { run: liveRun('run-a', 'sess-old') });

    expect(order(listing)).toEqual(['sess-old', 'sess-new']);
  });

  it('does not move the row when the poll reports a newer mtime', () => {
    setPaneState(focusedPane(), { run: liveRun('run-a', 'sess-a') });
    const right = splitPane('right');
    if (!right) throw new Error('expected a second column');
    setPaneState(right, { run: liveRun('run-b', 'sess-b') });

    const first = order([summary('sess-a', 1_000), summary('sess-b', 2_000)]);

    // Three polls later, each agent having written at a different moment — the
    // exact churn that used to swap these two rows every four seconds.
    expect(order([summary('sess-a', 8_000), summary('sess-b', 2_000)])).toEqual(first);
    expect(order([summary('sess-a', 8_000), summary('sess-b', 9_000)])).toEqual(first);
    expect(order([summary('sess-a', 11_000), summary('sess-b', 9_000)])).toEqual(first);
  });

  it('holds a project’s place in the list, not just a row’s inside it', () => {
    setPaneState(focusedPane(), { run: liveRun('run-a', 'sess-a') });

    const listing = [summary('sess-a', 1_000, '/api'), summary('sess-b', 2_000, '/web')];
    const groups = (of: readonly SessionSummary[]) =>
      groupSessionsByProject(of, { orderKey: (s) => sessionOrderKey(s, hold()) }).map((g) => g.project);

    expect(groups(listing)).toEqual(['/api', '/web']);
    // `/web` was written more recently, and still does not displace the project
    // whose agent is working.
    expect(groups([summary('sess-a', 1_000, '/api'), summary('sess-b', 20_000, '/web')])).toEqual([
      '/api',
      '/web',
    ]);
  });

  it('keeps the same record while the running set is unchanged', () => {
    setPaneState(focusedPane(), { run: liveRun('run-a', 'sess-a') });
    const stamped = hold();

    // A composer keystroke: same pane store, nothing to do with runs. Re-minting
    // the record here would re-render the whole session list per character.
    setPaneState(focusedPane(), { draft: 'typing' });

    expect(hold()).toBe(stamped);
  });

  it('releases only the session that stopped', () => {
    setPaneState(focusedPane(), { run: liveRun('run-a', 'sess-a') });
    const right = splitPane('right');
    if (!right) throw new Error('expected a second column');
    setPaneState(right, { run: liveRun('run-b', 'sess-b') });
    const heldA = hold()['sess-a' as SessionId];

    setPaneState(right, { run: { ...liveRun('run-b', 'sess-b'), status: 'ended' } });

    expect(Object.keys(hold())).toEqual(['sess-a']);
    // Untouched, not re-stamped: the surviving run's row must not move because
    // a different one finished.
    expect(hold()['sess-a' as SessionId]).toBe(heldA);
  });

  it('holds the session the next prompt continues, before the run has an id', () => {
    // The run reports its own `sessionId` only once the provider has minted one.
    // Until then the pane's `resumeSessionId` is what the sidebar marks, and the
    // two must hold the same row — see `syncRunningSessions`.
    setPaneState(focusedPane(), {
      run: { ...liveRun('run-a', 'sess-a'), sessionId: undefined },
      resumeSessionId: 'sess-a' as SessionId,
    });

    expect(Object.keys(hold())).toEqual(['sess-a']);
    expect(paneState(focusedPane()).run?.sessionId).toBeUndefined();
  });
});
