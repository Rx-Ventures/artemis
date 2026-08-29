/**
 * @vitest-environment jsdom
 *
 * The threshold trigger opens a question, not a document (§5 phase 2, ADR 0003).
 *
 * `handoffTrigger` fires exactly as it always has, and the interrupt-and-settle
 * is byte-for-byte the shipped one. What changed is what happens once the pane
 * is quiet: when another reachable account could take the conversation, the
 * picker opens and *nothing happens until the user chooses* — the chosen act.
 * Three answers, three paths:
 *
 *  - **Choose a target** — the conversation moves: account switched, session
 *    kept, latch re-armed. No continuity note is written, because nothing was
 *    lost.
 *  - **Decline to the note** — today's document path runs, unchanged to the
 *    letter, `asked` → `done` → blocked composer and all.
 *  - **Dismiss** — the standing door out: nothing moves, nothing re-asks.
 *
 * And when no candidate passes the gates — reachability, freshness, auth — the
 * picker never opens and the note is written exactly as before this existed,
 * which is what "additive" means here.
 *
 * Same caveat as its neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '@rx-artemis/protocol';

import {
  chooseHandoffTarget,
  declineHandoffOffer,
  dismissHandoffOffer,
  focusedPane,
  handleAgentEvent,
  installPlanUsageFeed,
  resetRunStreamState,
  setAutoHandoff,
  submitPrompt,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';
import { capabilities } from './testkit';

/* -------------------------------------------------------------------------- */
/* A bridge that records the turns it was asked to start                      */
/* -------------------------------------------------------------------------- */

let started: string[] = [];
let interrupts = 0;
/** Auth answers per profile, so tests decide what the probe learns. */
let authAnswers: Record<string, { loggedIn: boolean }> = {};

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    start: async ({ input }: { input: { prompt: string; runId: string } }) => {
      started.push(input.prompt);
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'running',
            capabilities: capabilities(),
            startedAt: 1,
            sessionId: 'sess-1',
          },
        },
      };
    },
    interrupt: async () => {
      interrupts += 1;
      return { ok: true, value: { runId: 'r1', stillQueued: [] } };
    },
    send: async () => ({ ok: true, value: { runId: 'r1', deliveredImmediately: true } }),
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    list: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    listAll: async () => ({ ok: true, value: { sessions: [], unreadableProfiles: [] } }),
  },
  providers: {
    list: async () => ({ ok: true, value: { providers: [] } }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
  },
  auth: {
    status: async ({ profileId }: { profileId: string }) => {
      const status = authAnswers[profileId];
      if (status === undefined) return { ok: false as const, error: { code: 'unknown', message: 'stub' } };
      return { ok: true as const, value: { status, signInCommand: 'claude auth login' } };
    },
  },
  usagePlan: {
    refresh: async () => ({ ok: true, value: { usage: null } }),
    cached: async () => ({ ok: true, value: { usage: null } }),
    onChange: (listener: (push: { profileId: string; usage: PlanUsage }) => void) => {
      pushUsage = listener;
      return () => {
        pushUsage = null;
      };
    },
  },
};

let pushUsage: ((push: { profileId: string; usage: PlanUsage }) => void) | null = null;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = 1_700_000_000_000;

const usage = (utilization: number, fetchedAt = NOW): PlanUsage => ({
  available: true,
  windows: [
    { id: 'five_hour', label: '5 hours', utilization, resetsAt: NOW + 3 * 3600_000 },
  ],
  fetchedAt,
});

/** Push a reading for `p1`, the focused pane's account, the way the poll does. */
function reading(u: PlanUsage): void {
  pushUsage?.({ profileId: 'p1', usage: u });
}

/** The sidebar's row: `p1` ran it, `p2` shares the store. */
const SHARED_ROW = {
  id: 'sess-1',
  providerId: 'claude',
  profileId: 'p1',
  alsoInProfiles: ['p2'],
  cwd: '/repo',
  title: 'One conversation',
  updatedAt: 10,
};

const handoff = (): string => paneState(focusedPane()).handoff;
const offer = () => paneState(focusedPane()).handoffOffer;

