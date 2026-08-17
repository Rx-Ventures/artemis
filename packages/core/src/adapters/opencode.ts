/**
 * The OpenCode adapter.
 *
 * Third provider, and the first built on a *shared* transport: everything
 * protocol-shaped lives in `adapters/acp`, so this file is a credential spec, a
 * capability declaration, and the wiring between an {@link AcpClient} and the
 * normalized event stream. Kimi Code and Grok Build speak the same dialect, and
 * the intended shape of adding them is a second file this size — not a second
 * transport.
 *
 * Verified against `opencode acp` 1.18.18 on 2026-08-17, driven live through
 * `scripts/acp-probe.ts`.
 *
 * ## Why `XDG_DATA_HOME` is the isolation variable
 *
 * Every other provider names its own: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`.
 * OpenCode has `OPENCODE_CONFIG_DIR` and it is *the wrong variable* — driving
 * the binary showed it relocates configuration while credentials stay at
 * `~/.local/share/opencode/auth.json`. Two profiles set up that way would share
 * one account, which is precisely the failure `configDirVar` exists to prevent.
 * `XDG_DATA_HOME` is what actually moves the account, so that is what a profile
 * sets, and a profile's OpenCode state lives at `<profileDir>/opencode/`.
 *
 * The variable is generic rather than vendor-specific, which is worth stating
 * plainly: it is set on the environment of *this subprocess only*, composed per
 * run by `composeProviderEnv`, and never exported into the user's session. A
 * second provider in the same profile directory is unaffected — it reads its
 * own variable.
 *
 * ## Why the scrub list is so much longer than Claude's
 *
 * OpenCode is a multi-provider agent: it will authenticate to Anthropic,
 * OpenAI, xAI, Google and a dozen more from environment variables if they
 * happen to be set. Every one of those outranks the profile's own login the
 * same way `ANTHROPIC_API_KEY` outranks a Claude subscription — the billing
 * trap the seam was built to make structural. So the list below covers the
 * provider keys OpenCode reads, not just OpenCode's own.
 */

import type {
  AdapterAvailability,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  InterruptResult,
} from './types.js';
import type {
  AgentError,
  AgentEvent,
  Capabilities,
  JsonObject,
  PermissionDecision,
  PermissionRequestId,
  ProviderId,
  RunStatus,
  SessionId,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { connectAcpAgent, isAcpAuthRequiredError } from './acp/client.js';
import type { AcpClient } from './acp/client.js';
import type {
  AcpPermissionOption,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
} from './acp/protocol.js';
import { composeProviderEnv } from './env.js';
import {
  createOpencodeMapperState,
  finishOpencodeRun,
  flushOpencodeToolCalls,
  mapOpencodeUpdate,
  mapStopReason,
  openSession,
  stampOpencodeEvent,
} from './opencode/mapper.js';
import type { OpencodeMapperState } from './opencode/mapper.js';
import { AsyncQueue, createDeferred } from './stream.js';
import type { Deferred } from './stream.js';
import { adapterError, toAgentError } from './types.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const PROVIDER_ID: ProviderId = 'opencode';

/** Default executable name, resolved on `PATH`. */
const DEFAULT_EXECUTABLE = 'opencode';

/**
 * Variables that could authenticate a run without going through the profile's
 * own directory. All strip-only: Artemis writes none of them.
 */
const OPENCODE_ENV_SCRUB_KEYS: readonly string[] = [
  // OpenCode's own credential and configuration surface.
  'OPENCODE_API_KEY',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONSOLE_TOKEN',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  // Model-provider keys OpenCode will happily authenticate with. Each one is a
  // way to bill an account the profile did not choose.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  // The isolation variable itself: inherited, it would point every profile at
  // the same account.
  'XDG_DATA_HOME',
];

/** How a profile's OpenCode account is located and signed in. */
export const OPENCODE_CREDENTIALS: ProviderCredentialSpec = {
  // Not `OPENCODE_CONFIG_DIR` — see the module header.
  configDirVar: 'XDG_DATA_HOME',
  credentialEnvKeys: OPENCODE_ENV_SCRUB_KEYS,
  signIn: {
    executable: DEFAULT_EXECUTABLE,
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'list'],
    logoutArgs: ['auth', 'logout'],
    howTo:
      'OpenCode opens a picker in your terminal to add a provider credential. Artemis never sees it — the credential is written into this profile’s own directory.',
    /**
     * `opencode auth list` prints a decorated summary rather than JSON, so the
     * shared parser cannot read it. The one fact needed is whether the isolated
     * directory holds any credential at all.
     *
     * Deliberately tolerant about *which* provider is signed in: OpenCode is
     * multi-provider, and a profile with a Google key is as signed in as one
     * with an Anthropic key. It also runs its own free models with no
     * credential at all — verified live — so a profile reporting zero
     * credentials is usable rather than broken, and the UI says so instead of
     * blocking.
     */
    parseStatus: (result) => {
      if (result.exitCode !== 0) {
        return {
          loggedIn: false,
          error:
            result.stderr.trim() === ''
              ? 'The OpenCode CLI could not read this profile’s credentials.'
              : result.stderr.trim().slice(0, 200),
        };
      }
      const text = `${result.stdout}\n${result.stderr}`;
      const match = /(\d+)\s+credentials?/i.exec(text);
      const count = match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
      return count > 0 ? { loggedIn: true, authMethod: 'opencode' } : { loggedIn: false };
    },
  },
};

