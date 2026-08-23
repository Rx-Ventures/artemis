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

import { compareVersions } from './updateChannel.js';

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
 * Semver precedence, tolerant of a leading `v`, and **prerelease-aware** —
 * which it was not until the beta channel existed. The old comparison split on
 * `.` and required every part to be an integer, so `1.0.0-beta.1` produced
 * `Number('0-beta')`, which is NaN, which meant "not newer". Harmless while
 * nothing carried a prerelease part; fatal the moment something did, because it
 * failed in *both* directions: a beta was never offered, and a machine running
 * one was never offered anything again. A beta build would have been stranded
 * on the version it was installed at, permanently.
 *
 * The shape check stays, and stays strict. The updater must fail toward
 * silence: "not offered" leaves a stale app that still works, while a bad
 * offer is an install loop. So anything that is not a recognisable version
 * compares as not newer rather than being coerced into one.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!looksLikeVersion(candidate) || !looksLikeVersion(current)) return false;
  return compareVersions(candidate.replace(/^v/, ''), current.replace(/^v/, '')) > 0;
}

/** `1.2.3`, optionally `-beta.1`, optionally `+build`, optionally `v`-prefixed. */
function looksLikeVersion(value: string): boolean {
  return /^v?\d+(\.\d+)*(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * What a check should do about the version it just read.
 *
 * This was a boolean — `shouldOffer` — and a boolean turned out to be one bit
 * short. It could say "stay quiet" but not *why*, and the two reasons for quiet
 * want opposite things from a card that is already on screen: a version the
 * user declined should leave it exactly where it is, while a feed with nothing
 * newer in it at all means the card is offering a release that no longer exists
 * and should come down. That distinction did not matter while a standing offer
 * was never re-read. It is the whole point now that every check re-reads.
 */
export type OfferDecision =
  /** Newer, and not declined: put it up, or replace what is up with it. */
  | 'offer'
  /** Nothing to say, and nothing to correct: leave the screen as it is. */
  | 'silence'
  /** Nothing here is newer than what is running: a standing offer is stale. */
  | 'withdraw';

/**
 * Offer, stay silent, or take back what is on screen.
 *
 * Dismissal is per-version and sticky — declining 0.3.0 keeps 0.3.0 quiet
 * forever, and 0.4.0 starts a fresh conversation — and it is `silence` rather
 * than `withdraw` on purpose: a card can only be up because someone asked for
 * one, and a decision recorded before that ask must not undo it.
 */
export function decideOffer(options: {
  readonly feedVersion: string;
  readonly currentVersion: string;
  readonly dismissedVersion: string | null;
}): OfferDecision {
  const { feedVersion, currentVersion, dismissedVersion } = options;
  // A version neither side can parse is a feed that cannot be reasoned about,
  // which is the same answer as a feed that never arrived: say nothing, change
  // nothing. Withdrawing here would let one malformed release take down a
  // perfectly good offer.
  if (!looksLikeVersion(feedVersion) || !looksLikeVersion(currentVersion)) return 'silence';
  if (!isNewerVersion(feedVersion, currentVersion)) return 'withdraw';
  return feedVersion === dismissedVersion ? 'silence' : 'offer';
}
