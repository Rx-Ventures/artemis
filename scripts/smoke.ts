/**
 * Headless end-to-end smoke test for `@rx-artemis/core`.
 *
 * Runs the entire engine with no Electron anywhere in the process:
 *
 * ```
 *   InMemorySecretStore → ProfileStore.create()   (a profile with a real key)
 *          ↓
 *   resolveEnv()                                  (key + isolated CLAUDE_CONFIG_DIR)
 *          ↓
 *   RunRegistry.start()  →  Claude adapter  →  Agent SDK
 *          ↓
 *   normalized AgentEvents, printed as they arrive
 * ```
 *
 * This is the same wiring `apps/desktop/main/engine.ts` performs, minus the
 * `safeStorage`-backed secret store and the IPC layer — which is the point. If
 * this script works and the app does not, the fault is in Electron plumbing; if
 * this script fails, the fault is in core and can be debugged in a plain Node
 * process with a debugger attached.
 *
 * ## Usage
 *
 * ```sh
 * pnpm build:libs          # smoke.ts imports @rx-artemis/core's built output
 * pnpm smoke               # or: npx tsx scripts/smoke.ts "your prompt here"
 * ```
 *
 * No environment variable authenticates this. It runs against the config
 * directory the CLI is already signed into — `$CLAUDE_CONFIG_DIR` if set,
 * `~/.claude` otherwise — exactly as a profile would, and **the run is billed
 * to that account**. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are
 * deliberately ignored: Artemis strips both from every run, so a smoke test
 * that authenticated with one would be exercising a path the product does not
 * have. Not signed in anywhere → exit 2 with the sign-in command.
 *
 * Everything it writes — the profile store, the credential, the isolated config
 * directory and the working directory the agent is pointed at — lives in one
 * `mkdtemp` directory that is removed on the way out. It never touches your real
 * Artemis data, and the key it uses is the one already in your environment: no
 * credential is written anywhere except that temporary directory, encrypted by
 * nothing, which is why it is deleted.
 *
 * Exit codes: `0` the run ended normally, `1` the run ended in an error, `2` the
 * script could not get as far as starting a run.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { homedir } from 'node:os';

import {
  checkAuthStatus,
  createDefaultProviderRegistry,
  ProfileStore,
  resolveEnv,
  RunRegistry,
  signInCommand,
} from '@rx-artemis/core';
import type { AgentEvent, ProfileId, ProviderId, RunInput } from '@rx-artemis/protocol';

/** How long to wait for a run to finish before giving up and tearing down. */
const RUN_TIMEOUT_MS = 120_000;

const DEFAULT_PROMPT =
  'Reply with exactly the word: pong. Do not use any tools and do not explain yourself.';

/* -------------------------------------------------------------------------- */
/* Event printing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Render one normalized event as a single line.
 *
 * Exhaustive over the union on purpose: adding an event type to the protocol
 * should break this script's build, because a smoke test that silently ignores
 * a new event kind stops being evidence that the mapper works.
 */
function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'session.started':
      return `session ${event.sessionId}${event.model ? ` model=${event.model}` : ''}`;
    case 'text.delta':
      return `+${JSON.stringify(event.text)}`;
    case 'text.complete':
      return JSON.stringify(event.text);
    case 'thinking.delta':
      return `thinking +${event.text.length} chars`;
    case 'tool.start':
      return `${event.name}(${JSON.stringify(event.input ?? {}).slice(0, 120)})`;
    case 'tool.end':
      return `${event.name ?? event.toolCallId} → ${event.status}${
        event.error ? ` (${event.error.code}: ${event.error.message})` : ''
      }`;
    case 'permission.request':
      // Nothing here answers permission requests, so this line is also the
      // explanation for the run that is about to stall.
      return `${event.request.toolName} needs approval (nothing is listening — the run will be interrupted)`;
    case 'permission.resolved':
      return `${event.requestId} ${event.outcome}${event.note === undefined ? '' : ` — ${event.note}`}`;
    case 'usage':
      return `${event.usage.scope} in=${event.usage.tokens.inputTokens} out=${event.usage.tokens.outputTokens}${
        event.usage.costUsd === undefined ? '' : ` cost=$${event.usage.costUsd.toFixed(4)}`
      }`;
    case 'background.tasks':
      return event.tasks.length === 0
        ? 'no background tasks left running'
        : `${String(event.tasks.length)} background task(s): ${event.tasks.map((t) => t.description).join(', ')}`;
    case 'session.commands':
      return `${String(event.slashCommands.length)} slash command(s) now on offer`;
    case 'plan.limit':
      return `${event.limit.status} on ${event.limit.windowId ?? 'an unnamed window'}${
        event.limit.utilization === undefined ? '' : ` at ${String(event.limit.utilization)}%`
      }`;
    case 'run.end':
      return `${event.reason}${event.error ? ` — ${event.error.code}: ${event.error.message}` : ''}${
        event.sessionId ? ` (resume with ${event.sessionId})` : ''
      }`;
    default: {
      // `event` is `never` here when the switch is exhaustive.
      const unhandled: never = event;
      return `unhandled: ${JSON.stringify(unhandled)}`;
    }
  }
}