/**
 * What this adapter can do, as a constant.
 *
 * **Static by contract** — the renderer caches it and builds a stable UI from
 * it — which is why it is a literal here rather than a read of the ACP
 * handshake, even though the handshake reports the same territory per
 * connection.
 *
 * Everything below is set from behaviour verified live. The flags left `false`
 * are the honest ones: OpenCode *advertises* `fork`, `list` and `resume` in
 * `sessionCapabilities`, but the wire shapes behind them have not been driven
 * yet, and a capability declared before it is verified is a UI affordance that
 * fails in the user's hands. They are the next increment; until then the
 * pickers render disabled with a reason, which is what the capability system is
 * for.
 */
export const OPENCODE_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  // Verified: `session/request_permission` parks the turn until answered.
  interactivePermissions: true,
  // Verified: message and thought chunks stream token by token.
  partialMessages: true,
  // ACP has no steering method — a turn is one `session/prompt` request.
  midRunSteering: false,
  // Verified: `usage_update` carries context occupancy and cost.
  usageReporting: true,
  costReporting: true,
  // Metered credits, not a subscription with rate-limit windows.
  planUsageReporting: false,
  // Advertised as `promptCapabilities.image`.
  imageInput: true,
  // ACP exposes no system-prompt append; OpenCode owns its own instructions.
  systemPromptAppend: false,
  // Artemis's modes have no ACP equivalent. OpenCode governs approvals with its
  // own configuration and asks over the transport, which is the mode Artemis
  // calls `default`.
  permissionModes: ['default'],
};

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link createOpencodeAdapter}. */
export interface OpencodeAdapterOptions {
  /** Override the executable, for tests and unusual installs. */
  readonly executable?: string;
  /** Arguments that put the CLI in ACP mode. Defaults to `['acp']`. */
  readonly acpArgs?: readonly string[];
  /** Injected clock, for deterministic tests. */
  readonly now?: () => number;
  /** The environment to inherit from. Defaults to `process.env`. */
  readonly hostEnv?: NodeJS.ProcessEnv;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/** One parked approval, waiting for the user. */
interface ParkedPermission {
  readonly deferred: Deferred<AcpRequestPermissionResponse>;
  readonly options: readonly AcpPermissionOption[];
}

/**
 * One OpenCode turn.
 *
 * Owns its ACP client: unlike the Claude adapter, which keeps a process alive
 * across turns for background work, an OpenCode run is a process that exists
 * for the length of the turn. There is no `release` override, so the registry
 * disposes when a run ends, which is correct here.
 */
class OpencodeRun implements Run {
  readonly runId: string;
  readonly providerId = PROVIDER_ID;
  readonly capabilities = OPENCODE_CAPABILITIES;

  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #state: OpencodeMapperState;
  readonly #permissions = new Map<PermissionRequestId, ParkedPermission>();
  readonly #startedAt: number;

  #client: AcpClient | undefined;
  #status: RunStatus = 'starting';
  #disposing: Promise<void> | undefined;
  #nextPermissionId = 0;

  constructor(runId: string, state: OpencodeMapperState, startedAt: number) {
    this.runId = runId;
    this.#state = state;
    this.#startedAt = startedAt;
  }

  get status(): RunStatus {
    return this.#status;
  }

