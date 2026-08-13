/**
 * Sharing one `~/.claude` across every profile — as a script, not as an action.
 * ============================================================================
 *
 * Artemis gives each profile its own `CLAUDE_CONFIG_DIR`, and that one variable
 * buys isolated auth *and* isolated everything-else. The isolation is the point
 * for the credential and an irritation for the rest: a skill written once has to
 * be written again per account, and history splits four ways for no reason the
 * user asked for.
 *
 * This module writes the shell that undoes the second half without touching the
 * first — symlinks from each profile's directory to the matching entry under
 * the user's own `~/.claude`.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND NOT A BUTTON
 * ---------------------------------------------------------------------------
 *
 * Artemis does not run this. It generates text, the user reads it, and the user
 * runs it in their own terminal.
 *
 * That is a deliberate refusal rather than an unfinished feature. The operation
 * moves directories that hold months of transcripts, across accounts, on paths
 * this app got from a JSON file a user can edit. A button would make that a
 * single click with no diff to read and no record of what happened; a script is
 * reviewable before it runs, greppable after it ran, and re-runnable outside
 * Artemis when the app is not the thing that is broken. The generator is pure
 * for the same reason — it is the part worth testing, and it can be tested
 * without a filesystem.
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

import type { ProfileMetadata } from '@rx-artemis/protocol';

/**
 * Directories linked from the root config into every profile.
 *
 * Created under the root when absent. A fresh `~/.claude` has no `commands` or
 * `todos`, and a symlink pointing at a path that does not exist is not an empty
 * folder — it is a broken read, reported as one by every tool that touches it.
 *
 * ## `projects` is in this list, and it duplicates the sidebar
 *
 * Recorded because it is the one entry whose consequence is not guessable from
 * its name, and because it is a defect in *Artemis* rather than in the script.
 *
 * `projects/<encoded-cwd>/` holds the transcripts. Sharing it does not merge
 * history — Artemis already does that in the reader, and that is exactly the
 * problem. `listAllSessions` walks every profile, points `CLAUDE_CONFIG_DIR` at
 * each one in turn, enumerates whatever that directory's store contains, and
 * tags each result with the profile it came from. Nothing downstream
 * de-duplicates: `sessionGroups` keys rows on `profileId + id` on the stated
 * grounds that a session id is unique only inside its own profile.
 *
 * Point three profiles at one store and all three enumerate the same
 * transcripts, so every session arrives three times under three different
 * account labels and renders as three rows.
 *
 * Directory contents make the same point about what is actually being shared:
 * everything under `projects/` is session-scoped — the `.jsonl` transcript, and
 * a `<session-uuid>/` sidecar holding `subagents/`, `subagents/workflows/` and
 * `tool-results/` — except `memory/`, which is per-project knowledge and the
 * one thing in there that is not about an account at all.
 *
 * The fix is a de-duplication pass keyed on the transcript rather than on the
 * profile that happened to read it. Until that exists, this entry is honest
 * about costing duplicate rows, and the warning copy says so in those words.
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
 */
export const SHARED_FILES: readonly string[] = ['CLAUDE.md'];

/**
 * What a displaced directory is renamed to.
 *
 * Not `.bak`: this suffix has to survive being read months later by someone
 * deciding whether the folder is safe to delete, and "pre-shared" answers that
 * where "bak" only raises it.
 */
export const BACKUP_SUFFIX = '.pre-shared';

/** Which script to generate. */
export type SharedConfigMode = 'share' | 'restore';

/**
 * Quote one value for `/bin/sh`.
 *
 * Single quotes and the `'\''` dance, because the inputs are profile
 * directories and the default on macOS lives under `~/Library/Application
 * Support` — a path with a space in it, in the one position where losing the
 * split turns `mv` into a two-argument command aimed at the wrong place.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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

/**
 * Build the script.
 *
 * `/bin/sh`, not bash: the only bash-isms this needs are conveniences, and a
 * script the user is about to paste into whatever shell they happen to run
 * should not fail on the shebang. `set -eu` rather than `pipefail` for the same
 * reason — there are no pipes here, and `pipefail` is not POSIX.
 *
 * The root is written as `$HOME/.claude` and left for the shell to expand. The
 * renderer does not know the home directory, and asking the main process for it
 * would add an IPC channel to interpolate a string the shell already has.
 */
export function buildSharedConfigScript(dirs: readonly string[], mode: SharedConfigMode): string {
  return mode === 'share' ? shareScript(dirs) : restoreScript(dirs);
}

/** `profile 'a'` lines, or a comment where the list is empty. */
function calls(dirs: readonly string[], fn: string): string {
  if (dirs.length === 0) return '# No Claude profiles to cover.';
  return dirs.map((dir) => `${fn} ${shellQuote(dir)}`).join('\n');
}

