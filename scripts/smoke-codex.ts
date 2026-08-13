/**
 * Headless end-to-end smoke test for the Codex adapter.
 *
 * The counterpart to `smoke.ts`, exercising the other transport:
 *
 * ```
 *   resolveEnv-shaped bundle  (CODEX_HOME → an isolated config directory)
 *          ↓
 *   Codex adapter  →  spawn `codex app-server`  →  JSON-RPC over stdio
 *          ↓
 *   normalized AgentEvents, printed as they arrive
 * ```
 *
 * It also *checks* the events rather than only printing them: the ordering
 * rules on `AgentEvent` are a contract, and a smoke test that renders a
 * plausible-looking transcript while violating them is worse than none.
 *
 * ## Usage
 *
 * ```sh
 * pnpm build:libs
 * npx tsx scripts/smoke-codex.ts "your prompt here"
 * ```
 *
 * By default it points `CODEX_HOME` at your real `~/.codex`, because that is
 * where you are already signed in — the same thing Artemis supports a profile
 * doing. Set `CODEX_SMOKE_HOME` to use a different directory. The *workspace*
 * the agent runs in is always a fresh `mkdtemp` that is removed on the way out.
 *
 * Exit codes: `0` the run ended normally, `1` the run ended in an error or
 * broke the event contract, `2` the script could not get as far as starting.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, PermissionMode } from '@rx-artemis/protocol';
import { createCodexAdapter } from '@rx-artemis/core';
import type { ResolvedRunInput } from '@rx-artemis/core';

const PROMPT = process.argv[2] ?? 'Reply with exactly the word PONG. Do not use any tools.';
const CODEX_HOME = process.env['CODEX_SMOKE_HOME'] ?? join(homedir(), '.codex');

/**
 * Which permission mode to run in.
 *
 * Defaults to `plan`, which is read-only and prompts for nothing — the right
 * default for something you run casually. Set `CODEX_SMOKE_MODE=default` to
 * exercise the approval path, where the run really does park until this script
 * answers.
 */
const MODE = (process.env['CODEX_SMOKE_MODE'] ?? 'plan') as PermissionMode;

/**
 * How to answer prompts. `deny` by default so an unattended run cannot be
 * talked into doing something; `allow` exercises the accept path.
 */
const ANSWER = process.env['CODEX_SMOKE_ANSWER'] === 'allow' ? 'allow' : 'deny';

function label(event: AgentEvent): string {
  switch (event.type) {
    case 'session.started':
      return `session ${event.sessionId} in ${event.cwd}`;
    case 'text.delta':
      return JSON.stringify(event.text);
    case 'text.complete':
      return `[${event.role}] ${event.text.slice(0, 120)}`;
    case 'thinking.delta':
      return `${event.text.slice(0, 60)}…`;
    case 'tool.start':
      return `${event.name} ${event.title ?? ''}`;
    case 'tool.end':
      return `${event.name ?? '?'} → ${event.status}${event.durationMs === undefined ? '' : ` (${String(event.durationMs)}ms)`}`;
    case 'permission.request':
      return `${event.request.toolName}: ${event.request.title ?? ''}`;
    case 'permission.resolved':
      return `${event.requestId} ${event.outcome}`;
    case 'usage':
      return `${event.usage.scope} in=${String(event.usage.tokens.inputTokens)} out=${String(event.usage.tokens.outputTokens)}`;
    // Codex has no background-task surface of its own, so this is here to keep
    // the switch exhaustive rather than because this script expects to see one.
    case 'background.tasks':
      return `${String(event.tasks.length)} background task(s)`;
    case 'run.end':
      return `${event.reason}${event.error === undefined ? '' : ` — ${event.error.message}`}`;
  }
}

