/**
 * Workspace: facts about the directory an agent is pointed at.
 *
 * ```ts
 * const check = await checkWorkingDirectory(input.cwd)
 * if (!check.ok) throw new RunError('invalid_request', check.message)
 * ```
 *
 * Two modules, two questions about the same directory:
 *
 *  - `workdir.ts` — *can* it be used? Asked before a provider subprocess is
 *    spawned with it, because `spawn`'s error for a bad cwd is indistinguishable
 *    from its error for a missing binary.
 *  - `repo.ts` — what is it *called*? Asked by the sidebar, which heads a
 *    session list with the name of the repository rather than of the directory.
 *
 * Both answer rather than throw, and neither needs `git` on the PATH.
 */

export * from './workdir.js';
export * from './repo.js';