  get sessionId(): SessionId | undefined {
    return this.#state.sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  /** @internal Wire the client in once it has connected. */
  attach(client: AcpClient): void {
    this.#client = client;
    this.#status = 'running';
  }

  /** @internal Push mapper output onto the stream. */
  emit(events: readonly AgentEvent[]): void {
    for (const event of events) this.#events.push(event);
  }

  /** @internal Park an approval and announce it. */
  requestPermission(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    const id: PermissionRequestId = `perm-${this.runId}-${String(this.#nextPermissionId++)}`;
    const deferred = createDeferred<AcpRequestPermissionResponse>();
    this.#permissions.set(id, { deferred, options: request.options });

    const toolName = request.toolCall.title ?? 'tool';
    this.emit([
      stampOpencodeEvent(this.#state, {
        type: 'permission.request',
        requestId: id,
        request: {
          id,
          runId: this.runId,
          toolName,
          input: (request.toolCall.rawInput ?? {}) as JsonObject,
          ...(request.toolCall.toolCallId === undefined
            ? {}
            : { toolCallId: request.toolCall.toolCallId }),
          ...(request.toolCall.title === undefined || request.toolCall.title === null
            ? {}
            : { title: request.toolCall.title }),
        },
      }),
    ]);

    return deferred.promise;
  }

  async send(): Promise<SendResult> {
    // ACP models a turn as one request with no steering channel, so there is
    // nothing honest to do with mid-run text. Rejecting is the contract's
    // alternative to silently dropping it.
    throw adapterError(
      'invalid_request',
      'OpenCode cannot take more input while a turn is running.',
    );
  }

  async interrupt(): Promise<InterruptResult> {
    if (this.#state.ended) return { stillQueued: [] };
    this.#state.interruptRequested = true;
    this.#client?.cancel();
    // The turn ends when the agent answers `session/prompt` with `cancelled`;
    // `run.end` is emitted there, not here.
    return { stillQueued: [] };
  }

  async respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    const parked = this.#permissions.get(requestId);
    if (parked === undefined) {
      // A double answer usually means the UI lost track of which prompt it is
      // showing, which is worth surfacing rather than absorbing.
      throw adapterError(
        'invalid_request',
        `No permission request "${requestId}" is waiting for an answer.`,
      );
    }
    this.#permissions.delete(requestId);

    const optionId = chooseOption(parked.options, decision.behavior === 'allow');
    parked.deferred.resolve(
      optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } },
    );

    this.emit([
      stampOpencodeEvent(this.#state, {
        type: 'permission.resolved',
        requestId,
        behavior: decision.behavior,
      }),
    ]);
  }

  /** @internal End the run, settling everything it holds. */
  finish(reason: Parameters<typeof finishOpencodeRun>[1]): void {
    if (this.#state.ended) return;
    this.#denyOutstanding();
    this.emit(
      finishOpencodeRun(this.#state, {
        ...reason,
        durationMs: reason.durationMs ?? Math.max(0, this.#state.now() - this.#startedAt),
      }),
    );
    this.#status = 'ended';
    this.#events.close();
  }

  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      this.#state.disposeRequested = true;
      this.finish({ reason: this.#state.ended ? 'completed' : 'disposed' });
      await this.#client?.dispose();
    })();
    return this.#disposing;
  }

  /**
   * Cancel every parked approval.
   *
   * `cancelled` rather than a denial, on the same reasoning as the ACP client:
   * the user never answered, and telling the agent they said no would teach it
   * something untrue.
   */
  #denyOutstanding(): void {
    for (const [, parked] of this.#permissions) {
      parked.deferred.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.#permissions.clear();
  }
}

/**
 * Pick the option matching the user's verdict.
 *
 * ACP option ids are opaque and agent-defined, so the mapping goes through
 * `kind` rather than guessing at a string. The "once" variants are chosen over
 * the "always" ones deliberately: Artemis owns durable permission rules in its
 * own vocabulary, and letting the agent persist a rule Artemis did not record
 * would put the two out of step.
 */
