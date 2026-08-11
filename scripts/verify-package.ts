/**
 * Launch the packaged app against a throwaway user-data directory and wait for
 * the engine to come up.
 *
 * This is the release gate between "electron-builder exited 0" and "a tester
 * can run this": it catches the class of failure where the bundle is missing a
 * dependency or the main process dies on boot — which `--dir` packaging cannot
 * see, because packaging succeeds and the corpse is only discovered on launch.
 *
 * The throwaway `--user-data-dir` matters twice over: it keeps the check off
 * your real profiles, and it dodges the single-instance lock when a dev
 * instance is already running.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_BINARY =
  process.argv[2] ?? 'apps/desktop/release/mac-arm64/Artemis.app/Contents/MacOS/Artemis';
const READY_MARKER = 'Engine started';
const TIMEOUT_MS = 30_000;

if (!existsSync(APP_BINARY)) {
  console.error(`verify-package: no packaged app at ${APP_BINARY} — run the dist build first.`);
  process.exit(1);
}

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
  rmSync(userDataDir, { recursive: true, force: true });
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
