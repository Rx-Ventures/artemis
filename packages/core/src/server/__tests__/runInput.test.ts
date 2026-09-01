/**
 * What a bridge token is allowed to put in a `RunInput`.
 *
 * The tests that matter here are the refusals, and one of them describes a real
 * hole: `additionalDirectories` is passed through to the Claude SDK's option of
 * the same name and into Codex's `writableRoots`, so a route that confined
 * `cwd` and nothing else let a pinned token declare the whole filesystem
 * writable in one line of JSON.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ServerConnection, RunHandle, RunInput } from '@rx-artemis/protocol';
import { NO_CAPABILITIES, REMOTE_RUNS_PATH } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import type { RunSource } from '../completions.js';
import { handleServerRequest, isStreamReply, type ServerContext } from '../http.js';
import { readRunInput, RunInputError } from '../runInput.js';
import { createWorkspaceResolver } from '../workspaces.js';

const TOKEN = 'pinned-token-abcdefghijklmnopqrstuv';
const SCRATCH_TOKEN = 'scratch-token-abcdefghijklmnopqrstu';

const PINNED: ServerConnection = {
  id: 'conn-pinned',
  label: 'Repo',
  workspace: { kind: 'directory', path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

const SCRATCH: ServerConnection = {
  id: 'conn-scratch',
  label: 'Scratch',
  workspace: { kind: 'ephemeral', perSession: true },
  token: SCRATCH_TOKEN,
  createdAt: 0,
};

const catalogue: Catalogue = { read: async () => [], invalidate: () => undefined };

const started: RunInput[] = [];
const runs: RunSource = {
  startRun: () => Promise.reject(new Error('not under test')),
  subscribe: () => () => undefined,
  interrupt: async () => undefined,
  respondToPermission: async () => undefined,
  disposeRun: async () => undefined,
  listRuns: async () => [],
  getRun: async () => undefined,
  runEvents: async () => ({ events: [], truncated: false }),
  startUserRun: async (input) => {
    started.push(input);
    const handle: RunHandle = {
      runId: 'run-new',
      providerId: input.providerId,
      profileId: input.profileId,
      cwd: input.cwd,
      status: 'running',
      capabilities: NO_CAPABILITIES,
      startedAt: 0,
    };
    return handle;
  },
};

function post(input: unknown, token = TOKEN): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    {
      method: 'POST',
      url: REMOTE_RUNS_PATH,
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
      body: { input },
    },
    {
      connections: [PINNED, SCRATCH],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
      runs,
      workspaces: createWorkspaceResolver(),
    } satisfies ServerContext,
  );
}

const base = { providerId: 'claude', profileId: 'prof-a', cwd: '/w', prompt: 'hi' };

describe('the run-start allowlist', () => {
  it('copies only the fields it names', () => {
    const input = readRunInput({
      input: { ...base, somethingNew: 'from a future protocol', __proto__: { polluted: true } },
    });
    expect(input).not.toHaveProperty('somethingNew');
    expect(Object.keys(input).sort()).toEqual(['cwd', 'profileId', 'prompt', 'providerId']);
  });

  it('names the field it refused', () => {
    expect(() => readRunInput({ input: { ...base, maxTurns: -1 } })).toThrow(RunInputError);
    expect(() => readRunInput({ input: { ...base, maxTurns: -1 } })).toThrow(/maxTurns/);
  });

  it('refuses a relative or NUL-bearing path', () => {
    expect(() => readRunInput({ input: { ...base, cwd: 'relative' } })).toThrow(/cwd/);
    expect(() => readRunInput({ input: { ...base, cwd: '/w/x\0/etc' } })).toThrow(/NUL/);
    // A Windows client's local directory is still refused when *sent* — the
    // omission below is the escape, not a laxer rule.
    expect(() => readRunInput({ input: { ...base, cwd: 'C:\\Users\\x' } })).toThrow(/cwd/);
  });

  it('lets a caller omit the cwd entirely — the pin will decide', () => {
    const { cwd: _cwd, ...rest } = base;
    const parsed = readRunInput({ input: rest });
    expect(parsed.cwd).toBeUndefined();
  });

  it('bounds the prompt, the system prompt and the metadata', () => {
    expect(() => readRunInput({ input: { ...base, prompt: 'x'.repeat(2_000_000) } })).toThrow(/prompt/);
    expect(() =>
      readRunInput({
        input: { ...base, systemPrompt: { kind: 'append', text: 'x'.repeat(300_000) } },
      }),
    ).toThrow(/systemPrompt/);
    // Deeply nested metadata is a way to make a JSON round-trip expensive.
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i += 1) deep = { deep };
    expect(() => readRunInput({ input: { ...base, metadata: deep } })).toThrow(/metadata/);
  });

  it('refuses an unknown permission mode rather than downgrading it', () => {
    expect(() => readRunInput({ input: { ...base, permissionMode: 'whatever' } })).toThrow(
      /permissionMode/,
    );
  });

  it('keeps the settings a person legitimately chooses', () => {
    const input = readRunInput({
      input: { ...base, model: 'opus', maxTurns: 12, title: 'A run', includePartialMessages: false },
    });
    expect(input).toMatchObject({
      model: 'opus',
      maxTurns: 12,
      title: 'A run',
      includePartialMessages: false,
    });
  });
});

describe('POST /api/v0/runs, against the pin', () => {
  it('starts a run in the pinned directory', async () => {
    started.length = 0;
    const reply = await post(base);
    expect(reply.status).toBe(200);
    expect(started[0]?.cwd).toBe(resolve('/w'));
  });

  /*
   * The traversal spelling. A prefix test on the raw string admits this: the
   * literal `/w/../../etc` starts with `/w/` and names `/etc`.
   */
  it('refuses a cwd that climbs out of the pin with dot segments', async () => {
    started.length = 0;
    for (const cwd of ['/w/../../etc', '/w/./../../etc', '/w/sub/../../../etc', '/w/..']) {
      const reply = await post({ ...base, cwd });
      expect(reply.status).toBe(403);
    }
    expect(started).toEqual([]);
  });

  it('does not admit a sibling directory sharing the pin’s prefix', async () => {
    const reply = await post({ ...base, cwd: '/w-other/repo' });
    expect(reply.status).toBe(403);
  });

  it('normalizes a path that stays inside', async () => {
    started.length = 0;
    const reply = await post({ ...base, cwd: '/w/packages/../packages/core' });
    expect(reply.status).toBe(200);
    expect(started[0]?.cwd).toBe(resolve('/w/packages/core'));
  });

  /*
   * The escape this route had. `additionalDirectories` becomes a writable root
   * in both adapters, so it has to face the same pin `cwd` does.
   */
  it('refuses additionalDirectories outside the pin', async () => {
    started.length = 0;
    for (const dir of ['/', '/etc', '/w/../..']) {
      const reply = await post({ ...base, additionalDirectories: [dir] });
      expect(reply.status).toBe(403);
    }
    expect(started).toEqual([]);
  });

  it('admits and normalizes additionalDirectories inside the pin', async () => {
    started.length = 0;
    const reply = await post({
      ...base,
      additionalDirectories: ['/w/vendor', '/w/packages/../docs'],
    });
    expect(reply.status).toBe(200);
    expect(started[0]?.additionalDirectories).toEqual([resolve('/w/vendor'), resolve('/w/docs')]);
  });

  it('roots a run at the pin when the body names no cwd', async () => {
    // The Windows-client case: the pane's local directory names a path on the
    // wrong machine, so the bridge leaves it off and the pin answers.
    started.length = 0;
    const { cwd: _cwd, ...rest } = base;
    const reply = await post(rest);
    expect(reply.status).toBe(200);
    expect(started[0]?.cwd).toBe(resolve('/w'));
  });

  it('still confines extra roots when the cwd is absent', async () => {
    // The list is filtered by field name, not position — an omitted cwd must
    // not shift the first extra root out of confinement.
    started.length = 0;
    const { cwd: _cwd, ...rest } = base;
    const ok = await post({ ...rest, additionalDirectories: ['/w/vendor'] });
    expect(ok.status).toBe(200);
    expect(started[0]?.additionalDirectories).toEqual([resolve('/w/vendor')]);

    const escape = await post({ ...rest, additionalDirectories: ['/etc'] });
    expect(escape.status).toBe(403);
  });

  it('refuses extra roots on a connection with no directory to widen', async () => {
    const reply = await post({ ...base, additionalDirectories: ['/tmp'] }, SCRATCH_TOKEN);
    expect(reply.status).toBe(403);
  });

  it('answers with the field name when the body is wrong', async () => {
    const reply = await post({ ...base, additionalDirectories: ['relative/path'] });
    expect(reply.status).toBe(400);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect((reply.body as { error: { message: string } }).error.message).toContain(
      'additionalDirectories',
    );
  });
});

