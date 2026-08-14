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
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
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

/**
 * Does the app archive contain this path?
 *
 * Answered by reading the asar header directly rather than depending on
 * `@electron/asar`: the format is stable — a 16-byte preamble of little-endian
 * u32s (pickle size-of-size, header pickle size, payload size, JSON length)
 * followed by a JSON directory tree — and the question here is one lookup.
 */
function asarContains(archive: string, path: string): boolean {
  const fd = openSync(archive, 'r');
  try {
    const preamble = Buffer.alloc(16);
    readSync(fd, preamble, 0, 16, 0);
    const json = Buffer.alloc(preamble.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    let node: unknown = JSON.parse(json.toString('utf8'));
    for (const segment of path.split('/')) {
      const files = (node as { files?: Record<string, unknown> }).files;
      if (files === undefined || files[segment] === undefined) return false;
      node = files[segment];
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Fail unless the renderer's entry point actually shipped.
 *
 * Booting proves the main process and nothing else: the ready marker comes
 * from the engine, so a BrowserWindow pointed at a missing file still prints
 * "Engine started" and this script would pass a build whose window is a blank
 * rectangle. The main process loads `out/renderer/index.html` out of app.asar
 * (see `main/index.ts`), so that exact entry is what is asserted.
 */
function verifyRendererEntry(): void {
  const resources = resourcesDir(APP_BINARY);
  const entry = 'out/renderer/index.html';

  if (!existsSync(resources)) {
    // Skipped, with the reason said out loud: a platform whose bundle keeps
    // resources elsewhere gives this check nothing to look inside, and the
    // boot check below still stands between that layout and a release.
    console.log(
      `verify-package: SKIP renderer check — no resources directory at ${resources}; ` +
        'unrecognized bundle layout, deferring to the boot check.',
    );
    return;
  }

  const archive = join(resources, 'app.asar');
  if (existsSync(archive)) {
    if (!asarContains(archive, entry)) {
      console.error(
        `verify-package: FAIL — app.asar ships no ${entry}, so every window in this build ` +
          'is blank. The renderer build output went missing between electron-vite and ' +
          "electron-builder; check `out/` and electron-builder.yml's `files` globs.",
      );
      process.exit(1);
    }
    console.log(`verify-package: OK — ${entry} is in app.asar.`);
    return;
  }

  // No archive: a build with asar disabled ships the app directory plain.
  if (existsSync(join(resources, 'app', 'out', 'renderer', 'index.html'))) {
    console.log(`verify-package: OK — ${entry} shipped unpacked (asar disabled).`);
    return;
  }
  console.error(
    `verify-package: FAIL — neither app.asar nor an unpacked app/ under ${resources} ` +
      `contains ${entry}. Nothing in this build can draw a window.`,
  );
  process.exit(1);
}

/**
 * Fail unless the Agent SDK's platform binary shipped.
 *
 * The SDK is a JS package plus one optional dependency per platform —
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, holding the `claude`
 * executable — and pnpm installs only the host's. That is exactly the
 * wrong-arch trap release.yml's preamble warns about: a cross-built bundle
 * packages cleanly and ships a binary the target CPU cannot exec. Runner
 * choice defends it today; this is the assertion, made against the artifact
 * itself, that the defense held. The script runs on the machine the build
 * targets, so the host's platform/arch pair *is* the target's.
 */
function verifySdkBinary(): void {
  const resources = resourcesDir(APP_BINARY);
  if (!existsSync(resources)) {
    console.log(
      `verify-package: SKIP SDK-binary check — no resources directory at ${resources}; ` +
        'unrecognized bundle layout, deferring to the boot check.',
    );
    return;
  }

  // The SDK spawns its binary from real files, so electron-builder unpacks it
  // beside the archive; with asar disabled it would sit in the plain app dir.
  const scope = [
    join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai'),
    join(resources, 'app', 'node_modules', '@anthropic-ai'),
  ].find(existsSync);
  if (scope === undefined) {
    console.error(
      'verify-package: FAIL — no @anthropic-ai packages outside the asar. The Agent SDK ' +
        'cannot spawn a binary that lives inside an archive, so no run could ever start.',
    );
    process.exit(1);
  }

  const wanted = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const shipped = readdirSync(scope).filter((name) => name.startsWith('claude-agent-sdk-'));
  // Linux publishes a musl variant per arch; either satisfies a Linux host.
  const match = shipped.find((name) => name === wanted || name === `${wanted}-musl`);
  if (match === undefined) {
    console.error(
      `verify-package: FAIL — the bundle ships no @anthropic-ai/${wanted}. ` +
        (shipped.length > 0
          ? `It ships ${shipped.join(', ')} instead — the wrong-arch build the release ` +
            'workflow exists to prevent; this artifact was not built on its target.'
          : 'It ships no platform package at all; pnpm never installed one, or the ' +
            'packaging dropped it.'),
    );
    process.exit(1);
  }

  const binary = ['claude', 'claude.exe']
    .map((name) => join(scope, match, name))
    .find(existsSync);
  if (binary === undefined) {
    console.error(
      `verify-package: FAIL — @anthropic-ai/${match} shipped without its claude binary, ` +
        'so no run could ever start.',
    );
    process.exit(1);
  }
  console.log(`verify-package: OK — @anthropic-ai/${match} ships its binary.`);
}

verifySpawnHelpers();
verifyRendererEntry();
verifySdkBinary();

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
