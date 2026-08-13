import { describe, expect, it, vi } from 'vitest';

import { NO_CAPABILITIES, PERMISSION_MODES } from '@rx-artemis/protocol';
import type {
  AgentEvent,
  Attachment,
  Capabilities,
  PermissionDecision,
  RunEndEvent,
  RunInput,
} from '@rx-artemis/protocol';

import type {
  InterruptResult,
  ProviderAdapter,
  ResolvedRunInput,
  SendResult,
} from '../adapters/types.js';
import { RunError } from './errors.js';
import { RunRegistry } from './registry.js';
import type { RunRegistryOptions } from './registry.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const FULL_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: PERMISSION_MODES,
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
};

/**
 * A `Run` whose event stream is driven by the test.
 *
 * `close()` completes the stream without a `run.end`, which is exactly the
 * misbehaviour the registry has to paper over.
 */
class FakeRun {
  readonly sent: string[] = [];
  readonly sentAttachments: (readonly Attachment[])[] = [];
  readonly answered: Array<{ requestId: string; decision: PermissionDecision }> = [];
  readonly events: AsyncIterable<AgentEvent>;

  interruptCount = 0;
  disposeCount = 0;
  interruptResult: InterruptResult = { stillQueued: [] };
  sendResult: SendResult = { deliveredImmediately: true };
  /** When false, `dispose()` leaves the stream open — a hung provider. */
  closeOnDispose = true;

  #queue: AgentEvent[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  #failure: Error | null = null;

  constructor() {
    this.events = { [Symbol.asyncIterator]: () => this.#iterate() };
  }

  emit(...events: AgentEvent[]): void {
    this.#queue.push(...events);
    this.#pulse();
  }

  close(): void {
    this.#closed = true;
    this.#pulse();
  }

  fail(error: Error): void {
    this.#failure = error;
    this.#pulse();
  }

  send(text: string, attachments?: readonly Attachment[]): Promise<SendResult> {
    this.sent.push(text);
    if (attachments !== undefined) this.sentAttachments.push(attachments);
    return Promise.resolve(this.sendResult);
  }

  interrupt(): Promise<InterruptResult> {
    this.interruptCount += 1;
    return Promise.resolve(this.interruptResult);
  }

  respondToPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.answered.push({ requestId, decision });
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.disposeCount += 1;
    if (this.closeOnDispose) this.close();
    return Promise.resolve();
  }

