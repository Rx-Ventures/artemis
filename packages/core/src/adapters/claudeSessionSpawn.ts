/**
 * Telling a scheduler's transcripts apart from a person's.
 * ============================================================================
 *
 * Claude's scheduler — cron jobs and cloud routines alike — runs each firing as
 * an ordinary headless session, so every firing leaves an ordinary transcript
 * in `projects/`. A store that has been running one task for a month holds
 * hundreds of them, and a listing that cannot tell them from conversations
 * files them all as conversations. That is exactly what happened when the
 * shared-`~/.claude` arrangement first merged a CLI store into the sidebar:
 * more than half the "history" that arrived was firings nobody had ever read.
 *
 * This module reads the distinction back out of the transcripts, so the mapper
 * can stamp `SessionSummary.spawnedBy` and the sidebar can file the rows where
 * they belong.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SDK'S OWN SUMMARY CANNOT ANSWER THIS
 * ---------------------------------------------------------------------------
 *
 * A firing's transcript is unmistakable at the source: its first `user` record
 * opens with a `<scheduled-task name="…" file="…">` turn naming the task that
 * fired. But the SDK's `firstPrompt` pass *deliberately skips* prompts that
 * open with an XML-ish tag (they are machine framing, not something to title a
 * row with), so the one field a summary consumer could have checked is exactly
 * the field the marker never reaches. The answer is in the file and only in
 * the file — hence this module, and not a string test in the mapper.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CLASSIFICATION COSTS, AND WHY IT IS PAID ONCE
 * ---------------------------------------------------------------------------
 *
 * One open per session, read line-by-line and abandoned at the first `user`
 * record — in practice a few kilobytes a few lines in, the same shape as
 * `claudeSessionCwd.ts` and bounded the same way ({@link MAX_LINES}).
 *
 * The verdict is immutable: a transcript's opening record is written once and
 * never rewritten, however long the session grows afterwards. So callers hand
 * in a cache and every session is read at most once per process — the first
 * listing after launch pays for the store, every listing after that pays for
 * new sessions only. The cache maps id → verdict, deliberately not id →
 * mtime → verdict: mtime changes on every append, and appends cannot change
 * the answer.
 *
 * ---------------------------------------------------------------------------
 * FINDING THE FILE WITHOUT DECODING ANYTHING
 * ---------------------------------------------------------------------------
 *
 * The transcript lives at `projects/<encoded-cwd>/<id>.jsonl`, where the
 * encoding replaces every character outside `[A-Za-z0-9]` with `-`. Decoding
 * that name is famously forbidden in this codebase — it is lossy — but this
 * module runs the *encode* direction, cwd → directory name, which is exact:
 * every summary already carries the authoritative `cwd`, and the same function
 * the provider applied to it lands on the same name. A session whose file
 * still cannot be opened is simply not classified, which leaves it an
 * ordinary row — the failure mode is a firing listed as a conversation, which
 * is yesterday's behaviour, not a new wrong answer.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/**
 * How far into a transcript to look for the first `user` record.
 *
 * The record is normally third or fourth — behind `queue-operation` and
 * `ai-title` bookkeeping — and a transcript that has not opened its
 * conversation within fifty records is not going to. The bound exists for the
 * same reason as `claudeSessionCwd.ts`'s: no session may turn a listing into a
 * scan of a hundred-megabyte file.
 */
const MAX_LINES = 50;

/**
 * The scheduler's opening turn.
 *
 * Anchored to the start because the marker is framing, not content: a person
 * *quoting* `<scheduled-task …>` mid-prompt is talking about the scheduler,
 * not fired by it. `[\s>]` closes the tag name so a hypothetical
 * `<scheduled-tasks-report>` prompt does not match.
 */
const SCHEDULED_OPENING = /^\s*<scheduled-task[\s>]/;

/** What a classification needs to know about one session. */
export interface SpawnCandidate {
  readonly id: string;
  /** The directory the session ran in — `SessionSummary.cwd`, authoritative. */
  readonly cwd: string;
}

