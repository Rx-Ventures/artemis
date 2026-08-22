/**
 * A hermetic localStorage per worker, replacing the one Node shares on disk.
 *
 * Local runs used to need `NODE_OPTIONS="--localstorage-file=…"`, because Node
 * keeps `localStorage` behind that flag and several renderer suites read it.
 * The flag has a property nobody wanted: the file is **one SQLite store shared
 * by every vitest fork**, and Node's global shadows the per-environment one
 * jsdom would otherwise provide. Two consequences, both observed at length:
 *
 *  - **State outlives its test.** A prefs blob written by one file — or one
 *    *run* — seeds the next file's module-scope `loadPrefs`, which is how a
 *    suite went green against a store that recorded nothing, and why harness
 *    comments warn against trusting `localStorage.clear()`.
 *  - **Writes can lose.** Workers overlap at the file even under
 *    `VITEST_MAX_FORKS=1` — the next fork starts while the last flushes — and
 *    a `setItem` that loses the race is silent. The visible symptom was the
 *    `sessionModelMemory` persistence tests failing one run in three with a
 *    restored record of nothing, in whichever file order the timing cache
 *    happened to produce that day.
 *
 * CI never saw any of this because it never set the flag: there, storage is
 * per-process and in-memory. This file makes local runs behave like CI —
 * every worker gets its own in-memory store, no flag required, and the
 * `NODE_OPTIONS` incantation can be forgotten.
 *
 * The shim is deliberately the whole `Storage` surface and nothing more.
 * `structuredClone` semantics, events, and cross-window sharing are browser
 * concerns no test here has; what the tests need is that a value written is a
 * value read back, which is exactly the property the shared file lost.
 */

const store = new Map<string, string>();

const memoryLocalStorage = {
  get length(): number {
    return store.size;
  },
  key(index: number): string | null {
    return [...store.keys()][index] ?? null;
  },
  getItem(name: string): string | null {
    return store.get(String(name)) ?? null;
  },
  setItem(name: string, value: string): void {
    store.set(String(name), String(value));
  },
  removeItem(name: string): void {
    store.delete(String(name));
  },
  clear(): void {
    store.clear();
  },
};

// `defineProperty` rather than assignment: when Node was started with the
// flag, its own `localStorage` is an accessor on `globalThis` and plain
// assignment throws in strict mode. Configurable, so an individual test that
// genuinely wants to replace it still can.
Object.defineProperty(globalThis, 'localStorage', {
  value: memoryLocalStorage,
  configurable: true,
  writable: true,
});
