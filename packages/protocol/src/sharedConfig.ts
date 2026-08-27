/**
 * The shared `~/.claude` arrangement: what is shared, and how to describe what
 * is actually on disk.
 * ============================================================================
 *
 * Artemis gives each profile its own `CLAUDE_CONFIG_DIR`, and that one variable
 * buys isolated auth *and* isolated everything-else. The isolation is the point
 * for the credential and an irritation for the rest: a skill written once has to
 * be written again per account, and history splits four ways for no reason the
 * user asked for. The arrangement that undoes the second half without touching
 * the first is a set of symlinks from each profile's directory to the matching
 * entry under the user's own `~/.claude`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIST IS IN THE PROTOCOL AND NOT NEXT TO THE SCRIPT
 * ---------------------------------------------------------------------------
 *
 * Two halves of the app read these names, for opposite reasons.
 *
 * The renderer *writes* them, into a shell script the user runs by hand
 * (`renderer/src/lib/sharedClaudeConfig.ts`). The main process *reads* them,
 * `lstat`ing each name to find out what the script actually did
 * (`main/sharedConfig.ts`).
 *
 * A second copy of the list would make the two disagree eventually, and the
 * disagreement would be invisible: a name added to the script's list but not to
 * the prober's is a directory that gets linked and then never appears in the
 * pane, which is precisely the silent failure the status display exists to end.
 * So the names live here, in the package both sides already import, with the
 * types that describe the reading.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT SHARED, AND WHY THAT LIST IS SHORT
 * ---------------------------------------------------------------------------
 *
 * `.claude.json`, `settings.json`, `sessions/` and the stored credential stay
 * per profile. They are what make two accounts two accounts — linking them is
 * how every profile ends up signed into whichever one logged in last, which is
 * precisely the failure `resolveEnv` exists to prevent. Sharing the *whole*
 * directory is the obvious thing to try and the one thing that cannot work.
 *
 * Everything in {@link SHARED_DIRECTORIES} and {@link SHARED_FILES} is content
 * the user authored or accumulated, not identity the provider issued.
 */

import type { ProfileMetadata } from './profile.js';

/* -------------------------------------------------------------------------- */
/* What is shared                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Directories linked from the root config into every profile.
 *
 * Created under the root when absent. A fresh `~/.claude` has no `commands` or
 * `todos`, and a symlink pointing at a path that does not exist is not an empty
 * folder — it is a broken read, reported as one by every tool that touches it.
 *
 * ## `projects` is in this list, and it merges the sidebar
 *
 * Recorded because it is the one entry whose consequence is not guessable from
 * its name.
 *
 * `projects/<encoded-cwd>/` holds the transcripts. Sharing it merges the store
 * itself, so a conversation started on any sharing account is listed — and
 * resumable — from all of them.
 *
 * This used to cost a row per profile. `listAllSessions` walked every profile,
 * pointed `CLAUDE_CONFIG_DIR` at each in turn, and nothing downstream
 * de-duplicated, so three profiles aimed at one store rendered every session
 * three times under three account labels. That is fixed: scopes are grouped by
 * the realpath of the store they actually read, each store is read once, and
 * the other profiles that reach it ride along in
 * `SessionSummary.alsoInProfiles`. The account label on a shared row is
 * therefore arbitrary among the sharers — which is why resuming prefers the
 * account already in use over the one the row happens to name.
 *
 * Directory contents make the same point about what is actually being shared:
 * everything under `projects/` is session-scoped — the `.jsonl` transcript, and
 * a `<session-uuid>/` sidecar holding `subagents/`, `subagents/workflows/` and
 * `tool-results/` — except `memory/`, which is per-project knowledge and the
 * one thing in there that is not about an account at all.
 */
export const SHARED_DIRECTORIES: readonly string[] = [
  'commands',
  'ide',
  'plans',
  'plugins',
  'skills',
  'todos',
  'session-env',
  'projects',
];

