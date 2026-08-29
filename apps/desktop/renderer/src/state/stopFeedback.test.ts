/**
 * @vitest-environment jsdom
 *
 * The stop button answers the click, not the round-trip ("the stop button is
 * SUPER slow and laggy").
 *
 * Measured before anything was changed: between the click and the run's
 * `run.end` coming back, the renderer wrote *nothing*. `interruptRun` awaited
 * the IPC call — which itself awaits the adapter, which awaits the CLI, seconds
 * on a real run — and only `run.end` moved any state a component reads. A stop
 * that is working perfectly therefore looks exactly like a stop that did
 * nothing: same glyph, same shuttle, same "running", for however long the
 * provider takes to let go. That silence is the lag the user reported.
 *
 * So the contract pinned here is about *when*, not just what:
 *
 *  - **The click lands synchronously.** `interruptRun` writes
 *    `interruptRequested` before its first await, so the button and the
 *    activity line change in the same frame as the click — acknowledgement
 *    cannot depend on main, the adapter, or the provider being quick.
 *  - **Streaming load cannot delay it.** The transcript batches its rendering
 *    onto animation frames, but the run state is not the transcript: a click
 *    arriving behind hundreds of undrawn deltas still lands first.
 *  - **A refused interrupt takes the acknowledgement back.** The flag is the
 *    button's disabled state, and a button that stayed dead after main said
 *    "no" would leave the run with no stop at all.
 *  - **`run.end` settles the pane the instant it arrives.** The tail of the
 *    wait is the provider's; the renderer adds nothing to it.
 *
 * Same caveat as its neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { focusedPane, handleAgentEvent, interruptRun, useApp } from './store';
import { paneState, setPaneState } from './pane';

/* -------------------------------------------------------------------------- */
/* A bridge whose interrupt answers only when the test says so                */
/* -------------------------------------------------------------------------- */

/** How main answers `runs.interrupt`. Reassigned per test. */
let interruptAnswer: () => Promise<unknown> = () =>
  new Promise(() => {
    // Never resolves: the round-trip the acknowledgement must not wait for.
  });

/** How many times the bridge was asked. */
let interruptCalls = 0;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    interrupt: async () => {
      interruptCalls += 1;
      return interruptAnswer();
    },
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const STEERABLE = { ...NO_CAPABILITIES, midRunSteering: true };

function liveRun(): void {
  setPaneState(focusedPane(), {
    run: {
      runId: 'r1',
      status: 'running',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/repo',
      capabilities: STEERABLE,
      startedAt: 1,
      sessionId: 'sess-1',
    } as never,
    permissionQueue: [],
  });
}

/** One streamed word, addressed like the adapter would address it. */
function delta(seq: number): never {
  return {
    type: 'text.delta',
    runId: 'r1',
    seq,
    ts: seq,
    messageId: 'm1',
    blockIndex: 0,
    text: `word${seq} `,
  } as never;
}

const banners = (): readonly { readonly message: string }[] =>
  useApp.getState().banners as readonly { readonly message: string }[];

beforeEach(() => {
  interruptCalls = 0;
  interruptAnswer = () => new Promise(() => {});
  useApp.setState({ banners: [] });
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    activeProfileId: 'p1',
    activeProviderId: 'claude',
    cwd: '/repo',
    run: null,
    permissionQueue: [],
    promptHistory: [],
  } as never);
  useApp.setState({
    providers: [{ id: 'claude', label: 'Claude', capabilities: STEERABLE, models: [] }] as never,
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude' }] as never,
  });
});

describe('clicking stop', () => {
  it('changes what is on screen before any round-trip, not after run.end', () => {
    liveRun();
    const pane = focusedPane();

    // The symptom, made falsifiable: does *any* state a component reads change
    // in the same tick as the click? Zero notifications here is the reported
    // bug — a Stop that answers nothing until the provider lets go.
    let notified = 0;
    const unsubscribe = pane.store.subscribe(() => {
      notified += 1;
    });
    void interruptRun(pane);
    unsubscribe();

    expect(notified).toBeGreaterThan(0);
    expect(paneState(pane).run?.interruptRequested).toBe(true);
    // Still the same run, still live: the acknowledgement is a fact about the
    // request, not a guess about the outcome.
    expect(paneState(pane).run?.status).toBe('running');
    // And the wire was asked — the flag is an acknowledgement, not a substitute.
    expect(interruptCalls).toBe(1);
  });

  it('is not queued behind a transcript that is streaming hard', () => {
    liveRun();
    const pane = focusedPane();

    // A few hundred deltas the display has not drawn yet — the transcript holds
    // them for its next animation frame. The click must not wait in that line.
    for (let seq = 0; seq < 400; seq += 1) handleAgentEvent(delta(seq));

    void interruptRun(pane);

    expect(paneState(pane).run?.interruptRequested).toBe(true);
  });

  it('takes the acknowledgement back when main refuses the interrupt', async () => {
    liveRun();
    const pane = focusedPane();
    interruptAnswer = async () => ({
      ok: false,
      error: { code: 'transport', message: 'The main process did not respond.' },
    });

    await interruptRun(pane);

    // The flag is what disables the button, so a refusal has to clear it — a
    // run that could not be stopped still needs its stop. The failure itself is
    // reported where failures are reported.
    expect(paneState(pane).run?.interruptRequested).not.toBe(true);
    expect(banners().map((b) => b.message)).toEqual([
      'Could not interrupt the run: The main process did not respond.',
    ]);
  });

  it('settles the pane the instant run.end arrives, no frame in between', () => {
    liveRun();
    const pane = focusedPane();
    void interruptRun(pane);

    handleAgentEvent({
      type: 'run.end',
      runId: 'r1',
      seq: 500,
      ts: 500,
      reason: 'interrupted',
    } as never);

    // Synchronous on the event, deliberately unawaited: the transcript may owe
    // the display a flush, but the run state is what the button and the shuttle
    // read, and it must not ride the transcript's frame.
    const run = paneState(pane).run;
    expect(run?.status).toBe('ended');
    expect(run?.endReason).toBe('interrupted');
  });

  it('leaves Escape a second shot while the first interrupt is in flight', () => {
    // The acknowledged button is disabled, so Escape is the only retry there
    // is. It must reach the wire, not short-circuit on the flag — a lost
    // interrupt with a swallowed retry is a run nobody can end.
    liveRun();
    const pane = focusedPane();

    void interruptRun(pane);
    void interruptRun(pane);

    expect(interruptCalls).toBe(2);
  });
});
