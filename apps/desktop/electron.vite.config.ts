import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin, type UserConfig } from 'electron-vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Remove the renderer's `<meta http-equiv="Content-Security-Policy">` during
 * `dev`, and only during `dev`.
 *
 * `index.html` carries a strict CSP with `script-src 'self'`. That is correct
 * for a packaged build and is deliberately kept there as defence in depth — if
 * the main process ever failed to attach its header, the document would still
 * refuse remote script. But `@vitejs/plugin-react` injects its Fast Refresh
 * preamble as an *inline* module script, which `script-src 'self'` blocks, and
 * the page then dies on `$RefreshSig$ is not defined`.
 *
 * A CSP delivered by header cannot loosen one delivered by meta — the browser
 * intersects every policy it is given — so main's dev header (which does allow
 * `'unsafe-inline'` for script) cannot rescue this on its own. The meta tag has
 * to go in dev. Nothing is lost: `applySessionPolicy` sets a CSP header on
 * every response in both modes, so the dev renderer is still governed by the
 * development policy in `main/security.ts`.
 */
function stripDevCspMeta(): Plugin {
  return {
    name: 'apollo:strip-dev-csp-meta',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, ''),
    },
  };
}

/**
 * Build configuration for the three Electron layers.
 *
 * Workspace packages are deliberately *excluded* from externalization so they
 * get bundled into `out/`. Everything else in `dependencies` — the Claude Agent
 * SDK above all — stays external: it spawns processes and reads from disk at
 * runtime, and bundling it breaks both.
 *
 * OWNERSHIP: shared build infrastructure. The desktop implementer may extend
 * this (aliases, define, dev-server options); coordinate before restructuring
 * the entry points, since main/preload/renderer each have a tsconfig pinned to
 * these paths.
 *
 * ASYNC, deliberately. `@rolldown/plugin-babel` (which carries the React
 * Compiler preset) is an async plugin factory: it returns a `Promise`. Vite
 * itself flattens promises in `plugins`, but electron-vite deep-clones the
 * whole config *before* that flattening and throws `Cannot deep clone
 * non-plain object` on a bare Promise. Awaiting the factory here hands
 * electron-vite an already-resolved, plain plugin object. electron-vite
 * explicitly supports an async config function, so this is a supported shape,
 * not a workaround around its config loader.
 */
// The return type is annotated rather than inferred: an object literal handed
// straight to `defineConfig` gets contextually typed, but one returned from a
// function does not, and `preload.build.rollupOptions.output.format` would
// widen from the literal `'cjs'` to `string` and stop matching `ModuleFormat`.
export default defineConfig(async (): Promise<UserConfig> => ({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@apollo/core', '@apollo/protocol'] })],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: here('./main/index.ts') },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@apollo/protocol'] })],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: here('./preload/index.ts'),
        // CommonJS, deliberately. The app package is `"type": "module"`, so the
        // default output would be `.mjs` — and Electron only loads an ESM
        // preload when `sandbox` is disabled. Apollo keeps the sandbox on, so
        // the preload is emitted as CJS and referenced as `index.cjs` from
        // `BrowserWindow`'s `webPreferences.preload`.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },

  renderer: {
    root: here('./renderer'),
    // React Compiler runs as a Babel preset fed to `@rolldown/plugin-babel`.
    // `@vitejs/plugin-react` 6 no longer carries a `babel` option of its own —
    // the compiler is opt-in and wired up separately, exactly as here.
    plugins: [
      stripDevCspMeta(),
      react(),
      await babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ],
    resolve: {
      alias: { '@': here('./renderer/src') },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: here('./renderer/index.html') },
    },
  },
}));
