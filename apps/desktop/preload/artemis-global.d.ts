/**
 * The `window.artemis` global.
 *
 * `@rx-artemis/protocol` deliberately does not declare this: the protocol package is
 * compiled into the main process too, and a `Window` interface there would be a
 * lie — there is no DOM in the main process, and code that accidentally reached
 * for `window` would typecheck instead of failing.
 *
 * So the declaration lives next to the script that actually creates the global.
 *
 * ### For the renderer
 *
 * The renderer's tsconfig references `@rx-artemis/protocol` only, not this project,
 * so it needs its own copy. Drop this into
 * `apps/desktop/renderer/src/global.d.ts` verbatim — `renderer/tsconfig.json`
 * already includes `*.d.ts`:
 *
 * ```ts
 * import type { ArtemisBridge } from '@rx-artemis/protocol';
 *
 * declare global {
 *   interface Window {
 *     readonly artemis: ArtemisBridge;
 *   }
 * }
 *
 * export {};
 * ```
 *
 * `readonly` matters: `contextBridge.exposeInMainWorld` installs a
 * non-configurable property, so an assignment to `window.artemis` fails at
 * runtime. Better to fail at compile time.
 */

import type { ArtemisBridge } from '@rx-artemis/protocol';

declare global {
  interface Window {
    readonly artemis: ArtemisBridge;
  }
}

export {};
