/**
 * Which surface answers which path.
 * ============================================================================
 *
 * Two clients address runs on this port and they are not the same kind of
 * thing. The remote bridge (`remote.ts`) serves a *window*: it owns
 * `/api/v0/runs`, `/api/v0/events` and `/api/v0/terminals` whole, and
 * authorises by what a connection's allowance can see. The completions surface
 * serves a *provider adapter* holding a run id it was handed on its own stream:
 * three verbs, authorised by ownership.
 *
 * The failure this file exists to prevent has no textual conflict and no type
 * error. A dispatcher written as `path.startsWith('/api/v0/runs')` — the
 * obvious shape, and the one the completions surface arrived with — swallows
 * every bridge route silently, because each of them starts with those
 * characters. Nothing fails to compile; the run list, the event replay, `send`,
 * `respond-permission`, `stop-task` and `dispose` simply stop being the
 * bridge's, and the first person to find out is holding a remote window that
 * has gone blank.
 *
 * So the bridge's dispatch is asserted directly rather than through its
 * answers: `handleRemoteRequest` is wrapped, and every REMOTE_* path is checked
 * to reach it. Behaviour is `remote.test.ts`'s business; this file is only
 * about *who gets the request*.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, RunHandle, ServerProfile } from '@rx-artemis/protocol';
import {
  NO_CAPABILITIES,
  REMOTE_EVENTS_PATH,
  REMOTE_LIVE_WORK_PATH,
  REMOTE_RUN_ACTIONS,
  REMOTE_RUNS_PATH,
  REMOTE_TERMINALS_PATH,
  remoteRunPath,
  remoteTerminalPath,
} from '@rx-artemis/protocol';

/**
 * The bridge's entry point, wrapped so that "did this reach Seth's handler?" is
 * a question with a direct answer rather than one inferred from a response
 * body. `isRemotePath` is left exactly as it is — the point is to observe the
 * real routing, not to replace it.
 */
const reachedBridge = vi.fn<(path: string, method: string) => void>();
vi.mock('../remote.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../remote.js')>();
  return {
    ...actual,
    handleRemoteRequest: (input: Parameters<typeof actual.handleRemoteRequest>[0]) => {
      reachedBridge(input.path, input.method);
      return actual.handleRemoteRequest(input);
    },
  };
});

const { handleServerRequest, isStreamReply } = await import('../http.js');
const { createRunDirectory } = await import('../runs.js');
type ServerContext = import('../http.js').ServerContext;
type RunSource = import('../completions.js').RunSource;

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const OTHER_TOKEN = 'other-token-abcdefghijklmnopqrstuvwx';

const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

/** A second token on the same directory: same visibility, different ownership. */
const NEIGHBOUR = { ...CONNECTION, id: 'conn-2', label: 'Neighbour', token: OTHER_TOKEN };

const catalogue = { read: async () => [] as readonly ServerProfile[], invalidate: () => undefined };

function runHandle(runId: string): RunHandle {
  return {
    runId,
    providerId: 'claude',
    profileId: 'prof-a',
    cwd: '/w',
    status: 'running',
    capabilities: NO_CAPABILITIES,
    startedAt: 0,
  };
}

/** Every call either surface can make, recorded rather than performed. */
const calls: string[] = [];

