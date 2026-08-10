/**
 * Filesystem paths, as the renderer is allowed to know them.
 * ============================================================================
 *
 * The renderer has no `node:path`, no `fs`, and — importantly — no `$HOME`.
 * Everything here is therefore *display* logic plus one shape check, and none
 * of it is authoritative: the main process validates a path properly before any
 * run touches it (see `main/validate.ts`, which is the real gate). What this
 * module buys is a sidebar that reads like a person wrote it, and a text field
 * that rejects `src/foo` before it costs the user a round trip.
 *
 * ## Why `inferHomeDirectory` is a heuristic and why that is acceptable
 *
 * Tilde-collapsing `/Users/ada/code/apollo` → `~/code/apollo` needs the home
 * directory, and there is no IPC channel that reports one. Rather than invent
 * a channel for a cosmetic gain, the home directory is *inferred* from the
 * paths already on screen: whichever `/Users/<name>` (or `/home/<name>`, or
 * `C:\Users\<name>`) prefix is most common across the known session
 * directories is treated as home.
 *
 * That can be wrong — a machine with two user directories in play, an unusual
 * layout — so nothing depends on it being right. Every place a shortened path
 * is rendered also carries the full path in its `title`, so a bad guess costs
 * a hover and never hides information.
 */

export type Platform = 'darwin' | 'win32' | 'linux';

/** The separator paths on this platform are built from. */
export function separatorFor(platform: Platform): string {
  return platform === 'win32' ? '\\' : '/';
}

/**
 * Is this an absolute path, on the given platform?
 *
 * Mirrors what `node:path.isAbsolute` would say, which is what the main process
 * actually enforces. Deliberately platform-specific rather than "starts with a
 * slash or has a drive letter": telling a macOS user that `C:\src` is fine and
 * then having the backend reject it is worse than rejecting it here.
 */
export function isAbsolutePath(path: string, platform: Platform): boolean {
  const value = path.trim();
  if (value.length === 0 || value.includes('\u0000')) return false;
  if (platform === 'win32') {
    // `C:\x`, `C:/x`, or a UNC share `\\server\share`.
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]/.test(value);
  }
  return value.startsWith('/');
}

/** The sentence shown under a rejected path. Names the platform's rule. */
export function absolutePathHint(platform: Platform): string {
  return platform === 'win32'
    ? 'Must be an absolute path — a drive letter (C:\\Users\\you\\project) or a UNC share (\\\\server\\share).'
    : 'Must be an absolute path, starting with “/”. Relative paths and “~” are not expanded here.';
}

/** Home-directory shapes, per platform. Only ever used for display. */
const HOME_PATTERNS: Record<Platform, RegExp> = {
  darwin: /^(\/Users\/[^/]+)(?:\/|$)/,
  linux: /^(\/home\/[^/]+)(?:\/|$)/,
  win32: /^([A-Za-z]:\\Users\\[^\\]+)(?:\\|$)/,
};

/**
 * Guess the user's home directory from the paths we already have.
 *
 * Returns `undefined` when nothing looks like a home directory, in which case
 * callers simply render the full path — the degraded case is "a slightly longer
 * label", which is why guessing is safe here at all.
 */
export function inferHomeDirectory(
  paths: Iterable<string>,
  platform: Platform,
): string | undefined {
  const pattern = HOME_PATTERNS[platform];
  const counts = new Map<string, number>();
  for (const path of paths) {
    const match = pattern.exec(path);
    const home = match?.[1];
    if (home === undefined) continue;
    counts.set(home, (counts.get(home) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [home, count] of counts) {
    // Strictly greater, so the first-inserted candidate wins a tie and the
    // result is stable across renders rather than flickering between two homes.
    if (count > bestCount) {
      best = home;
      bestCount = count;
    }
  }
  return best;
}

/** `/Users/ada/code` → `~/code`, when `home` is a prefix. Otherwise unchanged. */
export function collapseHome(path: string, home: string | undefined, platform: Platform): string {
  if (!home || home.length === 0) return path;
  const separator = separatorFor(platform);
  if (path === home) return '~';
  if (path.startsWith(home + separator)) return `~${path.slice(home.length)}`;
  return path;
}

export interface ShortenOptions {
  readonly home?: string | undefined;
  readonly platform?: Platform;
  /** Target length. Not a hard cap — the last segment is never fully eaten. */
  readonly max?: number;
}

/**
 * A readable label for a project directory.
 *
 * Collapses the home directory, then elides the *middle* rather than either
 * end. Both ends carry meaning in a session sidebar: the head says which tree
 * ("~", "/opt", a volume) and the tail is the project's actual name, which is
 * what the user is scanning for. Truncating from the right — the default a
 * `truncate` class would give — throws away exactly the part that identifies
 * the row.
 */
export function shortenPath(path: string, options: ShortenOptions = {}): string {
  const platform = options.platform ?? 'darwin';
  const max = options.max ?? 32;
  const separator = separatorFor(platform);

  const collapsed = collapseHome(path.trim(), options.home, platform);
  if (collapsed.length <= max) return collapsed;

  const leading = collapsed.startsWith(separator) ? separator : '';
  const segments = collapsed.slice(leading.length).split(separator).filter(Boolean);
  if (segments.length === 0) return collapsed;

  const last = segments[segments.length - 1] as string;

  // Head + … + last two segments, e.g. `~/…/apps/desktop`.
  if (segments.length > 3) {
    const head = segments[0] as string;
    const tail = segments.slice(-2).join(separator);
    const elided = `${leading}${head}${separator}…${separator}${tail}`;
    if (elided.length <= max) return elided;
  }

  // Still too long: drop the head entirely.
  if (segments.length > 2) {
    const tail = segments.slice(-2).join(separator);
    const elided = `…${separator}${tail}`;
    if (elided.length <= max) return elided;
  }

  // One segment, and it is the name of the thing. Clip its front, not its
  // back — `…ktop-app` still identifies a project; `desktop-…` does not.
  if (last.length > max) return `…${last.slice(last.length - (max - 1))}`;
  return `…${separator}${last}`;
}

/** Last segment of a path, for a compact chip. Handles both separators. */
export function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}
