/**
 * Make `dist/` self-contained, so the tarball resolves against nothing.
 * ============================================================================
 *
 * The SDK imports `@rx-artemis/protocol` — deliberately, because one definition
 * of the wire types checked by the compiler is what keeps this package from
 * drifting from the server it talks to. That import is also unpublishable:
 * protocol is private and lives in this workspace, so a tarball that depended
 * on it would install here and fail at every consumer.
 *
 * `tsup` already solves half of it — `noExternal` inlines protocol's JavaScript
 * into `dist/index.js`. It cannot solve the other half: its declaration
 * bundler reads a TypeScript API that TypeScript 7 no longer exposes
 * (`useCaseSensitiveFileNames`), so `dts: true` throws. Rather than hold the
 * repo's compiler back to suit a bundler, the declarations are flattened here.
 *
 * ## What it does
 *
 * Copies protocol's emitted declarations into `dist/_protocol/` and rewrites
 * the SDK's own `.d.ts` files to point there. Protocol's declarations already
 * import each other *relatively* (`./server.js`, `./ipc.js`), so moving the
 * folder wholesale preserves them; only the one bare specifier crossing the
 * package boundary has to change.
 *
 * ## Why not vendor the types into `src/` instead
 *
 * That is this rewrite done by hand, permanently, in the place where it can
 * rot: a second copy of `ServerModel` would be free to disagree with the one
 * the server actually serialises, and the disagreement would surface as a field
 * that is quietly always `undefined`. This runs at pack time, from the real
 * declarations, every time.
 */

import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const protocolDist = join(here, '..', '..', 'protocol', 'dist');

/** Where protocol's declarations land inside the tarball. */
const VENDORED = '_protocol';

/**
 * The specifier that must not survive into the published types.
 *
 * Checked for by name rather than by pattern, so that a *new* cross-package
 * import — a day someone adds `@rx-artemis/core` to this package — fails this
 * script loudly instead of shipping a tarball that cannot resolve.
 */
const BARE = '@rx-artemis/protocol';

await cp(protocolDist, join(dist, VENDORED), {
  recursive: true,
  // Declarations and their maps only. The JavaScript is already inlined by
  // tsup, and shipping a second copy would be dead weight a reader would have
  // to work out the status of.
  filter: (source) =>
    !source.endsWith('.js') && !source.endsWith('.js.map') && !source.includes('.tsbuildinfo'),
});

const entries = await readdir(dist, { withFileTypes: true });
let rewritten = 0;

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
  const path = join(dist, entry.name);
  const before = await readFile(path, 'utf8');
  // `./_protocol/index.js`, with the `.js` extension NodeNext resolution wants
  // even though the file on disk is `.d.ts`.
  const after = before.replaceAll(`'${BARE}'`, `'./${VENDORED}/index.js'`);
  if (after !== before) {
    await writeFile(path, after, 'utf8');
    rewritten += 1;
  }
}

/*
 * Prove it rather than assume it.
 *
 * The failure this catches is the one that only appears at a consumer: a
 * declaration still *importing* a package that is not in `dependencies` and not
 * on any registry. Better to fail the pack than to publish it.
 *
 * Specifiers only — a quoted module id in an `import`, `export` or `import()`
 * type. The first version of this check looked for the package name anywhere in
 * the file and failed on a sentence in a doc comment that merely explains where
 * the wire types come from, which is prose worth keeping.
 */
const SPECIFIER = new RegExp(String.raw`(?:from|import\(|module)\s*['"]${BARE}['"]`);

const remaining = [];
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (!entry.name.endsWith('.d.ts') && !entry.name.endsWith('.js')) continue;
  const text = await readFile(join(dist, entry.name), 'utf8');
  if (SPECIFIER.test(text)) remaining.push(entry.name);
}

if (remaining.length > 0) {
  console.error(
    `pack: ${remaining.join(', ')} still reference ${BARE} — the tarball would not resolve.`,
  );
  process.exit(1);
}

console.log(`pack: bundled protocol into dist/${VENDORED}, rewrote ${rewritten} declaration file(s)`);
