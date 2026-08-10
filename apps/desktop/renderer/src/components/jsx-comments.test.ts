/**
 * A block comment sitting in JSX *child* position is not a comment — React
 * renders it as literal text. `{\/* ... *\/}` is a comment; a bare `\/* ... *\/`
 * between two elements is a text node, and it ships to the screen.
 *
 * This shipped twice in one session, so it gets a test. The real fix is
 * eslint's `react/jsx-no-comment-textnodes`; until this repo has a lint stack,
 * this stands in for it.
 *
 * The heuristic: an indented block comment whose previous non-blank line ends
 * in `>` is between JSX elements. Outside JSX, a line almost never ends in `>`
 * — generics resolve to `;`, `{`, or `,`. A false positive here is a loud test
 * failure someone can silence in one line; the bug it guards against is
 * invisible until a user screenshots it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = new URL('../..', import.meta.url).pathname;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'out') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

describe('source / JSX comments', () => {
  it('has no block comment stranded in JSX child position', () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');

      lines.forEach((line, index) => {
        // Indented block-comment opener. Top-level (column 0) comments are
        // section headers between declarations and are never JSX children.
        if (!/^\s+\/\*/.test(line)) return;

        // `{/*` is the correct form — already braced, nothing to flag.
        if (/\{\s*\/\*/.test(line)) return;

        let prev = index - 1;
        while (prev >= 0 && lines[prev]!.trim() === '') prev--;
        if (prev < 0) return;

        if (lines[prev]!.trimEnd().endsWith('>')) {
          offenders.push(`${file.slice(ROOT.length)}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
