/**
 * Run the OpenCode adapter end to end, headless, and print the normalized
 * event stream.
 *
 * The sibling of `smoke.ts`, which does the same for Claude. Where
 * `acp-probe.ts` verifies the *transport* (does this agent speak ACP the way we
 * think), this verifies the *adapter*: that a real turn against a real binary
 * comes out the other side as a well-formed `AgentEvent` stream — session
 * first, run.end last, dense seq, every tool.start closed.
 *
 * ```bash
 * pnpm opencode:smoke
 * pnpm opencode:smoke "list the files here"
 * OPENCODE_BIN=/path/to/opencode pnpm opencode:smoke
 * ```
 *
 * The profile directory is a fresh `mkdtemp` removed on exit, so the run never
 * touches an account you actually use — and, because that isolation is the same
 * `XDG_DATA_HOME` mechanism a real profile uses, a passing run is also evidence
 * the isolation works.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '../packages/protocol/src/index.js';
import { createOpencodeAdapter } from '../packages/core/src/adapters/opencode.js';

const prompt = process.argv[2] ?? 'Reply with exactly: ARTEMIS_OPENCODE_OK';
const executable = process.env['OPENCODE_BIN'] ?? 'opencode';

const profileDir = mkdtempSync(join(tmpdir(), 'artemis-opencode-profile-'));
const workdir = mkdtempSync(join(tmpdir(), 'artemis-opencode-cwd-'));

function cleanup(): void {
  for (const dir of [profileDir, workdir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth failing over.
    }
  }
}

/** One line per event, in the shape a transcript would render. */
function describe(event: AgentEvent): string {
  switch (event.type) {
    case 'session.started':
      return `session.started  ${event.sessionId} (${event.model ?? 'default model'})`;
    case 'text.delta':
      return `text.delta       ${JSON.stringify(event.text)}`;
    case 'thinking.delta':
      return `thinking.delta   ${JSON.stringify(event.text.slice(0, 60))}`;
    case 'text.complete':
      return `text.complete    [${event.role}] ${JSON.stringify(event.text.slice(0, 120))}`;
    case 'tool.start':
      return `tool.start       ${event.name} ${JSON.stringify(event.input).slice(0, 100)}`;
    case 'tool.end':
      return `tool.end         ${event.name ?? '?'} → ${event.status}`;
    case 'permission.request':
      return `permission.req   ${event.request.toolName}`;
    case 'usage':
      return `usage            in ${String(event.usage.tokens.inputTokens)} out ${String(event.usage.tokens.outputTokens)} · ctx ${String(event.usage.contextTokens ?? 0)}/${String(event.usage.contextWindow ?? 0)} · $${String(event.usage.costUsd ?? 0)}`;
    case 'run.end':
      return `run.end          ${event.reason}${event.error === undefined ? '' : ` — ${event.error.message}`}`;
    default:
      return `${event.type}`;
  }
}

async function main(): Promise<number> {
  const adapter = createOpencodeAdapter({ executable });

  const availability = await adapter.checkAvailability?.();
  if (availability !== undefined && !availability.available) {
    console.error(`✗ ${availability.unavailableReason ?? 'unavailable'}`);
    return 1;
  }

  console.log(`→ prompt:  ${prompt}`);
  console.log(`  cwd:     ${workdir}`);
  console.log(`  profile: ${profileDir}\n`);

  const run = await adapter.createRun({
    runId: 'smoke-1',
    providerId: 'opencode',
    profileId: 'smoke-profile',
    prompt,
    cwd: workdir,
    // Exactly what `resolveEnv` would build for a profile: one variable,
    // pointing the provider at this profile's own directory.
    env: { XDG_DATA_HOME: profileDir },
  });

  const seen: AgentEvent[] = [];
  for await (const event of run.events) {
    seen.push(event);
    console.log(`  ${describe(event)}`);
  }

  // The contract, checked rather than assumed.
  const problems: string[] = [];
  if (seen[0]?.type !== 'session.started') problems.push('first event was not session.started');
  if (seen.at(-1)?.type !== 'run.end') problems.push('last event was not run.end');
  if (seen.filter((e) => e.type === 'run.end').length !== 1) problems.push('run.end was not emitted exactly once');
  if (seen.some((event, index) => event.seq !== index)) problems.push('seq was not dense and monotonic from 0');

  const starts = seen.filter((e) => e.type === 'tool.start').length;
  const ends = seen.filter((e) => e.type === 'tool.end').length;
  if (starts !== ends) problems.push(`${String(starts)} tool.start vs ${String(ends)} tool.end`);

  console.log(`\n  ${String(seen.length)} events`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log('✓ stream is well-formed');

  const sessionId = seen.find((e) => e.type === 'session.started')?.sessionId;
  const env = { XDG_DATA_HOME: profileDir };

  // The catalogue, which must cost no tokens and say whether the account
  // confirmed it.
  const catalogue = await adapter.listModels?.({ env, cwd: workdir });
  if (catalogue !== undefined) {
    console.log(
      `\n✓ listModels     ${String(catalogue.models.length)} models, live=${String(catalogue.live)}`,
    );
    for (const model of catalogue.models.slice(0, 3)) {
      console.log(`    ${model.id} — ${model.label} (${model.note})`);
    }
  }

  // The history this run just wrote, read back through the seam.
  const page = await adapter.listSessions?.({ profileId: 'smoke-profile', cwd: workdir, env });
  if (page !== undefined) {
    console.log(`\n✓ listSessions   ${String(page.sessions.length)} session(s) for this cwd`);
    for (const summary of page.sessions) {
      console.log(`    ${summary.id} — ${summary.title}`);
      if (summary.cwd !== workdir) console.error(`✗ cwd mismatch: ${summary.cwd}`);
    }
    if (!page.sessions.some((s) => s.id === sessionId)) {
      console.error('✗ the session this run created was not listed');
      return 1;
    }
  }

  // Resume: the stored conversation must replay before the new turn starts.
  if (sessionId !== undefined) {
    console.log(`\n→ resuming ${sessionId}`);
    const resumed = await adapter.createRun({
      runId: 'smoke-2',
      providerId: 'opencode',
      profileId: 'smoke-profile',
      prompt: 'In one word, what did you just say?',
      cwd: workdir,
      env,
      resumeSessionId: sessionId,
    });

    const replayed: AgentEvent[] = [];
    for await (const event of resumed.events) {
      replayed.push(event);
      if (event.type === 'text.complete' || event.type === 'run.end') {
        console.log(`  ${describe(event)}`);
      }
    }
    // A resumed run that replayed nothing is one where the agent silently
    // started fresh, which would lose the conversation.
    const history = replayed.filter((e) => e.type === 'text.complete' && e.replay === true);
    console.log(`\n✓ resume         ${String(history.length)} replayed message(s)`);
    if (history.length === 0) {
      console.error('✗ resume replayed no history');
      return 1;
    }
  }

  return 0;
}

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((error: unknown) => {
    cleanup();
    console.error('\n✗ smoke failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
