/**
 * Does an attached file actually reach the agent?
 *
 * `fileInput` was turned on because the handshake advertises
 * `promptCapabilities.embeddedContext`. An advertisement is not a delivery, and
 * this adapter has already shipped one capability that was declared and never
 * sent — so the claim gets driven before it is believed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createOpencodeAdapter } from '../packages/core/src/adapters/opencode.js';

const CODE = 'FALCON-7719';

async function main(): Promise<void> {
  const adapter = createOpencodeAdapter();
  const cwd = mkdtempSync(path.join(tmpdir(), 'oc-attach-'));
  const home = mkdtempSync(path.join(tmpdir(), 'oc-home-'));

  const run = await adapter.createRun({
    runId: 'attach-check' as never,
    prompt:
      process.argv[2] === 'image'
        ? 'An image is attached. Reply with exactly: IMAGE_ARRIVED'
        : 'A file is attached to this message. Reply with ONLY the secret code written inside it.',
    cwd,
    env: { XDG_DATA_HOME: home },
    attachments:
      process.argv[2] === 'image'
        ? [
            {
              kind: 'image',
              id: 'i1',
              mediaType: 'image/png',
              // A 1x1 transparent PNG. Enough to prove the block is accepted.
              data:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            },
          ]
        : [
            {
              kind: 'file',
              id: 'f1',
              name: 'secret.txt',
              mediaType: 'text/plain',
              data: `The secret code is ${CODE}.`,
            },
          ],
  } as never);

  let text = '';
  for await (const event of run.events) {
    if (event.type === 'text.delta') text += (event as unknown as { text: string }).text;
    if (event.type === 'run.end') {
      const end = event as unknown as { reason: string; error?: { message: string } };
      console.log(`\n  run.end  ${end.reason}${end.error ? ` — ${end.error.message}` : ''}`);
    }
  }

  console.log(`  reply    ${JSON.stringify(text.trim())}`);
  console.log(
    text.includes(CODE)
      ? '\n  ✓ the agent read the embedded file\n'
      : '\n  ✗ the code did not come back — the file did not arrive\n',
  );
}

await main();
