/**
 * The local-server adapter.
 * ============================================================================
 *
 * One implementation, three providers. LM Studio, Ollama and llama.cpp's
 * `llama-server` are separate rows in the picker because a user chooses between
 * them and should see which one a profile is pointed at — but they speak the
 * same wire format, so they are the same adapter with a different flavour.
 *
 * ## What is different about this provider
 *
 * The other three wrap something that owns the agent loop. This one wraps an
 * inference server, which does not — so the loop is ours, and lives in
 * `loop.ts`. What this file adds around it is everything that loop needs from
 * the outside world: a streamed completion, an approval that parks the turn,
 * and a shell that the operating system confines.
 *
 * Because Artemis executes the tools rather than a vendor's process, the
 * defences are its own too, and they are not one thing. `sandbox.ts` confines
 * paths for the tools Artemis performs itself; `seatbelt.ts` confines the shell,
 * which no path check can reach. A command that cannot be confined is refused
 * rather than run, because a silent downgrade from sandboxed to not is exactly
 * the failure a boundary must not have.
 *
 * ## No credential, an endpoint instead
 *
 * The first provider with nothing to sign in to. A profile here is defined by a
 * URL, so `credentialEnvKeys` is empty — not because credentials are handled
 * elsewhere, but because there are none. What would be a sign-in flow for a
 * hosted provider is, here, a server either answering or not.
 */

import type {
  AgentError,
  AgentEvent,
  Capabilities,
  MessageId,
  PermissionDecision,
  PermissionRequestId,
  ProviderId,
  RunId,
  RunStatus,
  SessionId,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AsyncQueue, createDeferred } from '../stream.js';
import type { Deferred } from '../stream.js';

const execFileAsync = promisify(execFile);
import { AdapterError, adapterError } from '../types.js';
import type {
  InterruptResult,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
} from '../types.js';
import { parseLlamaServerModels, parseOllamaTags } from './catalogues.js';
import { parseNativeCatalogue, parseOpenAiCatalogue } from '../lmstudio/catalogue.js';
import { readEventLine, splitEvents, ToolCallAccumulator } from './stream.js';
import { runAgentLoop } from './loop.js';
import type { ChatMessage, CompletionResult } from './loop.js';
import { toolsForRisk, toWireTools } from './tools.js';
import type { ToolSpec } from './tools.js';
import { describeConfinement, resolveSandbox, wrapCommand } from './commandSandbox.js';
import type { ResolvedSandbox } from './commandSandbox.js';
import { sandboxEnv } from './sandbox.js';
import type { StreamUsage, ToolCall } from './stream.js';

/**
 * What one local server does differently: its name, its default port, and how
 * it answers when asked for models.
 */
export interface LocalFlavour {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultBaseUrl: string;
  /** Path appended to the base URL, and the parser for what comes back. */
  readonly cataloguePath: string;
  readonly parseCatalogue: (body: unknown) => readonly import('@rx-artemis/protocol').ProviderModelOption[];
  /** A second discovery attempt, for a server whose richer endpoint may be absent. */
  readonly fallback?: { readonly path: string; readonly parse: (body: unknown) => readonly import('@rx-artemis/protocol').ProviderModelOption[] };
}

export const LM_STUDIO: LocalFlavour = {
  id: 'lmstudio',
  label: 'LM Studio',
  defaultBaseUrl: 'http://127.0.0.1:1234',
  // Verified live: the native endpoint reports type and state, and the OpenAI
  // one under-reports. See `lmstudio/catalogue.ts`.
  cataloguePath: '/api/v0/models',
  parseCatalogue: parseNativeCatalogue,
  fallback: { path: '/v1/models', parse: parseOpenAiCatalogue },
};

export const OLLAMA: LocalFlavour = {
  id: 'ollama',
  label: 'Ollama',
  defaultBaseUrl: 'http://127.0.0.1:11434',
  cataloguePath: '/api/tags',
  parseCatalogue: parseOllamaTags,
  fallback: { path: '/v1/models', parse: parseOpenAiCatalogue },
};

export const LLAMA_CPP: LocalFlavour = {
  id: 'llamacpp',
  label: 'llama.cpp',
  defaultBaseUrl: 'http://127.0.0.1:8080',
  cataloguePath: '/v1/models',
  parseCatalogue: parseLlamaServerModels,
};

/**
 * Where a profile's endpoint is read from.
 *
 * Carried on the profile's `publicEnv` rather than a dedicated field, which is
 * the honest short-term answer: a URL is exactly what `publicEnv` is for, and it
 * survives the credential-routing filter because it names no vendor. A profile
 * whose identity *is* an endpoint arguably deserves its own field on `Profile`;
 * that is a protocol change and this is not, so it waits until the shape has
 * been used enough to know what it should look like.
 */
