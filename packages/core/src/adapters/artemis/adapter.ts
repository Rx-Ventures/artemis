/**
 * The Artemis-server adapter — one Artemis driving another.
 * ============================================================================
 *
 * `packages/core/src/server` is the half of this that *serves*: it runs a full
 * agent turn under one of the user's profiles and streams it out as an
 * OpenAI-shaped completion. This is the other half — the provider row that
 * lets *this* Artemis be the client, pointed at that server on another machine
 * over whatever tunnel reaches its loopback.
 *
 * ## What is different about this provider
 *
 * The other endpoint providers (`local/adapter.ts`) wrap inference servers, so
 * the agent loop is Artemis's own: it offers tools, executes them here, and
 * asks permission here. The Artemis server is the opposite — **the remote end
 * already ran the whole agent turn**. Reusing the local adapter (or pointing a
 * llamacpp profile at this server) would put a second harness around a
 * finished one: tools offered twice, a `cwd` that names a directory on the
 * wrong machine, permission prompts for work that already happened. So this
 * adapter is a renderer of someone else's run: one streamed request per turn,
 * no loop, no tools, no sandbox.
 *
 * Three consequences, each carried on the capability descriptor rather than
 * discovered by a user:
 *
 *  - **Turns run in the connection's workspace, on the server's machine.**
 *    The remote pins its working directory per connection token when the
 *    token is created; the `cwd` chosen here does not travel (there is
 *    deliberately no `cwd` on the wire — see `protocol/src/server.ts`).
 *  - **Permission prompts are auto-denied over there.** Nobody is present at
 *    the server to approve tool use, so `interactivePermissions` is false and
 *    no mode picker is offered.
 *  - **The conversation lives on the server.** It stores real sessions, so
 *    `resumeSession` is honestly true: the `artemis.sessionId` a turn reports
 *    is passed back to continue it — the one capability the raw local
 *    endpoints cannot offer.
 *
 * ## The profile is an endpoint, and the key is a connection token
 *
 * Same entry model as the local providers: `baseUrl` for the address, and the
 * encrypted per-profile key for the credential — here the *connection token*
 * the serving Artemis minted, sent as the same `Authorization: Bearer` the
 * local servers read.
 */

import type {
  AgentError,
  AgentEvent,
  ArtemisActivity,
  Capabilities,
  MessageId,
  ProviderId,
  RunEndReason,
  RunId,
  RunStatus,
  SessionId,
  ToolCallId,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import {
  defaultBaseUrlFor,
  LOCAL_API_KEY_ENV,
  LOCAL_BASE_URL_ENV,
  NO_CAPABILITIES,
  SERVER_API_VERSION,
} from '@rx-artemis/protocol';

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
import { splitEvents } from '../local/stream.js';
import { parseServerModels } from './catalogue.js';
import { readServerLine } from './stream.js';

export const ARTEMIS_PROVIDER_ID: ProviderId = 'artemis';

/** The server's own API, versioned the way `server/http.ts` builds it. */
const API_PREFIX = `/api/${SERVER_API_VERSION}`;

/**
 * What driving a remote Artemis can honestly claim.
 *
 * Read the `false` rows against the module header: most are not "not yet" but
 * "not here" — the work happens on the server's machine, under the server's
 * own settings, and claiming a control this side cannot honour would be worse
 * than omitting it.
 */
export const ARTEMIS_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  // The server streams text fragments as the remote agent produces them.
  partialMessages: true,
  // Final chunks carry token counts when the remote provider reported them.
  usageReporting: true,
  // The server stores real sessions; `artemis.sessionId` continues one. The
  // raw local endpoints cannot say this — their server remembers nothing.
  resumeSession: true,
  // Permission prompts are auto-denied at the server (nobody is present
  // there), so offering an approval surface or a mode picker here would be
  // claiming a control that does not exist. Empty modes, no interactivity.
  interactivePermissions: false,
  permissionModes: [],
  // The remote agent's own instructions are the serving user's settings; a
  // `system` message would be folded into the prompt text over there, which
  // is not what "append to the system prompt" promises.
  systemPromptAppend: false,
};

