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
 * The same hole exists on Linux and opens wider: a `.desktop` launch from
 * GNOME or KDE gets systemd's environment, not the shell's, so an `npm i -g`
 * `claude` in `~/.local/bin` or a `gh` from Flatpak is invisible to the app
 * and visible to the terminal the user then tries to reproduce it in.
 *
 * The fix is to ask the user's own login shell what PATH it would have and
 * merge that into `process.env.PATH` once, at startup, before anything
 * spawns. One subprocess, interactive + login flags so both profile and rc
 * files contribute (nvm and friends export from rc files), a hard timeout so
 * a pathological shell config cannot wedge startup, and a fallback list of
 * well-known directories for when the shell cannot be asked at all.
 *
 * Split like `appNames.ts`: the parsing, the shell choice and the merging are
 * pure and tested; the one impure function is the subprocess call.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, posix } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import { createLogger } from './log.js';

const execFileAsync = promisify(execFile);

const log = createLogger('shellPath');

/**
 * Where CLIs live when the shell cannot tell us. Merged in even when it can —
 * a directory that is already present is dropped by the dedupe.
 *
 * Per platform, because the list is a claim about where *this* operating
 * system's package managers put things and the macOS list is wrong about Linux
 * in both directions. `/opt/homebrew/bin` does not exist on Linux (Homebrew
 * installs to `/home/linuxbrew/.linuxbrew` there), and the directories that do
 * hold agent CLIs on a Linux desktop — Flatpak's two export roots, Nix's
 * profile, cargo, bun — have no macOS equivalent at all. Sending the macOS
 * list to a Fedora box costs nothing and buys nothing, which is the same as
 * having no fallback.
 *
 * Both flatpak roots are listed: `/var/lib/flatpak` is a system install and
 * `~/.local/share/flatpak` is a user one, and which of the two a given machine
 * uses is a choice its owner made, not something to infer.
 */
export function wellKnownBinDirs(platform: NodeJS.Platform, home: string): readonly string[] {
  // `posix.join`, not `join`: these are POSIX paths by definition — the caller
  // returns early on win32 — and `join` would spell them with backslashes when
  // the *host* is Windows, which is a thing that happens when this suite runs
  // on a Windows runner.
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.local', 'bin')];
  }
  return [
    posix.join(home, '.local', 'bin'),
    '/usr/local/bin',
    posix.join(home, '.cargo', 'bin'),
    posix.join(home, '.bun', 'bin'),
    posix.join(home, '.nix-profile', 'bin'),
    '/var/lib/flatpak/exports/bin',
    posix.join(home, '.local', 'share', 'flatpak', 'exports', 'bin'),
    '/snap/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ];
}

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

/**
 * How to make each shell we understand print one PATH, and nothing else.
 *
 * An allowlist keyed by basename, because `$SHELL` is a string the user's
 * account record supplies and this spawns it: a shell not on this list is one
 * whose `-c` contract nobody here has checked, and guessing is how you end up
 * parsing a login banner as a PATH.
 *
 * `fish` needs its own command, and that is the reason it was excluded before
 * rather than an oversight. A fish `$PATH` is a *list*, so `printf "%s" "$PATH"`
 * yields the entries joined with spaces — which parses as one enormous
 * directory and would poison the merge with a PATH the machine does not have.
 * `string join :` is fish's own way of spelling the colon-separated form. Fish
 * is worth the special case rather than being left to the fallback: it is the
 * default interactive shell on CachyOS and a common choice on Arch, and a fish
 * user's PATH lives in `config.fish` where no sh-like fallback can read it.
 *
 * The flags are passed separately rather than bundled as `-ilc`. Identical for
 * the sh-like shells, and unambiguous for fish, whose parser is its own.
 */