export const BASE_URL_ENV = 'ARTEMIS_LOCAL_BASE_URL';

/**
 * Phase 1 capabilities.
 *
 * Read the `false` rows as *not yet* rather than *cannot*. Every one of them is
 * within reach precisely because nothing upstream imposes it — which is the
 * trade this provider makes: more work than wrapping a runtime, and no ceiling
 * set by somebody else's protocol.
 */
export const LOCAL_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  // The servers stream, and the parser handles both spellings of reasoning.
  partialMessages: true,
  // Every OpenAI-compatible response carries token counts.
  usageReporting: true,
  // Local inference has no price to report. Not a gap — there is no number.
  costReporting: false,
  // No plan, no limits, nothing to be near the end of.
  planUsageReporting: false,
  // We build the message array ourselves, so a system prompt is just its first
  // element. The cheapest `true` in the file.
  systemPromptAppend: true,
  // We own the loop, so we can park it — and must. Every tool call is offered
  // to the user before it runs, under the modes below.
  interactivePermissions: true,
  // Phase 3. The server stores no conversation, so sessions would mean Artemis
  // persisting transcripts itself.
  listSessions: false,
  resumeSession: false,
  rewind: false,
  forkSession: false,
  /**
   * Enforced by our own loop rather than by a provider, which is why the list
   * is short: each of these has to mean something here, and inventing a rung
   * the loop does not honour would be worse than omitting it.
   *
   * `plan` withholds the tools that change anything, so the model can look and
   * propose without being able to act. `bypassPermissions` stops asking but
   * does *not* widen the sandbox — the OS boundary is a separate axis, and
   * conflating them is the mistake Codex's two flags exist to avoid.
   */
  permissionModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
};

/** No account to sign in to. See the module header. */
function localCredentials(): ProviderCredentialSpec {
  return {
    // Nothing is spawned, so nothing reads this — but the field is required and
    // an inert, clearly-named variable is more honest than borrowing a vendor's.
    configDirVar: 'ARTEMIS_LOCAL_PROFILE_DIR',
    credentialEnvKeys: [],
    signIn: {
      executable: 'true',
      loginArgs: [],
      statusArgs: [],
      logoutArgs: [],
      howTo:
        'Nothing to sign in to. Start the server on your own machine and point this profile at its address.',
      // A local server is signed in exactly when it answers, which the
      // availability probe already establishes.
      parseStatus: () => ({ loggedIn: true }),
    },
  };
}

/** The endpoint this run should talk to. */
function baseUrl(flavour: LocalFlavour, env: Readonly<Record<string, string | undefined>>): string {
  const declared = env[BASE_URL_ENV];
  const chosen = declared !== undefined && declared.trim() !== '' ? declared.trim() : flavour.defaultBaseUrl;
  return chosen.replace(/\/+$/, '');
}

/** Token counts in the shape the seam expects. */
function toUsage(usage: StreamUsage): UsageSnapshot {
  return {
    scope: 'final',
    tokens: {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    },
  };
}

/**
 * One turn against a local server.
 *
 * Streams until the server says it is done, then ends. `send` is refused rather
 * than queued: without `midRunSteering` the composer is already disabled, and a
 * silently queued message that arrives a turn later is worse than a refusal.
 */
class LocalRun implements Run {
  readonly runId: RunId;
  readonly providerId: ProviderId;
  readonly capabilities = LOCAL_CAPABILITIES;

  #status: RunStatus = 'running';
  #seq = 0;
  #messageSeq = 0;
  #permissionSeq = 0;
  #usage: UsageSnapshot | undefined;
  /** Approvals the loop is parked on, keyed by the id the renderer answers. */
  readonly #pending = new Map<PermissionRequestId, Deferred<'allow' | 'deny'>>();
  /** What this machine can enforce. Resolved once; see `#sandbox`. */
  #resolvedSandbox: ResolvedSandbox | undefined;
  /** The run's own writable scratch, made on first use and removed at the end. */
  #scratch: string | undefined;
  readonly #queue = new AsyncQueue<AgentEvent>();
  readonly #abort = new AbortController();
  readonly #input: ResolvedRunInput;
  readonly #flavour: LocalFlavour;

  constructor(input: ResolvedRunInput, flavour: LocalFlavour) {
    this.runId = input.runId;
    this.providerId = flavour.id;
    this.#input = input;
    this.#flavour = flavour;
    void this.#drive();
  }

