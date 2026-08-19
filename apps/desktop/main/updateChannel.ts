/**
 * Which releases this installation is willing to see.
 *
 * `stable` is the default and asks GitHub for `/releases/latest`, an endpoint
 * that **excludes prereleases**. That single fact is what makes a beta channel
 * safe to add: a prerelease is invisible to everyone who did not ask for it,
 * without the stable path needing to filter anything.
 *
 * `beta` cannot use that endpoint, precisely because it skips the releases beta
 * exists to find. So it resolves the newest release *including* prereleases and
 * asks for that tag by name.
 *
 * ## Why the newest release rather than the newest prerelease
 *
 * A beta user should be offered 1.1.0 when it ships stable, not held on
 * 1.1.0-beta.3 forever waiting for a beta that will never come. "Beta" means
 * *earlier*, not *a separate product* — so the channel widens what is
 * considered rather than replacing it, and the newest release wins whether or
 * not it is a prerelease.
 */

export type UpdateChannel = 'stable' | 'beta';

/** What the GitHub releases API returns, reduced to what a channel decides on. */
export interface ReleaseSummary {
  readonly tag_name: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
}

/**
 * The tag to fetch a feed from, or `''` for "ask GitHub for the latest".
 *
 * The empty string is not a sentinel invented here — `fetchAsset` already
 * treats it as "use the /releases/latest path", which is the anonymous route
 * that needs no API call at all. Stable keeps that: one fewer request, and one
 * fewer thing to fail.
 */
export function tagForChannel(
  channel: UpdateChannel,
  releases: readonly ReleaseSummary[],
): string {
  if (channel === 'stable') return '';

  // Drafts are not published to anyone. A draft in this list means someone is
  // mid-release, and offering its tag would 404 at the download.
  const visible = releases.filter((release) => !release.draft);
  return visible[0]?.tag_name ?? '';
}

/**
 * Whether `candidate` is newer than `current`, by semver with prereleases.
 *
 * The updater already compares versions for the stable channel, but stable only
 * ever sees `1.2.3` shapes. Beta introduces `1.0.0-beta.2`, where the rules are
 * less obvious and getting them wrong is user-visible in both directions: a
 * beta user offered a downgrade, or held back from the stable release their
 * prerelease was leading up to.
 *
 * Two rules from semver §11 carry all of it:
 *
 *   - a version *with* a prerelease part is **older** than the same version
 *     without one, so 1.0.0-beta.2 < 1.0.0
 *   - prerelease identifiers compare left to right, numeric ones numerically,
 *     so beta.2 < beta.10 — which a string compare gets backwards
 */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** Negative, zero or positive, like every other comparator. */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = split(a);
  const [bCore, bPre] = split(b);

  for (let i = 0; i < 3; i++) {
    const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  // Equal cores. A release beats its own prereleases.
  if (aPre === null && bPre === null) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;

  const aParts = aPre.split('.');
  const bParts = bPre.split('.');
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const x = aParts[i];
    const y = bParts[i];
    // A shorter set of identifiers is lower, so beta < beta.1.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;

    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    // Numeric identifiers always rank below alphanumeric ones.
    if (xNum && !yNum) return -1;
    if (!xNum && yNum) return 1;
    if (xNum && yNum) return Number(x) - Number(y) < 0 ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function split(version: string): [readonly number[], string | null] {
  // Build metadata (`+sha`) is ignored for precedence, per semver §10.
  const withoutBuild = version.split('+')[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? null : withoutBuild.slice(dash + 1);
  return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre];
}
