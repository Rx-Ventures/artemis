/**
 * The agent loop, which for this provider is ours.
 * ============================================================================
 *
 * Claude's SDK, Codex's app-server and OpenCode's ACP peer each run this cycle
 * themselves and the adapter translates it. An inference server does not, so
 * here it is written out:
 *
 *     prompt ──► completion ──► tool calls? ──► approve ──► execute ──► append
 *                    ▲                                                    │
 *                    └────────────────────────────────────────────────────┘
 *
 * Kept apart from the transport so the whole cycle is testable against a faked
 * completion function, with no socket, no server and no model. That matters
 * more than usual: the failure modes worth testing are a model that loops
 * forever, a model that calls a tool that does not exist, and a user who
 * refuses — none of which a real model reproduces on demand.
 */

import type { ToolCall } from './stream.js';
import { executeTool } from './tools.js';
import type { ToolContext, ToolSpec } from './tools.js';

/** What the loop asks of the transport: one completion, streamed. */
export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSpec[];
}

/** One completion's outcome. */
export interface CompletionResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason?: string;
}

/** A message in the array sent to the server. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** Present on an assistant message that asked for tools. */
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  /** Present on a tool result, matching the call it answers. */
  readonly tool_call_id?: string;
}

/** What the user decided about one tool call. */
export type Approval = 'allow' | 'deny';

export interface LoopOptions {
  /** The conversation so far — the system prompt, if any, and the user's turn. */
  readonly initialMessages: readonly ChatMessage[];
  readonly complete: (request: CompletionRequest) => Promise<CompletionResult>;
  readonly tools: readonly ToolSpec[];
  readonly context: ToolContext;
  /**
   * Ask about a tool call. Returning `deny` puts a refusal where the result
   * would go, which the model can read and respond to.
   */
  readonly approve: (call: ToolCall, tool: ToolSpec) => Promise<Approval>;
  /** Told about each call and its result, for the transcript. */
  readonly onToolStart?: (call: ToolCall) => void;
  readonly onToolEnd?: (call: ToolCall, output: string, failed: boolean) => void;
  /**
   * Told about each message this turn adds to the conversation, as it is added.
   *
   * Deliberately the exact array a later turn has to replay — the assistant's
   * turn *with* its tool calls, then one result per call, then the final answer
   * — rather than a summary of what happened. The server has no memory of any
   * of it (see `sessionStore.ts`), so whatever this reports is what the model
   * will be told it said, and a message shaped for display rather than for the
   * wire would come back as a request the server rejects.
   *
   * Not given {@link initialMessages}: the caller already holds those, and the
   * history among them has been replayed rather than newly said.
   */
  readonly onAppend?: (message: ChatMessage) => void;
  /**
   * How many completions one turn may take.
   *
   * A ceiling rather than a target. Small models loop — calling the same tool
   * with the same arguments indefinitely is their most common failure — and
   * without a bound a single prompt runs until the user kills the app. Ten is
   * enough for real work and short enough that a loop is noticed in seconds.
   */
  readonly maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Run one turn to completion.
 *
 * Returns the assistant's final text. Every intermediate step — the tool calls,
 * their results, the refusals — is reported through the callbacks, because the
 * transcript needs them as they happen rather than in a summary at the end.
 */
export async function runAgentLoop(options: LoopOptions): Promise<string> {
  const max = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const messages: ChatMessage[] = [...options.initialMessages];
  let last = '';

  /**
   * Add to the conversation, and tell whoever is storing it.
   *
   * One place rather than four, so the array the loop sends and the array a
   * later turn replays cannot drift apart.
   */
  const append = (message: ChatMessage): void => {
    messages.push(message);
    options.onAppend?.(message);
  };

  for (let iteration = 0; iteration < max; iteration += 1) {
    const result = await options.complete({ messages, tools: options.tools });
    last = result.text;

    if (result.toolCalls.length === 0) {
      // The final answer is appended like any other message rather than merely
      // returned. Nothing downstream reads `messages` after this, so it is
      // recorded for the store alone — a transcript that stopped before the
      // reply would be a conversation the model is never reminded of giving.
      // An empty one is not recorded: some servers reject a contentless
      // assistant turn, and it would replay as a blank row.
      if (last !== '') append({ role: 'assistant', content: last });
      return last;
    }

    // The assistant's turn is recorded *with* its tool calls before any result
    // is appended. A server given results for calls it has no record of asking
    // for will reject the request.
    append({
      role: 'assistant',
      content: result.text,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    });

    for (const call of result.toolCalls) {
      const tool = options.tools.find((candidate) => candidate.name === call.name);
      options.onToolStart?.(call);

      // An unknown tool is answered rather than approved: there is nothing to
      // approve, and the model needs to hear that the name was wrong.
      if (tool === undefined) {
        const output = `No tool called "${call.name}" exists.`;
        options.onToolEnd?.(call, output, true);
        append({ role: 'tool', tool_call_id: call.id, content: output });
        continue;
      }

      const decision = await options.approve(call, tool);
      if (decision === 'deny') {
        // A refusal is a result, not an error. The model can propose something
        // else; ending the run would make every "no" a dead end.
        const output = 'The user declined to run this tool.';
        options.onToolEnd?.(call, output, true);
        append({ role: 'tool', tool_call_id: call.id, content: output });
        continue;
      }

      const executed = await executeTool(call.name, call.argumentsJson, options.context);
      options.onToolEnd?.(call, executed.output, executed.failed === true);
      append({ role: 'tool', tool_call_id: call.id, content: executed.output });
    }
  }

  // Hitting the ceiling is reported to the user rather than passed off as a
  // finished answer, because the two look identical otherwise and one of them
  // means the model was going in circles.
  return last === ''
    ? `Stopped after ${max} tool rounds without a final answer. The model may be looping.`
    : `${last}\n\n[Stopped after ${max} tool rounds. The model may be looping.]`;
}
