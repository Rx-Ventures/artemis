/**
 * The hard constraint, enforced.
 *
 * `@apollo/core` must never import `electron` — not directly, not transitively.
 * It has to run in a plain Node process (`scripts/smoke.ts`), under vitest, and
 * one day under a CLI or a server. Everything genuinely Electron-shaped is
 * injected as an interface instead: `SecretStore` for encrypted storage,
 * `userDataDir` for the profile location.
 *
 * This is written down in three doc comments and in the project brief, none of
 * which the compiler reads. A single `safeStorage` import added in a hurry
 * would typecheck (Electron's types are installed in the workspace), pass every
 * other test, and only fail when someone tried to run core outside Electron —
 * at which point the fix is a refactor, not a revert.
 *
 * So it is a test. It reads the package's own source rather than mocking
 * anything, which also means it covers files no other test imports.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Static imports, `require(…)` and dynamic `import(…)` of Electron or any of
 * its subpaths.
 *
 * Built from a fragment rather than written as one literal so that this file
 * does not itself match the repository-wide greps documented in the README.
 */
const ELECTRON_MODULE = String.raw`['"]electron(?:\/[^'"]*)?['"]`;
const ELECTRON_IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)${ELECTRON_MODULE}`,
);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      // Test files are excluded from `tsconfig`'s `include` and from the
      // package's published `files`, so they are not "core" in the sense that
      // matters here — and this file necessarily contains the pattern it looks
      // for.
      if (entry.name.endsWith('.test.ts')) return [];
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

describe('@apollo/core never imports electron', () => {
  it('has no electron import in any source file', async () => {
    const files = await sourceFiles(SRC_DIR);

    // Guard the guard: if the walk returns nothing, the test would pass
    // vacuously forever.
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (ELECTRON_IMPORT.test(text)) offenders.push(file.slice(SRC_DIR.length));
    }

    expect(offenders).toEqual([]);
  });

  it('declares no dependency on electron', async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = manifest as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    for (const bucket of [dependencies, devDependencies, peerDependencies]) {
      expect(Object.keys(bucket)).not.toContain('electron');
    }
  });
});
