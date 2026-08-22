/**
 * @vitest-environment jsdom
 *
 * The stall sweep: a lost stream costs seconds, not a ⌘R.
 *
 * The reported symptom, in the user's own words: send a message, the pane says
 * "starting" forever — or "thinking", or "running" — and on reload everything
 * is there and the task is done. Every shape of that report is one fact seen
 * from different moments: the run lived in the main process, its events never
 * (or only partly) reached this window, and with no later event there was no
 * seq gap, so nothing ever noticed. The push stream was the only source of
 * liveness, and it had failed silently.
 *
 * The sweep is the renderer giving up that trust. A pane that reads live but
 * has heard nothing for a while is checked against main — which has perfect
 * information — and healed from the retained events. What is pinned here:
 *
 *  - each stuck shape actually heals, with the *real* events and the *real*
 *    end, not a synthesis;
 *  - a quiet-but-working run is left entirely alone, and cheaply — the whole
 *    economics rest on `RunHandle.lastSeq` making "behind" provable without
 *    fetching anything;
 *  - the healing is idempotent: a replay racing the live stream must not draw
 *    anything twice.
 *
 * Same caveat as the neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  focusedPane,
  handleAgentEvent,
  resetRunStreamState,
  submitPrompt,
  sweepStalledRuns,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

/* -------------------------------------------------------------------------- */
/* A bridge whose main process has perfect information                        */
/* -------------------------------------------------------------------------- */

/** What the registry claims is running, and how far each stream has got. */
let mainProcessRuns: readonly Record<string, unknown>[] = [];
/** What the registry has retained, per run. */
let retainedEvents: Record<string, readonly unknown[]> = {};
/** Calls, recorded to assert the sweep's economics, not just its outcome. */
let listCalls = 0;
let eventsCalls: string[] = [];
/** Set by a test to hold the events reply open; resolved to release it. */
let holdEventsReply: Promise<void> | null = null;

let startedRunIds: string[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    start: async ({ input }: { input: { runId: string; prompt: string } }) => {
      startedRunIds.push(input.runId);
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'starting',
            capabilities: RESUMABLE,
            startedAt: Date.now(),
          },
        },
      };
    },
    send: async () => ({ ok: true, value: { runId: 'r?', deliveredImmediately: true } }),
    list: async () => {
      listCalls += 1;
      return { ok: true, value: { runs: mainProcessRuns } };
    },
    events: async ({ runId }: { runId: string }) => {
      eventsCalls.push(runId);
      if (holdEventsReply !== null) await holdEventsReply;
      return { ok: true, value: { runId, events: retainedEvents[runId] ?? [], truncated: false } };
    },
    onEvent: () => () => undefined,
  },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Resumable, because one assertion below is end-to-end on purpose: a healed
 * `run.end` must leave the conversation continuable, and the promotion it
 * checks is gated on this capability.
 */
const RESUMABLE = { ...NO_CAPABILITIES, resumeSession: true };

const NOW = 1_700_000_000_000;
/** Comfortably past RUN_STALL_MS. */
const LATER = NOW + 30_000;

const started = (runId: string, seq: number) => ({
  type: 'session.started',
  runId,
  seq,
  ts: 1,
  sessionId: `sess-${runId}`,
});

const text = (runId: string, seq: number, body: string) => ({
  type: 'text.complete',
  runId,
  seq,
  ts: 1,
  messageId: `m-${runId}-${String(seq)}`,
  role: 'assistant',
  text: body,
});

const ended = (runId: string, seq: number) => ({
  type: 'run.end',
  runId,
  seq,
  ts: 1,
  reason: 'completed',
  sessionId: `sess-${runId}`,
});

const liveHandle = (runId: string, lastSeq?: number) => ({
  runId,
  status: 'running',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/repo',
  capabilities: RESUMABLE,
  startedAt: NOW,
  ...(lastSeq === undefined ? {} : { lastSeq }),
});