/**
 * Files linked from the root config into every profile.
 *
 * Never created when absent, which is the opposite rule to the directories
 * above and is the difference between a folder and an instruction file. An
 * empty `commands/` offers no commands; an empty `CLAUDE.md` is a document that
 * tells the agent nothing, written into every profile at once by a script that
 * was asked to share a file the user does not have.
 *
 * That asymmetry is also why the status reading reports
 * {@link SharedConfigStatus.rootMissing}: a profile with no `CLAUDE.md` is
 * unlinked-and-correct when the root has none either, and unlinked-and-wrong
 * when the root has one.
 */
export const SHARED_FILES: readonly string[] = ['CLAUDE.md'];

/**
 * Every shared name, in the order both scripts walk them.
 *
 * The prober reports one entry per name in this order, so a pane listing them
 * is listing them the way the terminal output did.
 */
export const SHARED_ENTRIES: readonly string[] = [...SHARED_DIRECTORIES, ...SHARED_FILES];

/**
 * What a displaced directory is renamed to.
 *
 * Not `.bak`: this suffix has to survive being read months later by someone
 * deciding whether the folder is safe to delete, and "pre-shared" answers that
 * where "bak" only raises it.
 */
export const BACKUP_SUFFIX = '.pre-shared';

/**
 * The Claude config directories a script should cover, in a stable order.
 *
 * Filtered to Claude because the entry names are Claude's vocabulary and mean
 * nothing under another provider. Disabled profiles are *kept*: disabled hides
 * an account from the picker, it does not retire its directory, and a profile
 * re-enabled a week later that had been skipped would be the only one left
 * un-shared with nothing on screen explaining why.
 *
 * De-duplicated by path rather than by profile id — two profiles are allowed to
 * name the same directory, and linking it twice would move the first pass's own
 * symlinks aside into backups on the second.
 *
 * Used twice with the same list on purpose: the renderer feeds it to the script
 * generator, and the main process feeds it to the prober. The pane's reading
 * therefore covers exactly the directories the script covers, which is what
 * makes "the switch says yes and the disk says no" a comparison rather than two
 * unrelated lists.
 */
