/**
 * The renderer's one and only view of the outside world.
 *
 * `@libra/protocol` deliberately does not declare this global — doing so would
 * hand main-process code a bogus `Window`. The renderer declares it instead,
 * which is why `window.libra` typechecks here and nowhere else.
 */
import type { LibraBridge } from '@libra/protocol';

declare global {
  interface Window {
    /** Present only when the preload script has run. See `lib/bridge.ts`. */
    readonly libra?: LibraBridge;
  }
}

export {};
