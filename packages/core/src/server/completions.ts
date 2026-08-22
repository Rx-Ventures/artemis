/**
 * Running a turn for an HTTP caller.
 * ============================================================================
 *
 * `POST /v1/chat/completions` is the endpoint that actually does something. A
 * client sends a conversation, Artemis starts an agent run under one of the
 * user's accounts, and the reply comes back in the shape every OpenAI client
 * already understands — either whole, or streamed.
 *
 * This module is that translation and nothing else. It does not own the port
 * (see `http.ts`), it does not know what a profile is (see the {@link RunSource}
 * seam), and it does not choose the directory (see `workspaces.ts`).
 *
 * ---------------------------------------------------------------------------
 * A TURN IS NOT A COMPLETION, AND THREE THINGS FOLLOW
 * ---------------------------------------------------------------------------
 *
 * **1. Nobody is watching, so nobody can answer a permission prompt.** An
 * agentic run can stop and ask. In the app a person answers; over HTTP there is
 * no person, and a request that parked on a prompt would hang until the client
 * timed out with no explanation. So every permission request is **denied
 * automatically**, with a message the model can act on, and the denial is
 * reported on the response. Denying is the only safe default: the alternative
 * is a program the user has not looked at approving file writes on their behalf.
 *
 * **2. The agent's tools are its own.** A run reads files and executes commands
 * internally; those are reported as {@link ArtemisActivity}, never as OpenAI
 * `tool_calls`, because a `tool_calls` reply is a request *to the client* and no
 * client can execute Claude Code's `Bash`. See `openai.ts` in protocol.
 *
 * **3. The client can vanish.** A browser tab closes, a script is `^C`'d. The
 * run keeps going — it is a real process doing real work on the user's disk —
 * unless someone stops it, so a disconnect interrupts it. Anything else spends
 * the user's plan on output nobody will ever read.
 */

import type {
  AgentEvent,
  ArtemisActivity,
  ArtemisChatExtensions,
  OpenAiChatChunk,
  OpenAiChatMessage,
  OpenAiChatRequest,
  OpenAiChatResponse,
  OpenAiFinishReason,
  OpenAiUsage,
  RunEndReason,
  RunHandle,
  RunId,
  ServerModel,
} from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

/** What one turn needs from the engine. */
export interface RunSource {
  /**
   * Start a run and resolve once it is registered.
   *
   * The shape is deliberately narrower than `RunInput`: this module may not
   * choose a permission mode, a system prompt or a set of tools, because those
   * are the user's settings and an HTTP caller is not the user.
   */
  startRun(input: {
    readonly providerId: string;
    readonly profileId: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
    readonly effort?: string;
    readonly fastMode?: boolean;
    readonly ultracode?: boolean;
    readonly resumeSessionId?: string;
  }): Promise<RunHandle>;

  /** Every event from every run. Filtered by `runId` here. */
  subscribe(listener: (event: AgentEvent) => void): () => void;

  /** Stop a run that is still going. Called when the client disconnects. */
  interrupt(runId: RunId): Promise<void>;

  /** Answer a permission request. See the file comment on why this always denies. */
  respondToPermission(
    runId: RunId,
    requestId: string,
    decision: { readonly behavior: 'deny'; readonly message?: string },
  ): Promise<void>;

  /** Release the run's resources once its reply has been written. */
  disposeRun(runId: RunId): Promise<void>;
}

/** Everything one turn needs, resolved by the caller before this is entered. */
export interface TurnRequest {
  readonly model: ServerModel;
  readonly cwd: string;
  readonly request: OpenAiChatRequest;
  readonly extensions: ArtemisChatExtensions;
  /** Parameters accepted but not applied, echoed back so a caller can see them. */
  readonly ignored: readonly string[];
  /** Aborts when the client hangs up. */
  readonly signal?: { readonly aborted: boolean; addEventListener?: unknown };
}

/* -------------------------------------------------------------------------- */
/* Reading the request                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Flatten OpenAI's `messages` into the one prompt a turn takes.
 *
 * The rule, and it is a real semantic choice rather than a simplification:
 * **the trailing user message is the turn.** Everything before it is either
 * already in the session (when the caller passed a `sessionId`) or is context
 * the caller is re-sending because OpenAI's API is stateless and theirs has to
 * be too.
 *
 * So earlier `user` and `assistant` messages are folded into a transcript
 * *prefix* only when there is no session to resume — otherwise the agent would
 * be handed its own history a second time and would answer as though the
 * conversation had happened twice.
 *
 * `system` and `developer` messages always survive, at the front: they are
 * instructions rather than history, and a caller that sets one on every request
 * means it every time.
 */
