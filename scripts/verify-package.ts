/**
 * Check the packaged app's static shape, then launch it and wait for the engine
 * to come up.
 *
 * This is the release gate between "electron-builder exited 0" and "a tester
 * can run this": it catches the class of failure where the bundle is missing a
 * dependency or the main process dies on boot — which `--dir` packaging cannot
 * see, because packaging succeeds and the corpse is only discovered on launch.
 *
 * The throwaway `--user-data-dir` matters twice over: it keeps the check off
 * your real profiles, and it dodges the single-instance lock when a dev
 * instance is already running.
 *
 * Booting is necessary and not sufficient. Artemis 0.6.1 booted perfectly and
 * could not open a terminal, because a file mode three directories deep in the
 * bundle was wrong — a defect no launch reveals, since nothing execs
 * `spawn-helper` until somebody asks for a shell. So the file checks below run
 * first: they are the cheap half, they name the file when they fail, and they
 * cover exactly the things that are invisible until a user goes looking.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const APP_BINARY =
  process.argv[2] ?? 'apps/desktop/release/mac-arm64/Artemis.app/Contents/MacOS/Artemis';
const READY_MARKER = 'Engine started';
const TIMEOUT_MS = 30_000;

if (!existsSync(APP_BINARY)) {
  console.error(`verify-package: no packaged app at ${APP_BINARY} — run the dist build first.`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* The static checks                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The bundle's resources directory, worked back from the executable.
 *
 * `Artemis.app/Contents/MacOS/Artemis` → `Artemis.app/Contents/Resources`, and
 * every other platform keeps a plain `resources/` beside the binary
 * (`win-unpacked/Artemis.exe`, `linux-unpacked/artemis`). Derived rather than
 * passed in because the workflow already passes the binary and one path per
 * platform is one path too many to keep in step.
 */
function resourcesDir(appBinary: string): string {
  const dir = dirname(appBinary);
  return basename(dir) === 'MacOS' ? join(dirname(dir), 'Resources') : join(dir, 'resources');
}

/**
 * Every `spawn-helper` shipped in the bundle's unpacked node-pty.
 *
 * One per published platform sits in `prebuilds/`, plus `build/Release/` if
 * node-gyp compiled it here instead. All of them are checked: the host's is the
 * one that matters today, and a build that ships a broken mode for another
 * platform is a build that is one cross-compile away from being wrong.
 */
function spawnHelpers(): readonly string[] {
  const ptyRoot = join(resourcesDir(APP_BINARY), 'app.asar.unpacked', 'node_modules', 'node-pty');
  const candidates: string[] = [join(ptyRoot, 'build', 'Release', 'spawn-helper')];
  try {
    for (const entry of readdirSync(join(ptyRoot, 'prebuilds'), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(ptyRoot, 'prebuilds', entry.name, 'spawn-helper'));
      }
    }
  } catch {
    // No prebuilds directory: a locally compiled node-pty, covered above.
  }
  return candidates.filter((candidate) => existsSync(candidate));
}

/**
 * Fail unless node-pty can actually exec its helper.
 *
 * Windows drives the PTY through ConPTY, has no helper, and has no execute bit
 * to check — so there is nothing here it could assert.
 */
function verifySpawnHelpers(): void {
  if (process.platform === 'win32') return;

  const helpers = spawnHelpers();
  if (helpers.length === 0) {
    console.error(
      'verify-package: FAIL — the bundle ships no spawn-helper. node-pty cannot spawn a ' +
        'shell without one, so every terminal would fail with "posix_spawnp failed".',
    );
    process.exit(1);
  }

  const unexecutable = helpers.filter((helper) => (statSync(helper).mode & 0o111) === 0);
  if (unexecutable.length > 0) {
    console.error(
      'verify-package: FAIL — spawn-helper is not executable, so every terminal in this ' +
        'build would fail with "posix_spawnp failed". `build/after-pack.cjs` is what sets ' +
        `the bit; check that it ran.\n  ${unexecutable.join('\n  ')}`,
    );
    process.exit(1);
  }

  console.log(`verify-package: OK — ${String(helpers.length)} spawn-helper(s) executable.`);
}

verifySpawnHelpers();

/* -------------------------------------------------------------------------- */
/* The boot check                                                             */
/* -------------------------------------------------------------------------- */

const userDataDir = mkdtempSync(join(tmpdir(), 'artemis-verify-'));

const child = spawn(APP_BINARY, [`--user-data-dir=${userDataDir}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let settled = false;

function finish(code: number, message: string): void {
  if (settled) return;
  settled = true;
  console.log(message);
  if (code !== 0 && output) console.error(output.slice(-2_000));
  child.kill();
  try {
    // Windows: the just-killed process can hold locks in its own profile dir
    // for a beat, so retry — and a leftover temp dir on an ephemeral runner
    // must never fail a verification that passed.
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // best-effort
  }
  process.exit(code);
}

for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes(READY_MARKER)) {
      finish(0, `verify-package: OK — "${READY_MARKER}" seen, packaged app boots.`);
    }
  });
}

child.on('exit', (code) => {
  finish(1, `verify-package: FAIL — app exited (code ${code}) before "${READY_MARKER}".`);
});

setTimeout(() => {
  finish(1, `verify-package: FAIL — no "${READY_MARKER}" within ${TIMEOUT_MS / 1000}s.`);
}, TIMEOUT_MS);
