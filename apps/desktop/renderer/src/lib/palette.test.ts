/**
 * The palette's own claims, re-derived from the stylesheet on every run.
 *
 * `index.css` makes five promises in prose. Prose does not fail a build, so
 * this reads the actual file and checks them:
 *
 *   1. every token falls inside sRGB with no clipping
 *   2. every ink and semantic colour clears WCAG AA on both grounds
 *   3. the accent and the five semantics are at least 40° apart in hue
 *   4. `--line-strong` clears 3:1 against the surfaces it draws boundaries on
 *   5. `--beam` — a fill now, not a text colour — clears 3:1 on both grounds
 *
 * Three real errors were caught by exactly this check while the palette was
 * being written — a teal accent above the sRGB ceiling, `--cyan` sitting on the
 * accent's own hue with zero separation, and a near-black `--beam-ink` that
 * clipped. None was visible by eye in a swatch. That is the argument for the
 * file existing.
 *
 * It parses CSS with a regex, which is normally a mistake. It is fine here
 * because the thing being matched is a token declaration in a file this repo
 * owns and formats, and because the parse failing loudly (zero tokens found)
 * is itself a test failure rather than a silent pass.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { contrastRatio, hueDistance, inGamut, type Oklch } from './oklch';

const CSS = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

/** Tokens declared between `start` and the next line that closes the block. */
function tokensIn(start: string): Record<string, Oklch> {
  const from = CSS.indexOf(start);
  expect(from, `could not find the ${start.trim()} block`).toBeGreaterThan(-1);
  const to = CSS.indexOf('\n}', from);
  const body = CSS.slice(from, to);

  const found: Record<string, Oklch> = {};
  const pattern = /--([a-z-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g;
  for (const m of body.matchAll(pattern)) {
    found[m[1]!] = { l: Number(m[2]), c: Number(m[3]), h: Number(m[4]) };
  }
  return found;
}

const THEMES = {
  dark: tokensIn(':root {'),
  light: tokensIn('\n.light {'),
} as const;

/**
 * Text and semantic colours, which are read rather than merely seen.
 *
 * `beam-text` stands where `beam` used to. The accent is a deep fill now —
 * docs/design/_seeds.md records the split — so the fill is owed 3:1 as a
 * component (checked below) and its derived text companion is what carries
 * the 4.5 duty here. Putting `beam` back in this list would fail honestly.
 */
const READABLE = [
  'ink',
  'ink-muted',
  'ink-faint',
  'beam-text',
  'cyan',
  'sage',
  'mint',
  'amber',
  'signal',
];

/** The accent plus the five semantics — the set that must stay tellable apart. */
const MEANINGFUL = ['beam', 'cyan', 'sage', 'mint', 'amber', 'signal'];

describe.each(Object.entries(THEMES))('%s theme', (theme, tokens) => {
  it('parses a full set of tokens', () => {
    // A regex that silently matched nothing would pass every check below.
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(19);
    for (const name of [...READABLE, 'abyss', 'panel', 'raised', 'float', 'inset', 'line']) {
      expect(tokens[name], `${theme} is missing --${name}`).toBeDefined();
    }
  });

  it.each(Object.entries(tokens))('--%s falls inside sRGB', (name, colour) => {
    expect(inGamut(colour), `--${name} clips in ${theme}`).toBe(true);
  });

  it.each(READABLE)('--%s clears WCAG AA on both grounds', (name) => {
    const colour = tokens[name]!;
    for (const ground of ['abyss', 'panel'] as const) {
      const ratio = contrastRatio(colour, tokens[ground]!);
      expect(ratio, `--${name} on --${ground} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the meaningful colours at least 40° apart', () => {
    for (const [i, a] of MEANINGFUL.entries()) {
      for (const b of MEANINGFUL.slice(i + 1)) {
        const apart = hueDistance(tokens[a]!.h, tokens[b]!.h);
        expect(apart, `--${a} and --${b} in ${theme} are ${apart.toFixed(0)}° apart`).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it('draws component boundaries at 3:1 or better', () => {
    // WCAG 1.4.11: --line-strong is scrollbar thumbs and unchecked radios,
    // which are UI components and owed 3:1 — unlike a decorative hairline,
    // which is owed nothing and is why --line is not checked here.
    for (const ground of ['abyss', 'panel'] as const) {
      const ratio = contrastRatio(tokens['line-strong']!, tokens[ground]!);
      expect(ratio, `--line-strong on --${ground} in ${theme}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('holds the accent fill at 3:1 or better on both grounds', () => {
    // --beam left READABLE when it became a fill — buttons, rings, the
    // shuttle — and --beam-text took over accent-as-text duty. A fill is
    // still a meaningful component, so it is owed 3:1 under 1.4.11, and the
    // seed derivation walks the accent until it clears exactly this.
    for (const ground of ['abyss', 'panel'] as const) {
      const ratio = contrastRatio(tokens['beam']!, tokens[ground]!);
      expect(ratio, `--beam on --${ground} in ${theme}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the two themes agree with each other', () => {
  it('declares the same token names in both', () => {
    // A token defined in one theme and not the other resolves to the dark
    // value in light, which is the sort of thing nobody notices until a
    // screenshot looks wrong.
    const dark = Object.keys(THEMES.dark).sort();
    const light = Object.keys(THEMES.light).sort();
    expect(light).toEqual(dark);
  });
});
