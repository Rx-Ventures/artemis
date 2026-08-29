/**
 * Sessions: the live-run registry the host process drives, and the two
 * subscribers that record what the sessions those runs produce are called and
 * whose they are.
 *
 * ```ts
 * const runs = new RunRegistry({ resolveAdapter: (id) => adapters.get(id) })
 * const namer = new SessionNamer({ resolveAdapter: (id) => adapters.get(id), plan })
 * const owners = new SessionOwners({ userDataDir })
 * const off = runs.subscribe((event) => {
 *   namer.handleEvent(event)
 *   owners.handleEvent(event)
 *   window.webContents.send(IPC_PUSH.agentEvent, event)
 * })
 * const handle = await runs.start(input)
 * namer.noteRun(input, handle.runId)
 * owners.noteRun(input, handle.runId)
 * // …
 * await Promise.all([runs.disposeAll(), namer.dispose(), owners.flush()])
 * ```
 */

export * from './errors.js';
export * from './registry.js';
export * from './naming.js';
export * from './owners.js';
export * from './lifecycleLog.js';
