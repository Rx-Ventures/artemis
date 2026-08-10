/**
 * A fake `LibraBridge`, for developing the renderer without a main process.
 *
 * This exists so the UI can be exercised — streaming, permissions, capability
 * degradation, errors — before the Electron layers are wired up, and so a
 * contributor can run the renderer alone. It is installed **only** when
 * `import.meta.env.DEV` is set and `window.libra` is absent, and when it is
 * active the status bar says so in as many words. It never masquerades as a
 * real bridge and it is dead code in a packaged build.
 *
 * It also honours the secret boundary: an API key handed to `profiles.create`
 * is turned into a masked hint and dropped on the floor. Nothing here can hand
 * a key back, so the UI cannot accidentally be written against a bridge that
 * would.
 */

import { maskApiKey } from '@libra/protocol';
import type {
  AgentEvent,
  AuthStatusInfo,
  Capabilities,
  IpcResult,
  LibraBridge,
  PermissionDecision,
  PermissionRequest,
  PlanUsage,
  ProfileMetadata,
  ProviderDescriptor,
  RunEndReason,
  RunHandle,
  RunsStartRequest,
  SessionSummary,
  Unsubscribe,
} from '@libra/protocol';
import { newId } from './id';

const ok = <T,>(value: T): IpcResult<T> => ({ ok: true, value });

/** An event minus the envelope fields the transport stamps on. */
type EventDraft = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'runId' | 'seq' | 'ts'>
    : never
  : never;

const CLAUDE_CAPS: Capabilities = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

/** A deliberately weaker provider, so capability gating is visible in dev. */
const CODEX_CAPS: Capabilities = {
  interactivePermissions: false,
  partialMessages: false,
  midRunSteering: false,
  forkSession: false,
  listSessions: false,
  subagents: false,
  permissionModes: ['default', 'bypassPermissions'],
  resumeSession: true,
  usageReporting: true,
  costReporting: false,
  planUsageReporting: false,
};

interface MockRun {
  readonly runId: string;
  cancelled: boolean;
  seq: number;
  readonly permissions: Map<string, (decision: PermissionDecision) => void>;
  readonly queue: string[];
}

const FINAL_USAGE = {
  scope: 'final',
  tokens: { inputTokens: 1840, outputTokens: 612, cacheReadInputTokens: 12_400 },
  costUsd: 0.0231,
  contextTokens: 18_930,
  contextWindow: 200_000,
} as const;

let mockAuth: AuthStatusInfo = { loggedIn: false, authMethod: 'none' };

