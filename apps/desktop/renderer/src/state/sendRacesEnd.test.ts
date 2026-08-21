/**
 * @vitest-environment jsdom
 *
 * Sending into a run that ended a moment ago (issue #164).
 *
 * The reported symptom was a red banner reading *"Could not deliver the
 * message: Run "run_…" has already ended"*, with the prompt sitting dimmed in
 * the transcript and nothing to do but type it again.
 *
 * Nobody did anything wrong to produce it. `submitPrompt` chooses between
 * steering a live run and starting a new one by reading `isLive`, which is
 * *this window's* copy of the run state; main retires a run the instant its
 * stream ends. Between the keystroke and the IPC call landing, that copy can go
 * stale — and the wider the gap, the likelier it is. A turn that finishes while
 * you are still typing the next prompt hits it every time.
 *
 * The engine already forgives this exact race on `interrupt`, whose own comment
 * calls it "a race, not a mistake". This is the same race one channel over, so
 * the fix is the same judgement: fall through to the path the send would have
 * taken had the state arrived a moment earlier.
 *
 * What is asserted here is the user-visible consequence rather than the
 * mechanism — a run gets started, carrying the same text, with no banner and no
 * second copy of the message on screen.
 *
 * Same caveat as its neighbours: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { focusedPane, submitPrompt, useApp } from './store';
import { paneState, setPaneState } from './pane';

/* -------------------------------------------------------------------------- */
/* A bridge that refuses the send the way main really refuses it              */
/* -------------------------------------------------------------------------- */

/** How main answers `runs.send`. Reassigned per test. */
let sendAnswer: () => unknown = () => ({
  ok: true,
  value: { runId: 'r1', deliveredImmediately: true },
});

/** Every `runs.start` input main was handed, in order. */
let started: { prompt: string; runId: string; resumeSessionId?: string }[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    send: async () => sendAnswer(),
    start: async ({
      input,
    }: {
      input: { prompt: string; runId: string; resumeSessionId?: string };
    }) => {
      started.push({
        prompt: input.prompt,
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
            capabilities: STEERABLE,
            startedAt: 1,
            sessionId: 'sess-new',
          },
        },
      };
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

/** The refusal main sends for a run it has already retired. */
const ENDED = {
  ok: false,
  error: {
    code: 'invalid_request',
    message: 'Run "r1" has already ended',
    details: { reason: 'run_ended', runId: 'r1' },
  },
};

/** The refusal for an id that never existed, which must stay loud. */
const UNKNOWN = {
  ok: false,
  error: {
    code: 'invalid_request',
    message: 'Unknown run "r1"',
    details: { reason: 'run_unknown', runId: 'r1' },
  },
};

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

/** The prompts on screen, in order, whatever their delivery state. */
function userMessages(): string[] {
  const transcript = focusedPane().transcript;
  // The transcript batches structural changes onto a frame; nothing is in the
  // snapshot until it flushes, and jsdom hands out no frames.
  transcript.flush();
  return transcript
    .getListSnapshot()
    .map((id) => transcript.getItem(id))
    .filter((item): item is NonNullable<typeof item> => item?.kind === 'user')
    .map((item) => (item as { text?: string }).text ?? '');
}

const banners = (): readonly { readonly message: string }[] =>
  useApp.getState().banners as readonly { readonly message: string }[];

beforeEach(() => {
  started = [];
  sendAnswer = () => ({ ok: true, value: { runId: 'r1', deliveredImmediately: true } });
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
    providers: [
      { id: 'claude', label: 'Claude', capabilities: STEERABLE, models: [] },
    ] as never,
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude' }] as never,
  });
});