/** No account to sign in to — the credential is the server's connection token. */
function artemisCredentials(): ProviderCredentialSpec {
  return {
    // Nothing is spawned, so nothing reads this — but the field is required
    // and an inert, clearly-named variable is more honest than borrowing one.
    configDirVar: 'ARTEMIS_LOCAL_PROFILE_DIR',
    // Both are set by Artemis from the profile, so both must be scrubbed from
    // whatever the user's shell happens to export — the same reasoning as the
    // local adapter, whose variables these are.
    credentialEnvKeys: [LOCAL_BASE_URL_ENV, LOCAL_API_KEY_ENV],
    signIn: {
      executable: 'true',
      loginArgs: [],
      statusArgs: [],
      logoutArgs: [],
      howTo:
        'Nothing to sign in to here. Point this profile at a running Artemis server and paste one of its connection tokens as the API key.',
      // Signed in exactly when the server answers, which the availability
      // probe already establishes.
      parseStatus: () => ({ loggedIn: true }),
    },
  };
}

/** The endpoint this profile talks to. */
function baseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const declared = env[LOCAL_BASE_URL_ENV];
  const chosen =
    declared !== undefined && declared.trim() !== ''
      ? declared.trim()
      : defaultBaseUrlFor(ARTEMIS_PROVIDER_ID);
  return chosen.replace(/\/+$/, '');
}

/**
 * Headers for a request to that endpoint. `Bearer`, because that is what the
 * server's `resolveConnection` reads; no header at all when there is no token,
 * for the same proxy reasons as the local adapter.
 */
function authHeaders(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const key = env[LOCAL_API_KEY_ENV];
  return key !== undefined && key.trim() !== '' ? { authorization: `Bearer ${key.trim()}` } : {};
}