const PATH_PROBES: Readonly<Record<string, readonly string[]>> = {
  zsh: ['-i', '-l', '-c', 'printf "%s" "$PATH"'],
  bash: ['-i', '-l', '-c', 'printf "%s" "$PATH"'],
  sh: ['-i', '-l', '-c', 'printf "%s" "$PATH"'],
  dash: ['-i', '-l', '-c', 'printf "%s" "$PATH"'],
  ksh: ['-i', '-l', '-c', 'printf "%s" "$PATH"'],
  fish: ['-i', '-l', '-c', 'string join : $PATH'],
};

/**
 * The shells to try when `$SHELL` names one we do not understand, or names one
 * that is not installed.
 *
 * Ordered by "most likely to exist and be configured", and existence-checked
 * rather than assumed — which is the whole point of this list having a
 * platform in it.
 *
 * The previous version fell back to `/bin/zsh` on every platform. That is
 * correct on macOS, where zsh has shipped in the base system since Catalina,
 * and wrong on essentially every Linux box: zsh is an optional package
 * everywhere, so a Fedora or Ubuntu user whose `$SHELL` is fish, nushell or
 * elvish had the probe spawn a path that does not exist, take the `catch`, and
 * adopt no PATH at all. The app then reported the user's own `claude` as not
 * installed — from a `.desktop` launch only, which is the hardest kind of bug
 * to be told about.
 *
 * `/bin/sh` anchors every chain because POSIX requires it and because it is the
 * one FHS path NixOS keeps, so even a machine with no `/bin/bash` has an
 * answer here.
 */
function fallbackShells(platform: NodeJS.Platform): readonly string[] {
  return platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh'];
}

/** A shell to ask, and the argv that makes it answer. */
export interface PathProbe {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Which shell to ask for a PATH, and how.
 *
 * `exists` is injected so the whole choice is testable from any platform —
 * the same trick `commandSandbox.ts` uses to exercise a Linux backend from a
 * Mac. Returns null when nothing on this machine can be asked, which is a real
 * outcome (a container with no shell at all) and not an error: the caller
 * still has the well-known directories.
 */
export function loginShellProbe(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): PathProbe | null {
  const preferred = env['SHELL'];
  const candidates =
    preferred !== undefined && preferred !== '' && PATH_PROBES[basename(preferred)] !== undefined
      ? [preferred, ...fallbackShells(platform)]
      : fallbackShells(platform);

  for (const file of candidates) {
    const args = PATH_PROBES[basename(file)];
    // A candidate whose basename is not in the table cannot happen for the
    // fallbacks and is filtered for `$SHELL` above; the check is what makes
    // that true to the type checker rather than only to the reader.
    if (args !== undefined && exists(file)) return { file, args };
  }
  return null;
}

/**
 * Merge the login shell's PATH into `process.env.PATH`.
 *
 * Called once during startup, before the engine or the updater spawn
 * anything. A failure leaves the process with the launcher's PATH plus the
 * well-known fallbacks — degraded but never worse than before the call.
 */
export async function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return; // GUI processes inherit the user env there

  const fallbacks = wellKnownBinDirs(process.platform, homedir());
  const probe = loginShellProbe(process.platform, process.env, existsSync);
  if (probe === null) {
    process.env['PATH'] = mergePaths(null, process.env['PATH'], fallbacks);
    log.warn(
      'No shell on this machine could be asked for a PATH; extended with well-known ' +
        'directories only. Anything Artemis spawns by name may report as not installed.',
    );
    return;
  }

  let loginPath: string | null = null;
  try {
    const { stdout } = await execFileAsync(probe.file, [...probe.args], {
      timeout: 3_000,
      encoding: 'utf8',
    });
    loginPath = parseShellPathOutput(stdout);
  } catch (error) {
    log.warn(`Could not read the login shell's PATH from ${probe.file}.`, error);
  }
  process.env['PATH'] = mergePaths(loginPath, process.env['PATH'], fallbacks);
  log.info(
    loginPath === null
      ? 'PATH extended with well-known directories only; the login shell did not answer.'
      : `PATH adopted from ${probe.file}.`,
  );
}