export function promptFromMessages(
  messages: readonly OpenAiChatMessage[],
  options: { readonly resuming: boolean },
): string {
  const systems: string[] = [];
  const history: string[] = [];
  let trailing = '';

  messages.forEach((message, index) => {
    const text = flattenContent(message.content);
    if (text.length === 0) return;

    if (message.role === 'system' || message.role === 'developer') {
      systems.push(text);
      return;
    }

    const isLast = index === messages.length - 1;
    if (isLast && message.role === 'user') {
      trailing = text;
      return;
    }

    // A `tool` message is a result the *client* produced for a tool call the
    // agent never made — Artemis's agents run their own. Carried as context
    // rather than dropped, because a caller that sent one meant something by it.
    history.push(`${message.role}: ${text}`);
  });

  const parts: string[] = [];
  if (systems.length > 0) parts.push(systems.join('\n\n'));
  if (!options.resuming && history.length > 0) {
    parts.push(`Earlier in this conversation:\n${history.join('\n')}`);
  }
  // The turn itself last, so it is the freshest thing the model reads. When a
  // caller sent only non-user messages this is empty and the history stands in.
  if (trailing.length > 0) parts.push(trailing);
  else if (options.resuming && history.length > 0) parts.push(history.join('\n'));

  return parts.join('\n\n').trim();
}

/** OpenAI allows a string or an array of parts; both have to be read. */
function flattenContent(content: OpenAiChatMessage['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part.type === 'text'
        ? part.text
        : // An image the transport cannot carry yet. Named rather than dropped
          // silently, so the model knows something was meant to be here.
          '[image omitted: the Artemis server does not forward images yet]',
    )
    .join('\n')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

/** What a finished turn produced. */
export interface TurnResult {
  readonly text: string;
  readonly finishReason: OpenAiFinishReason;
  readonly endReason: RunEndReason;
  readonly sessionId?: string;
  readonly usage?: OpenAiUsage;
  readonly activity: readonly ArtemisActivity[];
  /** Set when the run failed; the caller turns this into a 502. */
  readonly error?: string;
}

/** One streamed piece of a turn. */
export type TurnEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'activity'; readonly activity: ArtemisActivity }
  | {
      /**
       * The session this turn is writing to, announced as soon as it is known
       * rather than only on `done`.
       *
       * Exists for the client that wants to resume a conversation the moment it
       * can — an Artemis driving another Artemis emits its own
       * `session.started` from this — and for the caller whose stream dies
       * mid-turn, who would otherwise learn the id never. Emitted at most once
       * per id: a resumed turn's caller already holds it, so nothing is
       * announced unless the provider reports a different one.
       */
      readonly kind: 'session';
      readonly sessionId: string;
    }
  | { readonly kind: 'done'; readonly result: TurnResult };

/**
 * Start a run and yield its progress until it ends.
 *
 * An async generator rather than a callback so both surfaces read the same way:
 * the streaming handler forwards each event as it arrives, the non-streaming one
 * drains to the `done`. There is exactly one implementation of the run lifecycle,
 * which is what keeps the two from diverging on when a turn is over.
 */