function shareScript(dirs: readonly string[]): string {
  return `#!/bin/sh
#
# Shared Claude config — generated by Artemis.
# ==========================================================================
#
# Points the shareable parts of each Artemis Claude profile at your own
# ~/.claude, so commands, skills, plugins, plans and history are the same
# whichever account a run uses.
#
# NOT touched: .claude.json, settings.json, sessions/ and the stored
# credential. Those stay per profile — they are what make the accounts
# separate accounts, and linking them signs every profile into whichever one
# logged in last.
#
# Nothing is deleted. Anything already in a profile is renamed to
# <name>${BACKUP_SUFFIX} first, and the "stop sharing" script puts it back.
#
# Re-running this is safe: a link that already points at the root is left as
# it is, and no second backup is made.
#
# Quit Artemis before running it, so nothing is writing to these paths.

set -eu

ROOT="$HOME/.claude"
SUFFIX="${BACKUP_SUFFIX}"

SHARED_DIRS="${SHARED_DIRECTORIES.join(' ')}"
SHARED_FILES="${SHARED_FILES.join(' ')}"

# Move whatever is at $1 out of the way, then link it to $2.
link_one() {
  target="$1"
  source="$2"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    printf '  keep  %s\\n' "$target"
    return 0
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    backup="$target$SUFFIX"
    n=2
    while [ -e "$backup" ] || [ -L "$backup" ]; do
      backup="$target$SUFFIX.$n"
      n=$((n + 1))
    done
    mv "$target" "$backup"
    printf '  move  %s -> %s\\n' "$target" "$backup"
  fi

  ln -s "$source" "$target"
  printf '  link  %s\\n' "$target"
}

profile() {
  dir="$1"

  # Linking the root to itself would replace every shared folder with a link
  # to the backup it was just renamed into. A profile is allowed to name
  # ~/.claude directly, so this is a real case and not a defensive check.
  if [ "$dir" = "$ROOT" ]; then
    printf '%s\\n  skip  this is ~/.claude itself\\n' "$dir"
    return 0
  fi
  if [ ! -d "$dir" ]; then
    printf '%s\\n  skip  no such directory\\n' "$dir"
    return 0
  fi

  printf '%s\\n' "$dir"

  for name in $SHARED_DIRS; do
    mkdir -p "$ROOT/$name"
    link_one "$dir/$name" "$ROOT/$name"
  done

  for name in $SHARED_FILES; do
    if [ ! -e "$ROOT/$name" ]; then
      printf '  skip  %s (no %s to share)\\n' "$name" "$ROOT/$name"
      continue
    fi
    link_one "$dir/$name" "$ROOT/$name"
  done
}

mkdir -p "$ROOT"

${calls(dirs, 'profile')}

printf '\\nDone. Start Artemis again to pick up the new layout.\\n'
`;
}

function restoreScript(dirs: readonly string[]): string {
  return `#!/bin/sh
#
# Stop sharing the Claude config — generated by Artemis.
# ==========================================================================
#
# Undoes the sharing script: removes the links it made and moves each
# <name>${BACKUP_SUFFIX} back to where it came from.
#
# Conservative in both directions. A link is removed only when it still
# points at the matching path under ~/.claude — anything else at that name is
# something you put there since, and is left alone with a note. A backup is
# restored only onto a name that is now free, so nothing overwrites anything.
#
# Files created inside a shared folder while sharing was on stay in ~/.claude.
# They were written to the root, and this script does not try to guess which
# profile they belonged to.
#
# Quit Artemis before running it.

set -eu

ROOT="$HOME/.claude"
SUFFIX="${BACKUP_SUFFIX}"

SHARED_DIRS="${SHARED_DIRECTORIES.join(' ')}"
SHARED_FILES="${SHARED_FILES.join(' ')}"

restore_one() {
  target="$1"
  source="$2"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    rm "$target"
    printf '  unlink   %s\\n' "$target"
  elif [ -e "$target" ] || [ -L "$target" ]; then
    printf '  leave    %s (not the link this script made)\\n' "$target"
    return 0
  fi

  # Only the un-numbered backup: it is the original. A "$SUFFIX.2" exists only
  # because the name was occupied again after sharing was already on, and
  # guessing which of the two the user wants back is not this script's call.
  backup="$target$SUFFIX"
  if [ ! -e "$backup" ] && [ ! -L "$backup" ]; then
    return 0
  fi
  mv "$backup" "$target"
  printf '  restore  %s\\n' "$target"
}

profile() {
  dir="$1"

  if [ "$dir" = "$ROOT" ]; then
    printf '%s\\n  skip     this is ~/.claude itself\\n' "$dir"
    return 0
  fi
  if [ ! -d "$dir" ]; then
    printf '%s\\n  skip     no such directory\\n' "$dir"
    return 0
  fi

  printf '%s\\n' "$dir"

  for name in $SHARED_DIRS $SHARED_FILES; do
    restore_one "$dir/$name" "$ROOT/$name"
  done
}

${calls(dirs, 'profile')}

printf '\\nDone. Start Artemis again to pick up the new layout.\\n'
`;
}
