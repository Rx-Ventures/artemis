/**
 * Sessions: the live-run registry the host process drives, and the naming of
 * the sessions those runs produce.
 *
 * ```ts
 * const runs = new RunRegistry({ resolveAdapter: (id) => adapters.get(id) })
 * const namer = new SessionNamer({ resolveAdapter: (id) => adapters.get(id), plan })
 * const off = runs.subscribe((event) => {
 *   namer.handleEvent(event)
 *   window.webContents.send(IPC_PUSH.agentEvent, event)
 * })
 * const handle = await runs.start(input); namer.noteRun(input, handle.runId)
 * // …
 * await Promise.all([runs.disposeAll(), namer.dispose()])
 * ```
 */

export * from './errors.js';
export * from './registry.js';
export * from './naming.js';
