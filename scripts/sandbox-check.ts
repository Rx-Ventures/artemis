/**
 * What this machine can actually enforce, and proof that it does.
 *
 * The counterpart to `local-smoke.ts`: that one drives a model, this one drives
 * the sandbox. It is what took the `unverified` label off bubblewrap, and CI
 * runs it on Linux on every push so the label stays earned instead of aging
 * back into a claim.
 *
 * Exits non-zero when the backend does not do what it says, which is what makes
 * it a gate rather than a report.
 *
 * ## The network check brings its own listener
 *
 * It used to curl `127.0.0.1:1234` and call an empty reply "denied". Nothing
 * listens there on a normal machine, so the check passed identically with a
 * perfect sandbox, a broken one, and no sandbox at all — a green tick for a
 * question nobody had asked. So the script now starts a server, proves the host
 * can reach it, and only then asks whether the confined command can. A denial
 * means something exactly because the control succeeded.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describeConfinement, resolveSandbox, wrapCommand } from '../packages/core/src/adapters/local/commandSandbox.js';

const run = promisify(execFile);

/** The port the network probe listens on and the sandboxed command reaches for. */
const PROBE_PORT = 1234;

/** A listener on loopback, and the way to stop it. */
async function startProbeServer(): Promise<() => Promise<void>> {
  const server = createServer((_request, response) => {
    response.writeHead(200).end('reachable');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PROBE_PORT, '127.0.0.1', resolve);
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
}

async function main(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), 'artemis-sbcheck-'));
  const outside = path.join(work, 'outside.txt');
  const inside = path.join(work, 'project');
  await run('mkdir', ['-p', inside]);
  await writeFile(path.join(inside, 'secret.txt'), 'ZX-99\n');

  const sandbox = await resolveSandbox(process.platform, {
    has: async (binary) => {
      if (binary.startsWith('/')) return existsSync(binary);
      return run('which', [binary]).then(() => true, () => false);
    },
    succeeds: async (argv) => {
      const [file, ...args] = argv;
      if (file === undefined) return false;
      return run(file, args, { timeout: 5_000 }).then(() => true, () => false);
    },
  });

  console.log(`\n  platform     ${process.platform}`);
  console.log(`  backend      ${sandbox.backend?.name ?? 'none'} (${sandbox.backend?.verification ?? 'n/a'})`);
  console.log(`  confinement  ${sandbox.confinement}`);
  console.log(`  described    ${describeConfinement(sandbox)}\n`);

  const wrap = (command: string) => wrapCommand(sandbox, command, inside);

  const readArgv = await wrap('cat secret.txt');
  if (readArgv === null) {
    console.log('  ✓ refused    nothing can confine here, so commands are not run');
    await rm(work, { recursive: true, force: true });
    return;
  }

  /** Every way this run failed. Empty means the backend did what it says. */
  const failures: string[] = [];

  /*
   * Reading its own file is not a confinement property, it is the liveness
   * check — and it is the one that caught the mount-ordering defect, because a
   * bwrap that shadows its own workspace cannot even chdir into it. A backend
   * that confines everything including the command is not confinement, it is
   * an outage, so this counts as a failure like the escapes below.
   */
  const readOk = await run(readArgv[0]!, readArgv.slice(1), { cwd: inside }).catch(
    (error: unknown) => {
      failures.push(
        `the sandboxed command could not run at all: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { stdout: '' };
    },
  );
  if (readOk.stdout.trim() !== '') {
    console.log(`  ✓ inside     read its own file: ${JSON.stringify(readOk.stdout.trim())}`);
  }

  const scratch = path.join(inside, '..', 'scratch');
  await run('mkdir', ['-p', scratch]);
  const scratchArgv = (await wrapCommand(sandbox, 'echo ok > scratch.txt', inside, scratch))!;
  await run(scratchArgv[0]!, scratchArgv.slice(1), { cwd: inside }).catch(() => undefined);
  const scratchOk = await readFile(path.join(inside, 'scratch.txt'), 'utf8').then(
    () => true,
    () => false,
  );
  console.log(`  ${scratchOk ? '✓ scratch   ' : '✗ SCRATCH  '} write with a scratch root: ${scratchOk ? 'landed' : 'LOST'}`);
  if (!scratchOk) failures.push('a command could not write to its own workspace');

  const escapeArgv = (await wrap(`echo pwned > ${outside}`))!;
  await run(escapeArgv[0]!, escapeArgv.slice(1), { cwd: inside }).catch(() => undefined);
  const escaped = await readFile(outside, 'utf8').then(() => true, () => false);
  console.log(`  ${escaped ? '✗ ESCAPED  ' : '✓ outside   '} write beyond the workspace: ${escaped ? 'SUCCEEDED' : 'denied'}`);
  if (escaped) failures.push('a command wrote outside the workspace');

  // The listener, and the control that proves it is up. Without the control a
  // "denied" here is indistinguishable from "nothing was listening", which is
  // what this check used to be measuring.
  const stopProbeServer = await startProbeServer();
  const probeUrl = `http://127.0.0.1:${String(PROBE_PORT)}/`;
  const curl = ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}'];
  try {
    const control = await run('curl', [...curl, probeUrl]).catch(() => ({ stdout: '' }));
    if (control.stdout.trim() !== '200') {
      failures.push(
        'the network control failed: this host could not reach its own probe server, so ' +
          'a denial below would prove nothing',
      );
      console.log(`  ✗ CONTROL   the host could not reach ${probeUrl}\n`);
    } else {
      const netArgv = (await wrap(`curl ${curl.join(' ')} ${probeUrl}`))!;
      const net = await run(netArgv[0]!, netArgv.slice(1), { cwd: inside }).catch(() => ({
        stdout: '',
      }));
      const code = net.stdout.trim();
      const reached = code !== '' && code !== '000';
      console.log(`  ✓ control    the host reaches ${probeUrl} (HTTP 200)`);
      console.log(`  ${reached ? '✗ REACHED  ' : '✓ network   '} ${reached ? `got HTTP ${code}` : 'denied'}\n`);
      if (reached) failures.push(`a command reached the network (HTTP ${code})`);
    }
  } finally {
    await stopProbeServer();
  }

  await rm(work, { recursive: true, force: true });

  /*
   * The exit code is what makes this a gate rather than a report. Before it,
   * the script printed `✗ ESCAPED` and exited 0 — which is fine for a human
   * reading the output and useless to CI, and CI is what keeps the `verified`
   * label on `BUBBLEWRAP` earned rather than aging into a claim again.
   */
  if (failures.length > 0) {
    console.error(
      `sandbox-check: FAIL — ${sandbox.backend?.name ?? 'this backend'} did not do what it ` +
        `says on ${process.platform}:\n  · ${failures.join('\n  · ')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  sandbox-check: OK — ${sandbox.backend?.name ?? 'no backend'} holds.\n`);
}

await main();
