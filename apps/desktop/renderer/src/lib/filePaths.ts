/**
 * Deciding whether a piece of text is a file the reader could open.
 * ============================================================================
 *
 * An answer is full of backticked fragments — `useCopy`, `pnpm test`, `--force`,
 * `apps/desktop/main/files.ts:88` — and exactly one of those is a thing to
 * click. This module is that judgement, kept pure and kept here so it can be
 * argued with in a test rather than discovered in a transcript.
 *
 * ## The rule, and what it costs in both directions
 *
 * A reference is text with **no whitespace, no scheme, no shell punctuation, and
 * a filename-shaped tail** — a dot followed by a short extension beginning with
 * a letter. An optional `:line` or `:line:col` is understood and stripped first,
 * because that is how every tool on earth writes a code location and it is how
 * this repository's own conventions ask for one.
 *
 * The extension requirement is the load-bearing clause, and it is chosen over
 * "contains a slash" after looking at what actually appears in backticks.
 * Slashes turn up in `and/or`, in `n/a`, in `TypeScript/JavaScript`, and in
 * every command with a flag in it; a filename-shaped tail turns up in almost
 * nothing that is not a filename. So:
 *
 *  - **Wrongly linked** (rare, and cheap): `e.g` — a two-letter extension on a
 *    Latin abbreviation. Clicking it opens a view that says there is no file
 *    there, which is annoying for a second and misleads nobody.
 *  - **Wrongly plain** (more common, and cheaper still): `Makefile`,
 *    `Dockerfile`, `LICENSE` — real files with no extension, which stay as text.
 *    An allow-list of bare names would catch the famous ones and miss
 *    `justfile`, and the miss costs a reader nothing they did not already have.
 *
 * That asymmetry is deliberate. A link that does nothing is a worse experience
 * than a word that was never a link, so where the rule is unsure it declines.
 *
 * ## `~` is not expanded, so it is not linked
 *
 * The renderer has no `$HOME` — see `paths.ts` — and the main process's
 * validator requires an absolute path, so `~/.claude/settings.json` would
 * resolve to `<cwd>/~/.claude/settings.json` and fail with a puzzling sentence.
 * Rejecting it here means it renders as ordinary text, which is honest about
 * what Artemis can do with it.
 */

import { isAbsolutePath, separatorFor, type Platform } from './paths';

/** `path:line` and `path:line:col` — how a code location is written everywhere. */
const LOCATION = /:(\d+)(?::\d+)?$/;

/** A filename-shaped tail: `.ts`, `.md`, `.tsbuildinfo`. Never `.5` or `.3`. */
const FILENAME_TAIL = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/**
 * A URL, near enough.
 *
 * Two or more characters before the colon, which is what keeps a Windows drive
 * letter (`C:\src\app.ts`) from reading as a one-letter scheme.
 */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/**
 * Punctuation that says "this is an expression, not a path".
 *
 * Brackets and quotes catch `foo.map()` and `"./x.ts"`; the shell operators
 * catch `cat a.txt | wc`. A real path may legally contain most of these — and a
 * reader with such a file is served worse by this than by nothing — but the
 * trade is the one the header states: decline when unsure.
 */
const HOSTILE = /[\s()[\]{}<>|&;$*?`'"\\\u0000]/;

/** A path the reader could be shown, and the line it was pointed at. */
export interface FileReference {
  /** The path exactly as written, before any resolution against a directory. */
  readonly path: string;
  /** The 1-based line named after the colon, when one was named. */
  readonly line?: number;
}

/**
 * Read a fragment of text as a file reference, or decide it is not one.
 *
 * Windows paths are accepted with forward or backward slashes — except that a
 * backslash is in {@link HOSTILE}, so in practice this recognises the
 * forward-slash spelling the agent almost always writes. That is a known gap
 * rather than an oversight: distinguishing `C:\src\app.ts` from an escape
 * sequence in a code fragment is not a judgement worth making wrong.
 */
export function parseFileReference(raw: string): FileReference | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 512) return null;
  if (HOSTILE.test(text)) return null;
  if (text.startsWith('~')) return null;
  if (SCHEME.test(text)) return null;

  const at = LOCATION.exec(text);
  const path = at === null ? text : text.slice(0, at.index);
  if (path.length === 0) return null;
  if (!FILENAME_TAIL.test(path)) return null;

  // A trailing separator means a directory was meant, whatever the tail says.
  if (path.endsWith('/')) return null;

  const line = at === null ? undefined : Number.parseInt(at[1] as string, 10);
  return line === undefined || Number.isNaN(line) ? { path } : { path, line };
}

/**
 * Turn a reference into the absolute path the main process will accept.
 *
 * `cwd` is the conversation's own directory, which is the only sensible base:
 * an agent writing `apps/desktop/main/files.ts` means it relative to the project
 * it was pointed at, and the same string means a different file in the column
 * next door.
 *
 * Returns the input unchanged when it is already absolute, and — deliberately —
 * does no normalising of `..` or `.` beyond a leading `./`. The filesystem
 * resolves those correctly and is the authority on what they mean; a second
 * implementation here could only differ from it.
 */
export function resolveFilePath(path: string, cwd: string, platform: Platform): string {
  if (isAbsolutePath(path, platform)) return path;

  const separator = separatorFor(platform);
  const relative = path.replace(/^\.[\\/]/, '');
  const base = cwd.endsWith(separator) ? cwd.slice(0, -separator.length) : cwd;
  return `${base}${separator}${relative}`;
}
