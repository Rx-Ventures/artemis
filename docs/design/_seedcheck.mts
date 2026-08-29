/**
 * Round five's honesty pass: re-verify the emitted seed mockups through the
 * repo's own validator math.
 *
 * `_seed_build.py` enforces gamut, AA and the 40° rule with a Python port of
 * `renderer/src/lib/oklch.ts`. A port can drift, so this script reads the
 * variant-(b) files it emitted — 5b-violet.html (dark) and 5e-violet-light.html
 * (light) — extracts their token blocks with the same regex discipline as
 * `palette.test.ts`, and recomputes every claim through the TypeScript
 * original. Its output is pasted into `_seeds.md` as the seedcheck table.
 *
 *     node docs/design/_seedcheck.mts
 *
 * Exits non-zero if any claim fails, so it can gate a rebuild.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  contrastRatio,
  hueDistance,
  inGamut,
  type Oklch,
} from '../../apps/desktop/renderer/src/lib/oklch.ts';

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

/** Token declarations in the file's `:root` block. Alpha washes are skipped —
 *  the regex requires `)` straight after the hue, exactly as the app test's
 *  does — and a silent zero-token parse is a failure, not a pass. */
function tokensIn(file: string): Record<string, Oklch> {
  const css = readFileSync(here(file), 'utf8');
  const from = css.indexOf(':root {');
  const body = css.slice(from, css.indexOf('\n}', from));
  const found: Record<string, Oklch> = {};
  const pattern = /--([a-z0-9-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g;
  for (const m of body.matchAll(pattern)) {
    found[m[1]!] = { l: Number(m[2]), c: Number(m[3]), h: Number(m[4]) };
  }
  if (Object.keys(found).length < 20) {
    throw new Error(`${file}: parsed only ${Object.keys(found).length} tokens`);
  }
  return found;
}

/** Read as text at 13px — owed 4.5:1 on both grounds (WCAG AA). */
const READABLE = ['ink', 'ink-2', 'ink-3', 'accent-text', 'tool', 'think', 'ok', 'warn', 'err'];
/** The accent plus the five status hues — owed 40° pairwise separation. */
const MEANINGFUL = ['accent', 'tool', 'think', 'ok', 'warn', 'err'];

let failures = 0;
const f = (n: number) => n.toFixed(2);
const verdict = (pass: boolean) => {
  if (!pass) failures += 1;
  return pass ? 'pass' : 'FAIL';
};

const themes: Array<[string, string]> = [
  ['dark', '5b-violet.html'],
  ['light', '5e-violet-light.html'],
];

for (const [theme, file] of themes) {
  const t = tokensIn(file);
  const grounds: Array<[string, Oklch]> = [
    ['bg', t.bg!],
    ['chrome', t.chrome!],
  ];

  console.log(`\n### ${theme} (${file})\n`);

  const clipped = Object.entries(t).filter(([, c]) => !inGamut(c));
  console.log(
    `Gamut: ${Object.keys(t).length} tokens, ${clipped.length} clip` +
      (clipped.length ? ` — ${verdict(false)}: ${clipped.map(([n]) => n).join(', ')}` : ` (${verdict(true)})`),
  );

  console.log('\n| token | value | on --bg | on --chrome | rule | verdict |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const name of READABLE) {
    const c = t[name]!;
    const [a, b] = grounds.map(([, g]) => contrastRatio(c, g)) as [number, number];
    const pass = a >= 4.5 && b >= 4.5;
    console.log(
      `| \`--${name}\` | \`oklch(${c.l}% ${c.c} ${c.h})\` | ${f(a)} | ${f(b)} | ≥4.5 text | ${verdict(pass)} |`,
    );
  }
  for (const [name, rule, min] of [
    ['accent', '≥3.0 fill', 3.0],
    ['line-2', '≥3.0 boundary', 3.0],
  ] as const) {
    const c = t[name]!;
    const [a, b] = grounds.map(([, g]) => contrastRatio(c, g)) as [number, number];
    const pass = a >= min && b >= min;
    console.log(
      `| \`--${name}\` | \`oklch(${c.l}% ${c.c} ${c.h})\` | ${f(a)} | ${f(b)} | ${rule} | ${verdict(pass)} |`,
    );
  }
  for (const [ink, fill] of [
    ['accent-ink', 'accent'],
    ['warn-ink', 'warn'],
  ] as const) {
    const r = contrastRatio(t[ink]!, t[fill]!);
    console.log(
      `| \`--${ink}\` on \`--${fill}\` | \`oklch(${t[ink]!.l}% ${t[ink]!.c} ${t[ink]!.h})\` | — | ${f(r)} | ≥4.5 on fill | ${verdict(r >= 4.5)} |`,
    );
  }
}

// Hue separations are theme-independent (both passes share the hue set).
const t = tokensIn('5b-violet.html');
console.log('\n### pairwise hue distances (accent + five status hues, both themes)\n');
console.log('| pair | Δ° | verdict |');
console.log('| --- | --- | --- |');
for (const [i, a] of MEANINGFUL.entries()) {
  for (const b of MEANINGFUL.slice(i + 1)) {
    const d = hueDistance(t[a]!.h, t[b]!.h);
    console.log(`| \`${a}\` ${t[a]!.h}° ↔ \`${b}\` ${t[b]!.h}° | ${d.toFixed(0)} | ${verdict(d >= 40)} |`);
  }
}

console.log(`\n${failures === 0 ? 'All claims hold.' : `${failures} FAILURE(S).`}`);
process.exit(failures === 0 ? 0 : 1);
