/**
 * The build-time flavour define, declared so `main/index.ts` can read it.
 *
 * Substituted by `electron.vite.config.ts` from `ARTEMIS_FLAVOUR`. `declare`
 * rather than a real export because there is nothing to import at runtime — the
 * bundler replaces the identifier with a string literal — and the `typeof`
 * guard at the use site covers the unbundled case where it was never defined.
 */
declare const __ARTEMIS_FLAVOUR__: string | undefined;
