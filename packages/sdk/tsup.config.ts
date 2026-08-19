/**
 * How the published tarball is built.
 * ============================================================================
 *
 * The SDK's source imports `@rx-artemis/protocol` — for the wire types, and for
 * a handful of runtime values (`SERVER_HOST`, `DEFAULT_SERVER_PORT`,
 * `CHAT_EXTENSIONS_FIELD`, the route helpers). That import is the whole reason
 * the SDK cannot drift from the server: one definition, checked by the compiler
 * on every build.
 *
 * It is also unpublishable. `@rx-artemis/protocol` is private and lives in this
 * workspace, so a tarball that merely *depended* on it would install fine here
 * and fail at every consumer, which is the worst place to find out.
 *
 * So the artifact is flattened and the source is not. `noExternal` pulls
 * protocol into the bundle — both its JavaScript and its declarations — leaving
 * a package with **zero dependencies** that resolves against nothing. The
 * compiler still sees two packages; npm sees one.
 *
 * ## Why not vendor the types into `src/` instead
 *
 * That is the same flattening done by hand, permanently, in the place where it
 * can rot: a copy of `ServerModel` in this package would be free to disagree
 * with the one the server actually serialises, and the disagreement would show
 * up as a field that is quietly always `undefined`. Bundling gets the identical
 * artifact without a second source of truth.
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. The package is `"type": "module"` and every runtime it targets —
  // Node 18+, Deno, Bun, browsers — imports ESM natively; a CJS twin would be
  // a second artifact to keep honest for consumers who do not need it.
  format: ['esm'],
  /*
   * Declarations are emitted by `tsc`, not here.
   *
   * tsup's dts bundler reads a TypeScript API that TypeScript 7 no longer
   * exposes (`useCaseSensitiveFileNames`) and throws. Holding the whole repo's
   * compiler back to suit a bundler would be the wrong trade, so the types are
   * emitted by the real compiler and flattened by `scripts/pack.mjs`.
   */
  dts: false,
  // The point of the whole file: protocol goes *in* rather than being required.
  noExternal: ['@rx-artemis/protocol'],
  clean: true,
  sourcemap: true,
  // Readability over bytes. This is a few hundred lines that someone will read
  // in `node_modules` when something surprises them, and the comments in it are
  // load-bearing — see `client.ts` on why the public types name no environment.
  minify: false,
  target: 'es2023',
  outDir: 'dist',
});