  get status(): RunStatus {
    return this.#status;
  }

  /** No session concept: the server stores nothing. See `LOCAL_CAPABILITIES`. */
  get sessionId(): SessionId | undefined {
    return undefined;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#queue;
  }

  #emit(event: Omit<AgentEvent, 'runId' | 'seq' | 'ts'>): void {
    this.#queue.push({
      ...event,
      runId: this.runId,
      seq: this.#seq++,
      // A monotonic counter would be safer, but the seam's other adapters stamp
      // wall-clock here and the renderer orders on `seq`.
      ts: Date.now(),
    } as AgentEvent);
  }

  /**
   * Which tools this run may offer, from its permission mode.
   *
   * `plan` is the interesting one: it withholds every tool that changes
   * something, so the model can read, search and propose but cannot act. That
   * is enforced by not *offering* the tools rather than by refusing them later
   * — a model that is never told about `write_file` does not spend a turn
   * trying it and being denied.
   */
  #toolsForMode(): readonly ToolSpec[] {
    const mode = this.#input.permissionMode ?? 'default';
    if (mode === 'plan') return toolsForRisk(false, false);
    return toolsForRisk(true, true);
  }

  /**
   * Ask the user about one call — or answer for them when the mode says to.
   *
   * `acceptEdits` and `bypassPermissions` skip the prompt. Neither widens the
   * OS sandbox: approval and confinement are separate axes, and a mode that
   * quietly did both would make "stop asking me" mean "and also let it out".
   */
  async #approve(call: ToolCall, tool: ToolSpec): Promise<'allow' | 'deny'> {
    const mode = this.#input.permissionMode ?? 'default';
    if (mode === 'bypassPermissions') return 'allow';
    if (mode === 'acceptEdits' && tool.risk !== 'execute') return 'allow';

    const requestId = `${this.runId}-perm-${this.#permissionSeq++}` as PermissionRequestId;
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.argumentsJson);
      if (typeof parsed === 'object' && parsed !== null) input = parsed as Record<string, unknown>;
    } catch {
      /* the loop reports the parse failure; the prompt shows what it can */
    }

    const decided = createDeferred<'allow' | 'deny'>();
    this.#pending.set(requestId, decided);
    this.#status = 'awaiting_permission';
    this.#emit({
      type: 'permission.request',
      requestId,
      request: {
        id: requestId,
        runId: this.runId,
        toolName: tool.name,
        input,
        toolCallId: call.id,
        title: tool.description,
      },
    } as never);

    const decision = await decided.promise;
    this.#status = 'running';
    return decision;
  }

  /**
   * What this machine can enforce, resolved once per run.
   *
   * Once rather than per command, because it cannot change mid-run and because
   * the answer is what `session.started` tells the user — they should learn
   * that commands will be refused before the model tries one, not after.
   */
  async #sandbox(): Promise<ResolvedSandbox> {
    this.#resolvedSandbox ??= await resolveSandbox(process.platform, hasBinary);
    return this.#resolvedSandbox;
  }

  /** Run a shell command, or refuse when nothing on this machine can confine it. */
  async #shell(command: string, signal: AbortSignal): Promise<{ output: string; failed?: boolean }> {
    const sandbox = await this.#sandbox();
    // A scratch directory of the run's own, because the profile no longer
    // opens the system temp area — see `seatbeltProfile` for what that granted.
    this.#scratch ??= await mkdtemp(path.join(tmpdir(), 'artemis-run-'));
    const argv = await wrapCommand(sandbox, command, this.#input.cwd, this.#scratch);

    // `null` means nothing confined it. Refused rather than run: the
    // alternative is a silent downgrade from sandboxed to not, on whichever
    // platform is least able to notice.
    if (argv === null) {
      return { output: `Refused: ${describeConfinement(sandbox)}`, failed: true };
    }

    try {
      const { stdout, stderr } = await execFileAsync(argv[0] as string, argv.slice(1), {
        cwd: this.#input.cwd,
        // Pointed at the run's own scratch, so a toolchain writing "to /tmp"
        // lands somewhere the sandbox actually permits.
        env: { ...sandboxEnv(this.#input.env, []), TMPDIR: this.#scratch, TMP: this.#scratch, TEMP: this.#scratch },
        signal,
        maxBuffer: 4_000_000,
      });
      const output = `${stdout}${stderr}`.trim();
      return { output: output === '' ? '(no output)' : output };
    } catch (error) {
      // A non-zero exit is information the model needs, not a run-ending fault:
      // a failing test suite is the normal case for a coding agent.
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const detail = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
      return { output: detail === '' ? (failure.message ?? 'The command failed.') : detail, failed: true };
    }
  }

  /** One streamed completion, in the shape the loop asks for. */
  async #complete(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): Promise<CompletionResult> {
    const url = `${baseUrl(this.#flavour, this.#input.env)}/v1/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: this.#abort.signal,
      body: JSON.stringify({
        ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length === 0 ? {} : { tools: toWireTools(tools) }),
      }),
    });

    if (!response.ok || response.body === null) {
      throw adapterError(
        'provider_unavailable',
        `The ${this.#flavour.label} server answered ${response.status}. Is it running, and is a model loaded?`,
      );
    }

    const messageId = `${this.runId}-${this.#messageSeq}` as MessageId;
    const calls = new ToolCallAccumulator();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason: string | undefined;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const { lines, rest } = splitEvents(buffer);
      buffer = rest;

      for (const line of lines) {
        const delta = readEventLine(line);
        if (delta === null) continue;
        if (delta === 'done') break;

        if (delta.error !== undefined) throw adapterError('provider_unavailable', delta.error);
        if (delta.usage !== undefined) this.#usage = toUsage(delta.usage);
        if (delta.finishReason !== undefined) finishReason = delta.finishReason;
        if (delta.toolCalls !== undefined) calls.add(delta.toolCalls);
        if (delta.thinking !== undefined) {
          this.#emit({ type: 'thinking.delta', messageId, blockIndex: 0, text: delta.thinking } as never);
        }
        if (delta.text !== undefined) {
          text += delta.text;
          this.#emit({ type: 'text.delta', messageId, blockIndex: 0, text: delta.text } as never);
        }
      }
    }

    if (text !== '') {
      this.#emit({ type: 'text.complete', messageId, role: 'assistant', text } as never);
    }
    this.#messageSeq += 1;
    return { text, toolCalls: calls.take(), ...(finishReason === undefined ? {} : { finishReason }) };
  }

  async #drive(): Promise<void> {
    try {
      this.#emit({
        type: 'session.started',
        sessionId: this.runId as unknown as SessionId,
        providerId: this.#flavour.id,
        cwd: this.#input.cwd,
        ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
        tools: this.#toolsForMode().map((tool) => tool.name),
        ...(this.#input.permissionMode === undefined ? {} : { permissionMode: this.#input.permissionMode }),
      } as never);

      const initial: ChatMessage[] = [];
      const system = this.#input.systemPrompt;
      if (system !== undefined && system.kind !== 'default' && system.text !== '') {
        initial.push({ role: 'system', content: system.text });
      }
      initial.push({ role: 'user', content: this.#input.prompt });

      await runAgentLoop({
        initialMessages: initial,
        tools: this.#toolsForMode(),
        complete: (request) => this.#complete(request.messages, request.tools),
        context: {
          root: this.#input.cwd,
          env: sandboxEnv(this.#input.env, []),
          signal: this.#abort.signal,
          shell: (command, signal) => this.#shell(command, signal),
        },
        approve: (call, tool) => this.#approve(call, tool),
        onToolStart: (call) => {
          let input: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(call.argumentsJson);
            if (typeof parsed === 'object' && parsed !== null) input = parsed as Record<string, unknown>;
          } catch {
            /* reported to the model by executeTool; the row shows the raw text */
          }
          this.#emit({ type: 'tool.start', toolCallId: call.id, name: call.name, input } as never);
        },
        onToolEnd: (call, output, failed) => {
          this.#emit({
            type: 'tool.end',
            toolCallId: call.id,
            name: call.name,
            status: failed ? 'error' : 'ok',
            resultText: output,
          } as never);
        },
      });

      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason: 'completed',
        ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      } as never);
    } catch (error) {
      const aborted = this.#abort.signal.aborted;
      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason: aborted ? 'interrupted' : 'error',
        ...(aborted ? {} : { error: toError(error, this.#flavour) }),
      } as never);
    } finally {
      // Every parked approval is released, or a disposed run leaves the loop
      // waiting on a promise nobody will ever settle.
      for (const pending of this.#pending.values()) pending.resolve('deny');
      this.#pending.clear();
      if (this.#scratch !== undefined) void rm(this.#scratch, { recursive: true, force: true });
      this.#queue.close();
    }
  }

  send(): Promise<SendResult> {
    // Refused rather than queued: `midRunSteering` is false, so the composer is
    // already disabled, and a message silently delivered a turn later is worse
    // than one that was plainly not accepted.
    return Promise.reject(
      adapterError('invalid_request', `${this.#flavour.label} cannot take a message mid-turn.`),
    );
  }

  interrupt(): Promise<InterruptResult> {
    this.#abort.abort();
    return Promise.resolve({ stillQueued: [] });
  }

  respondToPermission(id: PermissionRequestId, decision: PermissionDecision): Promise<void> {
    const pending = this.#pending.get(id);
    // An unknown id is not an error: a request already settled by a dispose, or
    // answered twice by an impatient click, has nothing left to decide.
    if (pending === undefined) return Promise.resolve();
    this.#pending.delete(id);
    pending.resolve(decision.behavior === 'allow' ? 'allow' : 'deny');
    this.#emit({ type: 'permission.resolved', requestId: id, decision } as never);
    return Promise.resolve();
  }


  dispose(): Promise<void> {
    this.#abort.abort();
    this.#queue.close();
    return Promise.resolve();
  }
}

/**
 * Normalise a thrown value into the error a `run.end` carries.
 *
 * `AdapterError` already holds a scrubbed `AgentError`, so it is unwrapped
 * rather than rebuilt — rewrapping would discard the code the thrower chose.
 */
function toError(error: unknown, flavour: LocalFlavour): AgentError {
  if (error instanceof AdapterError) return error.agentError;
  if (error instanceof Error && error.name === 'AbortError') {
    return adapterError('cancelled', 'The run was stopped.').agentError;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return adapterError(
    'provider_unavailable',
    `Could not reach the ${flavour.label} server. ${detail}`,
  ).agentError;
}

/**
 * Whether a binary is here — the probe both the run and the descriptor use.
 *
 * Shared rather than written twice, because two copies of "can this machine
 * confine a command" would be two chances to answer differently, and the whole
 * value of showing the confinement is that it is the same answer the shell tool
 * will act on.
 */
async function hasBinary(binary: string): Promise<boolean> {
  if (binary.startsWith('/')) return existsSync(binary);
  // A bare name has to be found on PATH, which is what `which` is for.
  try {
    await execFileAsync('which', [binary]);
    return true;
  } catch {
    return false;
  }
}

/** Build the adapter for one local server. */
export function createLocalAdapter(flavour: LocalFlavour): ProviderAdapter {
  return {
    id: flavour.id,
    label: flavour.label,
    credentials: localCredentials(),
    capabilities: LOCAL_CAPABILITIES,

    /**
     * A local provider is available when its server answers, not when a binary
     * is on `PATH` — the server may be an app, a container or a machine on the
     * desk. Asking the endpoint is the only honest probe.
     */
    /**
     * What is confining this provider's shell commands on this machine.
     *
     * Only the local providers implement this, and that asymmetry is the point:
     * Artemis builds the shell tool here, so Artemis is what confines it. See
     * `ProviderAdapter.describeSandbox`.
     */
    async describeSandbox() {
      const resolved = await resolveSandbox(process.platform, hasBinary);
      return {
        ...(resolved.backend === undefined ? {} : { backend: resolved.backend.name }),
        confinement: resolved.confinement,
        verification: resolved.backend?.verification ?? ('unverified' as const),
        detail: describeConfinement(resolved),
      };
    },

    async checkAvailability() {
      try {
        const response = await fetch(`${flavour.defaultBaseUrl}/v1/models`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok
          ? { available: true as const }
          : {
              available: false as const,
              reason: `The ${flavour.label} server answered ${response.status}.`,
            };
      } catch {
        return {
          available: false as const,
          reason: `Nothing is answering at ${flavour.defaultBaseUrl}. Start ${flavour.label} and try again.`,
        };
      }
    },

    /**
     * Ask the server what it can run.
     *
     * Never rejects: an unreachable server is an ordinary state of a desktop,
     * and emptying the picker would be a worse answer than saying nothing was
     * confirmed. The richer endpoint is tried first and the OpenAI one second,
     * for the reasons in each flavour's catalogue module.
     */
    async listModels(query) {
      const root = baseUrl(flavour, query.env ?? {});
      const attempts = [
        { path: flavour.cataloguePath, parse: flavour.parseCatalogue },
        ...(flavour.fallback === undefined ? [] : [flavour.fallback]),
      ];

      for (const attempt of attempts) {
        try {
          const response = await fetch(`${root}${attempt.path}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) continue;
          const models = attempt.parse(await response.json());
          if (models.length > 0) return { models, live: true };
        } catch {
          continue;
        }
      }
      return { models: [], live: false };
    },

    createRun(input: ResolvedRunInput): Promise<Run> {
      return Promise.resolve(new LocalRun(input, flavour));
    },
  } as ProviderAdapter;
}
