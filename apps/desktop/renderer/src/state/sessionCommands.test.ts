/**
 * @vitest-environment jsdom
 *
 * The slash-command list, revised under a session that is already open.
 *
 * `session.started` reports what the session opened with, and that used to be
 * the only thing the composer's menu ever knew: the provider's own push of a
 * revised list was mapped to nothing, so a plugin the user installed while a
 * conversation was open stayed invisible in it until they started another one.
 *
 * What these pin down is the replace-not-merge contract, which is the whole
 * reason the event carries the full list — a command that has gone away has no
 * other way to say so — and the two things the event must *not* do: revive a
 * finished run, or arrive in a pane it does not belong to.
 *
 * Same caveat as `paneGrid.test.ts`: `renderer/tsconfig.json` excludes test
 * files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { allPanes, closePane, focusedPane, handleAgentEvent, paneCount } from './store';
import { paneState, setPaneState } from './pane';

const RUN = 'run-1';

/** A run mid-turn, holding the list its `session.started` reported. */
const liveRun = (slashCommands: readonly string[]) => ({
  runId: RUN,
  status: 'running' as const,
  providerId: 'claude' as const,
  profileId: 'profile-1',
  cwd: '/repo',
  capabilities: NO_CAPABILITIES,
  startedAt: 1,
  sessionId: 'sess-abc',
  slashCommands,
});

const commandsChanged = (runId: string, slashCommands: readonly string[], seq = 1) =>
  ({
    type: 'session.commands',
    runId,
    seq,
    ts: 0,
    slashCommands,
  }) as never;

beforeEach(() => {
  for (let guard = 0; guard < 20 && paneCount() > 1; guard += 1) {
    const last = allPanes()[paneCount() - 1];
    if (last) closePane(last.id);
  }
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, { run: liveRun(['compact', 'help']) });
});

describe('session.commands', () => {
  it('puts a newly discovered command on offer without a new session', () => {
    const pane = focusedPane();

    handleAgentEvent(commandsChanged(RUN, ['compact', 'help', 'mattpocock-skills:tdd']));

    expect(paneState(pane).run?.slashCommands).toEqual([
      'compact',
      'help',
      'mattpocock-skills:tdd',
    ]);
  });

  it('replaces rather than merges, so a command the user removed can leave', () => {
    const pane = focusedPane();

    handleAgentEvent(commandsChanged(RUN, ['compact']));

    expect(paneState(pane).run?.slashCommands).toEqual(['compact']);
  });

  it('accepts an empty list, which is how the last one leaves', () => {
    const pane = focusedPane();

    handleAgentEvent(commandsChanged(RUN, []));

    expect(paneState(pane).run?.slashCommands).toEqual([]);
  });

  it('leaves the run status alone, so a finished conversation stays finished', () => {
    // A provider process outlives the turn it served and can push a revised list
    // after `run.end`. Flipping the run back to running here would unlock the
    // composer on a conversation that is over.
    const pane = focusedPane();
    setPaneState(pane, { run: { ...liveRun(['compact']), status: 'ended', endReason: 'completed' } });

    handleAgentEvent(commandsChanged(RUN, ['compact', 'help']));

    expect(paneState(pane).run?.status).toBe('ended');
    expect(paneState(pane).run?.slashCommands).toEqual(['compact', 'help']);
  });

  it('ignores a push for a run this window is not holding', () => {
    const pane = focusedPane();

    handleAgentEvent(commandsChanged('run-somewhere-else', ['whatever']));

    expect(paneState(pane).run?.slashCommands).toEqual(['compact', 'help']);
  });
});