export function sharedConfigDirs(profiles: readonly ProfileMetadata[]): readonly string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const profile of profiles) {
    if (profile.providerId !== 'claude') continue;
    const dir = profile.configDir.trim();
    if (dir.length === 0 || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/* -------------------------------------------------------------------------- */
/* What is on disk                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What one shared name in one profile directory actually is.
 *
 * Deliberately the same four answers the scripts already distinguish, so the
 * pane is describing the terminal output the user just watched rather than
 * inventing a second glossary for the same facts:
 *
 *  - `linked`  — a symlink whose text is the matching path under the root.
 *                `link_one` prints `keep` and does nothing.
 *  - `own`     — a real directory or file of its own, not shared. The share
 *                script would `move` it to `<name>${BACKUP_SUFFIX}` and `link`.
 *  - `missing` — nothing at that name. The share script would `link`; whether
 *                that is a gap depends on {@link SharedConfigStatus.rootMissing},
 *                because a file the root does not have is one the script
 *                deliberately skips.
 *  - `foreign` — a symlink pointing somewhere else. Someone else's arrangement,
 *                which the undo script refuses to touch and reports as `leave`.
 *
 * The comparison behind `linked` and `foreign` is on the link's *text*, exactly
 * as `[ "$(readlink "$target")" = "$source" ]` compares it. A link that reaches
 * the same directory by another spelling — relative, or through a symlinked
 * `$HOME` — reads as `foreign` here because that is what the script will treat
 * it as, and being cleverer than the script would mean describing an outcome
 * the user is not going to get.
 *
 * On Windows the same four words describe two other kinds of link, because
 * `ln -s` has no unprivileged equivalent there. A shared *directory* is a
 * junction, which `lstat` and `readlink` answer for exactly as they do a symlink
 * — so `linked` and `foreign` are decided the same way, allowing for case and
 * for the `\\?\` prefix a target can be spelled with. A shared `CLAUDE.md` is a
 * hard link, which is not a link to anything but a second name for one file, so
 * `linked` there means the two names have the same `dev` and `ino`. The one
 * thing that cannot be told apart is which of the two names came first, which is
 * why the undo script leaves a `CLAUDE.md` alone once the root's copy is gone.
 */
export type SharedConfigEntryState = 'linked' | 'own' | 'missing' | 'foreign';

/** One shared name, as found in one profile's config directory. */
export interface SharedConfigEntry {
  /** The name itself — a member of {@link SHARED_ENTRIES}. */
  readonly name: string;
  readonly state: SharedConfigEntryState;
  /**
   * Where a `foreign` link points, verbatim as `readlink` gave it. Absent for
   * every other state.
   *
   * Carried so the pane can name the other arrangement instead of only saying
   * that one exists — a link into a dotfiles repo is a thing the user did on
   * purpose and will recognise on sight.
   */
  readonly target?: string;
  /**
   * A `<name>${BACKUP_SUFFIX}` sits alongside this entry.
   *
   * Reported because those hold whatever was displaced when the share script
   * ran — for `projects` that is months of transcripts — and until now nothing
   * in the app ever mentioned they exist. Only the un-numbered backup is
   * checked: it is the one the undo script restores, and a `.2` exists only
   * because the name was occupied again after sharing was already on.
   */
  readonly backup?: boolean;
}

/**
 * Whether a profile directory could be read at all, and if not, why not.
 *
 *  - `checked` — {@link SharedConfigDirStatus.entries} is the answer.
 *  - `root`    — this directory *is* `~/.claude`. Both scripts skip it (linking
 *                the root into itself would replace every shared folder with a
 *                link to the backup it was just renamed into), so it is not
 *                unlinked — it is the thing everything else is linked to.
 *  - `absent`  — no such directory. The scripts print `skip  no such directory`;
 *                a profile can name a path that was never created, or that the
 *                user has since deleted.
 */
export type SharedConfigDirState = 'checked' | 'root' | 'absent';

/** One profile config directory, as found on disk. */
export interface SharedConfigDirStatus {
  /** The directory asked about, echoed so a reading can be matched to a profile. */
  readonly dir: string;
  readonly state: SharedConfigDirState;
  /**
   * One entry per {@link SHARED_ENTRIES} name, in that order. Empty unless
   * `state` is `checked` — there is nothing to enumerate in a directory that
   * does not exist, and nothing to link in the root itself.
   */
  readonly entries: readonly SharedConfigEntry[];
}

/**
 * What is actually on disk, for every Claude profile at once.
 *
 * A reading, not a setting. Nothing here decides anything: the switch in the
 * Advanced pane records what the user *asked for*, and this records what the
 * filesystem *has*. The whole value of showing it is in the cases where the two
 * disagree — a switch left on after a script that was never run, a fifth
 * account added after the script covered four — so the two are deliberately
 * never reconciled into one number.
 */
export interface SharedConfigStatus {
  /**
   * The `~/.claude` this reading compared against — the path the scripts' `$ROOT`
   * expands to on this machine.
   *
   * Included because the renderer cannot work it out: it has no home directory
   * and no `fs`, and the script hands `$HOME` to the shell rather than
   * interpolating it. A pane that shows states without naming what they are
   * states *relative to* is asking the user to take it on faith.
   */
  readonly root: string;
  /**
   * Shared names the root itself does not have.
   *
   * The reason a `missing` entry is not automatically a gap. `CLAUDE.md` is
   * skipped by the share script when `~/.claude/CLAUDE.md` does not exist, so a
   * profile without one is correctly arranged; a directory absent from the root
   * is created on the next run, so it is still work outstanding. Reported as an
   * observation about the root and left for the reader to judge.
   */
  readonly rootMissing: readonly string[];
  /** One reading per directory {@link sharedConfigDirs} named, in that order. */
  readonly dirs: readonly SharedConfigDirStatus[];
}
