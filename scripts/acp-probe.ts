/**
 * Drive a real ACP agent through Artemis's own client, with no Electron and no
 * profile store.
 *
 * The same idea as `smoke.ts`, one layer lower: where that exercises the whole
 * engine against Claude, this exercises `adapters/acp` against whichever ACP
 * agent you name — so a new provider can be verified before an adapter for it
 * exists. ACP is the vendor-recommended surface for OpenCode, Kimi Code and
 * Grok Build, which makes "does this agent really speak the dialect we think it
 * does" a question worth being able to answer in one command.
 *
 * ```bash
 * pnpm acp:probe /path/to/opencode            # default args: ["acp"]
 * pnpm acp:probe kimi acp                     # explicit args
 * ARTEMIS_ACP_PROMPT='say hi' pnpm acp:probe opencode
 * ```
 *
 * Everything it writes lives in one `mkdtemp` directory that is removed on
 * exit, and the agent's own state is relocated into it via `XDG_DATA_HOME`, so
 * a probe never reads or writes the account you actually use. That isolation is
 * the same mechanism a profile uses, exercised here on purpose: if it stops
 * working, this script starts seeing your real credentials and the profile
 * model is broken.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectAcpAgent, isAcpAuthRequiredError } from '../packages/core/src/adapters/acp/client.js';
import type { AcpSessionNotification } from '../packages/core/src/adapters/acp/protocol.js';

const [named, ...rest] = process.argv.slice(2);
if (named === undefined) {
  console.error('usage: pnpm acp:probe <executable> [args...]   (args default to "acp")');
  process.exit(2);
}
// Rebound after the guard so the narrowing survives into `main`'s closure.
const executable: string = named;
const args = rest.length > 0 ? rest : ['acp'];

const home = mkdtempSync(join(tmpdir(), 'artemis-acp-home-'));
const workdir = mkdtempSync(join(tmpdir(), 'artemis-acp-cwd-'));

/** Only what a CLI needs to run — plus the isolation a profile would apply. */
const env: Record<string, string> = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? home,
  TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
  // The account and history live here, not in the user's real directory.
  XDG_DATA_HOME: home,
  XDG_CONFIG_HOME: join(home, 'config'),
};

function cleanup(): void {
  for (const dir of [home, workdir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp directory is not worth failing over.
    }
  }
}

const updates: AcpSessionNotification[] = [];
let text = '';

async function main(): Promise<number> {
  console.log(`→ launching: ${executable} ${args.join(' ')}`);
  console.log(`  cwd:           ${workdir}`);
  console.log(`  XDG_DATA_HOME: ${home}\n`);

  const client = await connectAcpAgent({
    executable,
    args,
    cwd: workdir,
    env,
    onUpdate: (notification) => {
      updates.push(notification);
      const update = notification.update as { sessionUpdate: string; content?: { type?: string; text?: string } };
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        text += update.content.text ?? '';
      }
      console.log(`  update: ${update.sessionUpdate}`);
      // Agents extend `sessionUpdate` beyond the spec's variants — OpenCode
      // sends `usage_update`, which is where its token accounting lives. A
      // mapper has to be written against what actually arrives, so the probe
      // can show it.
      if (process.env['ARTEMIS_ACP_DUMP'] !== undefined) {
        console.log(`    ${JSON.stringify(notification.update).slice(0, 900)}`);
      }
    },
    onPermissionRequest: (request) => {
      // Approve read-only-looking work so a probe can complete a turn, and
      // refuse anything else: this script runs unattended.
      const allow = request.options.find((option) => option.kind === 'allow_once');
      console.log(`  permission asked: ${request.toolCall.title ?? '(untitled)'} → ${allow ? 'allow_once' : 'cancelled'}`);
      return Promise.resolve(
        allow === undefined
          ? { outcome: { outcome: 'cancelled' as const } }
          : { outcome: { outcome: 'selected' as const, optionId: allow.optionId } },
      );
    },
    onDiagnostic: (message, detail) => {
      console.log(`  [diagnostic] ${message}`, detail === undefined ? '' : detail);
    },
    onExit: (reason) => {
      console.log(`  [exit] ${reason}`);
    },
  });

  const { handshake } = client;
  console.log('✓ handshake');
  console.log(`  agent:      ${handshake.agentName ?? '(unnamed)'} ${handshake.agentVersion ?? ''}`);
  console.log(`  version:    ACP ${String(handshake.protocolVersion)}`);
  console.log(`  sessions:   fork=${String(handshake.canFork)} list=${String(handshake.canList)} resume=${String(handshake.canResume)} load=${String(handshake.canLoadSession)}`);
  console.log(`  images:     ${String(handshake.acceptsImages)}`);
  console.log(
    `  auth:       ${handshake.authMethods.map((method) => `${method.id} (${method.description ?? method.name})`).join(', ') || '(none advertised)'}`,
  );

  // R3, exercised rather than asserted: this session is created against the
  // relocated data directory, so a signed-in machine still probes clean.
  let sessionId: string;
  try {
    sessionId = await client.newSession();
    console.log(`\n✓ session/new → ${sessionId}`);
  } catch (error) {
    if (isAcpAuthRequiredError(error)) {
      // Not a failure of the probe: it is the protocol answering the question
      // Artemis's profile screen asks, over the transport, with the command to
      // fix it attached.
      console.log('\n✓ session/new answered auth_required (the isolated directory has no credential)');
      for (const method of error.authMethods) {
        console.log(`  sign in with: ${method.description ?? method.name}`);
      }
      await client.dispose();
      return 0;
    }
    throw error;
  }

  const prompt = process.env['ARTEMIS_ACP_PROMPT'];
  if (prompt === undefined) {
    console.log('\n(set ARTEMIS_ACP_PROMPT to run a turn)');
    await client.dispose();
    return 0;
  }

  console.log(`\n→ session/prompt: ${prompt}`);
  const stopReason = await client.prompt([{ type: 'text', text: prompt }]);
  console.log(`\n✓ turn ended: ${stopReason}`);
  console.log(`  updates: ${String(updates.length)}`);
  if (text !== '') console.log(`  text: ${text.slice(0, 500)}`);

  await client.dispose();
  return 0;
}

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((error: unknown) => {
    cleanup();
    console.error('\n✗ probe failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
