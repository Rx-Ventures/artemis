/**
 * Driving a local server through the adapter, without Electron.
 *
 * The counterpart to `opencode-smoke.ts`: the whole path — flavour, catalogue,
 * run, event stream — in a plain Node process, against a server on this machine.
 * Costs nothing and bills nobody, which is the point of local models.
 */
import { createLocalAdapter, LLAMA_CPP, LM_STUDIO, OLLAMA } from '../packages/core/src/adapters/local/adapter.js';

const FLAVOURS = { lmstudio: LM_STUDIO, ollama: OLLAMA, llamacpp: LLAMA_CPP } as const;

async function main(): Promise<void> {
  const key = (process.argv[2] ?? 'lmstudio') as keyof typeof FLAVOURS;
  const flavour = FLAVOURS[key];
  if (flavour === undefined) throw new Error(`Unknown server "${key}".`);

  const adapter = createLocalAdapter(flavour);
  const available = await adapter.checkAvailability!();
  console.log(`\n  ${flavour.label} — ${JSON.stringify(available)}`);
  if (!available.available) return;

  const cat = await adapter.listModels!({ env: {}, cwd: process.cwd() } as never);
  console.log(`\n  ✓ listModels   ${cat.models.length} model(s), live=${cat.live}`);
  for (const m of cat.models) console.log(`      ${m.id} — ${m.note}`);

  const model = process.argv[3] ?? cat.models[0]?.id;
  if (model === undefined) return console.log('\n  no model to run against.');

  console.log(`\n  → turn against ${model}`);
  const run = await adapter.createRun({
    runId: 'local-smoke' as never,
    prompt: process.argv[4] ?? 'Reply with exactly: ARTEMIS_LOCAL_OK',
    cwd: process.cwd(),
    model,
    env: {},
    permissionMode: 'bypassPermissions',
  } as never);

  let text = '';
  const seen: string[] = [];
  for await (const ev of run.events) {
    seen.push(ev.type);
    if (ev.type === 'text.delta') text += (ev as unknown as { text: string }).text;
    if (ev.type === 'tool.start') {
      const t = ev as unknown as { name: string; input: unknown };
      console.log(`  tool.start     ${t.name} ${JSON.stringify(t.input)}`);
    }
    if (ev.type === 'tool.end') {
      const t = ev as unknown as { name: string; status: string; resultText?: string };
      console.log(`  tool.end       ${t.name} ${t.status} — ${(t.resultText ?? '').slice(0, 90).replace(/\n/g, ' ')}`);
    }
    if (ev.type === 'run.end') {
      const end = ev as unknown as { reason: string; error?: { message: string } };
      console.log(`  run.end        ${end.reason}${end.error ? ' — ' + end.error.message : ''}`);
    }
  }
  console.log(`  events         ${seen.length}: ${[...new Set(seen)].join(', ')}`);
  console.log(`  reply          ${JSON.stringify(text)}\n`);
}

await main();