export function createMockBridge(): LibraBridge {
  const listeners = new Set<(event: AgentEvent) => void>();
  const runs = new Map<string, MockRun>();
  const handles = new Map<string, RunHandle>();

  let profiles: ProfileMetadata[] = [
    {
      id: 'demo-anthropic',
      label: 'Demo — Anthropic',
      providerId: 'claude',
      authMode: 'api-key',
      keyHint: maskApiKey('sk-ant-api03-demo-key-000000000000000000004f2a'),
    },
    {
      id: 'demo-subscription',
      label: 'Demo — subscription',
      providerId: 'claude',
      backend: 'anthropic',
      // The second billing arrangement, seeded so the badge, the picker and
      // the "switching modes changes what is billed" warning are all reachable
      // in dev without a real credential.
      authMode: 'subscription',
      keyHint: maskApiKey('sk-ant-oat01-demo-token-00000000000000009c71'),
    },
    {
      id: 'demo-bedrock',
      label: 'Demo — Bedrock',
      providerId: 'claude',
      backend: 'bedrock',
      keyHint: null,
    },
  ];

  function emit(run: MockRun, draft: EventDraft): void {
    const event: AgentEvent = { ...draft, runId: run.runId, seq: run.seq++, ts: Date.now() };
    for (const listener of listeners) listener(event);
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function typeOut(
    run: MockRun,
    messageId: string,
    blockIndex: number,
    text: string,
  ): Promise<void> {
    for (const chunk of text.match(/\S+\s*/g) ?? [text]) {
      if (run.cancelled) return;
      emit(run, { type: 'text.delta', messageId, blockIndex, text: chunk });
      await sleep(16);
    }
    emit(run, { type: 'text.complete', messageId, role: 'assistant', blockIndex, text });
  }

  function askPermission(run: MockRun, request: PermissionRequest): Promise<PermissionDecision> {
    emit(run, { type: 'permission.request', requestId: request.id, request });
    return new Promise<PermissionDecision>((resolve) => run.permissions.set(request.id, resolve));
  }

  function finish(run: MockRun, reason: RunEndReason): void {
    if (!runs.has(run.runId)) return;
    runs.delete(run.runId);
    emit(run, { type: 'usage', usage: FINAL_USAGE });
    emit(run, {
      type: 'run.end',
      reason,
      durationMs: Date.now() - (handles.get(run.runId)?.startedAt ?? Date.now()),
      numTurns: 2,
      usage: FINAL_USAGE,
      ...(reason === 'error'
        ? { error: { code: 'provider_unavailable' as const, message: 'Mock provider fell over.' } }
        : {}),
    });
  }

  async function script(run: MockRun, request: RunsStartRequest): Promise<void> {
    const { cwd, prompt, providerId, permissionMode, model, effort } = request.input;
    await sleep(120);
    emit(run, {
      type: 'session.started',
      sessionId: newId('sess'),
      providerId,
      cwd,
      // Echo what was asked for, so the status line's "this run reports" line
      // and the run inspector show something that tracks the pickers rather
      // than a constant that would hide a broken wiring.
      model: model === undefined ? 'mock-default' : `mock-${model}${effort ? `-${effort}` : ''}`,
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      slashCommands: ['/clear', '/compact'],
      permissionMode: permissionMode ?? 'default',
      providerVersion: '0.0.0-mock',
    });

    const first = newId('msg');
    emit(run, {
      type: 'thinking.delta',
      messageId: first,
      blockIndex: 0,
      text: `The user asked: "${prompt.slice(0, 72)}". Read the layout first, then run the suite.`,
    });
    await sleep(180);
    if (run.cancelled) return finish(run, 'interrupted');

    await typeOut(run, first, 1, 'Reading the workspace layout before changing anything.');

    const readCall = newId('call');
    emit(run, {
      type: 'tool.start',
      toolCallId: readCall,
      name: 'Read',
      input: { file_path: `${cwd}/package.json` },
      title: 'Read package.json',
    });
    await sleep(420);
    emit(run, {
      type: 'tool.end',
      toolCallId: readCall,
      name: 'Read',
      status: 'ok',
      resultText: '{\n  "name": "libra",\n  "private": true\n}',
      durationMs: 420,
    });

    // A real file edit, so the transcript's inline diff — gutters, line
    // numbers, intra-line spans — is reachable in dev without a live provider.
    const editCall = newId('call');
    emit(run, {
      type: 'tool.start',
      toolCallId: editCall,
      name: 'Edit',
      input: {
        file_path: `${cwd}/src/adapters/claude.ts`,
        old_string:
          'export function createClaudeAdapter(options?: ClaudeAdapterOptions): ProviderAdapter {\n  const now = options?.now ?? Date.now;\n  const hostEnv = options?.hostEnv;\n\n  return {\n    id: CLAUDE_PROVIDER_ID,\n    label: "Claude",\n    capabilities: CLAUDE_CAPABILITIES,\n  };\n}',
        new_string:
          'export function createClaudeAdapter(options?: ClaudeAdapterOptions): ProviderAdapter {\n  const now = options?.now ?? Date.now;\n  const hostEnv = options?.hostEnv;\n  const diagnostic = options?.onDiagnostic;\n\n  return {\n    id: CLAUDE_PROVIDER_ID,\n    label: "Claude",\n    capabilities: CLAUDE_CAPABILITIES,\n    models: CLAUDE_MODELS,\n    effortLevels: CLAUDE_EFFORT_LEVELS,\n  };\n}',
      },
      title: 'Edit src/adapters/claude.ts',
    });
    await sleep(320);
    emit(run, {
      type: 'tool.end',
      toolCallId: editCall,
      name: 'Edit',
      status: 'ok',
      resultText: 'Applied 3 additions and 0 removals.',
      durationMs: 320,
    });

    const bashCall = newId('call');
    const decision = await askPermission(run, {
      id: newId('perm'),
      runId: run.runId,
      toolName: 'Bash',
      input: { command: 'pnpm -r test', description: 'Run the workspace test suite' },
      toolCallId: bashCall,
      title: 'Libra wants to run a shell command',
      displayName: 'Run command',
      description: 'Executes `pnpm -r test` in the working directory.',
      reason: 'Bash is not on the allow-list for this project.',
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
          scope: 'session',
        },
      ],
      requestedAt: Date.now(),
    });
    if (run.cancelled) return finish(run, 'interrupted');

    if (decision.behavior === 'deny') {
      emit(run, { type: 'tool.end', toolCallId: bashCall, name: 'Bash', status: 'denied' });
      await typeOut(run, newId('msg'), 0, 'Understood — leaving the test suite alone.');
      return finish(run, decision.interrupt === true ? 'permission_denied' : 'completed');
    }

    emit(run, {
      type: 'tool.start',
      toolCallId: bashCall,
      name: 'Bash',
      input: { command: 'pnpm -r test' },
      title: 'pnpm -r test',
    });
    await sleep(700);
    emit(run, {
      type: 'tool.end',
      toolCallId: bashCall,
      name: 'Bash',
      status: 'error',
      resultText: 'FAIL  packages/core/src/adapters/claude.test.ts\n  ✗ emits tool.end on interrupt',
      error: { code: 'unknown', message: 'Command exited with status 1' },
      durationMs: 700,
    });

    await typeOut(
      run,
      newId('msg'),
      0,
      'One test fails: `tool.end` is not emitted when a run is interrupted mid-call. That is the invariant the transcript relies on to clear its spinners, so it is worth fixing first.',
    );

    while (run.queue.length > 0 && !run.cancelled) {
      const next = run.queue.shift() ?? '';
      await typeOut(run, newId('msg'), 0, `Noted mid-run: "${next}". Folding it into this turn.`);
    }

    finish(run, run.cancelled ? 'interrupted' : 'completed');
  }

  /**
   * Seed history, spread across several projects and two profiles.
   *
   * Shaped for the sidebar rather than for a flat list: multiple directories so
   * grouping and group ordering are visible, two profiles inside one directory
   * so the per-row profile marker has something to distinguish, and enough rows
   * that the filter field appears and the virtualiser actually windows.
   */
  const minutes = (n: number): number => Date.now() - n * 60_000;

  const PROJECTS: readonly (readonly [string, number])[] = [
    ['/Users/dev/code/libra', 22],
    ['/Users/dev/code/api-gateway', 9],
    ['/Users/dev/scratch/spike-rope', 3],
    ['/Users/dev/work/very/deeply/nested/monorepo/packages/renderer', 4],
  ];

  const TITLES: readonly string[] = [
    'Wire the adapter seam',
    'Profile store encryption',
    'Triage the flaky permission test',
    'Rename the capability keys',
    'Streaming perf: stop re-rendering the list',
    'Sidebar grouping by project',
    'Fix the resume-into-wrong-cwd bug',
    'Audit the IPC validators',
  ];

  const seedSessions: readonly SessionSummary[] = PROJECTS.flatMap(([cwd, count], project) =>
    Array.from({ length: count }, (_, index): SessionSummary => {
      const age = minutes(project * 90 + index * index * 37 + index * 11 + 4);
      return {
        id: `a1c9f0e2-${String(project)}${String(index).padStart(3, '0')}-4a2b-9c33-00000000000${project}`,
        providerId: 'claude',
        // Alternate profiles inside a project, which is the case the row-level
        // marker exists for.
        profileId: index % 3 === 0 ? 'demo-subscription' : 'demo-anthropic',
        cwd,
        title: `${TITLES[index % TITLES.length] ?? 'Session'}${index > TITLES.length ? ` (${index})` : ''}`,
        ...(index % 2 === 0
          ? { firstPrompt: 'Take a look at the failing case and explain what you find.' }
          : {}),
        updatedAt: age,
        messageCount: 4 + ((index * 7) % 40),
        ...(index % 4 === 0 ? { gitBranch: index % 8 === 0 ? 'main' : `fix-${index}` } : {}),
      };
    }),
  );

  const providers: readonly ProviderDescriptor[] = [
    {
      id: 'claude',
      label: 'Claude',
      capabilities: CLAUDE_CAPS,
      backends: [
        {
          id: 'anthropic',
          label: 'Anthropic API',
          note: 'Anthropic’s first-party API. A credential is required.',
          requiresApiKey: true,
        },
        {
          id: 'bedrock',
          label: 'AWS Bedrock',
          note: 'Uses the ambient AWS credential chain.',
          requiresApiKey: false,
        },
      ],
      // Mirrors the shape the real adapter publishes, including the constraint
      // that makes the picker interesting: subscription billing exists only on
      // the first-party API, so selecting Bedrock must disable it.
      authModes: [
        {
          id: 'api-key',
          label: 'API key',
          note: 'Metered API usage, billed to the key’s account.',
          requiresSecret: true,
          secretHowTo: 'Create a key in the provider’s console. It starts with sk-ant-.',
        },
        {
          id: 'subscription',
          label: 'Claude subscription',
          note: 'Billed against a Claude Pro, Max, Team or Enterprise plan instead of API credit.',
          requiresSecret: true,
          backends: ['anthropic'],
          secretHowTo:
            'Run `claude setup-token` in Anthropic’s own CLI. It opens a browser, then prints a token — paste that here. Libra never performs the login itself.',
        },
      ],
      // Same pattern again for the status line's model and thinking pickers:
      // both lists come off the descriptor, so a provider that offers neither
      // renders them disabled-with-a-reason rather than showing this one's.
      models: [
        { id: 'default', label: 'Default', note: 'Whatever the mock provider feels like.' },
        { id: 'opus', label: 'Opus', note: 'The most capable model. Slowest, most expensive.' },
        { id: 'sonnet', label: 'Sonnet', note: 'Balanced: strong on code, much cheaper.' },
        { id: 'haiku', label: 'Haiku', note: 'Fastest and cheapest.' },
      ],
      effortLevels: [
        { id: 'low', label: 'Low', note: 'Minimal thinking. Fastest, least reliable.' },
        { id: 'medium', label: 'Medium', note: 'Moderate thinking for routine work.' },
        { id: 'high', label: 'High', note: 'Deep reasoning. The default.' },
      ],
      available: true,
    },
    {
      id: 'codex',
      label: 'Codex',
      capabilities: CODEX_CAPS,
      // Unregistered, so no backends, auth modes, models or effort levels —
      // every picker in the app renders its own "this provider offers none"
      // state, which is the case worth being able to see in dev.
      backends: [],
      authModes: [],
      models: [],
      effortLevels: [],
      available: false,
      unavailableReason: 'No adapter registered in this build.',
    },
  ];

  return {
    version: '0.1.0-mock',
    platform: 'darwin',

    profiles: {
      list: async () => ok({ profiles }),
      create: async ({ draft }) => {
        const profile: ProfileMetadata = {
          id: newId('prof'),
          label: draft.label,
          providerId: draft.providerId,
          ...(draft.backend ? { backend: draft.backend } : {}),
          ...(draft.authMode ? { authMode: draft.authMode } : {}),
          keyHint: maskApiKey(draft.apiKey ?? null),
        };
        profiles = [...profiles, profile];
        return ok({ profile });
      },
      update: async ({ id, patch }) => {
        const existing = profiles.find((p) => p.id === id);
        if (!existing) {
          return { ok: false, error: { code: 'invalid_request', message: `No profile ${id}` } };
        }
        const updated: ProfileMetadata = {
          ...existing,
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.backend === undefined ? {} : { backend: patch.backend }),
          ...(patch.authMode === undefined ? {} : { authMode: patch.authMode }),
          ...(patch.apiKey === undefined ? {} : { keyHint: maskApiKey(patch.apiKey) }),
        };
        profiles = profiles.map((p) => (p.id === id ? updated : p));
        return ok({ profile: updated });
      },
      remove: async ({ id }) => {
        profiles = profiles.filter((p) => p.id !== id);
        return ok({ id, configDirDeleted: false });
      },
    },

    providers: { list: async () => ok({ providers }) },

    runs: {
      start: async (request) => {
        const runId = request.input.runId ?? newId('run');
        const run: MockRun = {
          runId,
          cancelled: false,
          seq: 0,
          permissions: new Map(),
          queue: [],
        };
        runs.set(runId, run);
        const handle: RunHandle = {
          runId,
          providerId: request.input.providerId,
          profileId: request.input.profileId,
          cwd: request.input.cwd,
          status: 'starting',
          capabilities: request.input.providerId === 'claude' ? CLAUDE_CAPS : CODEX_CAPS,
          startedAt: Date.now(),
        };
        handles.set(runId, handle);
        void script(run, request).catch(() => finish(run, 'error'));
        return ok({ run: handle });
      },
      send: async ({ runId, text }) => {
        const run = runs.get(runId);
        run?.queue.push(text);
        return ok({ runId, deliveredImmediately: run !== undefined });
      },
      interrupt: async ({ runId }) => {
        const run = runs.get(runId);
        if (run) {
          run.cancelled = true;
          for (const resolve of run.permissions.values()) {
            resolve({ behavior: 'deny', message: 'Run interrupted.' });
          }
          run.permissions.clear();
          setTimeout(() => finish(run, 'interrupted'), 60);
        }
        return ok({ runId, stillQueued: [] });
      },
      respondToPermission: async ({ runId, requestId, decision }) => {
        const run = runs.get(runId);
        run?.permissions.get(requestId)?.(decision);
        run?.permissions.delete(requestId);
        return ok({ requestId });
      },
      dispose: async ({ runId }) => {
        const run = runs.get(runId);
        if (run) run.cancelled = true;
        runs.delete(runId);
        handles.delete(runId);
        return ok({ runId });
      },
      list: async () => ok({ runs: [...handles.values()] }),
      onEvent: (listener): Unsubscribe => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },

    sessions: {
      /*
        A short replayed transcript, so selecting a session in dev shows
        history rather than an empty pane — the exact bug this feature fixes.
      */
      messages: async ({ runId }) =>
        ok({
          events: [
            { runId, seq: 0, ts: Date.now(), type: 'text.complete', messageId: 'h1', role: 'user', text: 'Where is auth handled?', replay: true },
            { runId, seq: 1, ts: Date.now(), type: 'tool.start', toolCallId: 'h_t1', name: 'Grep', input: { pattern: 'authenticate' } },
            { runId, seq: 2, ts: Date.now(), type: 'tool.end', toolCallId: 'h_t1', status: 'ok', result: 'src/auth/session.ts:42' },
            { runId, seq: 3, ts: Date.now(), type: 'text.complete', messageId: 'h2', role: 'assistant', text: 'Auth lives in `src/auth/session.ts`.', replay: true },
          ] as AgentEvent[],
          hasMore: false,
        }),

      /* One profile, one project — the narrow query the palette's fallback uses. */
      list: async ({ cwd, profileId }) =>
        ok({
          sessions: seedSessions
            .filter((s) => s.profileId === profileId)
            .map((s) => ({ ...s, cwd })),
          hasMore: false,
        }),
      /*
       * The sidebar's query: everything, newest first, already carrying `cwd`
       * and `profileId` on every entry. Sorted here rather than in the renderer
       * because the real handler sorts after merging profiles, and a mock that
       * returned them unsorted would let a missing sort in the UI go unnoticed
       * in dev.
       */
      listAll: async ({ limit }) => {
        const ordered = [...seedSessions].sort((a, b) => b.updatedAt - a.updatedAt);
        const page = limit === undefined ? ordered : ordered.slice(0, limit);
        return ok({ sessions: page, hasMore: page.length < ordered.length });
      },
    },

    workspace: {
      /*
       * No dialog to open without a main process, so the mock answers with a
       * seeded project — enough to exercise the "chosen" path. Cancellation and
       * failure are reachable in the real app; faking them here on a timer
       * would make the dev bridge unpredictable.
       */
      pickDirectory: async () => ok({ path: '/Users/dev/code/api-gateway' }),
    },

    /*
     * Plan usage, faked with the stale-while-revalidate shape the real bridge
     * has: `cached` answers instantly with a slightly stale reading, `refresh`
     * takes a beat and comes back with fresher numbers. That delay is the
     * point — it is what makes the loading state reachable in dev, and the
     * whole reason the two calls are separate channels.
     */
    /**
     * Auth starts *signed out*, because that is the state the profile screen
     * has to handle well and the one a mock that always returns "signed in"
     * would hide. `signIn` flips it after a beat, standing in for the browser
     * round trip.
     */
    auth: {
      status: async () => ok({ status: mockAuth }),
      signIn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        mockAuth = {
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'demo@example.com',
          subscriptionType: 'max',
        };
        return ok({ status: mockAuth });
      },
      signOut: async () => {
        mockAuth = { loggedIn: false, authMethod: 'none' };
        return ok({ status: mockAuth });
      },
    },

    usagePlan: {
      cached: async () => ok({ usage: mockPlanUsage(Date.now() - 4 * 60_000, 0) }),
      refresh: async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return ok({ usage: mockPlanUsage(Date.now(), 3) });
      },
    },
  };
}

/**
 * A plausible plan reading.
 *
 * The five-hour window is deliberately the busiest: it is the one that
 * actually stops you first on a Max plan, so it is the case the UI most needs
 * to render convincingly.
 */
function mockPlanUsage(fetchedAt: number, drift: number): PlanUsage {
  const hour = 60 * 60 * 1000;
  return {
    available: true,
    subscriptionType: 'max',
    fetchedAt,
    windows: [
      {
        id: 'five_hour',
        label: '5 hours',
        utilization: 61 + drift,
        resetsAt: fetchedAt + 2 * hour,
      },
      { id: 'seven_day', label: '7 days', utilization: 23 + drift, resetsAt: fetchedAt + 71 * hour },
      {
        id: 'seven_day_opus',
        label: '7 days · Opus',
        utilization: 44 + drift,
        resetsAt: fetchedAt + 71 * hour,
      },
    ],
  };
}