export async function* runTurn(
  source: RunSource,
  turn: TurnRequest,
): AsyncGenerator<TurnEvent> {
  const resuming = turn.extensions.sessionId !== undefined;
  const prompt = promptFromMessages(turn.request.messages, { resuming });

  /*
   * A queue, because events arrive by callback and are consumed by `for await`.
   *
   * The subscription is attached *before* `startRun` resolves — a fast provider
   * can emit `session.started` and text before the promise settles, and a
   * listener attached afterwards would miss the opening of the turn.
   */
  const pending: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let runId: RunId | null = null;

  const unsubscribe = source.subscribe((event) => {
    // `runId` is null only in the window before `startRun` resolves; events for
    // *other* runs are filtered here, which is why one global subscription is
    // enough for any number of concurrent turns.
    if (runId !== null && event.runId !== runId) return;
    pending.push(event);
    notify?.();
  });

  const activity: ArtemisActivity[] = [];
  let text = '';
  /*
   * Seeded from the request when resuming, and that is a fix rather than a
   * convenience.
   *
   * A *new* session announces itself with `session.started`, so the id is
   * observed. A *resumed* one does not — the session already started, on an
   * earlier turn — and providers do not always repeat it on `run.end` either.
   * The response therefore came back with no `sessionId` from the second turn
   * onward, so a client following the documented pattern (send back what you
   * were given) lost the thread after exactly one exchange. Caught by holding a
   * real two-turn conversation with a Codex account.
   *
   * Echoing the id we were handed is honest: this turn did run in that session,
   * which is precisely what the field means. Anything the run reports later
   * overwrites it.
   */
  let sessionId: string | undefined = turn.extensions.sessionId;
  /*
   * The id the caller has already been told, so a fresh session is announced
   * exactly once and a resumed one — whose caller sent the id in — not at all.
   * See the `session` member of {@link TurnEvent}.
   */
  let announced: string | undefined = turn.extensions.sessionId;
  let usage: OpenAiUsage | undefined;
  let deniedPermission = false;

  try {
    let handle: RunHandle;
    try {
      handle = await source.startRun({
        providerId: turn.model.providerId,
        profileId: String(turn.model.profileId),
        cwd: turn.cwd,
        prompt,
        model: turn.model.id,
        ...(turn.extensions.thinking === undefined ? {} : { effort: turn.extensions.thinking }),
        ...(turn.extensions.fastMode === undefined ? {} : { fastMode: turn.extensions.fastMode }),
        ...(turn.extensions.ultracode === undefined
          ? {}
          : { ultracode: turn.extensions.ultracode }),
        ...(turn.extensions.sessionId === undefined
          ? {}
          : { resumeSessionId: turn.extensions.sessionId }),
      });
    } catch (error) {
      yield {
        kind: 'done',
        result: {
          text: '',
          finishReason: 'stop',
          endReason: 'error',
          activity: [],
          error: error instanceof Error ? error.message : 'The run could not be started.',
        },
      };
      return;
    }

    runId = handle.runId;
    if (handle.sessionId !== undefined) sessionId = String(handle.sessionId);
    if (sessionId !== undefined && sessionId !== announced) {
      announced = sessionId;
      yield { kind: 'session', sessionId };
    }

    // Events that arrived while `startRun` was in flight were queued with no
    // filter; drop any that turned out to belong to another run.
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]?.runId !== runId) pending.splice(index, 1);
    }

    while (!ended) {
      if (pending.length === 0) {
        // Waiting for the next event, or for a client that has gone away.
        if (turn.signal?.aborted === true) {
          await source.interrupt(runId).catch(() => undefined);
          // Keep draining: the run answers the interrupt with a `run.end`, and
          // leaving without it would strand the subscription.
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 250);
        });
        notify = null;
        continue;
      }

      const event = pending.shift();
      if (event === undefined) continue;

      switch (event.type) {
        case 'session.started':
          sessionId = String(event.sessionId);
          if (sessionId !== announced) {
            announced = sessionId;
            yield { kind: 'session', sessionId };
          }
          break;

        case 'text.delta':
          text += event.text;
          yield { kind: 'text', text: event.text };
          break;

        case 'text.complete':
          /*
           * Only when nothing streamed.
           *
           * Providers that stream emit deltas *and* a completing block with the
           * whole text; appending both would double every reply. `partialMessages`
           * says which a provider does, but the honest check is whether anything
           * actually arrived — an adapter that claims streaming and sends none
           * would otherwise produce an empty answer.
           */
          if (event.role === 'assistant' && text.length === 0) {
            text += event.text;
            yield { kind: 'text', text: event.text };
          }
          break;

        case 'tool.start': {
          const entry: ArtemisActivity = {
            tool: event.name.toLowerCase(),
            at: Date.now(),
            ...(summariseToolInput(event.input) === undefined
              ? {}
              : { summary: summariseToolInput(event.input) }),
          };
          activity.push(entry);
          yield { kind: 'activity', activity: entry };
          break;
        }

        case 'permission.request':
          /*
           * Denied, always, because there is nobody here to ask.
           *
           * The message is written for the *model*: it explains the constraint so
           * the agent can choose another route, rather than reading as a fault.
           */
          deniedPermission = true;
          await source
            .respondToPermission(runId, String(event.requestId), {
              behavior: 'deny',
              message:
                'This turn is running through the Artemis HTTP server, where no one is present to approve tool use. Continue without this action, or explain what you would need.',
            })
            .catch(() => undefined);
          break;

        case 'usage':
          usage = toOpenAiUsage(event.usage.tokens);
          break;

        case 'run.end': {
          ended = true;
          if (event.sessionId !== undefined) sessionId = String(event.sessionId);
          if (event.usage !== undefined) usage = toOpenAiUsage(event.usage.tokens);
          // The provider's own summary, when it wrote one and nothing streamed.
          if (text.length === 0 && event.result !== undefined) text = event.result;

          yield {
            kind: 'done',
            result: {
              text,
              finishReason: finishReasonFor(event.reason),
              endReason: event.reason,
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(usage === undefined ? {} : { usage }),
              activity,
              ...(event.reason === 'error'
                ? { error: event.error?.message ?? 'The run failed.' }
                : {}),
              ...(deniedPermission && event.reason === 'permission_denied'
                ? { error: 'The agent needed permission that no one was present to give.' }
                : {}),
            },
          };
          break;
        }

        default:
          // `thinking.delta`, `tool.end`, `permission.resolved`,
          // `background.tasks`. Not silently dropped by accident — none of them
          // has a place in an OpenAI reply, and thinking in particular must not
          // be concatenated into `content`, where a caller would read a model's
          // private reasoning as its answer.
          break;
      }
    }
  } finally {
    unsubscribe();

    /*
     * Interrupt on *any* teardown, not just an observed abort.
     *
     * The in-loop `signal.aborted` check only runs while something is pulling
     * from this generator. When a client disconnects, the thing pulling — the
     * SSE writer — stops, and the generator is left suspended at a `yield`
     * with the run still going: the loop never gets another turn, so it never
     * notices, and the provider keeps spending the user's plan on output that
     * will never be read.
     *
     * `finally` runs whichever way the generator ends, including `.return()`
     * from a consumer that walked away, so this is the one place the guarantee
     * can actually be made. `ended` is what keeps a completed turn from being
     * pointlessly interrupted on its way out.
     *
     * Found by the abort test, which passed the in-loop check and still saw the
     * run left running.
     */
    if (runId !== null) {
      if (!ended) await source.interrupt(runId).catch(() => undefined);
      await source.disposeRun(runId).catch(() => undefined);
    }
  }
}

