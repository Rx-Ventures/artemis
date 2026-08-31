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
 * Set `CODEX_SMOKE_RESUME=1` for a second turn: after the first run ends, the
 * script checks whether Codex left a rollout file for the session on disk —
 * printed loudly as PERSISTED or MISSING, because a session with no rollout is
 * one no follow-up message can ever reach — then resumes the session and
 * checks that its `session.started` carries `resumedFrom`.
 *
 * Exit codes: `0` the run ended normally, `1` the run ended in an error or
 * broke the event contract, `2` the script could not get as far as starting.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

/**
 * Run a second, resumed turn after the first completes.
 *
 * Off by default because it doubles what the smoke costs. This is the probe
 * for "cannot send follow-up messages": did turn one leave a rollout file on
 * disk, and does `thread/resume` then reach it?
 */
const RESUME = process.env['CODEX_SMOKE_RESUME'] === '1';

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
    // Codex has neither a background-task surface, a command list, nor a live
    // plan-limit signal of its own, so these are here to keep the switch
    // exhaustive rather than because this script expects to see one.
    case 'background.tasks':
      return `${String(event.tasks.length)} background task(s)`;
    case 'session.commands':
      return `${String(event.slashCommands.length)} slash command(s)`;
    case 'plan.limit':
      return `${event.limit.status} on ${event.limit.windowId ?? 'an unnamed window'}`;
    case 'command.run':
      return `/${event.command.name}`;
    case 'message.delivered':
      return `read ${event.messageId}`;
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

/**
 * Locate the rollout file a session should have left on disk.
 *
 * Codex writes one JSONL per thread under `$CODEX_HOME/sessions/`, sharded by
 * date (`YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`), with the thread
 * id in the filename. Found-or-not is the whole answer: a session Artemis can
 * name but Codex never persisted is one no follow-up message can ever reach.
 */
async function findRolloutFile(codexHome: string, sessionId: string): Promise<string | undefined> {
  const root = join(codexHome, 'sessions');
  try {
    const entries = await readdir(root, { recursive: true });
    const match = entries.find((entry) => entry.includes(sessionId));
    return match === undefined ? undefined : join(root, match);
  } catch {
    // No sessions directory at all — nothing was ever persisted there.
    return undefined;
  }
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

  // The follow-up-message probe, ported from `opencode-smoke.ts`: resume the
  // session the first turn created and watch what comes back.
  const sessionId = events.find((e) => e.type === 'session.started')?.sessionId;
  if (RESUME && sessionId === undefined) {
    console.log('\n✗ resume requested, but the first run never reported a session id');
    exitCode = 1;
  }
  if (RESUME && sessionId !== undefined) {
    // Disk first, server second: whether a rollout file exists is a fact this
    // script can read without asking Codex, and it decides how to interpret
    // whatever `thread/resume` says next.
    const rollout = await findRolloutFile(CODEX_HOME, sessionId);
    if (rollout === undefined) {
      console.log(
        `\n!!! rollout MISSING — nothing for ${sessionId} under ${join(CODEX_HOME, 'sessions')}`,
      );
      exitCode = 1;
    } else {
      console.log(`\n✓ rollout PERSISTED — ${rollout}`);
    }

    console.log(`\nresuming ${sessionId}`);
    try {
      const resumed = await adapter.createRun({
        ...input,
        runId: 'smoke-run-2',
        prompt: 'In one word, what did you just say?',
        resumeSessionId: sessionId,
      });

      let resumedFrom: string | undefined;
      for await (const event of resumed.events) {
        console.log(`${String(event.seq).padStart(3)} ${event.type.padEnd(18)} ${label(event)}`);
        if (event.type === 'session.started') resumedFrom = event.resumedFrom;
        if (event.type === 'permission.request') {
          console.log(`      → ${ANSWER}`);
          await resumed.respondToPermission(
            event.requestId,
            ANSWER === 'allow' ? { behavior: 'allow' } : { behavior: 'deny' },
          );
        }
        if (event.type === 'run.end' && event.reason === 'error') exitCode = 1;
      }
      await resumed.dispose();

      // A resumed stream that does not say so would splice into the renderer
      // as a brand-new conversation.
      if (resumedFrom === sessionId) {
        console.log(`\n✓ resume — session.started carried resumedFrom ${resumedFrom}`);
      } else {
        console.log(`\n✗ resume — resumedFrom was ${resumedFrom ?? 'absent'}, expected ${sessionId}`);
        exitCode = 1;
      }
    } catch (error) {
      console.error(
        `\n✗ resume failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
      exitCode = 1;
    }
  }

  await rm(workspace, { recursive: true, force: true });
  return exitCode;
}

process.exitCode = await main();
