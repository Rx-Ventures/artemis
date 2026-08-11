/**
 * The grid: what splitting, closing and routing actually do.
 *
 * Every assertion here is about a rule that is invisible when it breaks. A
 * split that lands in the wrong row still renders a perfectly reasonable
 * window; an event routed to the wrong pane still draws a transcript; a closed
 * pane that leaves an empty row still looks like a layout. None of them throw,
 * and none of them look wrong in a screenshot — which is exactly the class of
 * regression the rest of this suite exists for.
 *
 * The four rules:
 *
 *  1. **Right grows a row, down adds a full-width one.** This is the whole
 *     layout model, and the reason a third conversation under a left/right pair
 *     spans the window instead of quartering it.
 *  2. **Four panes, whatever the shape.** The ceiling bounds conversations, not
 *     row length — see `MAX_PANES`.
 *  3. **A row dies with its last pane**, and the focus lands on a neighbour
 *     rather than jumping to the corner.
 *  4. **Events reach the pane that owns the run**, by `runId` and nothing else.
 *     Two panes streaming at once is the case the whole split exists for, and
 *     it is the one place a mix-up would put one agent's output under another
 *     agent's prompt.
 *
 * Same caveat as `cwd.test.ts` and `models.test.ts`: `renderer/tsconfig.json`
 * excludes test files, so `pnpm typecheck` never sees this one and the
 * assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  MAX_PANES,
  allPanes,
  canSplit,
  closePane,
  focusPane,
  focusedPane,
  handleAgentEvent,
  paneCount,
  splitPane,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

/** The shape of the grid, as rows of pane ids. */
const shape = (): string[][] => useApp.getState().grid.map((row) => row.panes.map((p) => p.id));

/** Collapse back to a single pane between tests, without touching the first one. */
function collapse(): void {
  // Closing always keeps one, so this terminates.
  for (let guard = 0; guard < 20 && paneCount() > 1; guard += 1) {
    const last = allPanes()[paneCount() - 1];
    if (last) closePane(last.id);
  }
}

beforeEach(() => {
  collapse();
  useApp.setState({ paneLayout: {}, banners: [] });
});

describe('splitting', () => {
  it('adds a column to the focused pane’s row', () => {
    splitPane('right');

    expect(shape()).toHaveLength(1);
    expect(shape()[0]).toHaveLength(2);
  });

  it('puts a third pane across the full width, not in a quarter', () => {
    // The case this layout model exists for. A matrix would have to either
    // widen the grid to 2×2 with an empty cell or refuse.
    splitPane('right');
    splitPane('down');

    const rows = shape();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(2);
    expect(rows[1]).toHaveLength(1);
  });

  it('reaches a two-by-two by splitting the full-width row', () => {
    splitPane('right');
    splitPane('down');
    // `splitPane` focuses what it created, so this grows the bottom row.
    splitPane('right');

    expect(shape().map((row) => row.length)).toEqual([2, 2]);
  });

  it('focuses the pane it just created', () => {
    const created = splitPane('right');
    expect(focusedPane().id).toBe(created?.id);
  });

  it('seeds the new pane from the one it was split off', () => {
    setPaneState(focusedPane(), { cwd: '/somewhere/else', model: 'opus' });

    const created = splitPane('right');

    // Splitting happens *while working*, so the new pane opens where the user
    // already is rather than wherever the app launched.
    expect(paneState(created!).cwd).toBe('/somewhere/else');
    expect(paneState(created!).model).toBe('opus');
    // But it is a fresh conversation, not a second view of the same one.
    expect(paneState(created!).resumeSessionId).toBeNull();
    expect(paneState(created!).run).toBeNull();
  });

  it('survives alternating directions and closes', () => {
    // Reported as "changing split direction crashes the renderer". The store
    // half of that is this: every one of these transitions adds or removes a
    // row *and* changes whether a row has an inner group at all, which is the
    // seam where an off-by-one in `locate` or `closePane` would surface as a
    // torn grid rather than as an error.
    const shapes: string[] = [];
    const record = (): void => {
      shapes.push(shape().map((row) => row.length).join('+'));
    };

    splitPane('right');
    record();
    splitPane('down');
    record();
    closePane(allPanes()[paneCount() - 1]!.id);
    record();
    splitPane('down');
    record();
    closePane(allPanes()[paneCount() - 1]!.id);
    record();
    closePane(allPanes()[paneCount() - 1]!.id);
    record();
    splitPane('right');
    record();

    expect(shapes).toEqual(['2', '2+1', '2', '2+1', '2', '1', '2']);
    // Never an empty row left behind, and never a pane orphaned out of the grid.
    expect(shape().every((row) => row.length > 0)).toBe(true);
    expect(paneCount()).toBe(2);
  });

  it('stops at the pane limit, in whatever shape', () => {
    // Driven off MAX_PANES rather than a fixed run of splits, and alternating
    // the axis so the cap is proved against a ragged grid rather than a single
    // row — the limit bounds the window's conversations, not a row's length.
    // Hardcoding the count would leave this asserting against a grid that never
    // reached the ceiling the moment the ceiling moved.
    for (let i = 1; i < MAX_PANES; i += 1) {
      expect(splitPane(i % 2 === 0 ? 'down' : 'right')).not.toBeNull();
    }

    expect(paneCount()).toBe(MAX_PANES);
    expect(canSplit()).toBe(false);
    // The controls are already disabled by then; this is the backstop for a
    // keyboard shortcut, which must not quietly add one more.
    expect(splitPane('right')).toBeNull();
    expect(splitPane('down')).toBeNull();
    expect(paneCount()).toBe(MAX_PANES);
  });
});

