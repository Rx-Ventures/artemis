/**
 * Headless check of session naming, against a real profile.
 *
 * Both halves of naming touch things a unit test cannot reach — a model, and
 * the provider's own session store — so this is where they are actually
 * verified:
 *
 * ```
 *   suggestSessionTitle()  →  Agent SDK  →  the smallest model on the account
 *          ↓
 *   setSessionTitle()      →  renameSession()  →  the session's JSONL
 *          ↓
 *   listAllSessions()      →  the title the sidebar will show
 * ```
 *
 * Three properties are asserted, and each one is a bug that would otherwise
 * only be visible in the app, days later:
 *
 *  1. **A first message becomes a title.** Printed, so the quality is judged by
 *     eye — this is a prompt, and only reading the output tells you it works.
 *  2. **Naming writes no session of its own.** The count of session files is
 *     taken before and after. Without `persistSession: false` a feature that
 *     labels the history pane also fills it with junk, which is the single
 *     worst way this could fail.
 *  3. **A title survives a round-trip through the store.** Written into a
 *     *copy* of a session, then read back through the same listing the sidebar
 *     uses. The original session is never opened for writing.
 *
 * ## Usage
 *
 * ```sh
 * pnpm build:libs
 * npx tsx scripts/smoke-title.ts "the login page redirects forever"
 * ```
 *
 * The config directory defaults to `~/.claude`; point it at an Artemis profile
 * with `CLAUDE_CONFIG_DIR=…` to name against that account instead. It must be
 * signed in — checked up front, the same way smoke.ts checks, so a signed-out
 * machine hears the sign-in command instead of an SDK failure mid-title — and
 * the naming call spends a few hundred tokens on the cheapest model the
 * profile has.
 *
 * Exit codes: `0` everything held, `1` an assertion failed, `2` it could not
 * get far enough to check.
 */

import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { lowestTierModel } from '@rx-artemis/protocol';
import type { ProfileId, SessionSummary } from '@rx-artemis/protocol';

import {
  checkAuthStatus,
  createClaudeAdapter,
  createDefaultProviderRegistry,
  signInCommand,
} from '@rx-artemis/core';

const CONFIG_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
const PROJECTS = join(CONFIG_DIR, 'projects');
const PROFILE = 'smoke' as ProfileId;

const MESSAGE =
  process.argv[2] ?? 'the login page redirects forever after the session cookie expires';

const adapter = createClaudeAdapter({
  onDiagnostic: (message) => console.log(`  diag: ${message}`),
});
const env = { CLAUDE_CONFIG_DIR: CONFIG_DIR };

/**
 * The project directories under the config dir.
 *
 * A profile that has signed in and never run a session has no `projects/` at
 * all. That is zero sessions to count and nothing to copy — not an ENOENT to
 * die on, which is what a bare readdir turned it into.
 */
async function projectDirs(): Promise<readonly string[]> {
  try {
    return await readdir(PROJECTS);
  } catch {
    return [];
  }
}

/** Every session file under the config directory, which must not grow. */
async function countSessions(): Promise<number> {
  let total = 0;
  for (const project of await projectDirs()) {
    try {
      const entries = await readdir(join(PROJECTS, project));
      total += entries.filter((file) => file.endsWith('.jsonl')).length;
    } catch {
      /* not a directory */
    }
  }
  return total;
}

/** The smallest real session on this machine, so the copy below is cheap. */
async function smallestSession(): Promise<{ project: string; file: string } | null> {
  let best: { project: string; file: string; bytes: number } | null = null;
  for (const project of await projectDirs()) {
    let entries: string[];
    try {
      entries = await readdir(join(PROJECTS, project));
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const { size } = await stat(join(PROJECTS, project, file));
      if (size < 200) continue;
      if (best === null || size < best.bytes) best = { project, file, bytes: size };
    }
  }
  return best === null ? null : { project: best.project, file: best.file };
}

