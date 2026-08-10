/**
 * Sessions: the live-run registry the host process drives.
 *
 * ```ts
 * const runs = new RunRegistry({ resolveAdapter: (id) => adapters.get(id) })
 * const off = runs.subscribe((event) => window.webContents.send(IPC_PUSH.agentEvent, event))
 * const handle = await runs.start(input)
 * // …
 * await runs.disposeAll()
 * ```
 */

export * from './errors.js';
export * from './registry.js';
