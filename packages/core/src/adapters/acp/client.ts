/**
 * An ACP client: one agent subprocess, initialized and ready to take turns.
 *
 * ## What this owns, and what it deliberately does not
 *
 * This layer owns the **connection lifecycle** — spawn, initialize, negotiate,
 * create or load a session, run a turn, cancel, tear down — and nothing about
 * how a turn's contents become Artemis events. That split is the same one
 * `jsonrpc.ts` draws between the codec and the plumbing, and it exists for the
 * same reason: the interesting half should be testable without a subprocess.
 *
 * So `session/update` notifications are handed to a callback verbatim. Turning
 * them into the `AgentEvent` union is a *mapper's* job, per provider, because
 * that is where providers actually differ — OpenCode, Kimi and Grok all speak
 * this protocol, but they name their tools differently and disagree about which
 * of a turn's parts count as thinking.
 *
 * ## Why the turn is a promise and the updates are a callback
 *
 * ACP models a turn as one long request: `session/prompt` resolves with a
 * {@link AcpStopReason} when the whole turn is over — minutes later — while the
 * turn's contents stream past as notifications in the meantime. That maps
 * cleanly onto Artemis's run contract, where `run.end` carries the reason and
 * everything before it is a stream. It is also why
 * `JsonRpcConnection.request` has no timeout: a turn legitimately takes as long
 * as the work takes.
 */

import type { JsonValue } from '@rx-artemis/protocol';

import { isJsonRpcError, spawnJsonRpcSubprocess } from '../jsonrpc.js';
import type { JsonRpcSubprocess, SpawnJsonRpcOptions } from '../jsonrpc.js';
import { adapterError } from '../types.js';
import {
  ACP_CLIENT_CAPABILITIES,
  ACP_CLIENT_METHOD,
  ACP_METHOD,
  ACP_NOTIFICATION,
  ACP_PROTOCOL_VERSION,
  hasSessionCapability,
  isAuthRequiredError,
  isInitializeResponse,
  isNewSessionResponse,
  isPromptResponse,
  isRequestPermissionRequest,
  isSessionListResponse,
  isSessionNotification,
} from './protocol.js';
import type {
  AcpAgentCapabilities,
  AcpAuthMethod,
  AcpContentBlock,
  AcpPromptResponse,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionListEntry,
  AcpSessionNotification,
} from './protocol.js';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** How to launch and drive one ACP agent. */
export interface AcpClientOptions {
  /** The agent executable, resolved on `PATH` by the caller. */
  readonly executable: string;
  /** Arguments that put it in ACP mode — `['acp']` for OpenCode and Kimi. */
  readonly args: readonly string[];
  /** Working directory for the subprocess *and* the default for a new session. */
  readonly cwd: string;
  /** The complete environment. Built by `composeProviderEnv`, never `process.env`. */
  readonly env: Record<string, string>;

  /**
   * Called for every `session/update` notification, in arrival order.
   *
   * Must not throw: it is invoked from the transport's notification path, where
   * an exception would be reported as a diagnostic and the update lost. Mappers
   * push onto a queue and return.
   */
  readonly onUpdate: (notification: AcpSessionNotification) => void;

  /**
   * Answer an approval request. **The returned promise parks the agent's turn**
   * until it settles, which is the intended behaviour — there is no deadline
   * and no default answer.
   *
   * Absent means this client denies nothing and approves nothing: the request
   * is answered `cancelled`, which ACP defines as "the client did not put this
   * to a user". An adapter that advertises `interactivePermissions` supplies
   * this; one that does not, must not.
   */
  readonly onPermissionRequest?: (
    request: AcpRequestPermissionRequest,
  ) => Promise<AcpRequestPermissionResponse>;

  /** Sink for protocol-level oddities. Never fatal. */
  readonly onDiagnostic?: (message: string, detail?: unknown) => void;

  /**
   * Called once when the agent process exits for any reason, with a message
   * naming the cause. Fires after every pending request has been failed.
   */
  readonly onExit?: (reason: string) => void;

  /**
   * Launch the transport. Defaults to {@link spawnJsonRpcSubprocess}.
   *
   * The seam exists so the handshake, the auth-required path and the
   * permission plumbing can be driven without spawning anything — the same
   * split `jsonrpc.ts` makes between its codec and its process handling, and
   * the reason this module claims its interesting half is testable. Production
   * code never passes it.
   */
  readonly spawn?: (options: SpawnJsonRpcOptions) => JsonRpcSubprocess;
}

