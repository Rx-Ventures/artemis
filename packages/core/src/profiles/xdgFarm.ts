/**
 * Isolating a provider that answers to generic XDG variables.
 * ============================================================================
 *
 * Every other provider Artemis ships names its own directory variable —
 * `CLAUDE_CONFIG_DIR`, `CODEX_HOME` — so pointing one profile somewhere else
 * affects that provider and nothing on the machine besides.
 *
 * OpenCode has no such variable. Verified against `opencode debug paths` on
 * 1.18.18: its data, config, state and cache directories are resolved purely
 * from `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and
 * `XDG_CACHE_HOME`, and `OPENCODE_CONFIG_DIR` moves none of them — it only adds
 * a config *file* to read.
 *
 * So isolating an OpenCode profile means overriding a variable that belongs to
 * the whole desktop, on a process whose entire job is to spawn other programs.
 *
 * ## Why that is not merely untidy
 *
 * A run inherits its environment to every tool the agent executes. With
 * `XDG_DATA_HOME` pointed at a profile, this machine's `~/.local/share` shows
 * what that costs: `claude`, `uv` — so an agent running the Claude CLI would
 * find *Artemis's profile directory* where that CLI keeps its own state, which
 * is precisely the cross-provider interference the seam exists to prevent.
 * `~/.config` is worse: `gh`, `fish`, `uv` and a set of mode-600 credential
 * files. An agent running `gh` under a naive override finds no login and
 * reports itself signed out.
 *
 * None of that is destructive — the real directories are untouched and the
 * tools behave as though freshly installed — but "your CLI forgot its login
 * whenever an agent uses it" is not a cost worth paying for profile isolation.
 *
 * ## The farm
 *
 * So the variable is pointed at a directory that *stands in for* the real one:
 * the provider's own entry is a real directory inside the profile, and every
 * other entry is a symlink back to where it actually lives.
 *
 *     <profile>/xdg/data/
 *       opencode -> (real directory, this profile's own)
 *       claude   -> /Users/…/.local/share/claude
 *       uv       -> /Users/…/.local/share/uv
 *
 * A tool that resolves `$XDG_DATA_HOME/claude` follows the link and finds its
 * real state. OpenCode resolves `$XDG_DATA_HOME/opencode` and finds the
 * profile's. One variable, two different answers, which is the whole trick.
 *
 * ## What this deliberately does not do
 *
 * Nothing here writes to, moves, or deletes anything under the user's own
 * directories. Every path this module creates is inside the profile directory
 * Artemis owns; the only reference to the user's files is a symlink pointing at
 * them. That is the line the shared-config script draws for `~/.claude` and it
 * is drawn here for the same reason — an operation that rearranges a home
 * directory should be one a user ran deliberately, not one an app did on a
 * profile switch.
 *
 * The farm is rebuilt on every run because it is a *view* of a directory that
 * changes: install a new tool and its entry appears in the real root, and a
 * farm built once would hide it. Rebuilding is a listing plus a few `symlink`
 * calls, on a path that already spawns a process.
 */

import { lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * One XDG root a provider resolves from, and how to stand in for it.
 */
export interface XdgRootSpec {
  /** The variable to set, e.g. `XDG_DATA_HOME`. */
  readonly variable: string;
  /**
   * Where the root lives when the variable is unset, relative to home — e.g.
   * `.local/share`. Used only when the host environment does not already say.
   */
  readonly defaultSubpath: string;
  /**
   * The entry inside the root that belongs to *this* provider and must be the
   * profile's own — e.g. `opencode`. Everything else is linked back.
   */
  readonly ownedEntry: string;
  /** Where the stand-in is built, relative to the profile directory. */
  readonly farmSubpath: string;
}

/** Where a real XDG root lives for this host. */
function realRoot(spec: XdgRootSpec, hostEnv: Readonly<Record<string, string | undefined>>): string {
  const declared = hostEnv[spec.variable];
  if (declared !== undefined && declared.trim() !== '') return declared;
  const home = hostEnv['HOME'] ?? '';
  return path.join(home, spec.defaultSubpath);
}

/**
 * Build one stand-in root and return the path to point the variable at.
 *
 * Tolerant by design. A real root that does not exist yet is not an error — a
 * machine with no `~/.local/share` simply has nothing to link, and the profile
 * still gets its own entry. An individual entry that cannot be read is skipped
 * rather than failing the run: the cost of missing one link is a tool that
 * behaves as freshly installed, and the cost of throwing is a profile that
 * cannot start at all.
 */
async function buildRoot(
  spec: XdgRootSpec,
  profileDir: string,
  hostEnv: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const farm = path.join(profileDir, spec.farmSubpath);
  const source = realRoot(spec, hostEnv);

  await mkdir(path.join(farm, spec.ownedEntry), { recursive: true, mode: 0o700 });

  let entries: string[];
  try {
    entries = await readdir(source);
  } catch {
    return farm;
  }

  // Clear previously linked entries before relinking, so a tool uninstalled
  // since the last run stops appearing. Only symlinks are removed — the owned
  // entry is a real directory holding this profile's account, and nothing here
  // may delete it.
  let existing: string[] = [];
  try {
    existing = await readdir(farm);
  } catch {
    /* first build */
  }
  for (const name of existing) {
    if (name === spec.ownedEntry) continue;
    const at = path.join(farm, name);
    try {
      if ((await lstat(at)).isSymbolicLink()) await rm(at);
    } catch {
      /* raced or unreadable; the relink below either replaces it or skips it */
    }
  }

  for (const name of entries) {
    if (name === spec.ownedEntry) continue;
    try {
      await symlink(path.join(source, name), path.join(farm, name));
    } catch {
      /* already there, or unreadable — see the tolerance note above */
    }
  }

  return farm;
}

/**
 * Build every stand-in root a provider needs, as environment.
 *
 * Returns the variables to merge over a run's environment. An empty spec list
 * returns an empty object and touches no disk, which is the case for every
 * provider that names its own directory variable.
 */
export async function buildXdgFarm(
  specs: readonly XdgRootSpec[],
  profileDir: string,
  hostEnv: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const spec of specs) {
    env[spec.variable] = await buildRoot(spec, profileDir, hostEnv);
  }
  return env;
}

/**
 * Read a farm back, for tests and diagnostics: entry name → where it points.
 *
 * A real directory reports `null`, which is how the owned entry is told apart
 * from the linked ones.
 */
export async function describeFarm(farm: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const name of await readdir(farm)) {
    const at = path.join(farm, name);
    out[name] = (await lstat(at)).isSymbolicLink() ? await readlink(at) : null;
  }
  return out;
}