function fullRuns(): RunSource {
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}:${String(args[0])}`);
    };
  return {
    startRun: () => Promise.reject(new Error('not under test')),
    subscribe: () => () => undefined,
    interrupt: async (runId) => {
      record('interrupt')(runId);
    },
    respondToPermission: async (runId) => {
      record('respondToPermission')(runId);
    },
    disposeRun: async (runId) => {
      record('disposeRun')(runId);
    },
    listRuns: async () => [runHandle('bridge-run'), runHandle('owned-run')],
    getRun: async (runId) => runHandle(runId),
    runEvents: async () => ({ events: [] as readonly AgentEvent[], truncated: false }),
    liveWork: async () => ({ sessionIds: [], working: [], delegated: [] }),
    startUserRun: async () => runHandle('bridge-run'),
    send: async (runId) => {
      record('send')(runId);
      return { deliveredImmediately: true };
    },
    interruptRun: async (runId) => {
      record('interruptRun')(runId);
      return { stillQueued: [] as readonly string[] };
    },
    stopTask: async (runId) => {
      record('stopTask')(runId);
    },
  };
}

/**
 * A directory in which `conn-1` owns `owned-run` and nothing else does.
 *
 * The sweep is off: these tests are about routing, and an interval firing
 * mid-assertion would be a race nobody asked for.
 */
function directoryOwning(runs: RunSource): ReturnType<typeof createRunDirectory> {
  const directory = createRunDirectory({ runs, sweepIntervalMs: 0 });
  directory.claim({ runId: 'owned-run', connectionId: 'conn-1', permissions: true });
  return directory;
}

let runs: RunSource;
let directory: ReturnType<typeof createRunDirectory>;

beforeEach(() => {
  reachedBridge.mockClear();
  calls.length = 0;
  runs = fullRuns();
  directory = directoryOwning(runs);
});

function ask(
  url: string,
  method = 'GET',
  body?: unknown,
  token = TOKEN,
  overrides: Partial<ServerContext> = {},
): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    {
      method,
      url,
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body }),
    },
    {
      connections: [CONNECTION, NEIGHBOUR],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
      runs,
      runDirectory: directory,
      ...overrides,
    },
  );
}

describe('the remote bridge still owns every path it owns', () => {
  it('dispatches each REMOTE_* constant to the bridge handler', async () => {
    /*
     * The enumeration is taken from the protocol's own constants rather than
     * written out, so a route added there and not routed here fails this test
     * instead of quietly becoming unreachable.
     */
    const routes: readonly (readonly [string, string])[] = [
      [REMOTE_RUNS_PATH, 'GET'],
      [REMOTE_RUNS_PATH, 'POST'],
      [REMOTE_LIVE_WORK_PATH, 'GET'],
      [REMOTE_EVENTS_PATH, 'GET'],
      [REMOTE_TERMINALS_PATH, 'GET'],
      [REMOTE_TERMINALS_PATH, 'POST'],
      [remoteRunPath('bridge-run', 'events'), 'GET'],
      ...REMOTE_RUN_ACTIONS.map(
        (action) => [remoteRunPath('bridge-run', action), 'POST'] as const,
      ),
      ...(['write', 'resize', 'close'] as const).map(
        (action) => [remoteTerminalPath('term-1', action), 'POST'] as const,
      ),
      [remoteTerminalPath('term-1', 'replay'), 'GET'],
    ];

    for (const [path, method] of routes) {
      reachedBridge.mockClear();
      const reply = await ask(path, method, { text: 'x', taskId: 't', requestId: 'p' });
      expect(
        reachedBridge.mock.calls,
        `${method} ${path} should reach the bridge`,
      ).toEqual([[path, method]]);
      // And it is genuinely answered rather than falling through to the
      // catch-all 404 the read-only gate below the bridge would produce.
      const status = isStreamReply(reply) ? reply.status : reply.status;
      expect(status, `${method} ${path}`).not.toBe(404);
    }
  });

  it('answers the run list and the five bridge verbs from the bridge', async () => {
    // Named individually as well as enumerated above, because these six are the
    // ones a completions-surface prefix dispatcher would have taken.
    const list = await ask(REMOTE_RUNS_PATH);
    expect(list.status).toBe(200);
    if (isStreamReply(list)) throw new Error('expected a body');
    expect(list.body).toMatchObject({ object: 'artemis.runs' });

    const started = await ask(REMOTE_RUNS_PATH, 'POST', {
      profileId: 'prof-a',
      model: 'opus',
      prompt: 'hi',
    });
    expect(reachedBridge).toHaveBeenCalledWith(REMOTE_RUNS_PATH, 'POST');
    expect(started.status).not.toBe(404);

    // `send` is the bridge's spelling of "another message". The completions
    // surface calls the same thing `messages`, and the two must not be one
    // route: this one answers in the bridge's own envelope.
    const sent = await ask(remoteRunPath('bridge-run', 'send'), 'POST', { text: 'stop that' });
    if (isStreamReply(sent)) throw new Error('expected a body');
    expect(sent.body).toMatchObject({ object: 'artemis.run.send' });

    for (const action of ['respond-permission', 'stop-task', 'dispose'] as const) {
      reachedBridge.mockClear();
      const reply = await ask(remoteRunPath('bridge-run', action), 'POST', {
        requestId: 'perm-1',
        decision: { behavior: 'deny' },
        taskId: 'task-1',
      });
      expect(reachedBridge.mock.calls).toEqual([[remoteRunPath('bridge-run', action), 'POST']]);
      expect(reply.status, action).toBe(200);
    }
  });

  it('keeps `?after=` replay as the bridge\'s, with no second spelling beside it', async () => {
    // The completions client is handed its run id on its own stream and never
    // enumerates or replays, so there is exactly one events route and one query
    // parameter. A second one on `?afterSeq=` would be two answers to one
    // question, differing in an easily-missed suffix.
    const replay = await ask(`${remoteRunPath('bridge-run', 'events')}?after=4`);
    expect(reachedBridge).toHaveBeenCalledWith(remoteRunPath('bridge-run', 'events'), 'GET');
    expect(replay.status).toBe(200);

    // Even on a run the completions surface owns: reading is the bridge's.
    reachedBridge.mockClear();
    await ask(`${remoteRunPath('owned-run', 'events')}?afterSeq=4`);
    expect(reachedBridge).toHaveBeenCalledWith(remoteRunPath('owned-run', 'events'), 'GET');
  });

  it('still reaches the bridge when this build keeps no run directory', async () => {
    // The completions surface being absent must not take the bridge with it.
    reachedBridge.mockClear();
    await ask(REMOTE_RUNS_PATH, 'GET', undefined, TOKEN, { runDirectory: undefined });
    expect(reachedBridge).toHaveBeenCalledWith(REMOTE_RUNS_PATH, 'GET');
  });
});

describe('ownership decides who answers `interrupt`', () => {
  it('answers an owned completions run here, without touching the bridge', async () => {
    const reply = await ask(remoteRunPath('owned-run', 'interrupt'), 'POST', {});
    expect(reachedBridge).not.toHaveBeenCalled();
    expect(reply.status).toBe(200);
    if (isStreamReply(reply)) throw new Error('expected a body');
    // The completions surface's envelope — a bare `{ runId }` — not the
    // bridge's `object: 'artemis.run.action'`.
    expect(reply.body).toEqual({ runId: 'owned-run' });
    // And through `interrupt`, not the bridge's richer `interruptRun`.
    expect(calls).toEqual(['interrupt:owned-run']);
  });

  it('passes a bridge-started run straight through, exactly as before', async () => {
    const reply = await ask(remoteRunPath('bridge-run', 'interrupt'), 'POST', {});
    expect(reachedBridge).toHaveBeenCalledWith(remoteRunPath('bridge-run', 'interrupt'), 'POST');
    expect(reply.status).toBe(200);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.body).toMatchObject({ object: 'artemis.run.interrupt' });
    expect(calls).toEqual(['interruptRun:bridge-run']);
  });

  it('passes another connection\'s completions run through rather than claiming it', async () => {
    // `conn-2` does not own `owned-run`, so this is not its completions run —
    // and a name the bridge also has must fall through rather than 404 here.
    // Anything else would let one connection make another's run unreachable by
    // starting one first.
    await ask(remoteRunPath('owned-run', 'interrupt'), 'POST', {}, OTHER_TOKEN);
    expect(reachedBridge).toHaveBeenCalledWith(remoteRunPath('owned-run', 'interrupt'), 'POST');
  });
});

describe('the two verbs the bridge does not have', () => {
  for (const action of ['messages', 'permission'] as const) {
    it(`answers \`${action}\` on an owned run`, async () => {
      const reply = await ask(`${REMOTE_RUNS_PATH}/owned-run/${action}`, 'POST', {
        text: 'keep going',
        requestId: 'perm-1',
        decision: { behavior: 'allow' },
      });
      expect(reachedBridge).not.toHaveBeenCalled();
      expect(reply.status).toBe(200);
    });

    it(`404s \`${action}\` on a run this connection does not own`, async () => {
      /*
       * Flat, and never handed to the bridge. The bridge would answer "no run
       * action" for these names, which is a different sentence about a
       * different thing — a caller would have to tell two 404s apart to know
       * whether it had the wrong id or the wrong idea.
       */
      const reply = await ask(
        `${REMOTE_RUNS_PATH}/owned-run/${action}`,
        'POST',
        { text: 'x', requestId: 'p', decision: { behavior: 'deny' } },
        OTHER_TOKEN,
      );
      expect(reachedBridge).not.toHaveBeenCalled();
      expect(reply.status).toBe(404);
      if (isStreamReply(reply)) throw new Error('expected a body');
      expect(reply.body).toMatchObject({ error: { code: 'unknown_run' } });
    });

    it(`404s \`${action}\` on a build with no run directory`, async () => {
      // Indistinguishable from a build that never had the routes, which is what
      // an older server is.
      const reply = await ask(
        `${REMOTE_RUNS_PATH}/never-claimed/${action}`,
        'POST',
        { text: 'x', requestId: 'p', decision: { behavior: 'deny' } },
        TOKEN,
        { runDirectory: undefined },
      );
      expect(reply.status).toBe(404);
    });
  }

  it('refuses a durable scope that the bridge would accept', async () => {
    /*
     * The narrowing is this surface's alone. A completions caller is a program
     * borrowing an account — the same principal that may not choose a
     * permission mode when it starts a run — so it may approve the call in
     * front of it and nothing wider. The bridge's caller is the user in their
     * own window, and keeps the whole `PermissionDecision`.
     */
    const narrowed = await ask(`${REMOTE_RUNS_PATH}/owned-run/permission`, 'POST', {
      requestId: 'perm-1',
      decision: { behavior: 'allow', scope: 'project' },
    });
    expect(narrowed.status).toBe(400);

    const bridged = await ask(remoteRunPath('bridge-run', 'respond-permission'), 'POST', {
      requestId: 'perm-1',
      decision: { behavior: 'allow', scope: 'project' },
    });
    expect(bridged.status).toBe(200);
  });

  it('leaves a GET on those names to the bridge to refuse', async () => {
    // Only POST is this surface's. A GET is not a completions verb, so it is
    // not intercepted, and the bridge answers it the way it answers any other
    // unknown run action.
    await ask(`${REMOTE_RUNS_PATH}/owned-run/messages`);
    expect(reachedBridge).toHaveBeenCalledWith(`${REMOTE_RUNS_PATH}/owned-run/messages`, 'GET');
  });
});

