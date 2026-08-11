/**
 * The update feed, as data.
 *
 * electron-builder publishes a `latest-mac.yml` beside every release's
 * artifacts — see the `publish` block in `electron-builder.yml` — and this
 * module turns that file into a decision: *is there something newer than what
 * is running, that the user has not already declined?*
 *
 * Everything here is pure and Electron-free so it can be unit-tested the way
 * `appNames.ts` is; fetching the feed, downloading the artifact and swapping
 * the bundle live in `updater.ts`, which is where the side effects belong.
 *
 * ## Why a hand parser and not a YAML dependency
 *
 * The feed is machine-written by one known emitter, and the three fields we
 * read — `version`, `path`, `sha512` — are scalar `key: value` lines at the
 * top level. A YAML library would be a parser for documents nobody writes,
 * pulled into the *privileged* process, to read a file that an attacker who
 * can tamper with it has already won against (they could just as easily
 * tamper with the artifact the feed describes — which is why the sha512 is
 * verified against the download, and why the feed itself is only ever fetched
 * from the repository this build was published from).
 */

/** What one feed file says, reduced to the fields the updater acts on. */
export interface UpdateFeed {
  /** The version the feed offers, e.g. `0.2.0`. */
  readonly version: string;
  /** File name of the zip artifact in the same release, e.g. `Artemis-0.2.0-arm64-mac.zip`. */
  readonly zipPath: string;
  /** Base64 sha512 of that zip, verified against the download before any swap. */
  readonly sha512: string;
}

/**
 * Read one top-level `key: value` line. Quoted values lose their quotes;
 * anything nested (indented) is ignored, which is what keeps the per-file
 * `sha512:` entries under `files:` from shadowing the top-level one.
 */
function topLevelValue(feed: string, key: string): string | null {
  for (const line of feed.split('\n')) {
    if (!line.startsWith(`${key}:`)) continue;
    const raw = line.slice(key.length + 1).trim();
    if (raw === '') return null;
    const unquoted = /^'(.*)'$/.exec(raw) ?? /^"(.*)"$/.exec(raw);
    return unquoted ? unquoted[1]! : raw;
  }
  return null;
}

/**
 * Parse a `latest-mac.yml`, or return null for anything that does not carry
 * all three fields. Null rather than throwing: a malformed feed means "no
 * update today", never a dialog.
 */
export function parseUpdateFeed(feed: string): UpdateFeed | null {
  const version = topLevelValue(feed, 'version');
  const zipPath = topLevelValue(feed, 'path');
  const sha512 = topLevelValue(feed, 'sha512');
  if (version === null || zipPath === null || sha512 === null) return null;
  // The top-level path has always been the zip, but nothing guarantees it
  // forever — and the swap can only consume a zip.
  if (!zipPath.endsWith('.zip')) return null;
  return { version, zipPath, sha512 };
}

/**
 * Is `candidate` strictly newer than `current`?
 *
 * Dotted numeric compare, tolerant of a leading `v`. Anything that does not
 * reduce to numbers compares as *not newer* — the updater must fail toward
 * silence, because the failure mode of "not offered" is a stale app that
 * still works, and the failure mode of a bad offer is an install loop.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const parts = value.replace(/^v/, '').split('.');
    const numbers = parts.map((part) => Number(part));
    return numbers.length > 0 && numbers.every((n) => Number.isInteger(n) && n >= 0)
      ? numbers
      : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * The one decision the periodic check makes: offer, or stay silent.
 *
 * Dismissal is per-version and sticky — declining 0.3.0 keeps 0.3.0 quiet
 * forever, and 0.4.0 starts a fresh conversation.
 */
export function shouldOffer(options: {
  readonly feedVersion: string;
  readonly currentVersion: string;
  readonly dismissedVersion: string | null;
}): boolean {
  const { feedVersion, currentVersion, dismissedVersion } = options;
  if (!isNewerVersion(feedVersion, currentVersion)) return false;
  return feedVersion !== dismissedVersion;
}