/**
 * OpenAI's four finish reasons, from Artemis's seven end reasons.
 *
 * Everything that is not "ran out of room" reports `stop`, and the true reason
 * travels on `artemis.endReason`. A client switches on `finish_reason`, so a
 * value outside OpenAI's set is an unhandled branch in code we do not own —
 * whereas an extra field it does not read costs it nothing.
 */
export function finishReasonFor(reason: RunEndReason): OpenAiFinishReason {
  return reason === 'max_turns' || reason === 'budget_exceeded' ? 'length' : 'stop';
}

/** Artemis counts more kinds of token than OpenAI reports; these are the three it has. */
function toOpenAiUsage(tokens: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): OpenAiUsage {
  return {
    prompt_tokens: tokens.inputTokens,
    completion_tokens: tokens.outputTokens,
    total_tokens: tokens.inputTokens + tokens.outputTokens,
  };
}

/**
 * One line naming what a tool acted on — never what it found.
 *
 * A path, a command, a pattern. Deliberately not the tool's *result*: that is
 * file contents, and a caller reading activity wants to know the agent read
 * `src/index.ts`, not to receive it.
 */
function summariseToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 200);
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Shaping the reply                                                          */
/* -------------------------------------------------------------------------- */

/** Build the whole-response body an OpenAI client expects. */
export function chatResponse(input: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly result: TurnResult;
  readonly ignored: readonly string[];
  readonly resolvedModel?: string;
}): OpenAiChatResponse {
  const { result } = input;
  return {
    id: input.id,
    object: 'chat.completion',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: result.finishReason,
      },
    ],
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    artemis: {
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      ...(input.resolvedModel === undefined ? {} : { resolvedModel: input.resolvedModel }),
      ...(input.ignored.length === 0 ? {} : { ignored: input.ignored }),
      ...(result.activity.length === 0 ? {} : { activity: result.activity }),
      endReason: result.endReason,
    },
  };
}

/** One streamed chunk, in OpenAI's shape. */
export function chatChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly delta: { readonly role?: 'assistant'; readonly content?: string };
  readonly finishReason?: OpenAiFinishReason;
  readonly usage?: OpenAiUsage;
  readonly artemis?: OpenAiChatChunk['artemis'];
}): OpenAiChatChunk {
  return {
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.artemis === undefined ? {} : { artemis: input.artemis }),
  };
}
