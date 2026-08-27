/**
 * Team memory banks: the part of them core is allowed to know about.
 *
 * Almost nothing, deliberately. The banks are driven by their own CLI from the
 * main process (`apps/desktop/main/memoryBanks.ts` says why a second
 * implementation in TypeScript would drift), so core holds no bank logic at
 * all. What it holds is the *shape of the thing main must inject*: a store for
 * the git credential a private bank needs, declared here because the
 * encryption behind it is Electron's and core may not name Electron.
 */

export * from './secrets.js';