describe('a send that races the end of its run', () => {
  it('starts a fresh run with the same prompt rather than losing it', async () => {
    liveRun();
    sendAnswer = () => ENDED;

    expect(await submitPrompt('carry on then')).toBe(true);

    // The whole point: the words the user typed went somewhere.
    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toBe('carry on then');
    // And silently — a banner here is the bug being reported, not a courtesy.
    expect(banners()).toHaveLength(0);
  });

  it('shows the message once, not once per attempt', async () => {
    // The steer path writes the prompt to the transcript before it knows the
    // send will fail. Falling through must adopt that message rather than push
    // a second one, or the user reads their own sentence twice.
    liveRun();
    sendAnswer = () => ENDED;

    await submitPrompt('carry on then');

    expect(userMessages()).toEqual(['carry on then']);
  });

  it('leaves the pane on the new run, not the retired one', async () => {
    liveRun();
    sendAnswer = () => ENDED;

    await submitPrompt('carry on then');

    const run = paneState(focusedPane()).run;
    expect(run?.runId).toBe(started[0]?.runId);
    expect(run?.runId).not.toBe('r1');
    expect(run?.status).not.toBe('ended');
  });

  it('continues the conversation whose id lived only on the run', async () => {
    /*
     * The sharpest version of the race: a conversation *started* in this pane,
     * so its session id exists nowhere but `run.sessionId` — `resumeSessionId`
     * is still null, because only a real `run.end` used to promote it. The
     * fall-through draws that end locally, and if the local end does not
     * promote too, the recovery run resumes nothing: the user's words arrive
     * in a brand-new provider session, under a transcript showing a
     * conversation the provider has never heard of.
     */
    const resumable = { ...STEERABLE, resumeSession: true };
    useApp.setState({
      providers: [{ id: 'claude', label: 'Claude', capabilities: resumable, models: [] }] as never,
    });
    setPaneState(focusedPane(), {
      resumeSessionId: null,
      run: {
        runId: 'r1',
        status: 'running',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/repo',
        capabilities: resumable,
        startedAt: 1,
        sessionId: 'sess-1',
      },
      permissionQueue: [],
    } as never);
    sendAnswer = () => ENDED;

    await submitPrompt('carry on then');

    expect(started).toHaveLength(1);
    expect(started[0]?.resumeSessionId).toBe('sess-1');
  });

  it('still reports a refusal that is not this race', async () => {
    liveRun();
    sendAnswer = () => UNKNOWN;

    expect(await submitPrompt('into the void')).toBe(true);

    // An id main has never heard of is a bug in this window, and quietly
    // starting a replacement run would hide it. Nothing was started; the banner
    // stands.
    expect(started).toHaveLength(0);
    // `reportFailure` prefixes the context onto the provider's own sentence.
    expect(banners().map((b) => b.message)).toEqual([
      'Could not deliver the message: Unknown run "r1"',
    ]);
  });

  it('draws the turn ending once, whichever order the two arrive in', async () => {
    // The fallback draws the ending main already performed, because the new run
    // replaces `state.run` and after that a straggling `run.end` for the old id
    // is dropped. But the event may equally have landed *during* the send, and
    // then the card is already there — inserting a second one would show the
    // same turn ending twice.
    liveRun();
    sendAnswer = () => ENDED;
    await submitPrompt('carry on then');

    const transcript = focusedPane().transcript;
    transcript.flush();
    const ends = transcript
      .getListSnapshot()
      .map((id) => transcript.getItem(id))
      .filter((item) => item?.kind === 'run-end');
    expect(ends).toHaveLength(1);
  });

  it('does not draw one at all when the event got there first', async () => {
    // Same race, other order: the pane has already settled, so there is nothing
    // left for the fallback to catch up on.
    liveRun();
    sendAnswer = () => {
      // The event lands mid-flight: the pane settles before the refusal is read.
      setPaneState(focusedPane(), (s) => ({
        run: s.run ? { ...s.run, status: 'ended', endReason: 'completed' } : null,
      }));
      focusedPane().transcript.localRunEnd('completed');
      return ENDED;
    };
    await submitPrompt('carry on then');

    const transcript = focusedPane().transcript;
    transcript.flush();
    const ends = transcript
      .getListSnapshot()
      .map((id) => transcript.getItem(id))
      .filter((item) => item?.kind === 'run-end');
    expect(ends).toHaveLength(1);
    // And the prompt still went somewhere.
    expect(started).toHaveLength(1);
  });

  it('does not go near the fallback when the send succeeds', async () => {
    liveRun();

    expect(await submitPrompt('steer me')).toBe(true);
    expect(started).toHaveLength(0);
    expect(paneState(focusedPane()).run?.runId).toBe('r1');
  });
});