function chooseOption(
  options: readonly AcpPermissionOption[],
  allow: boolean,
): string | undefined {
  const wanted = allow ? 'allow_once' : 'reject_once';
  const fallback = allow ? 'allow_always' : 'reject_always';
  return (
    options.find((option) => option.kind === wanted)?.optionId ??
    options.find((option) => option.kind === fallback)?.optionId
  );
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/** Create the OpenCode adapter. */
export function createOpencodeAdapter(options?: OpencodeAdapterOptions): ProviderAdapter {
  const executable = options?.executable ?? DEFAULT_EXECUTABLE;
  const acpArgs = options?.acpArgs ?? ['acp'];
  const now = options?.now ?? Date.now;
  const hostEnv = options?.hostEnv ?? process.env;

  return {
    id: PROVIDER_ID,
    label: 'OpenCode',
    credentials: OPENCODE_CREDENTIALS,
    capabilities: OPENCODE_CAPABILITIES,

    async checkAvailability(): Promise<AdapterAvailability> {
      const found = await which(executable, hostEnv);
      return found
        ? { available: true }
        : {
            available: false,
            unavailableReason:
              'The OpenCode CLI was not found on your PATH. Install it, then reopen this window.',
          };
    },

    async createRun(input: ResolvedRunInput): Promise<Run> {
      if (!input.cwd.startsWith('/')) {
        throw adapterError('invalid_request', 'The working directory must be an absolute path.');
      }
      if (input.permissionMode !== undefined && input.permissionMode !== 'default') {
        // Silently downgrading a permission mode is how a run ends up more
        // permissive than the user asked for.
        throw adapterError(
          'invalid_request',
          `OpenCode does not support the "${input.permissionMode}" permission mode.`,
        );
      }
      if (input.resumeSessionId !== undefined) {
        throw adapterError(
          'invalid_request',
          'Resuming an OpenCode session is not supported in this version of Artemis yet.',
        );
      }

      const state = createOpencodeMapperState(input.runId, { now });
      const run = new OpencodeRun(input.runId, state, now());

      const env = composeProviderEnv(input.env, {
        inheritHostEnv: input.inheritHostEnv !== false,
        hostEnv,
        scrubKeys: OPENCODE_ENV_SCRUB_KEYS,
      });

      let client: AcpClient;
      try {
        client = await connectAcpAgent({
          executable,
          args: acpArgs,
          cwd: input.cwd,
          env,
          onUpdate: (notification) => {
            run.emit(mapOpencodeUpdate(state, notification));
          },
          onPermissionRequest: (request) => run.requestPermission(request),
          onExit: (reason) => {
            // The process dying mid-turn is the one path where nothing else
            // will emit `run.end`.
            if (state.ended) return;
            run.emit(flushOpencodeToolCalls(state, 'cancelled'));
            run.finish({
              reason: state.interruptRequested ? 'interrupted' : 'error',
              ...(state.interruptRequested
                ? {}
                : { error: { code: 'transport', message: reason } satisfies AgentError }),
            });
          },
        });
      } catch (error) {
        throw asAdapterFailure(error);
      }

      run.attach(client);

      let sessionId: string;
      try {
        sessionId = await client.newSession(input.cwd);
      } catch (error) {
        await client.dispose();
        throw asAdapterFailure(error);
      }

      run.emit(
        openSession(state, {
          sessionId,
          cwd: input.cwd,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(client.handshake.agentVersion === undefined
            ? {}
            : { providerVersion: client.handshake.agentVersion }),
        }),
      );

      // The turn runs in the background: `createRun` resolves as soon as the
      // session exists, and events flow until `run.end`. Resolving does not
      // mean the provider has finished — the seam says so explicitly.
      void (async () => {
        try {
          const stopReason = await client.prompt([{ type: 'text', text: input.prompt }]);
          run.finish({ reason: mapStopReason(stopReason) });
        } catch (error) {
          if (state.ended) return;
          run.emit(flushOpencodeToolCalls(state, 'cancelled'));
          run.finish({
            reason: state.interruptRequested ? 'interrupted' : 'error',
            ...(state.interruptRequested ? {} : { error: toAgentError(error, 'transport') }),
          });
        } finally {
          await client.dispose();
        }
      })();

      return run;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turn a connect-time failure into the error the seam expects.
 *
 * An agent that refuses for want of a login is not a broken agent: it is the
 * profile screen's question answered over the transport, and it must reach the
 * user as "sign in", never as "the provider crashed".
 */
function asAdapterFailure(error: unknown): unknown {
  if (isAcpAuthRequiredError(error)) {
    const how = error.authMethods[0]?.description;
    return adapterError(
      'auth',
      how === undefined
        ? 'This OpenCode profile is not signed in.'
        : `This OpenCode profile is not signed in. ${how}`,
    );
  }
  return error;
}

/** Is the executable on `PATH`? */
async function which(executable: string, hostEnv: NodeJS.ProcessEnv): Promise<boolean> {
  // An absolute path is its own answer.
  if (executable.includes('/')) {
    const { access } = await import('node:fs/promises');
    try {
      await access(executable);
      return true;
    } catch {
      return false;
    }
  }

  const path = hostEnv['PATH'];
  if (path === undefined || path === '') return false;

  const { access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    try {
      await access(join(dir, executable));
      return true;
    } catch {
      // Next directory.
    }
  }
  return false;
}