  #pulse(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *#iterate(): AsyncGenerator<AgentEvent, void> {
    for (;;) {
      if (this.#failure) {
        const failure = this.#failure;
        this.#failure = null;
        throw failure;
      }
      const next = this.#queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/**
 * A run that is one *turn* of something longer-lived.
 *
 * The shape the Claude adapter has had since a process could outlive the turn
 * that spawned it: `release()` means "nobody is reading this turn any more" and
 * leaves the process alone, `dispose()` still means take it down. A `FakeRun`
 * without one models every other adapter, where the two are one act.
 */
class FakeTurn extends FakeRun {
  releaseCount = 0;

  release(): Promise<void> {
    this.releaseCount += 1;
    return Promise.resolve();
  }
}

interface Harness {
  readonly registry: RunRegistry;
  readonly runs: FakeRun[];
  readonly errors: Array<{ error: unknown; phase: string }>;
  /** Every ResolvedRunInput the adapter was handed. */
  readonly resolved: ResolvedRunInput[];
  /** Adapter methods in the order they were called. The history seam depends on it. */
  readonly calls: string[];
}

/**
 * The default working-directory checker for these tests: everything absolute
 * is fine.
 *
 * The registry now stats a run's `cwd` before starting it, and these tests run
 * in `/repo` and `/other`, which do not exist. Injecting the check keeps the
 * registry's *own* behaviour under test — that it refuses, and refuses before
 * resolving credentials — without turning every unrelated test into a
 * filesystem fixture. The real `stat` has its own tests in
 * `../workspace/workdir.test.ts`.
 */
const acceptAbsolute: RunRegistryOptions['checkWorkingDirectory'] = (cwd) =>
  cwd.startsWith('/')
    ? { ok: true, path: cwd }
    : { ok: false, path: cwd, problem: 'not_absolute', message: `not absolute: ${cwd}` };

function harness(
  options: {
    capabilities?: Capabilities;
    disposeTimeoutMs?: number;
    historyLimit?: number;
    adapter?: Partial<{ createRun: () => Promise<FakeRun> }>;
    /** Build runs that can be released without being torn down — see {@link FakeTurn}. */
    releasable?: boolean;
    /** Present only when a test is about the history seam; absent models a provider that cannot count. */
    countSessionMessages?: (query: { sessionId: string }) => Promise<number>;
    resolveRun?: RunRegistryOptions['resolveRun'];
    checkWorkingDirectory?: RunRegistryOptions['checkWorkingDirectory'];
  } = {},
): Harness {
  const runs: FakeRun[] = [];
  const errors: Array<{ error: unknown; phase: string }> = [];
  const resolved: ResolvedRunInput[] = [];
  const calls: string[] = [];

  const adapter = {
    id: 'claude',
    capabilities: options.capabilities ?? FULL_CAPABILITIES,
    createRun: (runInput: ResolvedRunInput) => {
      calls.push('createRun');
      resolved.push(runInput);
      if (options.adapter?.createRun) return options.adapter.createRun();
      const run = options.releasable === true ? new FakeTurn() : new FakeRun();
      runs.push(run);
      return Promise.resolve(run);
    },
    ...(options.countSessionMessages === undefined
      ? {}
      : {
          countSessionMessages: (query: { sessionId: string }) => {
            calls.push('countSessionMessages');
            return options.countSessionMessages!(query);
          },
        }),
  };

  const registry = new RunRegistry({
    resolveAdapter: (providerId) =>
      providerId === 'claude' ? (adapter as unknown as ProviderAdapter) : undefined,
    resolveRun:
      options.resolveRun ??
      (() => ({ env: { ANTHROPIC_API_KEY: 'sk-ant-test-key', CLAUDE_CONFIG_DIR: '/cfg' } })),
    checkWorkingDirectory: options.checkWorkingDirectory ?? acceptAbsolute,
    now: () => 1_000,
    newRunId: () => `run-${runs.length + 1}`,
    disposeTimeoutMs: options.disposeTimeoutMs ?? 50,
    historyLimit: options.historyLimit,
    onError: (error, context) => errors.push({ error, phase: context.phase }),
  });

  return { registry, runs, errors, resolved, calls };
}

const input = (overrides: Partial<RunInput> = {}): RunInput => ({
  providerId: 'claude',
  profileId: 'profile-1',
  cwd: '/repo',
  prompt: 'hello',
  ...overrides,
});

/** Let the event pump drain everything currently queued. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const sessionStarted = (runId: string, seq = 0): AgentEvent => ({
  type: 'session.started',
  runId,
  seq,
  ts: 1,
  sessionId: 'session-abc',
  providerId: 'claude',
  cwd: '/repo',
});

const textComplete = (runId: string, seq: number, text: string): AgentEvent => ({
  type: 'text.complete',
  runId,
  seq,
  ts: 1,
  messageId: `m${seq}`,
  role: 'assistant',
  text,
});

const permissionRequest = (runId: string, seq: number, requestId: string): AgentEvent => ({
  type: 'permission.request',
  runId,
  seq,
  ts: 1,
  requestId,
  request: {
    id: requestId,
    runId,
    toolName: 'Bash',
    input: { command: 'ls' },
    requestedAt: 1,
  },
});

const permissionResolved = (
  runId: string,
  seq: number,
  requestId: string,
  outcome: 'allowed' | 'denied' | 'withdrawn' = 'withdrawn',
): AgentEvent => ({
  type: 'permission.resolved',
  runId,
  seq,
  ts: 1,
  requestId,
  outcome,
});

const runEnd = (runId: string, seq: number): AgentEvent => ({
  type: 'run.end',
  runId,
  seq,
  ts: 1,
  reason: 'completed',
});

function firstRun(runs: FakeRun[]): FakeRun {
  const run = runs[0];
  if (!run) throw new Error('no run was created');
  return run;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('RunRegistry — starting', () => {
  it('returns a starting handle carrying the adapter capabilities', async () => {
    const { registry } = harness();
    const handle = await registry.start(input({ metadata: { tabId: 'tab-1' } }));

    expect(handle).toMatchObject({
      runId: 'run-1',
      providerId: 'claude',
      profileId: 'profile-1',
      cwd: '/repo',
      status: 'starting',
      startedAt: 1_000,
      metadata: { tabId: 'tab-1' },
    });
    expect(handle.capabilities).toEqual(FULL_CAPABILITIES);
    expect(registry.activeCount).toBe(1);
  });

  it('honours a caller-supplied run id and rejects a duplicate', async () => {
    const { registry } = harness();
    await registry.start(input({ runId: 'mine' }));

    expect(registry.isActive('mine')).toBe(true);
    await expect(registry.start(input({ runId: 'mine' }))).rejects.toBeInstanceOf(RunError);
  });

  it('reports provider_not_found when no adapter is registered', async () => {
    const { registry } = harness();
    const error = await registry.start(input({ providerId: 'codex' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunError);
    expect((error as RunError).code).toBe('provider_not_found');
  });

  it('requires an absolute cwd', async () => {
    const { registry } = harness();
    await expect(registry.start(input({ cwd: 'relative/path' }))).rejects.toBeInstanceOf(RunError);
  });

  /**
   * The bug this section exists for.
   *
   * A working directory that is absolute but not *real* used to pass every
   * check here, reach `spawn`, and come back as an `ENOENT` that the provider
   * SDK reported as a libc mismatch in its own binary — a message with no
   * relationship to the mistake the user made. Each case below asserts that
   * the run is refused with a sentence naming the directory instead.
   */
  it.each([
    [
      'a directory that does not exist',
      { problem: 'does_not_exist' as const, message: 'That directory does not exist: /gone' },
    ],
    [
      'a path that is a file',
      { problem: 'not_a_directory' as const, message: 'That path is not a directory: /gone' },
    ],
    [
      'a directory it cannot read',
      { problem: 'not_readable' as const, message: 'Artemis is not allowed to open that directory: /gone' },
    ],
  ])('refuses %s, with the checker’s own message', async (_label, failure) => {
    const { registry, resolved } = harness({
      checkWorkingDirectory: () => ({ ok: false, path: '/gone', ...failure }),
    });

    const error = await registry.start(input({ cwd: '/gone' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunError);
    expect((error as RunError).code).toBe('invalid_request');
    expect((error as RunError).message).toBe(failure.message);
    // Refused before the adapter saw it — nothing was spawned.
    expect(resolved).toHaveLength(0);
    expect(registry.activeCount).toBe(0);
  });

  it('checks the working directory before resolving credentials', async () => {
    // Order matters: resolving decrypts a key and creates the profile's config
    // directory. A folder typo must not cost either.
    const resolveRun = vi.fn(() => ({ env: {} }));
    const { registry } = harness({
      resolveRun,
      checkWorkingDirectory: () => ({
        ok: false,
        path: '/gone',
        problem: 'does_not_exist',
        message: 'That directory does not exist: /gone',
      }),
    });

    await expect(registry.start(input({ cwd: '/gone' }))).rejects.toBeInstanceOf(RunError);
    expect(resolveRun).not.toHaveBeenCalled();
  });

  it('treats a checker that throws as a refusal, not as approval', async () => {
    const { registry, resolved } = harness({
      checkWorkingDirectory: () => {
        throw new Error('stat exploded');
      },
    });

    const error = await registry.start(input()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunError);
    expect((error as RunError).message).toMatch(/Could not check the working directory/);
    expect(resolved).toHaveLength(0);
  });

  it('starts normally once the directory checks out', async () => {
    const seen: string[] = [];
    const { registry } = harness({
      checkWorkingDirectory: (cwd) => {
        seen.push(cwd);
        return { ok: true, path: cwd };
      },
    });

    await registry.start(input({ cwd: '/repo' }));
    expect(seen).toEqual(['/repo']);
    expect(registry.activeCount).toBe(1);
  });

  it('refuses a request the capabilities do not cover', async () => {
    const { registry } = harness({
      capabilities: { ...NO_CAPABILITIES, permissionModes: ['default'] },
    });

    await expect(registry.start(input({ permissionMode: 'bypassPermissions' }))).rejects.toBeInstanceOf(
      RunError,
    );
    await expect(registry.start(input({ resumeSessionId: 'old' }))).rejects.toBeInstanceOf(RunError);
    await expect(
      registry.start(input({ resumeSessionId: 'old', forkSession: true })),
    ).rejects.toBeInstanceOf(RunError);
  });

  /**
   * Images, on an adapter that cannot take them.
   *
   * Refused rather than stripped, and it is the same refusal on both routes.
   * The composer gates the button, so the way to arrive here is to attach under
   * one provider and switch before sending — at which point sending the text
   * alone puts a question about a screenshot in front of a model that never
   * received one.
   */
  it('refuses images an adapter cannot carry, on start and mid-run alike', async () => {
    const image: Attachment = {
      kind: 'image',
      id: 'img-1',
      mediaType: 'image/png',
      data: 'aGVsbG8=',
    };

    const textOnly = harness({ capabilities: { ...FULL_CAPABILITIES, imageInput: false } });
    await expect(textOnly.registry.start(input({ attachments: [image] }))).rejects.toBeInstanceOf(
      RunError,
    );
    const started = await textOnly.registry.start(input());
    await expect(textOnly.registry.send(started.runId, 'look', [image])).rejects.toBeInstanceOf(
      RunError,
    );
    expect(textOnly.runs[0]?.sentAttachments).toEqual([]);

    // And forwarded, unchanged, by one that can.
    const capable = harness({ capabilities: { ...FULL_CAPABILITIES, imageInput: true } });
    const handle = await capable.registry.start(input());
    await capable.registry.send(handle.runId, 'look', [image]);
    expect(capable.runs[0]?.sentAttachments).toEqual([[image]]);
  });

  it('refuses each kind against its own capability', async () => {
    // Per kind, because the two travel by different mechanisms — an image needs
    // a place on the wire, a file needs the adapter to stage it and say where —
    // and an adapter can plausibly have one and not the other.
    const image: Attachment = { kind: 'image', id: 'i1', mediaType: 'image/png', data: 'aGk=' };
    const file: Attachment = { kind: 'file', id: 'f1', name: 'a.csv', data: 'aGk=' };

    const imagesOnly = harness({
      capabilities: { ...FULL_CAPABILITIES, imageInput: true, fileInput: false },
    });
    await expect(imagesOnly.registry.start(input({ attachments: [file] }))).rejects.toBeInstanceOf(
      RunError,
    );
    await expect(imagesOnly.registry.start(input({ attachments: [image] }))).resolves.toBeDefined();

    const filesOnly = harness({
      capabilities: { ...FULL_CAPABILITIES, imageInput: false, fileInput: true },
    });
    await expect(filesOnly.registry.start(input({ attachments: [image] }))).rejects.toBeInstanceOf(
      RunError,
    );
    await expect(filesOnly.registry.start(input({ attachments: [file] }))).resolves.toBeDefined();
  });

  it('surfaces an adapter that fails to create a run, without registering it', async () => {
    const { registry } = harness({
      adapter: { createRun: () => Promise.reject(new Error('spawn failed')) },
    });

    await expect(registry.start(input())).rejects.toBeInstanceOf(RunError);
    expect(registry.activeCount).toBe(0);
  });

  it('hands the adapter a resolved input carrying the run id and environment', async () => {
    const { registry, resolved } = harness({
      resolveRun: (runInput) => ({
        env: { ANTHROPIC_API_KEY: `key-for-${runInput.profileId}`, CLAUDE_CONFIG_DIR: '/cfg/work' },
        inheritHostEnv: true,
      }),
    });

    const handle = await registry.start(input({ profileId: 'work' }));

    expect(resolved[0]).toMatchObject({
      runId: handle.runId,
      profileId: 'work',
      cwd: '/repo',
      prompt: 'hello',
      env: { ANTHROPIC_API_KEY: 'key-for-work', CLAUDE_CONFIG_DIR: '/cfg/work' },
      inheritHostEnv: true,
    });
  });

  it('keeps the resolver error code when credentials cannot be resolved', async () => {
    const { registry } = harness({
      resolveRun: () => {
        throw new RunError('auth', 'Profile "Work" has no API key stored');
      },
    });

    const error = await registry.start(input()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunError);
    expect((error as RunError).code).toBe('auth');
    expect(registry.activeCount).toBe(0);
  });

  it('does not retain the resolved environment', async () => {
    const { registry } = harness();
    const handle = await registry.start(input());

    // The handle is what reaches the renderer; it must carry no credentials.
    expect(JSON.stringify(registry.get(handle.runId))).not.toContain('sk-ant');
  });
});

describe('RunRegistry — event fan-out', () => {
  it('delivers every event to global and per-run subscribers, in order', async () => {
    const { registry, runs } = harness();
    const global: AgentEvent[] = [];
    registry.subscribe((event) => global.push(event));

    const handle = await registry.start(input());
    const scoped: AgentEvent[] = [];
    registry.subscribeToRun(handle.runId, (event) => scoped.push(event));

    firstRun(runs).emit(
      sessionStarted(handle.runId),
      textComplete(handle.runId, 1, 'one'),
      textComplete(handle.runId, 2, 'two'),
    );
    await flush();

    expect(global.map((e) => e.type)).toEqual(['session.started', 'text.complete', 'text.complete']);
    expect(scoped).toEqual(global);
  });

  it('keeps the run alive when a subscriber throws', async () => {
    const { registry, runs, errors } = harness();
    const good: AgentEvent[] = [];
    registry.subscribe(() => {
      throw new Error('renderer exploded');
    });
    registry.subscribe((event) => good.push(event));

    const handle = await registry.start(input());
    firstRun(runs).emit(sessionStarted(handle.runId), textComplete(handle.runId, 1, 'still here'));
    await flush();

    expect(good).toHaveLength(2);
    expect(errors.filter((e) => e.phase === 'listener')).toHaveLength(2);
    expect(registry.isActive(handle.runId)).toBe(true);
  });

  it('stops delivering after unsubscribe without disturbing the run', async () => {
    const { registry, runs } = harness();
    const received: AgentEvent[] = [];
    const unsubscribe = registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    const run = firstRun(runs);
    run.emit(sessionStarted(handle.runId));
    await flush();

    unsubscribe();
    run.emit(textComplete(handle.runId, 1, 'after unsubscribe'));
    await flush();

    expect(received).toHaveLength(1);
    expect(registry.isActive(handle.runId)).toBe(true);
    expect(registry.eventsSince(handle.runId).map((e) => e.type)).toEqual([
      'session.started',
      'text.complete',
    ]);
  });

  it('corrects an event stamped with the wrong run id', async () => {
    const { registry, runs } = harness();
    const received: AgentEvent[] = [];
    registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    firstRun(runs).emit({ ...sessionStarted('someone-elses-run'), runId: 'someone-elses-run' });
    await flush();

    expect(received[0]?.runId).toBe(handle.runId);
  });

  it('replays retained events from a sequence number', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    firstRun(runs).emit(
      sessionStarted(handle.runId),
      textComplete(handle.runId, 1, 'one'),
      textComplete(handle.runId, 2, 'two'),
    );
    await flush();

    expect(registry.eventsSince(handle.runId, 0).map((e) => e.seq)).toEqual([1, 2]);
    expect(registry.eventsSince('unknown-run')).toEqual([]);
  });

  it('bounds the replay buffer', async () => {
    const { registry, runs } = harness({ historyLimit: 2 });
    const handle = await registry.start(input());
    firstRun(runs).emit(
      sessionStarted(handle.runId),
      textComplete(handle.runId, 1, 'one'),
      textComplete(handle.runId, 2, 'two'),
    );
    await flush();

    expect(registry.eventsSince(handle.runId).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('RunRegistry — handle state', () => {
  it('tracks starting → running → awaiting_permission → running → ended', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    const run = firstRun(runs);
    const { runId } = handle;

    expect(registry.get(runId)?.status).toBe('starting');

    run.emit(sessionStarted(runId));
    await flush();
    expect(registry.get(runId)).toMatchObject({ status: 'running', sessionId: 'session-abc' });

    run.emit(permissionRequest(runId, 1, 'perm-1'));
    await flush();
    expect(registry.get(runId)?.status).toBe('awaiting_permission');

    await registry.respondToPermission(runId, 'perm-1', { behavior: 'allow' });
    expect(registry.get(runId)?.status).toBe('running');
    expect(run.answered).toEqual([{ requestId: 'perm-1', decision: { behavior: 'allow' } }]);

    run.emit(runEnd(runId, 2));
    await flush();
    expect(registry.get(runId)?.status).toBe('ended');
    expect(registry.list()).toEqual([]);
    expect(registry.isActive(runId)).toBe(false);
  });

  /**
   * The path nobody calls.
   *
   * A provider can take a request back — the turn was interrupted, the tool
   * became moot — and when it does, no `respondToPermission` ever runs. Before
   * the adapter said so on the stream, the id sat in `pending` forever: the run
   * read as `awaiting_permission` with nothing to answer, and every attempt to
   * answer took the adapter's "no such request" branch and failed identically.
   */
  it('clears a withdrawn request without anyone answering it', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    const run = firstRun(runs);
    const { runId } = handle;

    run.emit(permissionRequest(runId, 0, 'perm-1'));
    await flush();
    expect(registry.get(runId)?.status).toBe('awaiting_permission');

    run.emit(permissionResolved(runId, 1, 'perm-1'));
    await flush();
    expect(registry.get(runId)?.status).toBe('running');
    // Nothing was sent to the adapter: the provider settled this one itself.
    expect(run.answered).toEqual([]);
  });

  it('stays parked while any other request is still open', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    const run = firstRun(runs);
    const { runId } = handle;

    run.emit(permissionRequest(runId, 0, 'perm-1'));
    run.emit(permissionRequest(runId, 1, 'perm-2'));
    run.emit(permissionResolved(runId, 2, 'perm-1', 'allowed'));
    await flush();

    expect(registry.get(runId)?.status).toBe('awaiting_permission');

    run.emit(permissionResolved(runId, 3, 'perm-2', 'denied'));
    await flush();
    expect(registry.get(runId)?.status).toBe('running');
  });

  it('narrows list() by cwd', async () => {
    const { registry } = harness();
    await registry.start(input({ runId: 'a', cwd: '/repo' }));
    await registry.start(input({ runId: 'b', cwd: '/other' }));

    expect(registry.list('/repo').map((h) => h.runId)).toEqual(['a']);
    expect(registry.list()).toHaveLength(2);
  });

  it('rejects an answer to a permission request that is not open', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    firstRun(runs).emit(sessionStarted(handle.runId));
    await flush();

    await expect(
      registry.respondToPermission(handle.runId, 'never-asked', { behavior: 'allow' }),
    ).rejects.toBeInstanceOf(RunError);
  });

  it('rejects a second answer to the same request', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    firstRun(runs).emit(permissionRequest(handle.runId, 0, 'perm-1'));
    await flush();

    await registry.respondToPermission(handle.runId, 'perm-1', { behavior: 'deny' });
    await expect(
      registry.respondToPermission(handle.runId, 'perm-1', { behavior: 'deny' }),
    ).rejects.toBeInstanceOf(RunError);
  });

  it('refuses permission answers for a provider without interactive permissions', async () => {
    const { registry } = harness({ capabilities: { ...NO_CAPABILITIES } });
    const handle = await registry.start(input());

    await expect(
      registry.respondToPermission(handle.runId, 'x', { behavior: 'allow' }),
    ).rejects.toBeInstanceOf(RunError);
  });
});

describe('RunRegistry — steering', () => {
  it('forwards send and reports immediate delivery from capabilities', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());

    expect(await registry.send(handle.runId, 'more please')).toEqual({
      runId: handle.runId,
      deliveredImmediately: true,
    });
    expect(firstRun(runs).sent).toEqual(['more please']);
  });