let stopFeed: () => void = () => undefined;

beforeEach(() => {
  resetRunStreamState();
  vi.setSystemTime(NOW);
  stopFeed();
  stopFeed = installPlanUsageFeed();
  started = [];
  interrupts = 0;
  authAnswers = {};
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    activeProfileId: 'p1',
    activeProviderId: 'claude',
    cwd: '/repo',
    run: null,
    resumeSessionId: 'sess-1',
    permissionQueue: [],
    promptHistory: [],
    handoff: 'none',
    handoffOffer: null,
  } as never);
  useApp.setState({
    banners: [],
    handoffThresholds: {},
    sessions: [SHARED_ROW],
    // The world in which the picker opens: p2 shares the store, has room, has
    // a fresh reading, and is known signed in. Tests subtract one condition
    // each to reach the fallback.
    planUsageByProfile: { p2: usage(20) },
    authByProfile: { p2: { loggedIn: true } },
    providers: [
      { id: 'claude', label: 'Claude', capabilities: capabilities(), models: [] },
    ],
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.p2' },
    ],
  } as never);
  setAutoHandoff(true);
});

/* -------------------------------------------------------------------------- */
/* The trigger opens the picker                                               */
/* -------------------------------------------------------------------------- */

describe('when the trigger fires and a candidate exists', () => {
  it('opens the picker instead of asking for the document', async () => {
    reading(usage(99));

    await vi.waitFor(() => expect(handoff()).toBe('offered'));
    expect(offer()?.trigger.threshold.id).toBe('five_hour');
    // The chosen act: no turn was started, no budget spent, until the user
    // answers. This is the line ADR 0003 draws.
    expect(started).toEqual([]);
  });

  it('does not re-open or double-ask on the next reading', async () => {
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('offered'));

    reading(usage(99));
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('offered'));
    expect(started).toEqual([]);
  });

  it('interrupts a live run and offers only after the promotion has landed', async () => {
    // The pane has no resumable id yet — the run in flight owns the session.
    // The offer *requires* one, so its very existence proves the sequencing:
    // interrupt → run.end (which promotes `endedSessionId` while the profile
    // still matches) → settle → offer. Computed any earlier, there would be
    // no session to offer and this would have fallen to the note.
    setPaneState(focusedPane(), {
      resumeSessionId: null,
      run: {
        runId: 'r1',
        status: 'running',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/repo',
        capabilities: capabilities(),
        startedAt: 1,
        sessionId: 'sess-1',
      },
    } as never);
    reading(usage(99));

    await vi.waitFor(() => expect(interrupts).toBe(1));
    expect(handoff()).toBe('stopping');
    expect(offer()).toBeNull();

    handleAgentEvent({
      type: 'run.end',
      runId: 'r1',
      seq: 1,
      ts: 0,
      reason: 'interrupted',
      sessionId: 'sess-1',
    } as never);

    await vi.waitFor(() => expect(handoff()).toBe('offered'));
    expect(paneState(focusedPane()).resumeSessionId).toBe('sess-1');
    expect(started).toEqual([]);
  });

  it('probes unchecked candidates as the question opens', async () => {
    useApp.setState({ authByProfile: {} } as never);
    authAnswers = { p2: { loggedIn: true } };

    reading(usage(99));

    await vi.waitFor(() => expect(handoff()).toBe('offered'));
    // §5 obstacle 6: the cheap gate, asked at the moment the question opens,
    // so "signed out" is a fact on the row rather than a surprise after it.
    await vi.waitFor(() =>
      expect(useApp.getState().authByProfile['p2']?.loggedIn).toBe(true),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The three answers                                                          */
/* -------------------------------------------------------------------------- */

describe('choosing a target', () => {
  it('moves the account, keeps the session, and writes no document', async () => {
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('offered'));

    expect(await chooseHandoffTarget('p2')).toBe(true);

    const state = paneState(focusedPane());
    expect(state.activeProfileId).toBe('p2');
    expect(state.resumeSessionId).toBe('sess-1');
    expect(state.handoffOffer).toBeNull();
    expect(started).toEqual([]);
  });

  it('re-arms the trigger entirely — the new account earns its own question', async () => {
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('offered'));
    await chooseHandoffTarget('p2');
    expect(handoff()).toBe('none');

    // p1 is reachable from the moved conversation (it owns the row), its
    // reading is fresh — so when *p2* now crosses the threshold, the question
    // opens again rather than being eaten by a spent latch.
    useApp.setState({ planUsageByProfile: { p1: usage(20), p2: usage(20) } } as never);
    useApp.setState({ authByProfile: { p1: { loggedIn: true }, p2: { loggedIn: true } } } as never);
    pushUsage?.({ profileId: 'p2', usage: usage(99) });

    await vi.waitFor(() => expect(handoff()).toBe('offered'));
  });

  it('leaves the question open when the world changed under the choice', async () => {
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('offered'));
    // The dialog sat open across a poll and the target signed out meanwhile.
    useApp.setState({ authByProfile: { p2: { loggedIn: false } } } as never);

    expect(await chooseHandoffTarget('p2')).toBe(false);

    // Refused with the reason on the banner surface, and the question stands —
    // the user still has the note and the stay-put door.
    expect(handoff()).toBe('offered');
    expect(offer()).not.toBeNull();
    expect(paneState(focusedPane()).activeProfileId).toBe('p1');
    expect(useApp.getState().banners.at(-1)?.message).toContain('Could not hand off');
  });
});

