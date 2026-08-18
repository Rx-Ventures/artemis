/**
 * Confining a command, on whichever operating system this is.
 * ============================================================================
 *
 * There is no portable sandbox primitive, and pretending otherwise is the
 * mistake this file exists to correct. An earlier version made macOS's Seatbelt
 * *the* abstraction, which left Linux and Windows as a rewrite rather than a
 * file. The mechanisms are genuinely unrelated:
 *
 * | Platform | Mechanism                          | Status here            |
 * | -------- | ---------------------------------- | ---------------------- |
 * | macOS    | `sandbox-exec`, a Seatbelt profile | **verified** live      |
 * | Linux    | `bwrap` (bubblewrap) namespaces    | **unverified** — docs  |
 * | Windows  | requires native code               | **cannot confine**     |
 *
 * So "OS agnostic" means one *interface* with a backend per platform, not one
 * mechanism. What every caller gets is the same three answers — what this
 * machine can enforce, how to wrap a command, and what to say when it cannot.
 *
 * ## Windows is a refusal, not a gap
 *
 * Nothing shipped with Windows confines a child process the way Seatbelt and
 * bubblewrap do; job objects and restricted tokens need native code, which is a
 * different project. So the Windows backend reports that it cannot confine, and
 * the policy above refuses to run commands rather than running them unconfined.
 * That is the correct failure: the alternative is a silent downgrade from
 * sandboxed to not, on the platform least able to notice.
 *
 * ## What "unverified" means here, and why it is heavier than elsewhere
 *
 * The Ollama catalogue being written from documentation risks a wrong model
 * list. A sandbox written from documentation risks *failing open* — appearing
 * to confine while confining nothing. So the Linux backend is marked unverified
 * in three places, and {@link describeConfinement} says so to the user rather
 * than only to a reader of this file. Drive it on Linux and update the table.
 */

import { realpath } from 'node:fs/promises';

/** What a backend can promise on this machine. */
export type Confinement =
  /** Writes limited to the workspace, network denied. */
  | 'workspace'
  /** Nothing can be enforced here. */
  | 'none';

/** How sure we are that a backend does what it says. */
export type BackendVerification = 'verified' | 'unverified';

/** One platform's way of confining a command. */
export interface SandboxBackend {
  readonly platform: NodeJS.Platform;
  readonly name: string;
  readonly verification: BackendVerification;
  /**
   * Can this machine actually enforce it? Separate from the platform, because
   * a Linux box without `bwrap` installed is a Linux box that cannot confine.
   */
  probe: (has: (binary: string) => Promise<boolean>) => Promise<Confinement>;
  /**
   * The argv that runs `command` with exactly `writableRoots` writable — all
   * already resolved. Only called when {@link probe} answered `workspace`.
   */
  wrap: (command: string, writableRoots: readonly string[]) => readonly string[];
}

/* -------------------------------------------------------------------------- */
/* macOS — verified                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A Seatbelt profile as one `-D`-free literal, passed inline.
 *
 * Inline rather than a temp file so there is no file to leak, no cleanup to get
 * wrong, and nothing on disk for another process to swap between writing and
 * exec — the same check/use hazard the path confinement closes by resolving
 * once.
 *
 * The subpath **must** be a resolved path. Verified 2026-08-18: Seatbelt matches
 * the real path, so a profile naming `/tmp/x` denies writes the shell believes
 * are going to `/tmp/x`, because the kernel sees `/private/tmp/x`. It fails
 * closed and looks like nothing is wrong.
 */
export function seatbeltProfile(writableRoots: readonly string[]): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    // Reading is broad: an agent that cannot read a lockfile or a standard
    // library is useless, and reading is not what does damage.
    '(allow file-read*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // Deliberately absent: any network grant.
    // Exactly the roots handed in, and nothing else.
    //
    // An earlier version also allowed `/private/tmp` and `/private/var/folders`
    // wholesale, so a toolchain could write scratch files. `sandbox:check`
    // caught what that actually granted: macOS puts every per-user temporary
    // directory under `/var/folders`, so the blanket rule made another
    // application's scratch space writable and let a command escape the
    // workspace entirely. A run gets its own scratch directory in that list
    // instead, with TMPDIR pointed at it.
    ...writableRoots.map(
      (root) => `(allow file-write* (subpath "${root.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"))`,
    ),
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
  ].join(' ');
}

export const SEATBELT: SandboxBackend = {
  platform: 'darwin',
  name: 'Seatbelt (sandbox-exec)',
  // Driven directly: writes outside refused, network refused, writes inside
  // allowed once the root was resolved through symlinks.
  verification: 'verified',
  probe: async (has) => ((await has('/usr/bin/sandbox-exec')) ? 'workspace' : 'none'),
  wrap: (command, roots) => ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(roots), '/bin/sh', '-c', command],
};

/* -------------------------------------------------------------------------- */
/* Linux — UNVERIFIED                                                         */
/* -------------------------------------------------------------------------- */

