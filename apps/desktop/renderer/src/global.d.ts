/**
 * The renderer's one and only view of the outside world.
 *
 * `@rx-artemis/protocol` deliberately does not declare this global — doing so would
 * hand main-process code a bogus `Window`. The renderer declares it instead,
 * which is why `window.artemis` typechecks here and nowhere else.
 */
import type { ArtemisBridge } from '@rx-artemis/protocol';

declare global {
  interface Window {
    /** Present only when the preload script has run. See `lib/bridge.ts`. */
    readonly artemis?: ArtemisBridge;
  }
}

export {};
