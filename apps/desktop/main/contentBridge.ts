/**
 * Getting the user's own skills and commands into a session, and nothing else.
 * ============================================================================
 *
 * Content the user installed does not reach an Artemis session, and the reason
 * is different for each provider. Both are handled here because the *question*
 * is one question — "what has this profile got?" — and only the answer splits.
 *
 * ## Claude: discovery is gated, so the files being right is not enough
 *
 * `sharedConfig.ts` already puts the files in the right place: every Claude
 * profile's `skills` and `commands` entries point at the user's own directories.
 * The files were never the problem. *Discovery* is gated behind
 * `settingSources`, Artemis runs every query with `settingSources: []`, and so
 * the content sits on disk correctly arranged and permanently unread. Two skills
 * and a slash command sat there for six days that way — a session sees 46 slash
 * commands under `settingSources: []` and 49 under `['user']`, and the three
 * missing are exactly the user's own.
 *
 * Opening `settingSources` to `['user']` does fix it, and is the wrong fix. That
 * layer is `~/.claude/settings.json` entire: on this developer's machine that
 * means eight Supacode hooks that write terminal escape sequences to `/dev/tty`
 * on every tool call, and `bypassPermissionsModeEnabled: true` — a permission
 * bypass silently inherited by an app the user never granted it to. The whole
 * reason the empty default exists.
 *
 * Plugins are discovered on their own path, not through `settingSources`. That
 * is the seam {@link buildContentBridge} uses.
 *
 * ## Codex: discovery is not gated, so there is nothing to defeat
 *
 * Codex reads `$CODEX_HOME/skills/` directly — no equivalent gate, and Artemis
 * already points `CODEX_HOME` at the profile. A skill dropped in that directory
 * works today with no help from this module. What is missing is only that
 * nothing *puts* the user's skills there: the sharing arrangement is Claude-only
 * by construction (`sharedConfigDirs` filters on `providerId`, because the entry
 * names are Claude's vocabulary). So the Codex job is not a channel, it is
 * links: {@link linkSkillsIntoCodexHome}.
 *
 * Codex also reads `~/.agents/skills/` regardless of `CODEX_HOME` — a
 * vendor-neutral location it honours natively. Nothing needs doing for that on
 * the Codex side, which is exactly why it has to be handled on the Claude side:
 * a skill installed there is visible to one provider and not the other, and the
 * asymmetry would look like a bug in Artemis.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLAUDE BRIDGE IS A DIRECTORY OF OUR OWN
 * ---------------------------------------------------------------------------
 *
 * A plugin directory is read for four things: `skills/`, `commands/`,
 * `agents/`, and hooks. Two of those are wanted and two are emphatically not, so
 * pointing a plugin at the profile's config directory — one line, no filesystem
 * writes — would have taken the user's `agents/` and hooks along with them,
 * arriving at the same place `settingSources: ['user']` does by a quieter route.
 *
 * So the bridge is a directory Artemis assembles and owns, containing only the
 * two surfaces asked for:
 *
 *     <dataDir>/content-bridges/<key>/.claude-plugin/plugin.json
 *     <dataDir>/content-bridges/<key>/skills/<name> -> <source>/<name>
 *     <dataDir>/content-bridges/<key>/commands      -> <configDir>/commands
 *
 * There is no `agents/` and no hooks, so there is nothing for the plugin loader
 * to find beyond skills and commands, and the guarantee is structural rather
 * than a filter that has to be kept correct as the loader grows. That is the
 * property {@link LocalPlugin} documents and this module is responsible for.
 *
 * ## Why skills are linked one by one and commands are not
 *
 * The two are shaped differently because their sources are. Skills come from two
 * places — `~/.claude/skills` and the vendor-neutral `~/.agents/skills` — and
 * `use-railway` is in both on this machine, so linking each directory wholesale
 * would offer the model one skill twice under two names. Hence one link per
 * skill, with {@link SKILL_SOURCE_PRECEDENCE} to break the tie.
 *
 * Commands have exactly one source, so there is nothing to merge and the whole
 * directory is linked in one hop. That is strictly better where it applies: it
 * needs no reconciliation, it tracks a newly-added command for free, and it
 * preserves the nested subdirectories Claude reads as command namespaces, which
 * a flat link-per-entry pass would quietly flatten.
 *
 * Reconciliation runs per run rather than being cached, so content installed
 * while the app is open works on the next message rather than the next launch.
 *
 * ## What the user types
 *
 * A plugin's commands are addressed `/<plugin>:<command>`, and the bare name is
 * refused — `/cerebro` comes back as `Unknown command`. So bridging a command
 * renames it, and the composer's autocomplete is what makes that survivable: it
 * inserts the canonical name, so the prefix is something the user reads rather
 * than something they have to know. Skills are chosen by the model and need no
 * such help.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COSTS, AND WHAT IT NEVER DOES
 * ---------------------------------------------------------------------------
 *
 * A `readdir` per source plus a `stat` per candidate to find the skills, then a
 * `readlink` per bridged skill to confirm the link is already right. Writes
 * happen only when something actually changed.
 *
 * Nothing here throws. A bridge that cannot be built returns no plugins and the
 * run proceeds without the user's content — which is what every Artemis run did
 * before this module existed. Failing a run because a symlink could not be
 * written would trade a missing skill for a session the user cannot start.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import type { LocalPlugin } from '@rx-artemis/core';

import { createLogger } from './log.js';

const log = createLogger('content-bridge');

/**
 * The plugin name, and therefore the prefix every bridged skill and command
 * wears.
 *
 * Plugin content is addressed as `<plugin>:<name>`, so `use-railway` reaches the
 * model as `artemis-skills:use-railway` and `cerebro` is typed as
 * `/artemis-skills:cerebro`. Unavoidable on this channel and left deliberately
 * explicit rather than disguised as short as possible: the prefix is the answer
 * to "where did this come from", and it cannot collide with a marketplace plugin
 * the user installs later.
 *
 * Kept as `artemis-skills` now that commands ride along too, because the name is
 * baked into a string the user types. Renaming it to something more accurate
 * would break every muscle memory and saved note built on the old one, which is
 * a worse outcome than a name that undersells its contents.
 *
 * Codex needs no equivalent — its links land in a directory it already reads, so
 * those skills keep their bare names.
 */
