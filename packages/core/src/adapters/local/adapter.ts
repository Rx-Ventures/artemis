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
 * inference server, which does not. **Phase 1 therefore ships no tools at all**:
 * the run sends a prompt, streams the reply, and ends. That is a real product —
 * a conversation with a model on your own machine, costing nothing and leaving
 * the machine never — and the capability descriptor says plainly that it is not
 * yet more than that.
 *
 * This is deliberate rather than unfinished. Owning the loop means Artemis
 * executing tools in its own process, which is a materially different security
 * posture from every other provider, where tools run inside the provider's
 * process. Shipping the conversation first keeps that decision separate from
 * the transport work instead of smuggling it in.
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

import { AsyncQueue } from '../stream.js';
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
import { readEventLine, splitEvents } from './stream.js';
import type { StreamUsage } from './stream.js';

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
  // Phase 2. No tools means nothing to approve, and an approval surface over an
  // empty tool set would be a control that never appears.
  interactivePermissions: false,
  // Phase 3. The server stores no conversation, so sessions would mean Artemis
  // persisting transcripts itself.
  listSessions: false,
  resumeSession: false,
  forkSession: false,
  permissionModes: [],
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

  async #drive(): Promise<void> {
    const messageId = `${this.runId}-0` as MessageId;
    let text = '';

    try {
      const url = `${baseUrl(this.#flavour, this.#input.env)}/v1/chat/completions`;
      const messages: { role: string; content: string }[] = [];
      // A spec rather than a string: `append` and `replace` mean the same thing
      // here, because there is no preset of ours for an append to sit on top of.
      const system = this.#input.systemPrompt;
      if (system !== undefined && system.kind !== 'default' && system.text !== '') {
        messages.push({ role: 'system', content: system.text });
      }
      messages.push({ role: 'user', content: this.#input.prompt });

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: this.#abort.signal,
        body: JSON.stringify({
          ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
          messages,
          stream: true,
          // Servers differ on whether usage arrives during a stream; asking for
          // it is honoured where supported and ignored where not.
          stream_options: { include_usage: true },
        }),
      });

      if (!response.ok || response.body === null) {
        throw adapterError(
          'provider_unavailable',
          `The ${this.#flavour.label} server answered ${response.status}. Is it running, and is a model loaded?`,
        );
      }

      this.#emit({
        type: 'session.started',
        sessionId: this.runId as unknown as SessionId,
        providerId: this.#flavour.id,
        cwd: this.#input.cwd,
        ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
      } as never);

      let buffer = '';
      let usage: UsageSnapshot | undefined;
      const decoder = new TextDecoder();

      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const { lines, rest } = splitEvents(buffer);
        buffer = rest;

        for (const line of lines) {
          const delta = readEventLine(line);
          if (delta === null) continue;
          if (delta === 'done') break;

          if (delta.error !== undefined) throw adapterError('provider_unavailable', delta.error);
          if (delta.usage !== undefined) usage = toUsage(delta.usage);
          if (delta.thinking !== undefined) {
            this.#emit({
              type: 'thinking.delta',
              messageId,
              blockIndex: 0,
              text: delta.thinking,
            } as never);
          }
          if (delta.text !== undefined) {
            text += delta.text;
            this.#emit({ type: 'text.delta', messageId, blockIndex: 0, text: delta.text } as never);
          }
        }
      }

      this.#emit({ type: 'text.complete', messageId, role: 'assistant', text } as never);
      if (usage !== undefined) this.#emit({ type: 'usage', usage } as never);
      this.#status = 'ended';
      this.#emit({ type: 'run.end', reason: 'completed', ...(usage === undefined ? {} : { usage }) } as never);
    } catch (error) {
      const aborted = this.#abort.signal.aborted;
      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason: aborted ? 'interrupted' : 'error',
        ...(aborted ? {} : { error: toError(error, this.#flavour) }),
      } as never);
    } finally {
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

  respondToPermission(_id: PermissionRequestId, _decision: PermissionDecision): Promise<void> {
    // Unreachable while `interactivePermissions` is false — nothing emits a
    // request — and rejecting is more honest than pretending it landed.
    return Promise.reject(adapterError('invalid_request', 'This provider asks for no permissions yet.'));
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