/**
 * bubblewrap, from documentation. **Not driven against a Linux machine.**
 *
 * Chosen over Landlock because Landlock is a syscall and would need a native
 * module, while `bwrap` is a binary that is either installed or not — which the
 * probe can answer honestly. The shape mirrors the Seatbelt policy: the whole
 * filesystem readable, the workspace writable, the network gone.
 *
 * `--unshare-net` is the load-bearing flag. `--die-with-parent` matters nearly
 * as much: without it a command that outlives the run keeps running after the
 * user has stopped watching.
 */
export const BUBBLEWRAP: SandboxBackend = {
  platform: 'linux',
  name: 'bubblewrap (bwrap)',
  verification: 'unverified',
  probe: async (has) => ((await has('bwrap')) ? 'workspace' : 'none'),
  wrap: (command, roots) => [
    'bwrap',
    // Everything readable, nothing writable…
    '--ro-bind', '/', '/',
    // …except the roots handed in — the workspace and the run's own scratch.
    ...roots.flatMap((root) => ['--bind', root, root]),
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    // The flag that turns "it edited a file wrong" into the only failure mode.
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    // A command that outlives the run is a command nobody can stop.
    '--die-with-parent',
    '--chdir', roots[0] ?? '/',
    '/bin/sh', '-c', command,
  ],
};

/* -------------------------------------------------------------------------- */
/* Windows — cannot confine                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Windows, honestly.
 *
 * Job objects, AppContainers and restricted tokens are the real answers and all
 * of them need native code, which is a different project from this one. There
 * is no shipped binary that wraps a command the way `sandbox-exec` and `bwrap`
 * do, so this reports that it cannot confine and the policy refuses to run
 * commands at all.
 *
 * Written as a backend rather than an absence so the shape is right when
 * somebody does add the native piece: only {@link probe} and {@link wrap}
 * change, and nothing above this file moves.
 */
export const WINDOWS_UNCONFINED: SandboxBackend = {
  platform: 'win32',
  name: 'none available',
  verification: 'verified',
  probe: async () => 'none',
  wrap: (command) => ['cmd.exe', '/c', command],
};

export const BACKENDS: readonly SandboxBackend[] = [SEATBELT, BUBBLEWRAP, WINDOWS_UNCONFINED];

/** The backend for a platform, or `undefined` where none is written. */
export function backendFor(platform: NodeJS.Platform): SandboxBackend | undefined {
  return BACKENDS.find((backend) => backend.platform === platform);
}

/** What a run can actually promise, resolved once and reused. */
export interface ResolvedSandbox {
  readonly backend: SandboxBackend | undefined;
  readonly confinement: Confinement;
}

/**
 * Work out what this machine can enforce.
 *
 * `has` is injected so the whole resolution is testable without the binaries
 * being present — which is the only way the Linux path can be exercised at all
 * from a machine that is not Linux.
 */
export async function resolveSandbox(
  platform: NodeJS.Platform,
  has: (binary: string) => Promise<boolean>,
): Promise<ResolvedSandbox> {
  const backend = backendFor(platform);
  if (backend === undefined) return { backend: undefined, confinement: 'none' };
  return { backend, confinement: await backend.probe(has) };
}

/**
 * The argv for a confined command, or `null` when nothing can confine it.
 *
 * `null` is the whole safety property: the caller must refuse rather than run,
 * and returning a bare command here would make an unsandboxed execution
 * indistinguishable from a sandboxed one at the call site.
 */
export async function wrapCommand(
  resolved: ResolvedSandbox,
  command: string,
  workspaceRoot: string,
  scratchDir?: string,
): Promise<readonly string[] | null> {
  if (resolved.backend === undefined || resolved.confinement === 'none') return null;
  // Resolved here rather than trusted from the caller: getting it wrong denies
  // every write and reads as a broken sandbox rather than a misconfigured one.
  const roots = [await realpath(workspaceRoot)];
  // A run's own scratch directory, so a toolchain has somewhere to write
  // without the whole system temp area being opened up. See `seatbeltProfile`
  // for what allowing that wholesale turned out to grant.
  if (scratchDir !== undefined) roots.push(await realpath(scratchDir));
  return resolved.backend.wrap(command, roots);
}

/** One sentence for the user about what is protecting them, if anything. */
export function describeConfinement(resolved: ResolvedSandbox): string {
  if (resolved.backend === undefined) {
    return 'No sandbox exists for this platform, so commands will not be run.';
  }
  if (resolved.confinement === 'none') {
    return resolved.backend.platform === 'win32'
      ? 'Windows has no sandbox Artemis can use without native code, so commands will not be run.'
      : `${resolved.backend.name} is not installed, so commands will not be run. Install it to enable the shell tool.`;
  }
  const caveat =
    resolved.backend.verification === 'unverified'
      ? ' This backend has not been verified on a real machine — treat its confinement as unproven.'
      : '';
  return `Commands run under ${resolved.backend.name}: writes limited to the working directory, network blocked.${caveat}`;
}
