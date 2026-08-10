/**
 * Headless end-to-end smoke test for `@rx-apollo/core`.
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
 * export ANTHROPIC_API_KEY=sk-ant-…
 * pnpm build:libs          # smoke.ts imports @rx-apollo/core's built output
 * pnpm smoke               # or: npx tsx scripts/smoke.ts "your prompt here"
 * ```
 *
 * Everything it writes — the profile store, the credential, the isolated config
 * directory and the working directory the agent is pointed at — lives in one
 * `mkdtemp` directory that is removed on the way out. It never touches your real
 * Apollo data, and the key it uses is the one already in your environment: no
 * credential is written anywhere except that temporary directory, encrypted by
 * nothing, which is why it is deleted.
 *
 * Exit codes: `0` the run ended normally, `1` the run ended in an error, `2` the
 * script could not get as far as starting a run.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultProviderRegistry,
  InMemorySecretStore,
  ProfileStore,
  resolveEnv,
  RunRegistry,
} from '@rx-apollo/core';
import type { AgentEvent, ProfileId, ProviderId, RunInput } from '@rx-apollo/protocol';

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
    case 'usage':
      return `${event.usage.scope} in=${event.usage.tokens.inputTokens} out=${event.usage.tokens.outputTokens}${
        event.usage.costUsd === undefined ? '' : ` cost=$${event.usage.costUsd.toFixed(4)}`
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
  // Either credential works, and which one is set decides the profile's auth
  // mode — the same choice the profile editor offers. The API key is checked
  // first because it is the default in the app too.
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  const credential = apiKey ?? oauthToken;
  const authMode = apiKey ? 'api-key' : 'subscription';

  if (!credential) {
    console.error(
      'No credential in the environment.\n' +
        'Apollo never performs a login of its own, so this script needs one of:\n\n' +
        '  export ANTHROPIC_API_KEY=sk-ant-…          metered API usage\n' +
        '  export CLAUDE_CODE_OAUTH_TOKEN=…           billed to a Claude subscription\n\n' +
        'A subscription token is printed by `claude setup-token` in Anthropic’s CLI.\n',
    );
    return 2;
  }

  const prompt = process.argv.slice(2).join(' ').trim() || DEFAULT_PROMPT;

  // One disposable directory for everything: Apollo's "user data", and the
  // working directory the agent is pointed at.
  const root = await mkdtemp(join(tmpdir(), 'apollo-smoke-'));
  const userDataDir = join(root, 'userData');
  const workdir = join(root, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workdir, { recursive: true });

  console.log(`Apollo smoke test`);
  console.log(`  scratch : ${root}`);
  console.log(`  workdir : ${workdir}`);
  console.log(`  auth    : ${authMode}`);
  console.log(`  prompt  : ${prompt}\n`);

  // In the desktop app this is a `safeStorage`-backed store. Here it is memory
  // only, which is the whole reason the scratch directory is disposable.
  const secrets = new InMemorySecretStore();
  const profiles = new ProfileStore({ userDataDir, secrets });
  const providers = createDefaultProviderRegistry();

  const profile = await profiles.create({
    label: 'Smoke test',
    providerId: 'claude',
    backend: 'anthropic',
    authMode,
    apiKey: credential,
  });

  // Prove the metadata projection really is credential-free before going any
  // further — this is the shape the renderer would receive.
  const metadata = await profiles.describe(profile.id);
  console.log(`profile ${metadata.id} — ${metadata.label} [${metadata.keyHint ?? 'no key'}]\n`);

  const registry = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    // The only path a credential takes into a run. `baseEnv` is left at its
    // default: the adapter merges the host environment itself, scrubbing
    // inherited credential variables as it goes.
    resolveRun: async ({
      profileId,
      providerId,
    }: {
      readonly profileId: ProfileId;
      readonly providerId: ProviderId;
    }) => ({
      env: await resolveEnv(await profiles.require(profileId), secrets, {
        userDataDir,
        // The provider decides which variable names its credential lands in.
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