/** Generate a title, and prove the call left nothing behind. */
async function checkGeneration(): Promise<{ ok: boolean; title: string | null }> {
  // The same choice the engine makes for a profile with no cached live
  // catalogue: the smallest model the provider ships.
  const model = lowestTierModel(adapter.models);
  if (model === undefined) {
    console.log('no tiered model in the catalogue — nothing would ever be named');
    return { ok: false, title: null };
  }
  console.log(`naming with: ${model.id}`);

  const before = await countSessions();
  const started = Date.now();
  const title = await adapter.suggestSessionTitle?.({ prompt: MESSAGE, model: model.id, env, cwd: process.cwd() });
  const elapsed = Date.now() - started;
  const after = await countSessions();

  console.log(`  in:  ${JSON.stringify(MESSAGE)}`);
  console.log(`  out: ${JSON.stringify(title ?? null)}  (${String(elapsed)}ms)`);

  const persisted = after - before;
  console.log(
    persisted === 0
      ? '  wrote no session of its own: OK'
      : `  wrote ${String(persisted)} session file(s): VIOLATED`,
  );
  return { ok: persisted === 0, title: title ?? null };
}

/** Write a title into a copy of a real session and read it back. */
async function checkRoundTrip(title: string): Promise<boolean> {
  const source = await smallestSession();
  if (source === null) {
    console.log('no session on this machine to round-trip through — skipped');
    return true;
  }

  const root = await mkdtemp(join(tmpdir(), 'artemis-title-'));
  const copyConfig = join(root, 'config');
  try {
    // A copy, always. The point is to exercise the write, not to rename
    // something the user is still using.
    await cp(join(PROJECTS, source.project), join(copyConfig, 'projects', source.project), {
      recursive: true,
    });
    const copyEnv = { CLAUDE_CONFIG_DIR: copyConfig };

    const list = async (): Promise<readonly SessionSummary[]> =>
      (await adapter.listAllSessions?.({ profiles: [{ profileId: PROFILE, env: copyEnv }] }))
        ?.sessions ?? [];

    const target = (await list())[0];
    if (target === undefined) {
      console.log('the copied project listed no sessions — skipped');
      return true;
    }
    console.log(`  before: ${JSON.stringify(target.title)} (custom: ${String(target.titleIsCustom === true)})`);

    await adapter.setSessionTitle?.({ sessionId: target.id, title, cwd: target.cwd, env: copyEnv });

    const renamed = (await list()).find((session) => session.id === target.id);
    console.log(`  after:  ${JSON.stringify(renamed?.title)} (custom: ${String(renamed?.titleIsCustom === true)})`);

    const ok = renamed?.title === title && renamed.titleIsCustom === true;
    console.log(ok ? '  round-trip: OK' : '  round-trip: VIOLATED');
    return ok;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  console.log(`config dir: ${CONFIG_DIR}\n`);

  /*
   * The same gate smoke.ts opens with: everything below runs against whatever
   * account CONFIG_DIR is signed into, and a machine that is not signed in
   * anywhere should hear that, and the remedy, up front — not watch the SDK
   * fail partway through generating a title.
   */
  const credentials = createDefaultProviderRegistry().require('claude').credentials;
  const status = await checkAuthStatus({ credentials, configDir: CONFIG_DIR, hostEnv: process.env });
  if (!status.loggedIn) {
    console.error(
      `Not signed in at ${CONFIG_DIR}.\n` +
        `${status.error ?? ''}\n` +
        'Artemis performs no login of its own — run the CLI’s, the way the app tells you to:\n\n' +
        `  ${signInCommand({ credentials, configDir: CONFIG_DIR })}\n\n` +
        'Or point this script at a directory that is already signed in:\n\n' +
        '  export CLAUDE_CONFIG_DIR=/path/to/config/dir\n',
    );
    return 2;
  }

  const generated = await checkGeneration();
  if (!generated.ok) return 1;

  console.log('\nround-tripping a title through the store');
  // A title is needed either way; if the model declined, one is invented so the
  // storage half is still exercised.
  const ok = await checkRoundTrip(generated.title ?? 'Fix login redirect loop');
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`\nfailed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
