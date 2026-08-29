/**
 * @vitest-environment jsdom
 *
 * What a transcript with zero rows is allowed to claim.
 *
 * The bug this pins, screenshotted live on 2026-08-29: a sidebar-selected
 * conversation with a run visibly working — status line ticking, progress
 * active — rendered the **new-conversation empty state**, hints and all, with
 * its own footnote reading "the next prompt continues session …". The whole
 * transcript appeared gone, and ⌘R did not reliably bring it back.
 *
 * The mechanism: every path that (re)opens a conversation resets the
 * transcript *first* and reads its history *afterwards* — `resumeSession`
 * before `openSessionContents`, `attachRun` before `replayEarlierTurns` — and
 * that read queues behind main's process-wide config-directory lock, behind
 * the sidebar's four-second poll and every other profile's listing. Between
 * the reset and the first applied event the pane holds zero rows, and zero
 * rows rendered as "nothing has ever happened here". A slow read made the lie
 * arbitrarily long; the attach hold's eight-second expiry then traded the
 * scrollback away, which is why a reload so often came back without it.
 *
 * The rule, held here against the real render predicate (`blankTranscript`,
 * the extracted decision behind `Transcript.tsx`'s empty branch): **a pane
 * with a live run or a pending history read never presents the empty state**,
 * and a failed read surfaces a note rather than silence.
 *
 * Same caveat as the neighbouring suites: `renderer/tsconfig.json` excludes
 * test files, so these assertions are behavioural rather than typechecked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allPanes,
  blankTranscript,
  bootstrap,
  focusedPane,
  isLive,
  resumeSession,
  useApp,
} from './store';
import { paneState, type Pane } from './pane';
import { seedApp } from './testkit';

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

const PROFILE = { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' };

/** What the registry answers with. */
let mainProcessRuns: readonly unknown[] = [];
/** Retained events per run, for `runs.events`. */
let retainedEvents = new Map<string, readonly unknown[]>();

/** How `sessions.messages` behaves, per session id. Absent → empty answer. */
type HistoryAnswer =
  | { readonly kind: 'stall' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'gated'; readonly gate: Promise<void>; readonly events: readonly unknown[] }
  | { readonly kind: 'events'; readonly events: readonly unknown[] };
let historyBySession = new Map<string, HistoryAnswer>();
/** Sessions whose stored transcript was asked for — evidence of a read. */
let historyRead: string[] = [];

function liveRun(runId: string, sessionId: string, historyOffset: number) {
  return {
    runId,
    status: 'running',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    capabilities: CAPS,
    startedAt: 1_000,
    sessionId,
    historyOffset,
  } as const;
}