const PLUGIN_NAME = 'artemis-skills';

/** Where all Claude bridges live, under Artemis's own data directory. */
const BRIDGES_DIR = 'content-bridges';

/**
 * The vendor-neutral skills directory, relative to `$HOME`.
 *
 * Codex reads this on its own; Claude does not. Included in the Claude bridge's
 * sources so that one install location serves both providers, which is the
 * whole point of a neutral location and is not something either CLI arranges.
 */
const NEUTRAL_SKILLS = ['.agents', 'skills'] as const;

/** Codex's own home, relative to `$HOME` — the source for a Codex profile. */
const CODEX_SKILLS = ['.codex', 'skills'] as const;

/**
 * Codex writes and refreshes its bundled skills here, inside the same directory
 * this module links into. Never a source, never removed, never counted.
 */
const CODEX_SYSTEM_DIR = '.system';

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One skill, and where it really lives.
 *
 * `dir` is the skill's own directory — the thing a link points at — rather than
 * the source root, because after precedence has been applied the root it came
 * from is no longer interesting to anything downstream.
 */
interface DiscoveredSkill {
  readonly name: string;
  readonly dir: string;
}

/**
 * Which source wins when the same skill name appears in more than one.
 *
 * Vendor-specific before neutral, on the theory that a user who has the same
 * skill in both places most recently installed it with the vendor's own tool.
 * The choice matters less than its being fixed: an unstable winner would mean a
 * skill whose contents change depending on `readdir` order.
 */
export const SKILL_SOURCE_PRECEDENCE = 'vendor-then-neutral';

/**
 * Every skill in a source directory.
 *
 * A directory counts as a skill when it holds a `SKILL.md`, which is the same
 * test both CLIs apply. `stat` follows symlinks, because a skill directory may
 * itself be one — and because the marker is the file: a stray `.DS_Store` beside
 * two real skills must not count, and neither must a folder the user left behind
 * without a `SKILL.md` in it.
 *
 * Dot-directories are skipped wholesale. That is what keeps Codex's `.system`
 * out of the list, and it matches both CLIs' own treatment of hidden entries.
 */
async function readSource(sourceDir: string): Promise<readonly DiscoveredSkill[]> {
  const entries = await readdir(sourceDir).catch(() => null);
  if (entries === null) return [];

  const found: DiscoveredSkill[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(sourceDir, name);
    const isSkill = await stat(join(dir, 'SKILL.md'))
      .then((info) => info.isFile())
      .catch(() => false);
    if (isSkill) found.push({ name, dir });
  }
  return found;
}

/**
 * Merge sources into one skill per name, earlier sources winning.
 *
 * The de-duplication that makes a single bridge the right shape — see the header.
 */