describe('closing', () => {
  it('drops the row when its last pane goes', () => {
    splitPane('right');
    splitPane('down');
    const bottom = useApp.getState().grid[1]!.panes[0]!;

    closePane(bottom.id);

    // The width goes back to the row above rather than leaving a band of
    // nothing where the row was.
    expect(shape()).toHaveLength(1);
    expect(shape()[0]).toHaveLength(2);
  });

  it('keeps the row when it still has panes', () => {
    splitPane('right');
    const second = useApp.getState().grid[0]!.panes[1]!;

    closePane(second.id);

    expect(shape()).toEqual([[useApp.getState().grid[0]!.panes[0]!.id]]);
  });

  it('moves focus to a neighbour rather than the corner', () => {
    splitPane('right');
    splitPane('right');
    const [first, , third] = useApp.getState().grid[0]!.panes;

    focusPane(third!.id);
    closePane(third!.id);

    // The pane that took its place, or the one before it — not a leap back to
    // the top left, which in a four-pane grid is disorienting.
    expect(focusedPane().id).not.toBe(first!.id);
  });

  it('refuses to close the last pane', () => {
    const only = focusedPane();
    closePane(only.id);

    expect(paneCount()).toBe(1);
    expect(focusedPane().id).toBe(only.id);
  });

  it('leaves the other panes’ focus alone', () => {
    splitPane('right');
    const [first, second] = useApp.getState().grid[0]!.panes;
    focusPane(first!.id);

    closePane(second!.id);

    expect(focusedPane().id).toBe(first!.id);
  });
});

describe('event routing', () => {
  const run = (runId: string, cwd: string) => ({
    runId,
    status: 'running' as const,
    providerId: 'claude' as const,
    profileId: 'p1',
    cwd,
    capabilities: NO_CAPABILITIES,
    startedAt: 0,
  });

  it('delivers a run’s events to the pane that owns it, and to no other', () => {
    const left = focusedPane();
    const right = splitPane('right')!;
    setPaneState(left, { run: run('run-left', '/a') });
    setPaneState(right, { run: run('run-right', '/b') });

    handleAgentEvent({
      type: 'session.started',
      runId: 'run-right',
      seq: 0,
      ts: 0,
      sessionId: 'sess-right',
    } as never);

    // The case the whole split exists for: two agents streaming at once. A
    // `runId` mix-up here would put one agent's output under the other's
    // prompt, which reads as the model losing its mind rather than as a bug.
    expect(paneState(right).run?.sessionId).toBe('sess-right');
    expect(paneState(left).run?.sessionId).toBeUndefined();
  });

  it('drops an event for a run nothing here owns', () => {
    const only = focusedPane();
    setPaneState(only, { run: run('run-mine', '/a') });

    // Another window's run, or one whose pane has since been closed. Events are
    // multiplexed across every run the main process drives.
    handleAgentEvent({
      type: 'session.started',
      runId: 'run-someone-elses',
      seq: 0,
      ts: 0,
      sessionId: 'sess-other',
    } as never);

    expect(paneState(only).run?.sessionId).toBeUndefined();
    expect(only.transcript.isEmpty).toBe(true);
  });
});