function session(id: string) {
  return {
    id,
    title: 'A conversation',
    updatedAt: 2_000,
    cwd: '/a',
    profileId: 'p1',
    providerId: 'claude',
  } as never;
}

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => ({ ok: true, value: { runs: mainProcessRuns } }),
    events: async ({ runId }: { runId: string }) => ({
      ok: true,
      value: { runId, events: retainedEvents.get(runId) ?? [], truncated: false },
    }),
    send: async ({ runId }: { runId: string }) => ({
      ok: true,
      value: { runId, deliveredImmediately: true },
    }),
    liveWork: async () => ({ ok: true, value: { sessionIds: [], working: [], delegated: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async (request: { sessionId: string }) => {
      historyRead.push(request.sessionId);
      const answer = historyBySession.get(request.sessionId);
      if (answer === undefined) return { ok: true, value: { events: [], hasMore: false } };
      switch (answer.kind) {
        case 'stall':
          // A read parked behind the config-directory lock, never answered.
          return new Promise(() => undefined);
        case 'reject':
          throw new Error('the store could not be read');
        case 'gated':
          await answer.gate;
          return { ok: true, value: { events: answer.events, hasMore: false } };
        case 'events':
          return { ok: true, value: { events: answer.events, hasMore: false } };
      }
    },
  },
  profiles: { list: async () => ({ ok: true, value: { profiles: [PROFILE] } }) },
  providers: {
    list: async () => ({ ok: true, value: { providers: [CLAUDE_DESCRIPTOR] } }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
    commands: async () => ({ ok: true, value: { commands: [] } }),
  },
  usagePlan: { cached: async () => ({ ok: true, value: { usage: null } }) },
  workspace: { describe: async () => ({ ok: true, value: { workspace: null } }) },
  auth: { status: async () => ({ ok: true, value: { status: null } }) },
};

/** A stored `text.complete`, as a history read would replay it. */
function stored(sessionId: string, text: string, seq = 0) {
  return {
    type: 'text.complete',
    runId: `history:${sessionId}`,
    seq,
    ts: 1,
    messageId: `history:${sessionId}:m${seq}`,
    role: 'assistant',
    text,
  } as never;
}

/** The pane holding `runId`, whichever column or background slot it landed in. */
function paneFor(runId: string): Pane | undefined {
  const state = useApp.getState();
  return [...allPanes(state), ...state.background].find(
    (pane) => paneState(pane).run?.runId === runId,
  );
}

/**
 * What the transcript column presents — the same decision `Transcript.tsx`
 * makes: rows when it has them, and `blankTranscript`'s answer otherwise.
 */
function shown(pane: Pane): 'transcript' | 'loading' | 'empty' {
  if (pane.transcript.getRowsSnapshot().length > 0) return 'transcript';
  return blankTranscript(paneState(pane));
}

function transcriptText(pane: Pane): string {
  return pane.transcript
    .getListSnapshot()
    .map((id) => {
      const item = pane.transcript.getItem(id) as
        | { text?: string; title?: string }
        | undefined;
      return `${item?.title ?? ''} ${item?.text ?? ''}`;
    })
    .join('\n');
}

beforeEach(() => {
  seedApp({
    providers: [CLAUDE_DESCRIPTOR],
    activeProviderId: 'claude',
    profiles: [PROFILE],
    activeProfileId: 'p1',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
    historyLoading: false,
  } as never);
  focusedPane().transcript.reset();
  mainProcessRuns = [];
  retainedEvents = new Map();
  historyBySession = new Map();
  historyRead = [];
  useApp.setState({ banners: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a conversation that is still being read in', () => {
  it('presents as loading while its live run’s history is stalled, never as new', async () => {
    // The screenshot: a live run bound to the pane, elapsed time ticking, and
    // the history read parked behind the config-directory lock.
    historyBySession.set('s1', { kind: 'stall' });
    mainProcessRuns = [liveRun('r1', 's1', 2)];

    resumeSession(session('s1'));
    await vi.waitFor(() => expect(paneState(focusedPane()).run?.runId).toBe('r1'));

    const pane = focusedPane();
    // The contradiction the screenshot shows, reconstructed: live run, session
    // selected, zero rows.
    expect(isLive(paneState(pane))).toBe(true);
    expect(paneState(pane).resumeSessionId).toBe('s1');
    expect(pane.transcript.getRowsSnapshot()).toHaveLength(0);
    // The rule: that pane must never read as a new conversation.
    expect(shown(pane)).toBe('loading');
  });

  it('presents as loading while a stored conversation’s history is stalled', async () => {
    // No live run at all — just a click on an idle row whose read never lands.
    historyBySession.set('s1', { kind: 'stall' });

    resumeSession(session('s1'));
    await vi.waitFor(() => expect(historyRead).toContain('s1'));

    const pane = focusedPane();
    expect(pane.transcript.getRowsSnapshot()).toHaveLength(0);
    expect(shown(pane)).toBe('loading');
  });

  it('presents as loading through a reload that adopts the run', async () => {
    // ⌘R while the run works: `adoptLiveRuns` attaches at boot, and the same
    // stalled read leaves the same zero rows.
    historyBySession.set('s1', { kind: 'stall' });
    mainProcessRuns = [liveRun('r1', 's1', 2)];

    void bootstrap();
    await vi.waitFor(() => expect(paneFor('r1')).toBeDefined());

    const pane = paneFor('r1') as Pane;
    expect(pane.transcript.getRowsSnapshot()).toHaveLength(0);
    expect(shown(pane)).toBe('loading');
  });

  it('presents a live run with nothing replayed yet as loading, not as new', async () => {
    // A run that opened its own session: no history to read, no retained
    // events yet. The next token may be minutes out — a long tool call — and
    // for all of them the pane holds a working run and zero rows.
    mainProcessRuns = [liveRun('r1', 's1', 0)];

    resumeSession(session('s1'));
    await vi.waitFor(() => expect(paneState(focusedPane()).run?.runId).toBe('r1'));
    // Let the (empty) replay finish so this is the settled state, not a race.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pane = focusedPane();
    expect(pane.transcript.getRowsSnapshot()).toHaveLength(0);
    expect(shown(pane)).toBe('loading');
  });
});

describe('a history read that fails or expires', () => {
  it('says so in the transcript when the stored read fails', async () => {
    historyBySession.set('s1', { kind: 'reject' });

    resumeSession(session('s1'));
    await vi.waitFor(() => expect(shown(focusedPane())).toBe('transcript'));

    expect(transcriptText(focusedPane())).toContain('Could not load earlier messages');
    // The read is over; a blank must not go on claiming one is in flight.
    expect(paneState(focusedPane()).historyLoading).toBe(false);
  });

  it('says so in the transcript when the replay before an attach fails', async () => {
    historyBySession.set('s1', { kind: 'reject' });
    mainProcessRuns = [liveRun('r1', 's1', 2)];
    retainedEvents.set('r1', [
      {
        type: 'text.complete',
        runId: 'r1',
        seq: 0,
        ts: 1,
        messageId: 'r1:m0',
        role: 'assistant',
        text: 'the run itself still shows',
      },
    ]);

    resumeSession(session('s1'));
    await vi.waitFor(() =>
      expect(transcriptText(focusedPane())).toContain('the run itself still shows'),
    );

    expect(transcriptText(focusedPane())).toContain(
      'Could not load the earlier part of this conversation',
    );
    expect(paneState(focusedPane()).historyLoading).toBe(false);
  });

  it('leaves a note when the hold expires, and drops the answer that comes late', async () => {
    vi.useFakeTimers();

    let releaseTheRead = (): void => undefined;
    historyBySession.set('s1', {
      kind: 'gated',
      gate: new Promise<void>((resolve) => {
        releaseTheRead = resolve;
      }),
      events: [stored('s1', 'what came long before')],
    });
    mainProcessRuns = [liveRun('r1', 's1', 2)];

    resumeSession(session('s1'));
    await vi.advanceTimersByTimeAsync(50);
    expect(paneState(focusedPane()).run?.runId).toBe('r1');
    // Still waiting: the read is plausibly coming, so the pane is loading.
    expect(shown(focusedPane())).toBe('loading');

    // Past the hold, the wait is surfaced rather than left blank forever. The
    // fake clock only drives the deadline; the note rides the transcript's
    // coalesced flush, which was armed on real timers — so hand those back and
    // let it land.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paneState(focusedPane()).historyLoading).toBe(false);
    vi.useRealTimers();
    await vi.waitFor(() => expect(shown(focusedPane())).toBe('transcript'));
    expect(transcriptText(focusedPane())).toContain(
      'Could not replay what this run has already done',
    );

    // …and the answer that finally lands is dropped rather than applied under
    // live events it belongs above.
    releaseTheRead();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(transcriptText(focusedPane())).not.toContain('what came long before');
  });
});
