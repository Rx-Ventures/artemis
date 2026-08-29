/**
 * What a bridge token is allowed to put in a `RunInput`.
 *
 * The tests that matter here are the refusals, and one of them describes a real
 * hole: `additionalDirectories` is passed through to the Claude SDK's option of
 * the same name and into Codex's `writableRoots`, so a route that confined
 * `cwd` and nothing else let a pinned token declare the whole filesystem
 * writable in one line of JSON.
 */

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
    expect(started[0]?.cwd).toBe('/w');
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
    expect(started[0]?.cwd).toBe('/w/packages/core');
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
    expect(started[0]?.additionalDirectories).toEqual(['/w/vendor', '/w/docs']);
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
