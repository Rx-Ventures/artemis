/**
 * OS-level confinement for commands the model asks to run.
 * ============================================================================
 *
 * `sandbox.ts` decides which *paths* a tool may touch, and that is sufficient
 * for tools Artemis performs itself — it resolves the path and does the read,
 * so it can refuse. It does nothing for a shell command, because there Artemis
 * hands a string to `/bin/sh` and never sees the paths at all. A model that can
 * run `curl` has the network; one that can `cat ~/.ssh/id_rsa` has the keys.
 *
 * So a shell needs the operating system to say no. This file builds the policy
 * that makes it.
 *
 * ## Two axes, deliberately not one
 *
 * Copied from Codex, whose CLI separates `--sandbox` from `--ask-for-approval`,
 * because they answer different questions: what the OS *permits*, and when a
 * human is *asked*. Collapsing them into one setting makes "let it read freely
 * without prompting me" impossible to express — it is permissive on one axis and
 * strict on the other.
 *
 * Artemis's own `PermissionMode` is the approval axis. This is the other one.
 *
 * ## Verified, not assumed
 *
 * Driven on macOS 2026-08-18: writes outside the workspace were refused, the
 * network was refused, and writes inside succeeded — but **only after the
 * workspace path was resolved through symlinks**. Seatbelt matches on the real
 * path, so a profile naming `/tmp/x` denies writes to what the shell knows as
 * `/tmp/x`, because the kernel sees `/private/tmp/x`. That is the same lesson
 * `sandbox.ts` learned about `realpath`, in a second place, and it fails
 * closed — everything is denied and nothing looks wrong until a user reports
 * that writes do not work.
 *
 * ## What this is not
 *
 * macOS only. `sandbox-exec` has been formally deprecated for years and still
 * ships and still works; there is no supported replacement short of a full
 * container. On any other platform {@link seatbeltAvailable} answers false, and
 * the caller must decide between refusing to run commands and running them
 * unconfined — a decision that belongs to policy, not here.
 */

import path from 'node:path';
import { realpath } from 'node:fs/promises';

/** What the operating system will permit. Codex's vocabulary, deliberately. */
export type SandboxMode =
  /** Read anything, write nothing, no network. */
  | 'read-only'
  /** Read anything, write only inside the workspace, no network. */
  | 'workspace-write'
  /** No confinement at all. */
  | 'danger-full-access';

export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/**
 * The default, and the reason it is this one.
 *
 * Artemis is a desktop application someone downloads, not a CLI they typed. A
 * command line runs with the user's own expectations attached; a GUI app
 * executing an unconfined shell has no such cover. So the default reads freely,
 * writes only where the work is, and cannot reach the network — the posture
 * that makes a bad edit recoverable and an exfiltration impossible.
 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write';

/** Only macOS has `sandbox-exec`. See the module header. */
export function seatbeltAvailable(platform: string = process.platform): boolean {
  return platform === 'darwin';
}

/** Escape a path for the Scheme-like string literals a profile is written in. */
function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a Seatbelt profile for one run.
 *
 * `writableRoots` **must already be resolved through symlinks** — the caller
 * does it because it has the run's root to hand and this stays pure. Passing an
 * unresolved path is the failure described in the module header: it denies
 * silently rather than erroring.
 *
 * Network is denied by every mode that confines anything. It is the difference
 * between a run that damaged a file and a run that posted a repository
 * somewhere, and no amount of file confinement substitutes for it.
 */
export function buildProfile(mode: SandboxMode, writableRoots: readonly string[]): string {
  if (mode === 'danger-full-access') {
    throw new Error('danger-full-access runs unconfined; it has no profile.');
  }

  const lines = [
    '(version 1)',
    '(deny default)',
    // A shell that cannot start a process is not a shell.
    '(allow process-exec process-fork)',
    // Reading is broad on purpose: a coding agent that cannot read the standard
    // library, a lockfile or a config it did not write is not useful, and
    // reading is not the operation that does damage. Writes and the network are
    // where the risk lives, and both are handled below.
    '(allow file-read*)',
    // Without these a great many binaries fail in ways that read as a hung tool
    // rather than a refused one.
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // Deliberately absent: `(allow network*)`. See the note above.
  ];

  if (mode === 'workspace-write') {
    for (const root of writableRoots) {
      lines.push(`(allow file-write* (subpath "${quote(root)}"))`);
    }
    // Nearly every toolchain writes here, and denying it turns "the sandbox is
    // working" into "the build is broken for no visible reason".
    lines.push('(allow file-write* (subpath "/private/tmp"))');
    lines.push('(allow file-write* (subpath "/private/var/folders"))');
    // A shell writing to its own tty is not an escape.
    lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))');
  }

  return lines.join('\n') + '\n';
}

/**
 * The argv that runs a command confined, or `null` for no confinement.
 *
 * `null` is returned for `danger-full-access` and for platforms without
 * Seatbelt, and the caller must treat those as the same thing: a command about
 * to run unconfined. Returning `null` rather than silently running the command
 * unconfined keeps that decision at the call site, where the user's approval
 * policy can see it.
 */
export async function confinedArgv(
  mode: SandboxMode,
  command: string,
  workspaceRoot: string,
  writeProfile: (contents: string) => Promise<string>,
): Promise<readonly string[] | null> {
  if (mode === 'danger-full-access' || !seatbeltAvailable()) return null;

  // Resolved here rather than trusted from the caller, because getting this
  // wrong denies every write and looks like a broken sandbox rather than a
  // misconfigured one.
  const realRoot = await realpath(workspaceRoot);
  const profilePath = await writeProfile(buildProfile(mode, [realRoot]));

  return ['/usr/bin/sandbox-exec', '-f', profilePath, '/bin/sh', '-c', command];
}

/** One line explaining a mode, for the UI that offers the choice. */
export function describeMode(mode: SandboxMode): string {
  switch (mode) {
    case 'read-only':
      return 'Commands may read anything on this machine, but cannot write files or reach the network.';
    case 'workspace-write':
      return 'Commands may read anything and write inside the working directory. The network is blocked.';
    case 'danger-full-access':
      return 'Commands run with no confinement at all — full access to your files and the network.';
  }
}

/** Where a run's temporary profile belongs, relative to a scratch directory. */
export function profileFileName(runId: string): string {
  // Named after the run so a leftover file says which one left it.
  return path.join('artemis-sandbox', `${runId}.sb`);
}
