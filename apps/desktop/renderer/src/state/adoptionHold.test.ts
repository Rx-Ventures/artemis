/**
 * @vitest-environment jsdom
 *
 * Re-attaching to a live run must not silence it.
 *
 * `attachRun` holds a run's live events back while it rebuilds the conversation,
 * so that a token arriving mid-fetch cannot be applied above the history it
 * belongs after. That hold is correct and it is also the most dangerous state in
 * the renderer: while it is on, every event for the run goes into a buffer and
 * nothing reaches the screen. Two properties keep it safe, and both were missing.
 *
 *  - **It is per run.** Adoption used to await each attach in turn, so run *n*
 *    held its stream for the sum of every earlier run's reads. The reads behind
 *    them are whole stored transcripts, serialised process-wide in main against
 *    the sidebar's four-second poll and every other profile's history — which is
 *    why this showed up for people running several profiles at once, and why the
 *    backlog arrived as one burst rather than as a stream.
 *  - **It is finite.** `call` has no timeout. A read that never came back left
 *    the buffer holding the conversation for the rest of the session, and the
 *    agent went on working into it invisibly.
 *
 * Same caveat as `backgroundRuns.test.ts`: `renderer/tsconfig.json` excludes test
 * files, so these assertions are behavioural rather than typechecked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootstrap, focusedPane, handleAgentEvent, useApp, allPanes } from './store';
import { paneState, setPaneState } from './pane';
import { seedApp } from './testkit';

/* -------------------------------------------------------------------------- */
/* Bridge                                                                     */
/* -------------------------------------------------------------------------- */

const CAPS = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
} as const;

const CLAUDE_DESCRIPTOR = {
  id: 'claude',
  label: 'Claude',
  capabilities: CAPS,
  models: [],
  effortLevels: [],
  available: true,
};