  it('reports queued delivery when the adapter says it only queued the text', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    firstRun(runs).sendResult = { deliveredImmediately: false };

    expect((await registry.send(handle.runId, 'later')).deliveredImmediately).toBe(false);
  });

  it('forwards interrupt and passes through still-queued ids', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    const run = firstRun(runs);
    run.interruptResult = { stillQueued: ['msg-1', 'msg-2'] };

    expect(await registry.interrupt(handle.runId)).toEqual({
      runId: handle.runId,
      stillQueued: ['msg-1', 'msg-2'],
    });
    expect(run.interruptCount).toBe(1);
  });

  it('reports an empty queue when the adapter returns nothing', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    firstRun(runs).interruptResult = undefined as unknown as InterruptResult;

    expect(await registry.interrupt(handle.runId)).toEqual({
      runId: handle.runId,
      stillQueued: [],
    });
  });

  it('treats interrupting a just-finished run as a no-op, but not an unknown one', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    firstRun(runs).emit(runEnd(handle.runId, 0));
    await flush();

    await expect(registry.interrupt(handle.runId)).resolves.toEqual({
      runId: handle.runId,
      stillQueued: [],
    });
    await expect(registry.interrupt('never-existed')).rejects.toBeInstanceOf(RunError);
  });

  it('rejects steering an unknown or finished run', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    firstRun(runs).emit(runEnd(handle.runId, 0));
    await flush();

    await expect(registry.send(handle.runId, 'hi')).rejects.toBeInstanceOf(RunError);
    await expect(registry.send('never-existed', 'hi')).rejects.toBeInstanceOf(RunError);
  });
});