/** The pane's transcript, flushed and reduced to its assistant text. */
function assistantTexts(): string[] {
  const transcript = focusedPane().transcript;
  transcript.flush();
  return transcript
    .getListSnapshot()
    .map((id) => transcript.getItem(id))
    .filter((item): item is NonNullable<typeof item> => item?.kind === 'assistant')
    .map((item) => (item as { text?: string }).text ?? '');
}

const run = () => paneState(focusedPane()).run;

/** Start a real run through `submitPrompt`, with no events pushed at all. */
async function startSilently(): Promise<string> {
  await submitPrompt('hello?');
  const runId = startedRunIds.at(-1);
  if (runId === undefined) throw new Error('nothing started');
  return runId;
}

beforeEach(() => {
  // Fixture run ids repeat across cases; production ids never do. See the
  // helper's own note in `store.ts`.
  resetRunStreamState();
  vi.setSystemTime(NOW);
  mainProcessRuns = [];
  retainedEvents = {};
  listCalls = 0;
  eventsCalls = [];
  holdEventsReply = null;
  startedRunIds = [];
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    activeProfileId: 'p1',
    activeProviderId: 'claude',
    cwd: '/repo',
    run: null,
    permissionQueue: [],
    promptHistory: [],
    resumeSessionId: null,
  } as never);
  useApp.setState({
    banners: [],
    providers: [
      { id: 'claude', label: 'Claude', capabilities: RESUMABLE, models: [] },
    ] as never,
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude' }] as never,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* The stuck shapes, healed                                                   */
/* -------------------------------------------------------------------------- */

describe('a pane whose stream went silent', () => {
  it('heals “starting” forever: the missed events are fetched and applied', async () => {
    // The reported bug, exactly: the run started and streamed in main, and not
    // one event reached this window.
    const runId = await startSilently();
    mainProcessRuns = [liveHandle(runId, 2)];
    retainedEvents = { [runId]: [started(runId, 1), text(runId, 2, 'the answer')] };

    vi.setSystemTime(LATER);
    await sweepStalledRuns(LATER);

    expect(run()?.status).toBe('running');
    expect(assistantTexts()).toEqual(['the answer']);
    expect(eventsCalls).toEqual([runId]);
  });

  it('heals a run that finished silently, with the real end and the real reason', async () => {
    const runId = await startSilently();
    // Still in the registry's recently-ended window: listed as ended.
    mainProcessRuns = [{ ...liveHandle(runId, 3), status: 'ended' }];
    retainedEvents = {
      [runId]: [started(runId, 1), text(runId, 2, 'done it'), ended(runId, 3)],
    };

    await sweepStalledRuns(LATER);

    expect(run()?.status).toBe('ended');
    expect(run()?.endReason).toBe('completed');
    expect(assistantTexts()).toEqual(['done it']);
    // The end came from the stream, so the conversation is resumable — the
    // session id travelled on the real events, not on a guess.
    expect(paneState(focusedPane()).resumeSessionId).toBe(`sess-${runId}`);
  });

  it('heals a run the registry has let go of, from its retained events', async () => {
    // Ended long enough ago to have left `runs.list` entirely; `runs.events`
    // still answers for recently-ended ids.
    const runId = await startSilently();
    mainProcessRuns = [];
    retainedEvents = {
      [runId]: [started(runId, 1), text(runId, 2, 'finished quietly'), ended(runId, 3)],
    };

    await sweepStalledRuns(LATER);

    expect(run()?.status).toBe('ended');
    expect(run()?.endReason).toBe('completed');
    expect(assistantTexts()).toEqual(['finished quietly']);
  });

  it('settles a run nothing remembers, so the pane is not stuck forever', async () => {
    // The registry has no handle and no events — an id evicted past every
    // retention window, or a `runs.start` whose reply was lost before main
    // accepted it. Nothing more is ever coming; waiting is the bug.
    const runId = await startSilently();
    mainProcessRuns = [];
    retainedEvents = {};

    await sweepStalledRuns(LATER);

    expect(run()?.status).toBe('ended');
    // A new prompt goes through — the pane came back to the user.
    expect(await submitPrompt('again then')).toBe(true);
    expect(startedRunIds).toHaveLength(2);
  });

  it('applies only the tail it missed, mid-run', async () => {
    const runId = await startSilently();
    handleAgentEvent(started(runId, 1) as never);
    handleAgentEvent(text(runId, 2, 'first half') as never);
    mainProcessRuns = [liveHandle(runId, 4)];
    retainedEvents = {
      [runId]: [
        started(runId, 1),
        text(runId, 2, 'first half'),
        text(runId, 3, 'second half'),
        text(runId, 4, 'third half'),
      ],
    };

    await sweepStalledRuns(LATER);

    expect(assistantTexts()).toEqual(['first half', 'second half', 'third half']);
  });
});

/* -------------------------------------------------------------------------- */
/* What the sweep must not do                                                 */
/* -------------------------------------------------------------------------- */

describe('a pane that is merely quiet', () => {
  it('is left alone: no events fetch, no state change', async () => {
    // A long tool call spends minutes exactly here — live, silent, healthy.
    // `lastSeq` equal to what the window drew is the proof, and it is the
    // difference between a sweep that is safe to run forever and one that
    // re-reads every quiet conversation's history every tick.
    const runId = await startSilently();
    handleAgentEvent(started(runId, 1) as never);
    mainProcessRuns = [liveHandle(runId, 1)];
    retainedEvents = { [runId]: [started(runId, 1)] };

    vi.setSystemTime(LATER);
    await sweepStalledRuns(LATER);

    expect(eventsCalls).toEqual([]);
    expect(run()?.status).toBe('running');
    // And the check advanced its clock: the next sweep does not re-ask main
    // the same question for as long as the tool keeps running.
    await sweepStalledRuns(LATER);
    expect(listCalls).toBe(1);
  });

  it('is not even looked up before the stall threshold', async () => {
    await startSilently();
    await sweepStalledRuns(NOW + 5_000);
    expect(listCalls).toBe(0);
  });

  it('an ended pane costs nothing at all', async () => {
    const runId = await startSilently();
    handleAgentEvent(started(runId, 1) as never);
    handleAgentEvent(ended(runId, 2) as never);

    await sweepStalledRuns(LATER);

    expect(listCalls).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotence                                                                */
/* -------------------------------------------------------------------------- */

describe('the replay and the live stream', () => {
  it('a redelivered event never draws twice', async () => {
    // The gate, on the push path: a healed channel may redeliver, and events
    // are strictly ordered per run, so at-or-below the applied seq means
    // already drawn.
    const runId = await startSilently();
    handleAgentEvent(started(runId, 1) as never);
    handleAgentEvent(text(runId, 2, 'once only') as never);

    handleAgentEvent(text(runId, 2, 'once only') as never);

    expect(assistantTexts()).toEqual(['once only']);
  });

  it('holds the live stream during a replay and releases only what is new', async () => {
    /*
     * The race the hold exists for: the sweep is mid-fetch when the pushes
     * come back to life. One of the revived events is inside the replay, one
     * is past it. Without the hold the transcript could interleave; without
     * the seq filter on release, "from the replay" would draw twice.
     */
    const runId = await startSilently();
    mainProcessRuns = [liveHandle(runId, 2)];
    retainedEvents = { [runId]: [started(runId, 1), text(runId, 2, 'from the replay')] };

    let release: () => void = () => undefined;
    holdEventsReply = new Promise((resolve) => {
      release = resolve;
    });
    const sweep = sweepStalledRuns(LATER);
    // The fetch records its call before it parks on the hold, so this is the
    // moment the buffer is provably in place.
    await vi.waitFor(() => expect(eventsCalls).toContain(runId));
    handleAgentEvent(text(runId, 2, 'from the replay') as never);
    handleAgentEvent(text(runId, 3, 'live again') as never);
    release();
    await sweep;

    expect(assistantTexts()).toEqual(['from the replay', 'live again']);
    // The order mattered, not just the set: without the hold, the revived
    // pushes would outrun the replay and the gate would then drop the
    // replay's own `session.started` as already-passed — a pane with text on
    // screen and a status stuck at "starting".
    expect(run()?.status).toBe('running');
  });
});