async function discoverSkills(
  sourceDirs: readonly string[],
): Promise<readonly DiscoveredSkill[]> {
  const byName = new Map<string, DiscoveredSkill>();
  for (const sourceDir of sourceDirs) {
    for (const skill of await readSource(sourceDir)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

/* -------------------------------------------------------------------------- */
/* Claude: a plugin directory Artemis owns                                    */
/* -------------------------------------------------------------------------- */

/**
 * One bridge per config directory, keyed by its path.
 *
 * Keyed by the *directory* rather than by profile id because two profiles are
 * allowed to name the same config directory — `sharedConfigDirs` de-duplicates
 * on the same fact — and because a bridge is a statement about a directory's
 * skills, not about an account.
 *
 * The readable half is a courtesy for anyone who opens the folder; the hash is
 * what makes it unique. A basename alone would collide the moment two profiles
 * in different parents were both called `work`.
 */
function bridgeKey(configDir: string): string {
  const digest = createHash('sha256').update(configDir).digest('hex').slice(0, 12);
  const readable = basename(configDir)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 32);
  return readable.length > 0 ? `${readable}-${digest}` : digest;
}

/**
 * Make `dir` contain exactly one symlink per skill, and nothing else.
 *
 * Used for the Claude bridge's `skills/`, which Artemis created and owns
 * outright — so anything unrecognised in it is ours to remove, and removing it
 * is how a skill the user uninstalled stops being offered.
 */
async function reconcileOwnedDir(dir: string, skills: readonly DiscoveredSkill[]): Promise<void> {
  await mkdir(dir, { recursive: true });

  const wanted = new Map(skills.map((skill) => [skill.name, skill.dir]));
  for (const name of await readdir(dir).catch(() => [])) {
    const target = wanted.get(name);
    // Compare the link's *text*, the comparison `sharedConfig.ts` makes and for
    // the same reason: a link that reaches the right directory by a different
    // spelling is not the link this module writes, and treating it as equivalent
    // would mean never correcting it.
    const current = await readlink(join(dir, name)).catch(() => null);
    if (target !== undefined && current === target) {
      wanted.delete(name);
      continue;
    }
    await rm(join(dir, name), { force: true, recursive: true });
  }

  for (const [name, target] of wanted) await symlink(target, join(dir, name), 'dir');
}

/**
 * Does this directory hold at least one slash command?
 *
 * Two levels deep, because Claude reads a subdirectory of `commands/` as a
 * namespace (`commands/review/pr.md` is `/review:pr`), so a user whose commands
 * are all filed in folders has none at the top level. Not recursive beyond that:
 * the question is only whether the directory is worth linking, and one more level
 * of `readdir` to answer it more precisely would cost more than it settles.
 */
async function hasCommands(commandsDir: string): Promise<boolean> {
  const entries = await readdir(commandsDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return false;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.endsWith('.md')) return true;
    // `isDirectory` is false for a symlinked namespace, so the cheap check is
    // tried first and this only runs for entries that might be directories.
    const nested = await readdir(join(commandsDir, entry.name)).catch(() => []);
    if (nested.some((name) => name.endsWith('.md'))) return true;
  }
  return false;
}

/**
 * Point `link` at `target`, or make sure nothing is there when `target` is null.
 *
 * The second half is what stops a bridge going stale: a `commands` link left
 * behind after the user deleted their commands directory is a broken read, and
 * every tool that touches it says so.
 */
async function relink(link: string, target: string | null): Promise<void> {
  const current = await readlink(link).catch(() => null);
  if (current === target) return;
  await rm(link, { force: true, recursive: true });
  if (target !== null) await symlink(target, link, 'dir');
}

export interface ContentBridgeOptions {
  /** The profile's Claude config directory — the one holding `skills` and `commands`. */
  readonly configDir: string;
  /** Artemis's own data directory; the bridge is assembled beneath it. */
  readonly dataDir: string;
  /** Stand-in for `$HOME`. Overridden only by tests. */
  readonly home?: string;
}

/**
 * Bridge a Claude profile's skills and commands into a loadable plugin.
 *
 * Returns the plugin to pass to the run, or an empty list when there is nothing
 * to bridge — no skills or commands anywhere, or a filesystem that would not
 * cooperate. An empty list is the pre-existing behaviour and never an error.
 */
export async function buildContentBridge(
  options: ContentBridgeOptions,
): Promise<readonly LocalPlugin[]> {
  const home = options.home ?? homedir();
  const skillSources = [join(options.configDir, 'skills'), join(home, ...NEUTRAL_SKILLS)];
  const commandsDir = join(options.configDir, 'commands');

  try {
    const [skills, commands] = await Promise.all([
      discoverSkills(skillSources),
      hasCommands(commandsDir),
    ]);
    if (skills.length === 0 && !commands) return [];

    const bridgeDir = join(options.dataDir, BRIDGES_DIR, bridgeKey(options.configDir));
    await mkdir(join(bridgeDir, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(bridgeDir, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_NAME,
          version: '1.0.0',
          description: 'Skills and commands installed on this machine, bridged into Artemis',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    // Both surfaces are reconciled every time, including down to nothing. A
    // profile that had skills last week and has none today must stop offering
    // them, and the empty directory it leaves behind is inert.
    await reconcileOwnedDir(join(bridgeDir, 'skills'), skills);
    await relink(join(bridgeDir, 'commands'), commands ? commandsDir : null);

    return [{ path: bridgeDir }];
  } catch (error) {
    log.warn(
      `Could not bridge content for ${options.configDir}; the run continues without it`,
      error,
    );
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Codex: links into a directory Codex also owns                              */
/* -------------------------------------------------------------------------- */

export interface CodexSkillLinkOptions {
  /** The profile's `CODEX_HOME`. Its `skills/` is the directory Codex reads. */
  readonly configDir: string;
  /** Stand-in for `$HOME`. Overridden only by tests. */
  readonly home?: string;
}

/**
 * Link the user's Codex skills into a profile's `CODEX_HOME`.
 *
 * The destination is *shared*, not owned: Codex creates `skills/`, writes its
 * bundled skills into `skills/.system/`, and refreshes them on version change.
 * So this is a merge and not a reconciliation — the rules are narrower than
 * {@link reconcileOwnedDir}'s by necessity:
 *
 *  - A real directory is never touched. That covers `.system` and covers a skill
 *    the user installed into the profile directly, which is a supported thing to
 *    do and must not be deleted by an app that only meant to add to it.
 *  - Only a symlink whose target is missing, or which points into the source and
 *    is no longer wanted, is removed. A link pointing anywhere else belongs to
 *    someone else's arrangement and is left exactly where it is.
 *
 * `~/.agents/skills` is not a source here — Codex reads it natively — and it is
 * also a *veto*. A skill installed in both `~/.codex/skills` and
 * `~/.agents/skills` would otherwise be offered twice, once by our link and once
 * by Codex's own reading, which is not hypothetical: `use-railway` is in both on
 * this machine and Codex duly listed it twice the first time this ran. Since the
 * native reading cannot be suppressed without editing a directory that is not
 * ours, the neutral copy wins on Codex — the opposite of
 * {@link SKILL_SOURCE_PRECEDENCE}, and the only orderable choice available.
 *
 * Returns quietly on any failure, for the reason given in the header.
 */
export async function linkSkillsIntoCodexHome(options: CodexSkillLinkOptions): Promise<void> {
  const home = options.home ?? homedir();
  const sourceDir = join(home, ...CODEX_SKILLS);
  const destDir = join(options.configDir, 'skills');

  // A profile may legitimately point `CODEX_HOME` at the user's own `~/.codex`,
  // in which case the source *is* the destination and every skill is already
  // where it needs to be. Linking a directory into itself would be a no-op at
  // best and a self-referential link at worst.
  if (resolve(sourceDir) === resolve(destDir)) return;

  try {
    const native = new Set(
      (await readSource(join(home, ...NEUTRAL_SKILLS))).map((skill) => skill.name),
    );
    const skills = (await discoverSkills([sourceDir])).filter((skill) => !native.has(skill.name));

    // Nothing to link and no directory to tidy: leave the filesystem untouched,
    // so a profile whose Codex has never started stays exactly as it was. When
    // the directory *does* exist the loop below still has to run, because a skill
    // that has just become redundant leaves a link that must come back out.
    const destExists = await stat(destDir)
      .then((info) => info.isDirectory())
      .catch(() => false);
    if (skills.length === 0 && !destExists) return;
    if (skills.length > 0) await mkdir(destDir, { recursive: true });

    const wanted = new Map(skills.map((skill) => [skill.name, skill.dir]));

    for (const name of await readdir(destDir).catch(() => [])) {
      if (name === CODEX_SYSTEM_DIR) continue;
      const at = join(destDir, name);

      const info = await lstat(at).catch(() => null);
      if (info === null) continue;
      if (!info.isSymbolicLink()) {
        // Codex's own, or the user's own. Either way it wins the name, so drop
        // our claim to it rather than overwriting theirs.
        wanted.delete(name);
        continue;
      }

      const target = await readlink(at).catch(() => null);
      if (target !== null && target === wanted.get(name)) {
        wanted.delete(name);
        continue;
      }

      // Ours to clean up only if it came from the source we manage, or if it
      // points at nothing at all. Anything else is someone else's link.
      const dangling = !(await stat(at)
        .then(() => true)
        .catch(() => false));
      const fromSource = target !== null && resolve(target).startsWith(`${resolve(sourceDir)}/`);
      if (dangling || fromSource) await rm(at, { force: true, recursive: true });
      else wanted.delete(name);
    }

    for (const [name, target] of wanted) await symlink(target, join(destDir, name), 'dir');
  } catch (error) {
    log.warn(`Could not link Codex skills into ${destDir}; the run continues without them`, error);
  }
}
