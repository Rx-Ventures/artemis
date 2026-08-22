import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test configuration for the desktop package.
 *
 * Added when the renderer gained its first component test. Before that there
 * was no config at all and Vitest's defaults were enough, so this file keeps
 * as close to those defaults as possible — the only thing it really has to do
 * is teach Vitest the `@/*` alias, because renderer source (and every shadcn
 * component in it) imports `@/lib/utils` and `@/components/ui/*`, and Vitest
 * does not read `electron.vite.config.ts`.
 *
 * FOURTH PLACE THE ALIAS LIVES. The other three are
 * `renderer/tsconfig.json` (the compiler), `./tsconfig.json` (tooling that
 * looks next to `components.json`, i.e. the shadcn CLI), and
 * `electron.vite.config.ts` → `renderer.resolve.alias` (the bundler). All four
 * must point at `renderer/src`.
 *
 * No `environment` is set globally: main- and preload-process tests are Node
 * tests and jsdom would only slow them down. Renderer component tests opt in
 * per file with a `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  test: {
    // A hermetic, per-worker localStorage — see the setup file for the two
    // failure modes the shared `--localstorage-file` store had. With it, a
    // bare `npx vitest` behaves like CI and the NODE_OPTIONS flag is obsolete.
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./renderer/src', import.meta.url)),
    },
  },
});