/** What `initialize` established about the agent on the other end. */
export interface AcpHandshake {
  readonly protocolVersion: number;
  readonly agentCapabilities: AcpAgentCapabilities;
  readonly authMethods: readonly AcpAuthMethod[];
  readonly agentName: string | undefined;
  readonly agentVersion: string | undefined;
  /** Convenience reads of `sessionCapabilities`, which is presence-keyed. */
  readonly canFork: boolean;
  readonly canList: boolean;
  readonly canResume: boolean;
  readonly canLoadSession: boolean;
  readonly acceptsImages: boolean;
  /**
   * The agent takes a `resource` block carrying content inline, rather than
   * only a link to something it must fetch.
   *
   * Read as "can a file be attached at all". Separate from
   * {@link acceptsImages} because the two are advertised separately and an
   * agent may take one without the other.
   */
  readonly acceptsEmbeddedContext: boolean;
}

/** Raised when an agent refuses a session because the profile is not signed in. */
export class AcpAuthRequiredError extends Error {
  readonly authMethods: readonly AcpAuthMethod[];

  constructor(message: string, authMethods: readonly AcpAuthMethod[]) {
    super(message);
    this.name = 'AcpAuthRequiredError';
    this.authMethods = authMethods;
  }
}

/** True for an {@link AcpAuthRequiredError}, including across module realms. */
export function isAcpAuthRequiredError(value: unknown): value is AcpAuthRequiredError {
  return (
    value instanceof AcpAuthRequiredError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'AcpAuthRequiredError')
  );
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A live ACP agent.
 *
 * Created by {@link connectAcpAgent}, which does not return until the
 * handshake has completed — so a caller holding one of these knows the agent
 * launched, speaks a version it declared, and is ready for a session.
 */
export class AcpClient {
  readonly #process: JsonRpcSubprocess;
  readonly #options: AcpClientOptions;
  readonly #handshake: AcpHandshake;

  #sessionId: string | undefined;
  #disposed = false;
  /**
   * The raw answer to the last session-opening call.
   *
   * Kept because that answer carries the account's model list and the session's
   * available modes, which is how a live catalogue is published without a
   * second call and without spending a token — the obligation
   * `ProviderAdapter.listModels` puts on every implementation.
   */
  #sessionConfig: JsonValue | undefined;

  /** @internal Use {@link connectAcpAgent}. */
  constructor(process: JsonRpcSubprocess, options: AcpClientOptions, handshake: AcpHandshake) {
    this.#process = process;
    this.#options = options;
    this.#handshake = handshake;
  }

  /** What the agent said about itself during `initialize`. */
  get handshake(): AcpHandshake {
    return this.#handshake;
  }

  /** The session this client is working in, once one has been created or loaded. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** The last session-opening answer, for reading `configOptions` out of. */
  get sessionConfig(): JsonValue | undefined {
    return this.#sessionConfig;
  }

  /** True until the process exits or {@link dispose} is called. */
  get alive(): boolean {
    return this.#process.alive && !this.#disposed;
  }

  /** Recent stderr, for diagnosing a failed launch. */
  stderrTail(): string {
    return this.#process.stderrTail();
  }