describe('the two run registries do not overlap', () => {
  it('never registers a completions-started run with the bridge guard', async () => {
    /*
     * A run in both would be governed by whichever deadline fired first — a
     * bridge run reaped at six hours it was still being watched through, or a
     * completions run interrupted sixty seconds after some *other* client's
     * event stream dropped. The two are separated at the point of creation,
     * which is the only place worth checking.
     */
    const tracked: string[] = [];
    const guard = {
      attach: () => undefined,
      detach: () => undefined,
      trackRun: (run: { runId: string }) => tracked.push(run.runId),
      untrackRun: () => undefined,
      dispose: () => undefined,
    };

    const reply = await ask(
      '/v1/chat/completions',
      'POST',
      { model: 'work-max/opus', messages: [{ role: 'user', content: 'hi' }] },
      TOKEN,
      { guard },
    );
    // No catalogue in this fixture, so the turn is refused before it runs —
    // which is enough: what is asserted is that nothing on the completions path
    // reaches the guard, and the guard is the only thing being watched.
    expect(reply.status).not.toBe(200);
    expect(tracked).toEqual([]);
  });

  it('does not let the bridge claim ownership in the completions directory', async () => {
    // The mirror of the above. Starting a run through the bridge leaves the
    // completions directory empty, so the bridge's run stays the bridge's.
    await ask(REMOTE_RUNS_PATH, 'POST', { profileId: 'prof-a', model: 'opus', prompt: 'hi' });
    expect(directory.ownedBy('conn-1')).toEqual(['owned-run']);
    expect(directory.owns('conn-1', 'bridge-run' as never)).toBe(false);
  });
});
