/**
 * Workspace: facts about the directory an agent is pointed at.
 *
 * ```ts
 * const check = await checkWorkingDirectory(input.cwd)
 * if (!check.ok) throw new RunError('invalid_request', check.message)
 * ```
 *
 * One module, one job: turn "is this cwd usable?" into an answer with a
 * message a person can act on, *before* a provider subprocess is spawned with
 * it. See `workdir.ts` for why that has to happen up front.
 */

export * from './workdir.js';
