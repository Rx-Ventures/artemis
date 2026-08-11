/**
 * The working directory belongs to the session, not to the window.
 *
 * This is the rule that is easy to regress and impossible to see. A directory
 * change that leaves `resumeSessionId` set does not throw, does not look wrong,
 * and produces a perfectly ordinary-looking app — the failure arrives seconds
 * after the *next* prompt, from the provider, as a complaint about a session id
 * the user never saw. Every assertion here is about that pairing.
 *
 * `setCwd` is the only writer of `cwd` that callers use (`resumeSession` writes
 * the field directly, on purpose, and is covered by its own note in the store),
 * so the four cases below are the whole contract.
 *
 * Note the same caveat as `capability-gating.test.tsx`: `renderer/tsconfig.json`
 * excludes test files, so `pnpm typecheck` never sees this one. The assertions
 * are behavioural for that reason.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { focusedPane, setCwd, useApp } from './store';
import { paneState, setPaneState } from './pane';

/*
 * One column, and every assertion below is about it.
 *
 * Session state moved out of `useApp` into a pane when split view landed — see
 * `state/pane.ts`. These helpers are the whole difference: `pane()` is the
 * column the store's actions default to, and `session()` / `setSession()` read
 * and write what `useApp.getState()` used to hold. `transcript` is the
 * column's, too — there is one per pane now.
 */
const pane = () => focusedPane();
const session = () => paneState(pane());
const setSession = (patch) => setPaneState(pane(), patch);
const transcript = () => pane().transcript;


const LIVE_RUN = {
  runId: 'r1',
  status: 'running',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/a',
  capabilities: {
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
  },
  startedAt: 1_000,
};

/**
 * Wait out one transcript flush.
 *
 * The singleton uses the frame scheduler, which outside a browser is a 16ms
 * timer — see `frameScheduler`. 32ms is two of those, which is slack enough not
 * to be a race and short enough not to be felt.
 */
function flushed(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 32));
}

/** A window sitting in `/a`, with an earlier session selected in it. */
function withSelectedSession(): void {
  useApp.setState({ banners: [] });
  setSession({
    cwd: '/a',
    resumeSessionId: 'sess-1111',
    run: null,
    permissionQueue: [],
  });
  transcript().reset();
  transcript().note('info', 'Something the user was reading');
}

beforeEach(() => {
  useApp.setState({ banners: [] });
  setSession({ cwd: '', resumeSessionId: null, run: null });
  transcript().reset();
});

afterEach(() => transcript().reset());

describe('setCwd', () => {
  it('just moves when no session is selected', () => {
    setCwd('/b');

    expect(session().cwd).toBe('/b');
    expect(session().resumeSessionId).toBeNull();
    // Nothing was interrupted, so nothing is announced.
    expect(transcript().isEmpty).toBe(true);
  });

  it('trims what it is given', () => {
    setCwd('  /b  ');
    expect(session().cwd).toBe('/b');
  });

  it('drops the selected session rather than aiming it at a new directory', () => {
    withSelectedSession();

    setCwd('/b');

    expect(session().cwd).toBe('/b');
    // The point of the whole exercise: a session id from `/a` must not survive
    // into a window pointed at `/b`, where the provider cannot resolve it.
    expect(session().resumeSessionId).toBeNull();
  });

  it('says that it started a new session, in the new transcript', async () => {
    withSelectedSession();

    setCwd('/b');

    // One item: the note. The previous conversation was reset out from under
    // it, and the note has to land *after* that reset or it goes with it.
    expect(transcript().length).toBe(1);

    // The id list is published on a flush, not on the write — the model
    // coalesces so that streaming does not re-render per token. Outside a
    // browser that flush is a timer, so wait for it rather than reading a
    // snapshot that is still empty by design.
    await flushed();

    const [id] = transcript().getListSnapshot();
    const item = transcript().getItem(id ?? '');
    expect(item?.kind).toBe('notice');
    expect(item?.text).toContain('new session');
    expect(item?.detail).toContain('/b');
  });

  it('ignores a re-pick of the directory already selected', () => {
    withSelectedSession();
    const before = transcript().length;

    // The native picker opens *at* the current directory, so "Browse… → Choose"
    // with no navigation lands here every time. Treating that as a change would
    // throw away the session the user is reading.
    setCwd('/a');

    expect(session().cwd).toBe('/a');
    expect(session().resumeSessionId).toBe('sess-1111');
    expect(transcript().length).toBe(before);
  });

  it('refuses while a run is live, and says why', () => {
    withSelectedSession();
    setSession({ run: LIVE_RUN });

    setCwd('/b');

    // Ending a live run is a real loss of work and is not what reaching for a
    // folder picker asks for. Nothing moved.
    expect(session().cwd).toBe('/a');
    expect(session().resumeSessionId).toBe('sess-1111');

    const banner = useApp.getState().banners.at(-1);
    expect(banner?.level).toBe('warn');
    expect(banner?.message).toContain('run is still going');
  });
});