function printEvent(event: AgentEvent): void {
  const seq = String(event.seq).padStart(3, ' ');
  console.log(`  ${seq}  ${event.type.padEnd(18)} ${describeEvent(event)}`);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  /*
    A profile is a config directory, so this script needs one that is already
    signed in — the same thing the app needs, obtained the same way.

    It deliberately does *not* read `ANTHROPIC_API_KEY` or
    `CLAUDE_CODE_OAUTH_TOKEN` any more. Artemis strips both from every run, so a
    smoke test that authenticated with one would be exercising a path the
    product does not have.
  */
  const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');

  const credentials = createDefaultProviderRegistry().require('claude').credentials;
  const status = await checkAuthStatus({ credentials, configDir, hostEnv: process.env });
  if (!status.loggedIn) {
    console.error(
      `Not signed in at ${configDir}.\n` +
        `${status.error ?? ''}\n` +
        'Artemis performs no login of its own — run the CLI’s, the way the app tells you to:\n\n' +
        `  ${signInCommand({ credentials, configDir })}\n\n` +
        'Or point this script at a directory that is already signed in:\n\n' +
        '  export CLAUDE_CONFIG_DIR=/path/to/config/dir\n',
    );
    return 2;
  }

  const prompt = process.argv.slice(2).join(' ').trim() || DEFAULT_PROMPT;

  // One disposable directory for everything: Artemis's "user data", and the
  // working directory the agent is pointed at.
  const root = await mkdtemp(join(tmpdir(), 'artemis-smoke-'));
  const userDataDir = join(root, 'userData');
  const workdir = join(root, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workdir, { recursive: true });

  console.log(`Artemis smoke test`);
  console.log(`  scratch : ${root}`);
  console.log(`  workdir : ${workdir}`);
  console.log(`  config  : ${configDir}`);
  console.log(`  prompt  : ${prompt}\n`);

  const profiles = new ProfileStore({ userDataDir });
  const providers = createDefaultProviderRegistry();

  // The profile record is disposable; the directory it points at is the user's
  // real one and is never written to by the store.
  const profile = await profiles.create({
    label: 'Smoke test',
    providerId: 'claude',
    configDir,
  });

  const metadata = await profiles.describe(profile.id);
  console.log(`profile ${metadata.id} — ${metadata.label}`);
  console.log(`  signed in as ${status.email ?? 'unknown'} (${status.subscriptionType ?? status.authMethod ?? '?'})\n`);

  const registry = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    // `baseEnv` is left at its default: the adapter merges the host environment
    // itself, scrubbing inherited credential variables as it goes.
    resolveRun: async ({
      profileId,
      providerId,
    }: {
      readonly profileId: ProfileId;
      readonly providerId: ProviderId;
    }) => ({
      env: await resolveEnv(await profiles.require(profileId), {
        // The provider decides which variable points at the config directory.
        credentials: providers.require(providerId).credentials,
      }),
    }),
    onError: (error, context) => {
      console.error(`  !! ${context.phase} error on ${context.runId}:`, error);
    },
  });

  let exitCode = 2;

  try {
    // Subscribe before starting: events can arrive before `start()` resolves.
    const finished = new Promise<void>((resolve) => {
      const unsubscribe = registry.subscribe((event) => {
        printEvent(event);
        if (event.type === 'run.end') {
          exitCode = event.reason === 'error' ? 1 : 0;
          unsubscribe();
          resolve();
        }
      });
    });

    const input: RunInput = {
      providerId: 'claude',
      profileId: profile.id,
      cwd: workdir,
      prompt,
      // Nothing in this script can answer a permission prompt, so the agent is
      // asked not to raise one. A tool call would otherwise hang until the
      // timeout below fires.
      permissionMode: 'plan',
      includePartialMessages: true,
    };

    console.log('events:');
    const handle = await registry.start(input);
    console.log(`  (run ${handle.runId} started)\n`);

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), RUN_TIMEOUT_MS).unref(),
    );
    if ((await Promise.race([finished, timeout])) === 'timeout') {
      console.error(`\nThe run did not finish within ${RUN_TIMEOUT_MS / 1000}s. Interrupting.`);
      await registry.interrupt(handle.runId);
      exitCode = 1;
    }
  } catch (error) {
    console.error('\nThe run could not be started:', error);
    exitCode = 2;
  } finally {
    await registry.disposeAll();
    await rm(root, { recursive: true, force: true });
    console.log(`\ncleaned up ${root}`);
  }

  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  },
);