describe('RunRegistry — termination', () => {
  it('disposes the adapter run exactly once when it ends on its own', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    const run = firstRun(runs);

    run.emit(sessionStarted(handle.runId), runEnd(handle.runId, 1));
    await flush();

    expect(run.disposeCount).toBe(1);
    expect(registry.activeCount).toBe(0);
    expect(registry.get(handle.runId)?.status).toBe('ended');
  });

  it('delivers nothing after run.end', async () => {
    const { registry, runs } = harness();
    const received: AgentEvent[] = [];
    registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    const run = firstRun(runs);
    run.emit(runEnd(handle.runId, 0));
    await flush();
    run.emit(textComplete(handle.runId, 1, 'too late'));
    await flush();

    expect(received.map((e) => e.type)).toEqual(['run.end']);
  });

  it('synthesises run.end when the stream just stops', async () => {
    const { registry, runs } = harness();
    const received: AgentEvent[] = [];
    registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    const run = firstRun(runs);
    run.emit(sessionStarted(handle.runId), textComplete(handle.runId, 1, 'done'));
    await flush();
    run.close();
    await flush();

    const last = received.at(-1) as RunEndEvent | undefined;
    expect(last?.type).toBe('run.end');
    expect(last?.reason).toBe('completed');
    expect(last?.seq).toBe(2);
    expect(last?.sessionId).toBe('session-abc');
    expect(registry.activeCount).toBe(0);
  });

  it('synthesises an error run.end when the stream throws', async () => {
    const { registry, runs, errors } = harness();
    const received: AgentEvent[] = [];
    registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    const run = firstRun(runs);
    run.emit(sessionStarted(handle.runId));
    await flush();
    run.fail(new Error('transport died'));
    await flush();

    const last = received.at(-1) as RunEndEvent | undefined;
    expect(last?.type).toBe('run.end');
    expect(last?.reason).toBe('error');
    expect(last?.error?.code).toBe('transport');
    expect(last?.error?.message).toContain('transport died');
    expect(errors.some((e) => e.phase === 'events')).toBe(true);
  });

  it('reports interrupted when an interrupted stream ends without run.end', async () => {
    const { registry, runs } = harness();
    const received: AgentEvent[] = [];
    registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    const run = firstRun(runs);
    await registry.interrupt(handle.runId);
    run.close();
    await flush();

    expect((received.at(-1) as RunEndEvent | undefined)?.reason).toBe('interrupted');
  });

  it('synthesises run.end on dispose and retires the id', async () => {
    const { registry, runs } = harness();
    const received: AgentEvent[] = [];
    registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    firstRun(runs).emit(sessionStarted(handle.runId));
    await flush();

    expect(await registry.dispose(handle.runId)).toEqual({ runId: handle.runId });

    const last = received.at(-1) as RunEndEvent | undefined;
    expect(last?.type).toBe('run.end');
    expect(last?.reason).toBe('disposed');
    expect(registry.activeCount).toBe(0);
    expect(firstRun(runs).disposeCount).toBe(1);
  });

  it('does not hang when the adapter ignores dispose', async () => {
    const { registry, runs } = harness({ disposeTimeoutMs: 20 });
    const received: AgentEvent[] = [];
    registry.subscribe((event) => received.push(event));

    const handle = await registry.start(input());
    const run = firstRun(runs);
    run.closeOnDispose = false; // a provider that never closes its stream

    await registry.dispose(handle.runId);

    expect((received.at(-1) as RunEndEvent | undefined)?.reason).toBe('disposed');
    expect(registry.activeCount).toBe(0);
  });

  it('is idempotent for unknown and already-disposed runs', async () => {
    const { registry } = harness();
    const handle = await registry.start(input());

    await registry.dispose(handle.runId);
    await expect(registry.dispose(handle.runId)).resolves.toEqual({ runId: handle.runId });
    await expect(registry.dispose('never-existed')).resolves.toEqual({ runId: 'never-existed' });
  });

  it('disposes everything on shutdown and refuses new runs afterwards', async () => {
    const { registry, runs } = harness();
    await registry.start(input({ runId: 'a' }));
    await registry.start(input({ runId: 'b' }));

    await registry.disposeAll();

    expect(registry.activeCount).toBe(0);
    expect(runs.every((run) => run.disposeCount === 1)).toBe(true);
    await expect(registry.start(input())).rejects.toBeInstanceOf(RunError);
  });

  it('survives an adapter whose dispose rejects', async () => {
    const { registry, runs, errors } = harness();
    const handle = await registry.start(input());
    const run = firstRun(runs);
    vi.spyOn(run, 'dispose').mockImplementation(() => {
      run.close();
      return Promise.reject(new Error('close failed'));
    });

    await expect(registry.dispose(handle.runId)).resolves.toBeDefined();
    expect(errors.some((e) => e.phase === 'dispose')).toBe(true);
    expect(registry.activeCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Releasing versus disposing                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the registry does to a run that ends by itself.
 *
 * It used to dispose it, which was right while a run *was* its transport. It is
 * wrong now that a run can be one turn of a process that is deliberately still
 * holding something — a backgrounded subagent, an async workflow, a registered
 * schedule — because disposing the turn takes that process down and kills the
 * work at the turn boundary, which is the defect the retention rule exists to
 * fix. So the ordinary end of a run releases it, and only an explicit teardown
 * disposes.
 *
 * `disposeCount` is the assertion in most of these for the same reason the
 * adapter's own tests assert on `close()`: it is the act that killed the work.
 */
describe('RunRegistry — releasing a turn', () => {
  it('releases a run that ends on its own rather than tearing it down', async () => {
    const { registry, runs } = harness({ releasable: true });
    const handle = await registry.start(input());
    const run = firstRun(runs) as FakeTurn;

    run.emit(sessionStarted(handle.runId), runEnd(handle.runId, 1));
    await flush();

    expect(run.releaseCount).toBe(1);
    expect(run.disposeCount).toBe(0);
    expect(registry.activeCount).toBe(0);
    expect(registry.get(handle.runId)?.status).toBe('ended');
  });

  it('disposes instead when the adapter has no release', async () => {
    const { registry, runs } = harness();
    const handle = await registry.start(input());
    const run = firstRun(runs);

    run.emit(runEnd(handle.runId, 0));
    await flush();

    expect(run.disposeCount).toBe(1);
  });

  it('still disposes when a teardown was asked for', async () => {
    const { registry, runs } = harness({ releasable: true });
    const handle = await registry.start(input());
    const run = firstRun(runs) as FakeTurn;

    await registry.dispose(handle.runId);

    expect(run.disposeCount).toBe(1);
    expect(run.releaseCount).toBe(0);
  });

  it('leaves the provider alone when a turn is interrupted', async () => {
    const { registry, runs } = harness({ releasable: true });
    const handle = await registry.start(input());
    const run = firstRun(runs) as FakeTurn;

    // Stop means "stop this turn". Work the user never asked to end — the
    // subagent still running, the schedule still registered — is not this
    // button's business, and disposing here would take all of it with the turn.
    await registry.interrupt(handle.runId);
    run.close();
    await flush();

    expect(run.disposeCount).toBe(0);
    expect(run.releaseCount).toBe(1);
  });

  it('disposes a released run on shutdown, since nothing else can reach it', async () => {
    const { registry, runs } = harness({ releasable: true });
    const handle = await registry.start(input());
    const run = firstRun(runs) as FakeTurn;

    run.emit(runEnd(handle.runId, 0));
    await flush();
    expect(run.disposeCount).toBe(0);

    // The run is finished, so `dispose(runId)` is a no-op by design — the
    // retained tail is the only remaining handle on a process that may still be
    // alive, and quitting has to be able to end it.
    await registry.dispose(handle.runId);
    expect(run.disposeCount).toBe(0);

    await registry.disposeAll();
    expect(run.disposeCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The history seam                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `RunHandle.historyOffset` — how much of the session predates this run.
 *
 * It exists for one caller: a window that reloads mid-run re-attaches to the
 * run and has to draw the conversation from two places at once — the session
 * file for the earlier turns, the registry's buffer for the turn in flight.
 * The file is being appended to while that happens, so without a recorded
 * boundary the current turn appears in both and is rendered twice.
 *
 * The boundary is only true for an instant, which is what these assertions are
 * really about: it has to be taken before the provider is spawned, because one
 * line later the user's message is in the file and the count is wrong by a
 * message that nothing downstream can identify or subtract.
 */
describe('history offset', () => {
  it('is zero for a run that opens its own session, and costs no read', async () => {
    const count = vi.fn(() => Promise.resolve(9));
    const h = harness({ countSessionMessages: count });

    const handle = await h.registry.start(input());

    expect(handle.historyOffset).toBe(0);
    expect(count).not.toHaveBeenCalled();
  });

  it('counts the resumed session before the provider is started', async () => {
    const h = harness({ countSessionMessages: () => Promise.resolve(12) });

    const handle = await h.registry.start(input({ resumeSessionId: 'session-abc' }));

    expect(handle.historyOffset).toBe(12);
    // Order, not just occurrence: after `createRun` the provider has written
    // the new prompt into the session and the count is a message too high.
    expect(h.calls).toEqual(['countSessionMessages', 'createRun']);
  });

  it('counts the session being forked, which is the file the fork starts from', async () => {
    const seen: string[] = [];
    const h = harness({
      countSessionMessages: ({ sessionId }) => {
        seen.push(sessionId);
        return Promise.resolve(4);
      },
    });

    const handle = await h.registry.start(
      input({ resumeSessionId: 'session-abc', forkSession: true }),
    );

    expect(seen).toEqual(['session-abc']);
    expect(handle.historyOffset).toBe(4);
  });

  it('leaves the offset unknown when the provider cannot count, rather than guessing zero', async () => {
    // No `countSessionMessages` on the adapter at all.
    const h = harness();

    const handle = await h.registry.start(input({ resumeSessionId: 'session-abc' }));

    // Undefined, not 0: a zero would tell a reloading window that the whole
    // file belongs to this run, and it would replay the conversation twice.
    expect(handle.historyOffset).toBeUndefined();
  });

  it('starts the run anyway when the count fails, and reports it', async () => {
    const h = harness({
      countSessionMessages: () => Promise.reject(new Error('transcript unreadable')),
    });

    const handle = await h.registry.start(input({ resumeSessionId: 'session-abc' }));

    expect(handle.runId).toBe('run-1');
    expect(handle.historyOffset).toBeUndefined();
    expect(h.errors.map((e) => e.phase)).toEqual(['start']);
  });

  it('survives the handle being rebuilt as the run progresses', async () => {
    const h = harness({ countSessionMessages: () => Promise.resolve(7) });

    const handle = await h.registry.start(input({ resumeSessionId: 'session-abc' }));
    h.runs[0]?.emit(sessionStarted(handle.runId));
    await flush();

    // `session.started` replaces the handle. The offset is a fact about how the
    // run began and must not be dropped on the way through.
    expect(h.registry.get(handle.runId)?.historyOffset).toBe(7);
  });
});