export interface FindScheduledSpawnsOptions {
  /**
   * The store the sessions were listed from: a profile's `CLAUDE_CONFIG_DIR`.
   *
   * `undefined` is the ambient store, and classifies nothing — the same
   * refusal, for the same reason, as `claudeSessionCwd.ts`: every Artemis
   * profile names its directory, so the ambient case is not one Artemis lists,
   * and resolving the CLI's default here would be a guess.
   */
  readonly configDir: string | undefined;
  readonly sessions: readonly SpawnCandidate[];
  /**
   * Verdicts from earlier calls, updated in place. One map per store —
   * verdicts are per-transcript facts, and a transcript belongs to a store.
   */
  readonly cache: Map<string, boolean>;
}

/**
 * Which of these sessions are scheduler firings.
 *
 * Returns the ids whose transcript opens with the scheduler's turn. A session
 * that cannot be found, cannot be read, or opens like a conversation is simply
 * absent — callers treat membership as "stamp `spawnedBy`" and absence as
 * "leave the summary alone".
 */
export async function findScheduledSpawns(
  options: FindScheduledSpawnsOptions,
): Promise<ReadonlySet<string>> {
  const spawned = new Set<string>();
  if (options.configDir === undefined) return spawned;

  const projects = join(options.configDir, 'projects');
  for (const session of options.sessions) {
    let verdict = options.cache.get(session.id);
    if (verdict === undefined) {
      const file = join(projects, encodeProjectDir(session.cwd), `${session.id}.jsonl`);
      verdict = await opensWithScheduledTask(file);
      options.cache.set(session.id, verdict);
    }
    if (verdict) spawned.add(session.id);
  }
  return spawned;
}

/**
 * The provider's project-directory encoding: everything outside `[A-Za-z0-9]`
 * becomes `-`. Exact in this direction — see the file header for why running
 * it forward is fine where running it backward never is.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replaceAll(/[^A-Za-z0-9]/gu, '-');
}

/**
 * Does this transcript open with the scheduler's turn?
 *
 * Decided at the first `user` record: marker means firing, anything else means
 * conversation, and the read stops either way. The `queue-operation` records
 * that precede it carry the same content and are accepted as an earlier
 * answer, so most firings are recognised on line one or two.
 *
 * Errors — missing file, permission, a directory squatting on the name — all
 * answer `false`: an unclassifiable session stays an ordinary row.
 */
async function opensWithScheduledTask(file: string): Promise<boolean> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let seen = 0;
  try {
    for await (const line of lines) {
      seen += 1;
      if (seen > MAX_LINES) break;

      const record = parseRecord(line);
      if (record === null) continue;

      if (record.type === 'queue-operation') {
        const content = record['content'];
        if (typeof content === 'string' && SCHEDULED_OPENING.test(content)) return true;
        continue;
      }

      // The first user record settles it, in either direction.
      if (record.type === 'user') return openingText(record).some((t) => SCHEDULED_OPENING.test(t));
    }
    return false;
  } catch {
    return false;
  } finally {
    // `readline` does not close the stream when the loop is left early; a
    // first listing classifies a whole store, so a leaked handle per file
    // would be hundreds of leaked handles.
    lines.close();
    stream.destroy();
  }
}

/** One JSONL line as a typed-enough record, or `null` for anything else. */
function parseRecord(line: string): (Record<string, unknown> & { type: string }) | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // A truncated record — a process killed mid-write — is not a reason to
    // misfile the session.
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record['type'] === 'string'
    ? (record as Record<string, unknown> & { type: string })
    : null;
}

/**
 * The text a `user` record opens with — the string form, or every `text` block
 * of the array form. Both exist in real stores; an opening attachment is why
 * the array form matters (see `claudeSessionCwd.ts`, which exists because of
 * the same records).
 */
function openingText(record: Record<string, unknown>): string[] {
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { content?: unknown }).content;

  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') texts.push(text);
  }
  return texts;
}
