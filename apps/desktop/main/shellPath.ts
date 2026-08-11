/**
 * The login shell's PATH, adopted into a GUI-launched process.
 *
 * An app launched from Finder inherits launchd's environment, whose PATH is
 * the bare `/usr/bin:/bin:/usr/sbin:/sbin`. Everything Artemis spawns by name
 * — the user's `claude` CLI for auth status and plan usage, `gh` for update
 * checks — lives in directories that PATH has never heard of (`~/.local/bin`,
 * `/opt/homebrew/bin`, a version manager's shims). The symptom is
 * `spawn claude ENOENT` from the installed app while `pnpm dev` works
 * perfectly, because a terminal launch inherits the shell's real PATH.
 *
 * The fix is to ask the user's own login shell what PATH it would have and
 * merge that into `process.env.PATH` once, at startup, before anything
 * spawns. One subprocess, interactive + login flags so both profile and rc
 * files contribute (nvm and friends export from rc files), a hard timeout so
 * a pathological shell config cannot wedge startup, and a fallback list of
 * well-known directories for when the shell cannot be asked at all.
 *
 * Split like `appNames.ts`: the parsing and merging are pure and tested; the
 * one impure function is the subprocess call.
 */

import { execFile } from 'node:child_process';
import { basename, delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import { createLogger } from './log.js';

const execFileAsync = promisify(execFile);

const log = createLogger('shellPath');

/**
 * Where CLIs live when the shell cannot tell us. Merged in even when it can —
 * a directory that is already present is dropped by the dedupe.
 */
export const WELL_KNOWN_BIN_DIRS: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local', 'bin'),
];

/**
 * The PATH out of a login shell's output.
 *
 * Interactive rc files are allowed to print (greetings, version-manager
 * chatter), and all of it lands *before* our `printf` because the command
 * runs after the rc files finish. So the PATH is the last non-empty line —
 * and if that line does not look like a PATH at all, the shell printed
 * something we do not understand and the answer is "nothing" rather than a
 * corrupted merge.
 */
export function parseShellPathOutput(output: string): string | null {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const last = lines.at(-1);
  if (last === undefined || !last.includes('/')) return null;
  return last;
}

/**
 * One PATH out of many, first occurrence wins.
 *
 * The login shell's order is the user's order, so it leads; whatever the
 * process already had follows (launchd's system directories are in both, so
 * in practice they keep their place); the well-known fallbacks trail, only
 * filling genuine gaps.
 */
export function mergePaths(
  loginPath: string | null,
  currentPath: string | undefined,
  fallbacks: readonly string[],
): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of [loginPath ?? '', currentPath ?? '', fallbacks.join(delimiter)]) {
    for (const dir of source.split(delimiter)) {
      if (dir === '' || seen.has(dir)) continue;
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(delimiter);
}

/** Shells whose `-ilc 'printf …'` contract we trust. Anything else gets zsh. */
const SH_LIKE = new Set(['zsh', 'bash', 'sh']);

/**
 * Merge the login shell's PATH into `process.env.PATH`.
 *
 * Called once during startup, before the engine or the updater spawn
 * anything. A failure leaves the process with launchd's PATH plus the
 * well-known fallbacks — degraded but never worse than before the call.
 */
export async function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return; // GUI processes inherit the user env there
  let loginPath: string | null = null;
  const preferred = process.env['SHELL'] ?? '/bin/zsh';
  const shell = SH_LIKE.has(basename(preferred)) ? preferred : '/bin/zsh';
  try {
    const { stdout } = await execFileAsync(shell, ['-ilc', 'printf "%s" "$PATH"'], {
      timeout: 3_000,
      encoding: 'utf8',
    });
    loginPath = parseShellPathOutput(stdout);
  } catch (error) {
    log.warn(`Could not read the login shell's PATH from ${shell}.`, error);
  }
  process.env['PATH'] = mergePaths(loginPath, process.env['PATH'], WELL_KNOWN_BIN_DIRS);
  log.info(
    loginPath === null
      ? 'PATH extended with well-known directories only; the login shell did not answer.'
      : `PATH adopted from ${shell}.`,
  );
}
