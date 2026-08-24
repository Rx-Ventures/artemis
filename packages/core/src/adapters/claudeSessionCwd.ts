/**
 * Recovering a session's working directory from its own transcript.
 * ============================================================================
 *
 * The SDK's `listSessions` reports a `cwd` per session, read out of the
 * transcript, and for some sessions it reports none. Artemis used to drop those:
 * a session with no cwd cannot be grouped under a project and cannot be resumed,
 * so a row for it was reasoned to be a row that does nothing. The user-visible
 * result was worse than that reasoning allowed for — the conversation vanished
 * from the sidebar entirely, indistinguishable from one that had been deleted,
 * with its transcript intact on disk the whole time.
 *
 * This module reads the cwd back out of the file the SDK read it from.
 *
 * ---------------------------------------------------------------------------
 * WHICH SESSIONS THE SDK LOSES, AND WHY IT IS WORTH KNOWING
 * ---------------------------------------------------------------------------
 *
 * Every affected session found so far has the same shape: the first `type:
 * "user"` record's `message.content` is a **block array** rather than a string —
 * which is to say the conversation opened with an attachment. `[image, text]` in
 * both observed cases.
 *
 * The SDK's summary pass appears to take `firstPrompt` from the first user
 * record whose content is a plain string, and to take `cwd` from whatever record
 * it settled on. When the opening message carries an image it settles on nothing,
 * and both fields come back absent together — which is exactly the correlation
 * the store this was traced in shows: every session missing a `cwd` is also
 * missing a `firstPrompt`, and every session that has one has both.
 *
 * So the record the SDK skipped *does* hold the directory. Nothing here is a
 * guess: this reads the same field off the same line and is as authoritative as
 * the SDK's own answer would have been. That is what makes a recovered session
 * fully resumable rather than a greyed-out row — see the alternative the issue
 * proposed, which this makes unnecessary.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * **It does not decode the project directory's name.** That remains wrong for
 * the reason `mapAggregatedSessionInfo` gives: Claude replaces every
 * non-alphanumeric character in the path with `-`, so `/src/my-app` and
 * `/src/my/app` are both `-src-my-app`, and resuming there could start an agent
 * in a directory the user never worked in. The directory name is used only to
 * *find* the file — never to reconstruct a path.
 *
 * **It does not read the whole transcript.** These files reach megabytes and the
 * sidebar's listing is a hot path. The read stops at the first record carrying a
 * cwd, which in practice is the third line, and gives up after
 * {@link MAX_LINES} — a file that has not named a directory by then is not going
 * to.
 *
 * **It reports the first cwd, not the last.** A session that was relocated
 * mid-conversation ran in more than one directory, and this names the one it
 * began in. Finding the last would mean reading to the end of every recovered
 * file, and the choice here is between a row at the directory the conversation
 * started in and no row at all. (A `relocated` record carries a plain `cwd`
 * alongside its `relocatedCwd`, so a relocation is not invisible to this — it is
 * simply not preferred.)
 */

import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';

/**
 * How far into a transcript to look for a directory.
 *
 * The conversational records carry `cwd` and the first of them is normally the
 * third line — the two before it are `queue-operation` bookkeeping. A few
 * hundred lines is far past generous, and the bound exists so that a
 * pathological file cannot turn one missing session into a full scan of a
 * hundred-megabyte transcript.
 */
const MAX_LINES = 500;

export interface RecoverCwdOptions {
  /**
   * The store to search: a profile's `CLAUDE_CONFIG_DIR`.
   *
   * `undefined` is the *ambient* store — the CLI's own default, used by a scope
   * that names no config directory. Nothing is recovered for it, deliberately:
   * every Artemis profile sets this variable (that is what makes a profile a
   * profile), so the ambient case is a store Artemis does not place sessions in,
   * and resolving the CLI's default here would mean this module keeping its own
   * copy of a path the SDK owns — a guess, in a file whose whole argument is
   * that it does not guess.
   */
  readonly configDir: string | undefined;
  /** Sessions the SDK returned without a `cwd`. */
  readonly sessionIds: readonly string[];
}

/**
 * Find the working directory of each named session, where the file admits one.
 *
 * Returns only what was recovered — a session whose file cannot be found, cannot
 * be read, or names no directory is simply absent from the map, which the caller
 * treats exactly as it treated a `null` from the mapper.
 *
 * One `readdir` of `projects/` for the whole batch, then one existence probe per
 * project directory per session. Both are cheap and, more to the point, are only
 * paid for the sessions that are already broken: a store whose sessions all
 * report a cwd never reaches this module.
 */
export async function recoverSessionCwds(
  options: RecoverCwdOptions,
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  if (options.sessionIds.length === 0 || options.configDir === undefined) return found;

  const projects = join(options.configDir, 'projects');

  let entries: string[];
  try {
    entries = (await readdir(projects, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No `projects/` at all. Nothing to recover from, and not an error: the
    // caller is already holding sessions this store reported.
    return found;
  }

  for (const sessionId of options.sessionIds) {
    for (const entry of entries) {
      const cwd = await readFirstCwd(join(projects, entry, `${sessionId}.jsonl`));
      if (cwd !== null) {
        found.set(sessionId, cwd);
        break;
      }
    }
  }

  return found;
}

/**
 * The first absolute `cwd` in a JSONL transcript, or `null`.
 *
 * Doubles as the existence probe — a file that is not there throws on open and
 * answers `null`, which is the same answer as a file that holds no directory, so
 * the caller needs no separate `stat`.
 *
 * Exported because it is not specific to Claude's store: any JSONL transcript
 * that puts a `cwd` on its records answers to it, which is why the local
 * adapter's own store — whose layout deliberately mirrors this one — reads its
 * files back through here rather than growing a second copy of the same loop.
 *
 * Line-by-line rather than `readFile`: the first conversational record is near
 * the top and these files reach megabytes, so this returns after reading a few
 * kilobytes of a file it never has to hold in memory. A line that does not parse
 * is skipped rather than fatal — one truncated record at the end of a transcript
 * a process was killed mid-write is not a reason to lose the conversation.
 */
export async function readFirstCwd(file: string): Promise<string | null> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let seen = 0;
  try {
    for await (const line of lines) {
      seen += 1;
      if (seen > MAX_LINES) break;

      const cwd = readCwd(line);
      if (cwd !== null) return cwd;
    }
    return null;
  } catch {
    // A missing file, a directory in its place, a permission error: all mean the
    // same thing here.
    return null;
  } finally {
    // `readline` does not close the stream when the loop is left early, and a
    // listing that recovered several sessions would otherwise leak a handle per
    // file until GC.
    lines.close();
    stream.destroy();
  }
}

/** One record's `cwd`, if it has a usable one. */
function readCwd(line: string): string | null {
  if (!line.includes('"cwd"')) return null;

  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null) return null;

  const cwd = (record as { cwd?: unknown }).cwd;
  if (typeof cwd !== 'string') return null;

  const trimmed = cwd.trim();
  // Absolute, because the value is about to become a directory an agent is
  // resumed in. A relative path would be resolved against whatever Artemis's own
  // process happens to be sitting in, which is not a place the user has been.
  return trimmed.length > 0 && isAbsolute(trimmed) ? trimmed : null;
}
