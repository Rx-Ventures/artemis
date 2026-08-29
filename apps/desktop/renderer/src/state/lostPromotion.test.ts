/**
 * @vitest-environment jsdom
 *
 * A follow-up after the promotion was lost.
 *
 * The `run.end` handler promotes the ended run's session id into
 * `resumeSessionId` — but only when the pane's cwd and profile still match the
 * run's, and only if the event arrives at all. Forensics from 2026-08-28/29
 * found the aftermath of promotions that never happened: an app restart mid-run,
 * and account switches at the usage-limit seam. The pane is left holding an
 * ended (or vanished) run whose `sessionId` names the conversation, while
 * `resumeSessionId` is null.
 *
 * Every existing split-brain repair keys off `resumeSessionId` — the repair at
 * the top of `submitPrompt` (store.ts:8716), `restoreLiveRunBindings`, the
 * live-work poll. These cases pin what happens when that field is the thing
 * that was lost: the conversation's id survives only on the dead run record.
 *
 * What must not happen, in order of severity:
 *  1. a rival run started against a session the registry still shows working —
 *     two CLIs appending to one transcript;
 *  2. a follow-up sent as a brand-new provider session — the user's words
 *     arriving in a conversation the provider has never heard of, which is the
 *     reported "sessions detaching".
 *
 * Same caveat as the neighbouring suites: `renderer/tsconfig.json` excludes
 * test files, so these assertions are behavioural rather than typechecked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { focusedPane, handleAgentEvent, submitPrompt, useApp } from './store';
import { paneState, setPaneState } from './pane';
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
/** Runs whose retained events were asked for — evidence of an attach. */
let eventsAsked: string[] = [];
/** Run ids that received a mid-turn message. */
let steeredRuns: string[] = [];
/** Every `runs.start` input, with the continuation it carried. */
let startedRuns: { runId: string; resumeSessionId?: string }[] = [];

function liveRun(runId: string, sessionId: string, status = 'running') {
  return {
    runId,
    status,
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    capabilities: CAPS,
    startedAt: 1_000,
    sessionId,
    historyOffset: 0,
  } as const;
}

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => ({ ok: true, value: { runs: mainProcessRuns } }),
    events: async ({ runId }: { runId: string }) => {
      eventsAsked.push(runId);
      return { ok: true, value: { runId, events: [], truncated: false } };
    },
    send: async ({ runId }: { runId: string }) => {
      steeredRuns.push(runId);
      return { ok: true, value: { runId, deliveredImmediately: true } };
    },
    start: async ({
      input,
    }: {
      input: { runId: string; resumeSessionId?: string };
    }) => {
      startedRuns.push({
        runId: input.runId,
        ...(input.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: input.resumeSessionId }),
      });
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'running',
            capabilities: CAPS,
            startedAt: 2_000,
            sessionId: 'sess-new',
          },
        },
      };
    },
    liveWork: async () => ({
      ok: true,
      value: { sessionIds: [], working: [], delegated: [] },
    }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async () => ({ ok: true, value: { events: [], hasMore: false } }),
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

beforeEach(() => {
  seedApp({
    providers: [CLAUDE_DESCRIPTOR],
    activeProviderId: 'claude',
    profiles: [PROFILE],
    activeProfileId: 'p1',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
  } as never);
  mainProcessRuns = [];
  eventsAsked = [];
  steeredRuns = [];
  startedRuns = [];
  focusedPane().transcript.reset();
});

describe('a follow-up after the promotion was lost', () => {
  it('does not start a rival run against a session the registry still holds', async () => {
    // The C-shaped incident: the pane believes the turn is over, the registry
    // does not. resumeSessionId is null — the promotion never happened — so
    // the only surviving link to the conversation is the dead run's sessionId.
    setPaneState(focusedPane(), {
      resumeSessionId: null,
      run: { ...liveRun('r-old', 's1', 'ended'), endReason: 'error' },
    } as never);
    mainProcessRuns = [liveRun('r-live', 's1')];

    await submitPrompt('carry on');

    // The words must reach the run that is actually executing this
    // conversation — a second CLI on one transcript is the clobber.
    expect(startedRuns).toHaveLength(0);
    expect(steeredRuns).toEqual(['r-live']);
  });

  it('carries the dead run session into the recovery run when nothing is live', async () => {
    // The A-shaped incident: the run is genuinely over everywhere, but the end
    // never promoted. The follow-up must still continue the conversation the
    // transcript shows, not open a session the provider has never heard of.
    setPaneState(focusedPane(), {
      resumeSessionId: null,
      run: { ...liveRun('r-old', 's1', 'ended'), endReason: 'completed' },
    } as never);
    mainProcessRuns = [];

    await submitPrompt('carry on');

    expect(startedRuns).toHaveLength(1);
    expect(startedRuns[0]?.resumeSessionId).toBe('s1');
  });

  it('control: a promoted pane resumes exactly as designed', async () => {
    // The same scenario with the promotion intact — proves the loop's wiring,
    // and is the behaviour the two cases above should converge to.
    setPaneState(focusedPane(), {
      resumeSessionId: 's1',
      run: { ...liveRun('r-old', 's1', 'ended'), endReason: 'completed' },
    } as never);
    mainProcessRuns = [];

    await submitPrompt('carry on');

    expect(startedRuns).toHaveLength(1);
    expect(startedRuns[0]?.resumeSessionId).toBe('s1');
  });
});
