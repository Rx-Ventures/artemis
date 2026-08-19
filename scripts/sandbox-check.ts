/**
 * What this machine can actually enforce, and proof that it does.
 *
 * The counterpart to `local-smoke.ts`: that one drives a model, this one drives
 * the sandbox. Useful on a platform whose backend has never been verified —
 * run it on Linux and the unverified label can come off bubblewrap.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describeConfinement, resolveSandbox, wrapCommand } from '../packages/core/src/adapters/local/commandSandbox.js';

const run = promisify(execFile);

async function main(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), 'artemis-sbcheck-'));
  const outside = path.join(work, 'outside.txt');
  const inside = path.join(work, 'project');
  await run('mkdir', ['-p', inside]);
  await writeFile(path.join(inside, 'secret.txt'), 'ZX-99\n');

  const sandbox = await resolveSandbox(process.platform, async (binary) => {
    if (binary.startsWith('/')) return existsSync(binary);
    return run('which', [binary]).then(() => true, () => false);
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

  const readOk = await run(readArgv[0]!, readArgv.slice(1), { cwd: inside });
  console.log(`  ✓ inside     read its own file: ${JSON.stringify(readOk.stdout.trim())}`);

  const escapeArgv = (await wrap(`echo pwned > ${outside}`))!;
  await run(escapeArgv[0]!, escapeArgv.slice(1), { cwd: inside }).catch(() => undefined);
  const escaped = await readFile(outside, 'utf8').then(() => true, () => false);
  console.log(`  ${escaped ? '✗ ESCAPED  ' : '✓ outside   '} write beyond the workspace: ${escaped ? 'SUCCEEDED' : 'denied'}`);

  const netArgv = (await wrap('curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:1234/v1/models'))!;
  const net = await run(netArgv[0]!, netArgv.slice(1), { cwd: inside }).catch(() => ({ stdout: '' }));
  const reached = net.stdout.trim() !== '' && net.stdout.trim() !== '000';
  console.log(`  ${reached ? '✗ REACHED  ' : '✓ network   '} ${reached ? `got HTTP ${net.stdout.trim()}` : 'denied'}\n`);

  await rm(work, { recursive: true, force: true });
}

await main();