  /**
   * Create a new conversation.
   *
   * Rejects with an {@link AcpAuthRequiredError} when the agent answers
   * `auth_required` — the signal that this profile's config directory has no
   * credential in it. That is a *distinct* failure from a crashed agent, and
   * the adapter turns it into the sign-in instructions the profile screen
   * already knows how to show, rather than an error the user cannot act on.
   */
  async newSession(cwd?: string): Promise<string> {
    const result = await this.#request(ACP_METHOD.sessionNew, {
      cwd: cwd ?? this.#options.cwd,
      // Required by the schema even when empty. Artemis injects MCP servers
      // through the provider's own configuration, not through the handshake.
      mcpServers: [],
    });

    if (!isNewSessionResponse(result)) {
      throw adapterError('transport', 'The agent did not return a session id.');
    }
    this.#sessionId = result.sessionId;
    this.#sessionConfig = result as unknown as JsonValue;
    return result.sessionId;
  }

  /**
   * Re-open a stored conversation.
   *
   * Only legal when the agent advertised `loadSession`; callers check
   * {@link AcpHandshake.canLoadSession} first, because an agent that cannot do
   * this answers `METHOD_NOT_FOUND` and the user deserves a better message than
   * that.
   *
   * The agent replays the whole conversation as `session/update` notifications
   * before this resolves, which is how a resumed session arrives with its
   * history intact rather than empty.
   */
  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    const result = await this.#request(ACP_METHOD.sessionLoad, {
      sessionId,
      cwd: cwd ?? this.#options.cwd,
      mcpServers: [],
    });
    this.#sessionId = sessionId;
    this.#sessionConfig = result;
  }

  /**
   * Run one turn and wait for it to finish.
   *
   * Resolves with the stop reason and, on agents that report it, the turn's
   * token usage. Does **not** reject on `refusal` or `max_tokens`: those are
   * outcomes of a turn that ran, not failures of the transport, and the adapter
   * renders them as an ended run with something to say.
   */
  async prompt(content: readonly AcpContentBlock[]): Promise<AcpPromptResponse> {
    const sessionId = this.#requireSession();
    const result = await this.#request(ACP_METHOD.sessionPrompt, {
      sessionId,
      prompt: content as unknown as JsonValue,
    });

    if (!isPromptResponse(result)) {
      throw adapterError('transport', 'The agent ended the turn without a stop reason.');
    }
    return result;
  }

  /**
   * Branch a stored conversation into a new one.
   *
   * Gated on {@link AcpHandshake.canFork}. The `cwd` is required by the agent,
   * not optional as the sibling calls make it look — OpenCode rejects a fork
   * without one.
   */
  async forkSession(sessionId: string, cwd?: string): Promise<string> {
    const result = await this.#request(ACP_METHOD.sessionFork, {
      sessionId,
      cwd: cwd ?? this.#options.cwd,
    });
    if (!isNewSessionResponse(result)) {
      throw adapterError('transport', 'The agent forked the session without returning an id.');
    }
    this.#sessionId = result.sessionId;
    return result.sessionId;
  }

  /**
   * Enumerate stored conversations.
   *
   * Gated on {@link AcpHandshake.canList}. Returns entries verbatim; deciding
   * which belong to a given working directory is the adapter's job, since the
   * agent lists everything the account can see.
   */
  async listSessions(): Promise<readonly AcpSessionListEntry[]> {
    const result = await this.#request(ACP_METHOD.sessionList, {});
    return isSessionListResponse(result) ? result.sessions : [];
  }

  /**
   * Switch the session's mode — OpenCode's `build` and `plan`.
   *
   * Answers `{}` on success. Failure is reported rather than swallowed: a mode
   * that silently did not take would leave a run more permissive than the user
   * asked for, which is the one class of error this seam refuses to degrade.
   */
  async setMode(modeId: string): Promise<void> {
    await this.#request(ACP_METHOD.sessionSetMode, {
      sessionId: this.#requireSession(),
      modeId,
    });
  }

  /** Point the session at a different model. Marked UNSTABLE in the schema. */
  async setModel(modelId: string): Promise<void> {
    await this.#request(ACP_METHOD.sessionSetModel, {
      sessionId: this.#requireSession(),
      modelId,
    });
  }

  /**
   * Ask the agent to stop the turn in flight.
   *
   * A notification, so there is nothing to await: the agent acknowledges by
   * resolving the outstanding {@link prompt} with `cancelled`. Safe to call
   * when no turn is running and safe to call twice — "stop" is idempotent by
   * nature, and a user hitting Escape twice has done nothing wrong.
   */
  cancel(): void {
    if (this.#sessionId === undefined || !this.alive) return;
    this.#process.connection.notify(ACP_NOTIFICATION.sessionCancel, {
      sessionId: this.#sessionId,
    });
  }

  /**
   * Terminate the agent and fail everything outstanding.
   *
   * Idempotent and never rejects, per the seam's contract for `Run.dispose`.
   * Sends `session/cancel` first so an agent mid-turn gets the chance to stop
   * cleanly — a killed process leaves half-written files behind, which a
   * cancelled turn does not.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      await this.#process.dispose();
      return;
    }
    try {
      // Before the disposed flag goes up, not after: `cancel` declines to
      // speak for a client that is already down, so setting the flag first
      // silently skips the very notification this method exists to send.
      this.cancel();
    } catch {
      // The process may already be gone; disposing is still the point.
    }
    this.#disposed = true;
    await this.#process.dispose();
  }

  /* -------------------------------- internals ------------------------------ */

  #requireSession(): string {
    if (this.#sessionId === undefined) {
      throw adapterError('invalid_request', 'No ACP session has been created yet.');
    }
    return this.#sessionId;
  }

  async #request(method: string, params: JsonValue): Promise<JsonValue> {
    if (!this.alive) {
      throw adapterError('transport', 'The agent process is no longer running.');
    }
    try {
      return await this.#process.connection.request(method, params);
    } catch (error) {
      if (isJsonRpcError(error) && isAuthRequiredError({ code: error.code, message: error.message })) {
        throw new AcpAuthRequiredError(error.message, this.#handshake.authMethods);
      }
      throw error;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Connect                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Spawn an agent, initialize it, and hand back a client ready for a session.
 *
 * The handshake is done here rather than lazily on first use so that a broken
 * agent fails at a point where the caller can still report it usefully: a
 * missing binary, an agent that speaks a version this module was not written
 * against, or one that dies on startup all surface as a rejection from *this*
 * function, not as a turn that mysteriously produces nothing.
 */
export async function connectAcpAgent(options: AcpClientOptions): Promise<AcpClient> {
  const launch = options.spawn ?? spawnJsonRpcSubprocess;

  const child = launch({
    executable: options.executable,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    // ACP is standard JSON-RPC 2.0 and its schema requires this field, unlike
    // the Codex dialect this codec was first written for.
    jsonRpcVersion: '2.0',

    onNotification: (method, params) => {
      if (method !== ACP_CLIENT_METHOD.sessionUpdate) {
        options.onDiagnostic?.(`Ignored an unknown ACP notification "${method}".`);
        return;
      }
      if (!isSessionNotification(params)) {
        options.onDiagnostic?.('Dropped a malformed session/update notification.', params);
        return;
      }
      try {
        options.onUpdate(params);
      } catch (error) {
        // A mapper bug must not take down the transport feeding every other
        // update, including the ones the UI needs to render what went wrong.
        options.onDiagnostic?.('The session/update handler threw.', error);
      }
    },

    onRequest: async (request) => {
      if (request.method === ACP_CLIENT_METHOD.requestPermission) {
        return await handlePermission(request.params, options);
      }

      // Every other client method — the filesystem and terminal families — is
      // declined by construction: `ACP_CLIENT_CAPABILITIES` advertises none of
      // them, so a well-behaved agent never asks. Answering with an explicit
      // error rather than hanging means a *mis*behaved one fails fast and
      // visibly instead of parking a turn forever.
      throw adapterError(
        'invalid_request',
        `Artemis does not implement the ACP client method "${request.method}".`,
      );
    },

    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
  });

  let handshake: AcpHandshake;
  try {
    const result = await child.connection.request(ACP_METHOD.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES as unknown as JsonValue,
    });

    if (!isInitializeResponse(result)) {
      throw adapterError('transport', 'The agent did not answer initialize with a protocol version.');
    }

    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      // Negotiation failed rather than succeeded quietly. Continuing would mean
      // speaking a dialect whose message shapes this module has never seen.
      throw adapterError(
        'transport',
        `The agent speaks ACP version ${String(result.protocolVersion)}; Artemis speaks ${String(ACP_PROTOCOL_VERSION)}.`,
      );
    }

    const capabilities = result.agentCapabilities ?? {};
    handshake = {
      protocolVersion: result.protocolVersion,
      agentCapabilities: capabilities,
      authMethods: result.authMethods ?? [],
      agentName: result.agentInfo?.name,
      agentVersion: result.agentInfo?.version,
      canFork: hasSessionCapability(capabilities, 'fork'),
      canList: hasSessionCapability(capabilities, 'list'),
      canResume: hasSessionCapability(capabilities, 'resume'),
      canLoadSession: capabilities.loadSession === true,
      acceptsImages: capabilities.promptCapabilities?.image === true,
      acceptsEmbeddedContext: capabilities.promptCapabilities?.embeddedContext === true,
    };
  } catch (error) {
    // Nothing is usable, so nothing should be left running.
    await child.dispose();
    throw error;
  }

  return new AcpClient(child, options, handshake);
}

/**
 * Put an approval request to the adapter, and answer it in the agent's own
 * vocabulary.
 *
 * The `cancelled` outcome is the answer whenever Artemis has no user to ask —
 * no handler installed, or the handler failed. ACP defines it as "the client
 * did not put this to a user", which is exactly true and, unlike picking a
 * rejection option, teaches the agent nothing about what the user wants.
 */
async function handlePermission(
  params: JsonValue | undefined,
  options: AcpClientOptions,
): Promise<JsonValue> {
  const cancelled = { outcome: { outcome: 'cancelled' } } as unknown as JsonValue;

  if (!isRequestPermissionRequest(params)) {
    options.onDiagnostic?.('Cancelled a malformed session/request_permission.', params);
    return cancelled;
  }
  if (options.onPermissionRequest === undefined) {
    return cancelled;
  }

  try {
    return (await options.onPermissionRequest(params)) as unknown as JsonValue;
  } catch (error) {
    options.onDiagnostic?.('The permission handler threw; the request was cancelled.', error);
    return cancelled;
  }
}