let mainProcessRuns: readonly unknown[] = [];
/** Session id → a gate the history read parks on, so a test can stall one. */
let historyGates = new Map<string, Promise<void>>();
/** Which runs have had their retained events asked for. */
const eventsAsked: string[] = [];
/** How many upcoming `runs.list` calls fail before the stub answers again. */
let listFailures = 0;
/** Every `runs.list` call, counted to pin the retry. */
let listCalls = 0;

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
    // Non-zero, so `replayEarlierTurns` actually reads rather than returning early.
    historyOffset: 2,
  } as const;
}

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => {
      listCalls += 1;
      if (listFailures > 0) {
        listFailures -= 1;
        return {
          ok: false,
          error: { code: 'transport', message: 'the main process did not answer', retryable: true },
        };
      }
      return { ok: true, value: { runs: mainProcessRuns } };
    },
    events: async ({ runId }: { runId: string }) => {
      eventsAsked.push(runId);
      return { ok: true, value: { runId, events: [], truncated: false } };
    },
    liveWork: async () => ({ ok: true, value: { sessionIds: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async (request: { sessionId: string }) => {
      const gate = historyGates.get(request.sessionId);
      if (gate) await gate;
      return { ok: true, value: { events: [], hasMore: false } };
    },
  },
  profiles: {
    list: async () => ({
      ok: true,
      value: {
        profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' }],
      },
    }),
  },
  providers: {
    list: async () => ({ ok: true, value: { providers: [CLAUDE_DESCRIPTOR] } }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
  },
  usagePlan: { cached: async () => ({ ok: true, value: { usage: null } }) },
  workspace: { describe: async () => ({ ok: true, value: { workspace: null } }) },
};

/** A `text.complete` on `runId`, as the live feed would deliver it. */
function say(runId: string, text: string) {
  return {
    type: 'text.complete',
    runId,
    seq: 0,
    ts: 1,
    messageId: `${runId}:m0`,
    role: 'assistant',
    text,
  } as never;
}

/** The pane holding `runId`, whichever column or background slot it landed in. */
function paneFor(runId: string) {
  const state = useApp.getState();
  return [...allPanes(state), ...state.background].find(
    (pane) => paneState(pane).run?.runId === runId,
  );
}

function transcriptText(runId: string): string {
  const pane = paneFor(runId);
  if (!pane) return '';
  return pane.transcript
    .getListSnapshot()
    .map((id) => (pane.transcript.getItem(id) as { text?: string } | undefined)?.text ?? '')
    .join('');
}

beforeEach(() => {
  seedApp({});
  mainProcessRuns = [];
  historyGates = new Map();
  eventsAsked.length = 0;
  listFailures = 0;
  listCalls = 0;
  useApp.setState({ banners: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('adopting live runs after a reload', () => {
  it('does not let one conversation’s replay hold another’s stream back', async () => {
    let openTheGate = (): void => undefined;
    historyGates.set(
      's1',
      new Promise<void>((resolve) => {
        openTheGate = resolve;
      }),
    );

    mainProcessRuns = [liveRun('r1', 's1'), liveRun('r2', 's2')];

    const booted = bootstrap();
    // Let the adoption get as far as it can with `s1`'s history stalled.
    await vi.waitFor(() => expect(eventsAsked).toContain('r2'));

    // r2 is fully attached while r1 is still waiting, so its live events apply
    // rather than piling up behind a conversation it has nothing to do with.
    handleAgentEvent(say('r2', 'second run speaking'));
    await vi.waitFor(() => expect(transcriptText('r2')).toContain('second run speaking'));

    openTheGate();
    await booted;
  });

  it('releases the hold when the replay never comes back', async () => {
    vi.useFakeTimers();

    // A history read that is never answered — a wedged main process, or a store
    // read stuck behind the config-directory lock.
    historyGates.set('s1', new Promise<void>(() => undefined));
    mainProcessRuns = [liveRun('r1', 's1')];

    void bootstrap();
    await vi.advanceTimersByTimeAsync(50);

    // Held, as designed, while the replay is still plausibly coming.
    handleAgentEvent(say('r1', 'work carried on'));
    expect(transcriptText('r1')).not.toContain('work carried on');

    // Past the hold, the run is released rather than left buffering forever.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transcriptText('r1')).toContain('work carried on');
  });
});

/* -------------------------------------------------------------------------- */
/* The one registry read at boot                                              */
/* -------------------------------------------------------------------------- */

/*
 * `adoptLiveRuns` is the only reader of the registry at boot. One failed IPC
 * round-trip used to orphan every live run for the whole window session — and
 * silently, which gave "reload to fix one stall" the power to strand the rest.
 * The repair is proportionate: try once more, and if that also fails, say so,
 * because a user told the truth reloads again and a user told nothing watches
 * a working agent paint no pixels.
 */
describe('when the boot-time registry read fails', () => {
  /*
   * The suite shares one focused pane across tests, and a run adopted by an
   * earlier case would satisfy `paneFor` here for the wrong reason. Each case
   * starts from a pane that holds nothing.
   */
  beforeEach(() => {
    setPaneState(focusedPane(), { run: null });
  });

  it('retries once and still adopts everything', async () => {
    vi.useFakeTimers();
    listFailures = 1;
    mainProcessRuns = [liveRun('r1', 's1')];

    const booted = bootstrap();
    await vi.advanceTimersByTimeAsync(1_100);
    await booted;

    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(paneFor('r1')).toBeDefined();
    expect(useApp.getState().banners).toHaveLength(0);
  });

  it('says so when the retry fails too, instead of orphaning silently', async () => {
    vi.useFakeTimers();
    listFailures = 2;
    mainProcessRuns = [liveRun('r1', 's1')];

    const booted = bootstrap();
    await vi.advanceTimersByTimeAsync(1_100);
    await booted;

    expect(paneFor('r1')).toBeUndefined();
    const banners = useApp.getState().banners;
    expect(banners.some((b) => b.message.includes('conversations still running'))).toBe(true);
  });
});