/** Check the rules `AgentEvent` documents as a contract, not as advice. */
function checkContract(events: readonly AgentEvent[]): string[] {
  const problems: string[] = [];

  if (events.length === 0) return ['no events at all'];
  if (events[0]?.type !== 'session.started') {
    problems.push(`first event was ${events[0]?.type ?? 'none'}, expected session.started`);
  }
  if (events.at(-1)?.type !== 'run.end') {
    problems.push(`last event was ${events.at(-1)?.type ?? 'none'}, expected run.end`);
  }

  const ends = events.filter((e) => e.type === 'run.end');
  if (ends.length !== 1) problems.push(`${String(ends.length)} run.end events, expected exactly 1`);

  events.forEach((event, index) => {
    if (event.seq !== index) problems.push(`seq ${String(event.seq)} at position ${String(index)}`);
  });

  const started = new Set<string>();
  const ended = new Set<string>();
  for (const event of events) {
    if (event.type === 'tool.start') started.add(event.toolCallId);
    if (event.type === 'tool.end') {
      if (ended.has(event.toolCallId)) problems.push(`tool ${event.toolCallId} ended twice`);
      ended.add(event.toolCallId);
    }
  }
  for (const id of started) {
    if (!ended.has(id)) problems.push(`tool ${id} started but never ended`);
  }

  // Deltas must reconstruct the completed block exactly.
  const streams = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'text.delta') {
      streams.set(event.messageId, (streams.get(event.messageId) ?? '') + event.text);
    }
  }
  for (const event of events) {
    if (event.type === 'text.complete' && event.role === 'assistant') {
      const streamed = streams.get(event.messageId);
      if (streamed !== undefined && streamed !== event.text) {
        problems.push(`deltas for ${event.messageId} do not reconstruct text.complete`);
      }
    }
  }

  return problems;
}

async function main(): Promise<number> {
  const workspace = await mkdtemp(join(tmpdir(), 'artemis-codex-smoke-'));
  console.log(`workspace  ${workspace}`);
  console.log(`CODEX_HOME ${CODEX_HOME}`);
  console.log(`mode       ${MODE} (answering prompts: ${ANSWER})`);
  console.log(`prompt     ${PROMPT}\n`);

  const adapter = createCodexAdapter({
    onDiagnostic: (message, detail) => {
      console.log(`  · ${message}${detail === undefined ? '' : ` ${String(detail)}`}`);
    },
  });

  const availability = await adapter.checkAvailability?.();
  if (availability !== undefined && !availability.available) {
    console.error(`unavailable: ${availability.unavailableReason ?? ''}`);
    await rm(workspace, { recursive: true, force: true });
    return 2;
  }

  const input: ResolvedRunInput = {
    providerId: 'codex',
    profileId: 'smoke',
    runId: 'smoke-run',
    cwd: workspace,
    prompt: PROMPT,
    env: { CODEX_HOME },
    permissionMode: MODE,
  };

  const events: AgentEvent[] = [];
  let exitCode = 0;

  try {
    const run = await adapter.createRun(input);

    for await (const event of run.events) {
      events.push(event);
      console.log(`${String(event.seq).padStart(3)} ${event.type.padEnd(18)} ${label(event)}`);

      if (event.type === 'permission.request') {
        // The run is genuinely parked here — the app server is waiting on the
        // JSON-RPC response this call produces, and will wait forever.
        console.log(`      → ${ANSWER}`);
        await run.respondToPermission(
          event.requestId,
          ANSWER === 'allow' ? { behavior: 'allow' } : { behavior: 'deny' },
        );
      }
      if (event.type === 'run.end' && event.reason === 'error') exitCode = 1;
    }

    await run.dispose();
  } catch (error) {
    console.error(`\nfailed to start: ${error instanceof Error ? error.message : String(error)}`);
    await rm(workspace, { recursive: true, force: true });
    return 2;
  }

  const problems = checkContract(events);
  console.log(`\n${String(events.length)} events`);
  if (problems.length === 0) {
    console.log('event contract: OK');
  } else {
    console.log('event contract: VIOLATED');
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    exitCode = 1;
  }

  await rm(workspace, { recursive: true, force: true });
  return exitCode;
}

process.exitCode = await main();