describe('declining to the continuity note', () => {
  it('runs the document path unchanged, to the blocked composer at the end', async () => {
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('offered'));

    declineHandoffOffer();

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
    expect(handoff()).toBe('asked');
    expect(offer()).toBeNull();

    // The note's run ends; the latch promotes exactly as it always has…
    handleAgentEvent({
      type: 'run.end',
      runId: paneState(focusedPane()).run?.runId,
      seq: 1,
      ts: 0,
      reason: 'completed',
    } as never);
    expect(handoff()).toBe('done');

    // …and the stop still stops: the degraded hand off is today's behaviour,
    // byte for byte.
    expect(await submitPrompt('carry on')).toBe(false);
    expect(started).toHaveLength(1);
  });
});

describe('dismissing', () => {
  it('moves nothing, writes nothing, and never asks again', async () => {
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('offered'));

    dismissHandoffOffer();

    expect(handoff()).toBe('dismissed');
    expect(offer()).toBeNull();
    expect(paneState(focusedPane()).activeProfileId).toBe('p1');
    expect(started).toEqual([]);

    // The door out stays open — a safeguard that re-arms after being told no
    // is an obstacle, not a safeguard.
    reading(usage(99));
    await vi.waitFor(() => expect(handoff()).toBe('dismissed'));
    expect(started).toEqual([]);

    // And the composer works: nothing was written, so nothing blocks.
    expect(await submitPrompt('carry on here')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The fallback: no candidate, no picker — the note, exactly as shipped       */
/* -------------------------------------------------------------------------- */

describe('when no candidate passes the gates', () => {
  it('writes the note when no other profile reaches the store', async () => {
    useApp.setState({ sessions: [{ ...SHARED_ROW, alsoInProfiles: [] }] } as never);

    reading(usage(99));

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
    expect(handoff()).toBe('asked');
  });

  it('writes the note when the only candidate’s reading is stale', async () => {
    useApp.setState({
      planUsageByProfile: { p2: usage(20, NOW - 7 * 60_000) },
    } as never);

    reading(usage(99));

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
  });

  it('writes the note when the only candidate is known signed out', async () => {
    useApp.setState({ authByProfile: { p2: { loggedIn: false } } } as never);

    reading(usage(99));

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
  });

  it('writes the note when the listing has not seen the session yet', async () => {
    // Reachability is the floor: an unlisted session proves nothing about who
    // shares its store, and the honest degradation is the note (ADR 0003).
    useApp.setState({ sessions: [] } as never);

    reading(usage(99));

    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('.artemis/handoff-');
  });
});