/** Token counts in the shape the seam expects. */
function toUsage(usage: { promptTokens: number; completionTokens: number }): UsageSnapshot {
  return {
    scope: 'final',
    tokens: { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
  };
}

/** The seven end reasons cross the wire as strings; read one back safely. */
const END_REASONS: readonly RunEndReason[] = [
  'completed',
  'interrupted',
  'disposed',
  'max_turns',
  'budget_exceeded',
  'permission_denied',
  'error',
];

function asEndReason(value: string | undefined): RunEndReason | undefined {
  return (END_REASONS as readonly string[]).includes(value ?? '')
    ? (value as RunEndReason)
    : undefined;
}

/**
 * One turn against a remote Artemis.
 *
 * Opens one streamed completion and renders it: deltas as they arrive, then
 * the final chunk's activity report as settled tool rows, then `run.end`.
 *
 * ## The session id is never guessed
 *
 * `session.started` is emitted with a *real* id or not at all. On a resumed
 * turn the id is known up front and the event is first, as the contract asks.
 * On a fresh turn the server announces the id on an early chunk (older servers
 * only on the final one), and the event is emitted the moment it arrives —
 * which against an older server means after the first text deltas. That bends
 * the ordering contract, deliberately: the alternative is the local adapter's
 * placeholder id, and with `resumeSession: true` a placeholder that leaked
 * into `run.end` on a failed stream would be promoted to the pane's resume
 * target — a session the server has never heard of, poisoning every following
 * turn. A late `session.started` renders fine; a fabricated session id does
 * not.
 */
class ArtemisRun implements Run {
  readonly runId: RunId;
  readonly providerId: ProviderId = ARTEMIS_PROVIDER_ID;
  readonly capabilities = ARTEMIS_CAPABILITIES;

  #status: RunStatus = 'running';
  #seq = 0;
  #sessionId: SessionId | undefined;
  #sessionAnnounced = false;
  #usage: UsageSnapshot | undefined;
  readonly #queue = new AsyncQueue<AgentEvent>();
  readonly #abort = new AbortController();
  readonly #input: ResolvedRunInput;

  constructor(input: ResolvedRunInput) {
    this.runId = input.runId;
    this.#input = input;
    void this.#drive();
  }

  get status(): RunStatus {
    return this.#status;
  }

  get sessionId(): SessionId | undefined {
    return this.#sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#queue;
  }

  #emit(event: Omit<AgentEvent, 'runId' | 'seq' | 'ts'>): void {
    this.#queue.push({
      ...event,
      runId: this.runId,
      seq: this.#seq++,
      ts: Date.now(),
    } as AgentEvent);
  }

  /** Emit `session.started` once, only ever with an id the server owns. */
  #noteSession(sessionId: string): void {
    this.#sessionId = sessionId as SessionId;
    if (this.#sessionAnnounced) return;
    this.#sessionAnnounced = true;
    this.#emit({
      type: 'session.started',
      sessionId: this.#sessionId,
      providerId: ARTEMIS_PROVIDER_ID,
      cwd: this.#input.cwd,
      ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
      ...(this.#input.resumeSessionId === undefined
        ? {}
        : { resumedFrom: this.#input.resumeSessionId }),
    } as never);
  }

  async #drive(): Promise<void> {
    try {
      // A resumed turn knows its session before the first byte arrives.
      if (this.#input.resumeSessionId !== undefined) {
        this.#noteSession(this.#input.resumeSessionId);
      }

      const root = baseUrl(this.#input.env);
      const extensions = {
        ...(this.#input.resumeSessionId === undefined
          ? {}
          : { sessionId: this.#input.resumeSessionId }),
        ...(this.#input.fastMode === undefined ? {} : { fastMode: this.#input.fastMode }),
        ...(this.#input.ultracode === undefined ? {} : { ultracode: this.#input.ultracode }),
      };
      const response = await fetch(`${root}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(this.#input.env) },
        signal: this.#abort.signal,
        body: JSON.stringify({
          model: this.#input.model,
          messages: [{ role: 'user', content: this.#input.prompt }],
          stream: true,
          stream_options: { include_usage: true },
          ...(Object.keys(extensions).length === 0 ? {} : { artemis: extensions }),
        }),
      });

      if (!response.ok || response.body === null) {
        throw await refusalError(response, root);
      }

      const messageId = `${this.runId}-0` as MessageId;
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let activity: readonly ArtemisActivity[] = [];
      let endReason: string | undefined;

      stream: for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const { lines, rest } = splitEvents(buffer);
        buffer = rest;

        for (const line of lines) {
          const delta = readServerLine(line);
          if (delta === null) continue;
          if (delta === 'done') break stream;

          if (delta.error !== undefined) throw adapterError('provider_unavailable', delta.error);
          if (delta.artemis?.sessionId !== undefined) this.#noteSession(delta.artemis.sessionId);
          // The final chunk's report replaces, not appends — it is the whole
          // list, arriving once.
          if (delta.artemis?.activity !== undefined) activity = delta.artemis.activity;
          if (delta.artemis?.endReason !== undefined) endReason = delta.artemis.endReason;
          if (delta.usage !== undefined) this.#usage = toUsage(delta.usage);
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

      /*
       * The activity report, rendered as settled tool rows. It arrives whole
       * on the final chunk, so these rows land after the text — a summary of
       * what the remote agent did, not a live feed of it doing so. Each entry
       * is already summarised to a target, never contents.
       */
      activity.forEach((entry, index) => {
        const toolCallId = `${this.runId}-act-${index}` as ToolCallId;
        this.#emit({
          type: 'tool.start',
          toolCallId,
          name: entry.tool,
          input: {},
          ...(entry.summary === undefined ? {} : { title: entry.summary }),
        } as never);
        this.#emit({
          type: 'tool.end',
          toolCallId,
          name: entry.tool,
          status: entry.ok === false ? 'error' : 'ok',
          ...(entry.summary === undefined ? {} : { resultText: entry.summary }),
        } as never);
      });

      if (text !== '') {
        this.#emit({ type: 'text.complete', messageId, role: 'assistant', text } as never);
      }

      const reason = asEndReason(endReason) ?? 'completed';
      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason,
        ...(reason === 'error'
          ? {
              error: {
                code: 'unknown',
                message:
                  'The remote run failed. The server reported the detail in the reply text, when it had one.',
              } satisfies AgentError,
            }
          : {}),
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
        ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      } as never);
    } catch (error) {
      const aborted = this.#abort.signal.aborted;
      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason: aborted ? 'interrupted' : 'error',
        ...(aborted ? {} : { error: toError(error) }),
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      } as never);
    } finally {
      this.#queue.close();
    }
  }

  send(): Promise<SendResult> {
    // Refused rather than queued: without `midRunSteering` the composer is
    // already disabled, and a message silently delivered a turn later is
    // worse than one plainly not accepted.
    return Promise.reject(
      adapterError('invalid_request', 'An Artemis server cannot take a message mid-turn.'),
    );
  }

  interrupt(): Promise<InterruptResult> {
    // Aborting the request is the interrupt: the server treats a vanished
    // client as "stop the run" — see the `finally` in `server/completions.ts`.
    this.#abort.abort();
    return Promise.resolve({ stillQueued: [] });
  }

  respondToPermission(): Promise<void> {
    // Never emitted here — prompts are denied at the server — so an answer is
    // a caller confused about which run it is talking to.
    return Promise.reject(
      adapterError('invalid_request', 'Artemis-server runs have no permission prompts to answer.'),
    );
  }

  dispose(): Promise<void> {
    this.#abort.abort();
    this.#queue.close();
    return Promise.resolve();
  }
}

/** Read a refusal body — `ServerErrorBody` when the server wrote one. */
async function refusalError(
  response: { readonly status: number; json(): Promise<unknown> },
  root: string,
): Promise<AdapterError> {
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    detail = typeof body.error?.message === 'string' ? body.error.message : undefined;
  } catch {
    /* a refusal with no JSON body still gets the status-line message below */
  }

  if (response.status === 401 || response.status === 403) {
    return adapterError(
      'auth',
      `The Artemis server at ${root} refused the request (${response.status}). Check this profile's API key — it should be one of that server's connection tokens.`,
    );
  }
  if (response.status === 404) {
    return adapterError(
      'model_unavailable',
      detail ?? 'The server does not offer that model route. Refresh the model list and pick again.',
    );
  }
  return adapterError(
    'provider_unavailable',
    detail ?? `The Artemis server at ${root} answered ${response.status}.`,
  );
}

/** Normalise a thrown value into the error a `run.end` carries. */
function toError(error: unknown): AgentError {
  if (error instanceof AdapterError) return error.agentError;
  if (error instanceof Error && error.name === 'AbortError') {
    return adapterError('cancelled', 'The run was stopped.').agentError;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return adapterError('provider_unavailable', `Could not reach the Artemis server. ${detail}`)
    .agentError;
}

/** Build the adapter. */
export function createArtemisAdapter(): ProviderAdapter {
  return {
    id: ARTEMIS_PROVIDER_ID,
    label: 'Artemis Server',
    credentials: artemisCredentials(),
    capabilities: ARTEMIS_CAPABILITIES,

    /*
     * Probes `/api/v0/connection` rather than the model list: it is the
     * cheapest authenticated read, and its answer *is* the two things a
     * profile can have wrong — the address, and the token. Honours the
     * profile's address for the reason the local adapter documents.
     */
    async checkAvailability(query) {
      const root = baseUrl(query?.env ?? {});
      try {
        const response = await fetch(`${root}${API_PREFIX}/connection`, {
          headers: authHeaders(query?.env ?? {}),
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return { available: true as const };
        // 401/403 is the server working correctly and refusing *us* — a
        // different problem from a server that is not there, and the one a
        // profile with no token pasted hits first.
        const reason =
          response.status === 401 || response.status === 403
            ? `The Artemis server at ${root} refused the request (${response.status}). Paste one of its connection tokens into this profile's API key field.`
            : `The Artemis server at ${root} answered ${response.status}.`;
        return { available: false as const, unavailableReason: reason };
      } catch {
        return {
          available: false as const,
          unavailableReason: `Nothing is answering at ${root}. Is the Artemis server running, and is its address reachable from this machine?`,
        };
      }
    },

    /**
     * Ask the server what routes this connection may run. Never rejects: an
     * unreachable server is an ordinary state, and the picker saying "nothing
     * confirmed" is the honest answer.
     */
    async listModels(query) {
      const root = baseUrl(query.env ?? {});
      try {
        const response = await fetch(`${root}${API_PREFIX}/models`, {
          headers: authHeaders(query.env ?? {}),
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const models = parseServerModels(await response.json());
          if (models.length > 0) return { models, live: true };
        }
      } catch {
        /* fall through to the not-confirmed answer */
      }
      return { models: [], live: false };
    },

    createRun(input: ResolvedRunInput): Promise<Run> {
      // Strict about what the wire cannot carry — the same rule every adapter
      // follows, and doubly important where the run happens on another
      // machine: silently dropping a setting here means it is silently
      // different over there.
      if (input.permissionMode !== undefined) {
        return Promise.reject(
          adapterError(
            'invalid_request',
            'Artemis-server runs take no permission mode: prompts are auto-denied at the server.',
          ),
        );
      }
      if (input.forkSession === true || input.rewindToMessageId !== undefined) {
        return Promise.reject(
          adapterError('invalid_request', 'The Artemis server cannot fork or rewind a session yet.'),
        );
      }
      if (input.model === undefined || input.model.trim() === '') {
        return Promise.reject(
          adapterError(
            'invalid_request',
            'An Artemis-server run names a route from its catalogue (profile/model). Pick a model first.',
          ),
        );
      }
      return Promise.resolve(new ArtemisRun(input));
    },
  } as ProviderAdapter;
}
