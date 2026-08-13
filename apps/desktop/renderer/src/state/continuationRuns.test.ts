/**
 * @vitest-environment jsdom
 *
 * A turn the provider started by itself, arriving in a window that never asked
 * for one.
 *
 * The provider can now speak unprompted: told that background work finished,
 * the agent answers, and a subagent that outlived its own turn can ask for a
 * tool long after it. Those turns are real runs with real transcripts, and they
 * arrive on a run id nothing in this window has ever seen — which matters
 * because event routing is by run id and nothing else, so the default answer to
 * an unknown one is to drop it.
 *
 * Dropping it is right for another window's run and wrong for this, and the two
 * are told apart by the session id on `session.started`: a conversation this
 * window is holding is one it should be showing. What these assert is the seam
 * between those, including the three cases that must stay silent — a session
 * nobody here holds, a column already running something the user can see, and a
 * pane that cannot say whose account a turn would even belong to.
 *
 * Same caveat as `paneGrid.test.ts`: `renderer/tsconfig.json` excludes test
 * files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { closePane, focusedPane, handleAgentEvent, paneCount, allPanes, useApp } from './store';
import { paneState, setPaneState } from './pane';
import { seedApp } from './testkit';

const SESSION = 'sess-abc';

/** A run in the state it is in once its turn has finished. */
const endedRun = (runId: string, sessionId = SESSION) => ({
  runId,
  status: 'ended' as const,
  providerId: 'claude' as const,
  profileId: 'profile-1',
  cwd: '/repo',
  capabilities: NO_CAPABILITIES,
  startedAt: 1,
  sessionId,
  endReason: 'completed' as const,
});

/** The first event of any turn, and the only one that names the conversation. */
const started = (runId: string, sessionId = SESSION) =>
  ({
    type: 'session.started',
    runId,
    seq: 0,
    ts: 0,
    sessionId,
  }) as never;

const said = (runId: string, text: string, seq = 1) =>
  ({
    type: 'text.complete',
    runId,
    seq,
    ts: 0,
    role: 'assistant',
    messageId: `m-${runId}-${String(seq)}`,
    blockIndex: 0,
    text,
  }) as never;

beforeEach(() => {
  for (let guard = 0; guard < 20 && paneCount() > 1; guard += 1) {
    const last = allPanes()[paneCount() - 1];
    if (last) closePane(last.id);
  }
  useApp.setState({ background: [] });
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    run: null,
    resumeSessionId: null,
    activeProfileId: 'profile-1',
    cwd: '/repo',
  });
});

describe('a turn the provider started on its own', () => {
  it('lands in the conversation it belongs to, and draws', () => {
    const pane = focusedPane();
    setPaneState(pane, { run: endedRun('run-1'), resumeSessionId: SESSION });

    handleAgentEvent(started('run-c1'));
    handleAgentEvent(said('run-c1', 'The background task finished.'));

    // Claimed, and now the live run of that column: the next Stop button, the
    // sidebar's working light and the run info dialog all read this.
    expect(paneState(pane).run?.runId).toBe('run-c1');
    expect(paneState(pane).run?.status).toBe('running');
    expect(paneState(pane).run?.sessionId).toBe(SESSION);
    expect(pane.transcript.isEmpty).toBe(false);
  });

  it('carries none of the finished run over with it', () => {
    const pane = focusedPane();
    setPaneState(pane, { run: endedRun('run-1'), resumeSessionId: SESSION });

    handleAgentEvent(started('run-c1'));

    // `endReason` belongs to the run that ended. Left in place it would describe
    // this turn as having completed before its first event was applied, which
    // the run-state row would render as a finished conversation that is talking.
    expect(paneState(pane).run?.endReason).toBeUndefined();
    expect(paneState(pane).run?.startedAt).not.toBe(1);
  });

  it('is claimed by a column that has the session open but has never run it', () => {
    const pane = focusedPane();
    // Opened from the sidebar: there is no run here, only the session the next
    // prompt would continue. The process belongs to another column or another
    // window, and the conversation is still this one.
    setPaneState(pane, { run: null, resumeSessionId: SESSION });

    handleAgentEvent(started('run-c1'));
    handleAgentEvent(said('run-c1', 'done'));

    expect(paneState(pane).run?.runId).toBe('run-c1');
    expect(paneState(pane).run?.profileId).toBe('profile-1');
    expect(paneState(pane).run?.cwd).toBe('/repo');
    expect(pane.transcript.isEmpty).toBe(false);
  });

  it('ends the way any other run does', () => {
    const pane = focusedPane();
    setPaneState(pane, { run: endedRun('run-1'), resumeSessionId: SESSION });

    handleAgentEvent(started('run-c1'));
    handleAgentEvent({
      type: 'run.end',
      runId: 'run-c1',
      seq: 2,
      ts: 0,
      reason: 'completed',
      sessionId: SESSION,
    } as never);

    // The claimed run, ended — not the previous one still sitting there, which
    // was already `ended` and would satisfy a laxer assertion for free.
    expect(paneState(pane).run?.runId).toBe('run-c1');
    expect(paneState(pane).run?.status).toBe('ended');
    // Still the conversation to continue: a continuation is inside the session,
    // not a new one.
    expect(paneState(pane).run?.sessionId).toBe(SESSION);
  });

  it('leaves a session no column here holds alone', () => {
    const pane = focusedPane();
    setPaneState(pane, { run: endedRun('run-1'), resumeSessionId: SESSION });

    // Another window's conversation. Every window receives every event.
    handleAgentEvent(started('run-c9', 'sess-elsewhere'));
    handleAgentEvent(said('run-c9', 'not for this window'));

    expect(paneState(pane).run?.runId).toBe('run-1');
    expect(pane.transcript.isEmpty).toBe(true);
  });

  it('does not repoint a column that is running something', () => {
    const pane = focusedPane();
    // The race this guards: the user got a prompt in between the provider
    // opening its turn and this window hearing about it. Repointing the column
    // would leave the run they can see with nowhere to draw.
    setPaneState(pane, {
      run: { ...endedRun('run-2'), status: 'running' },
      resumeSessionId: SESSION,
    });

    handleAgentEvent(started('run-c1'));
    handleAgentEvent(said('run-c1', 'stolen'));

    expect(paneState(pane).run?.runId).toBe('run-2');
    expect(pane.transcript.isEmpty).toBe(true);
  });

  it('does not claim one for a column with no account to attribute it to', () => {
    const pane = focusedPane();
    // A conversation open from history under no profile cannot be continued
    // either, so there is nothing this turn could honestly be said to be.
    setPaneState(pane, { run: null, resumeSessionId: SESSION, activeProfileId: null });

    handleAgentEvent(started('run-c1'));
    handleAgentEvent(said('run-c1', 'orphan'));

    expect(paneState(pane).run).toBeNull();
    expect(pane.transcript.isEmpty).toBe(true);
  });
});
