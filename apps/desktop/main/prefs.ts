/**
 * The renderer's preferences, kept where the rest of Artemis's data is kept.
 * ============================================================================
 *
 * These used to live in `localStorage`, which put them inside Chromium's
 * `Local Storage` LevelDB — the one directory in `userData` that genuinely
 * cannot be shared between two processes, because LevelDB takes an exclusive
 * writer lock and a second opener either fails or corrupts it.
 *
 * That was tolerable while there was one build. It stopped being tolerable the
 * moment a second one existed, because the preferences blob is not only
 * preferences: it holds **which sessions are archived and which are pinned**.
 * Those are facts about the user's conversations, not about a window's
 * appearance, and a build that could see the sessions but not the shelf they
 * had been put on was showing a version of the sidebar the user had explicitly
 * tidied away.
 *
 * So they move to a plain JSON file beside `profiles.json` and
 * `sessionOwners.json` — the six other things Artemis owns — which is where
 * they always belonged. Every build sharing that directory shares the shelf,
 * the pins, the theme and the rest, with no LevelDB anywhere near it.
 *
 * ## Written whole, atomically
 *
 * The same discipline `ProfileStore` uses, for the same reason: a partial write
 * of this file is a window that opens with half its settings, and there is no
 * merge that could repair it. Temp file, rename, done.
 *
 * ## Opaque on purpose
 *
 * Main never parses the contents. The shape is the renderer's business —
 * `loadPrefs` there already validates every field on the way in, because a
 * hand-edited file has always been possible — and a second validator here would
 * be one more place to update when a preference is added, and one more place to
 * silently drop one that was not.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createLogger } from './log.js';

const log = createLogger('prefs');

/** Beside `profiles.json`, and named the way the others are. */
export const PREFS_FILE = 'prefs.json';

/** Set once at startup by `configurePrefs`. */
let prefsPath: string | null = null;

/** Point the store at Artemis's data directory. Call before any window opens. */
export function configurePrefs(dataDir: string): void {
  prefsPath = join(dataDir, PREFS_FILE);
}

/**
 * The stored blob, or `null` when there is none.
 *
 * Synchronous, and deliberately: the renderer reads this once, before its first
 * paint, because the values decide the font scale and the palette. An
 * asynchronous read would mean painting the app at the default size in the
 * default theme and correcting it a frame later, which is a visible flash on
 * every launch. One small local file read is the cheaper trade.
 */
export function readPrefsSync(): string | null {
  if (prefsPath === null) return null;
  try {
    return readFileSync(prefsPath, 'utf8');
  } catch {
    // Absent is the ordinary state on a first run, and unreadable is a state
    // the renderer already copes with by falling back to its defaults.
    return null;
  }
}

/** The stored blob, or `null`. The async twin of {@link readPrefsSync}. */
export async function readPrefs(): Promise<string | null> {
  if (prefsPath === null) return null;
  try {
    return await readFile(prefsPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Replace the stored blob.
 *
 * Never throws: preferences are a convenience, and a failure to persist the
 * sidebar width must not surface as an error over the user's work. It is logged
 * because a *persistent* failure is worth finding in a log later.
 */
export async function writePrefs(json: string): Promise<void> {
  if (prefsPath === null) return;
  const target = prefsPath;
  const temp = `${target}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Owner-only: this file names working directories and profile ids.
    await writeFile(temp, json, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    log.debug('Could not persist preferences', error);
  }
}