/*
 * Resuming somebody else's conversation.
 *
 * The attack this closes, in order: a token pinned to /w and allowed prof-a
 * posts a run naming the *serving user's own* session id. Every earlier check
 * passes — the profile is allowed, the cwd is inside the pin — and nothing
 * downstream has a notion of session ownership, so the provider re-opens the
 * private transcript. Then the run announces its session id, the host records
 * it into the ledger against this connection, and because the ledger is keyed
 * on session id with last-writer-wins, the entry that said the conversation
 * belonged to the desktop user now says it belongs to the caller. `mayAccess`
 * starts returning true and `/api/v0/sessions/{id}/messages` serves the whole
 * transcript, durably. A borrowed id would have laundered itself into an owned
 * one.
 */
describe('resuming a session over the bridge', () => {
  const MINE = 'sess-mine';
  const THEIRS = 'sess-theirs';

  /** A ledger where `MINE` is this connection's and `THEIRS` is not. */
  function ledger(): NonNullable<ServerContext['ledger']> {
    return {
      load: async () => undefined,
      record: () => undefined,
      has: (id) => id === MINE || id === THEIRS,
      isProgramSession: () => false,
      get: () => undefined,
      listFor: () => [],
      mayAccess: (_scope, id) => id === MINE,
      size: () => 2,
      flush: async () => undefined,
    } as unknown as NonNullable<ServerContext['ledger']>;
  }

  function resume(
    sessionId: string | undefined,
    context: Partial<ServerContext> = {},
  ): ReturnType<typeof handleServerRequest> {
    return handleServerRequest(
      {
        method: 'POST',
        url: REMOTE_RUNS_PATH,
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
        body: {
          input: { ...base, ...(sessionId === undefined ? {} : { resumeSessionId: sessionId }) },
        },
      },
      {
        connections: [PINNED, SCRATCH],
        version: '1.1.1',
        catalogue,
        startedAt: 0,
        runs,
        workspaces: createWorkspaceResolver(),
        ledger: ledger(),
        ...context,
      } satisfies ServerContext,
    );
  }

  it('resumes a conversation this connection owns', async () => {
    started.length = 0;
    const reply = await resume(MINE);
    expect(reply.status).toBe(200);
    expect(started[0]?.resumeSessionId).toBe(MINE);
  });

  it('refuses one it does not own, and never starts the run', async () => {
    started.length = 0;
    const reply = await resume(THEIRS);
    expect(reply.status).toBe(404);
    // The whole point: the provider is never asked to re-open the transcript,
    // so there is no session announcement to overwrite ownership with.
    expect(started).toEqual([]);
  });

  /*
   * The oracle. A refusal that distinguished "exists but not yours" from
   * "never existed" would let a caller enumerate the serving machine's
   * conversations by asking about ids until one answered differently — without
   * ever being allowed to read a single one.
   */
  it('answers a foreign id exactly as it answers an absent one', async () => {
    const foreign = await resume(THEIRS);
    const absent = await resume('sess-never-existed');
    if (isStreamReply(foreign) || isStreamReply(absent)) throw new Error('expected bodies');
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);
  });

  /*
   * Fail closed. The completions surface skips this check without a ledger,
   * which is defensible there — it cannot start a conversation it could later
   * be asked to re-enter. This route can, so "cannot prove it is yours" has to
   * read as no; otherwise dropping one optional dependency yields a deployment
   * where every conversation on the machine is resumable by any token.
   */
  it('refuses any resume at all when there is no ledger to ask', async () => {
    started.length = 0;
    const reply = await resume(MINE, { ledger: undefined });
    expect(reply.status).toBe(404);
    expect(started).toEqual([]);

    // A run that resumes nothing is unaffected — the gate is about session ids.
    expect((await resume(undefined, { ledger: undefined })).status).toBe(200);
  });
});

/*
 * Scratch is per-connection by construction, and the resolver now says so on
 * its own terms rather than relying on the route's gate.
 */
describe('ephemeral workspaces', () => {
  it('does not hand one connection another connection’s scratch directory', async () => {
    const workspaces = createWorkspaceResolver();
    const shared = { kind: 'ephemeral', perSession: true } as const;
    const mine = await workspaces.resolve({
      connectionId: 'conn-a',
      workspace: shared,
      sessionId: 'sess-1',
    });
    const theirs = await workspaces.resolve({
      connectionId: 'conn-b',
      workspace: shared,
      sessionId: 'sess-1',
    });
    expect(mine.path).not.toBe(theirs.path);

    // And each keeps its own across calls, which is what `perSession` promises.
    const again = await workspaces.resolve({
      connectionId: 'conn-a',
      workspace: shared,
      sessionId: 'sess-1',
    });
    expect(again.path).toBe(mine.path);
    await workspaces.disposeAll();
  });
});
