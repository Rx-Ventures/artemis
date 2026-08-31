import { describe, expect, it } from 'vitest';

import { decideOffer, isNewerVersion, parseUpdateFeed } from './updateFeed';

/** Verbatim shape of what electron-builder published for v0.1.0. */
const REAL_FEED = `version: 0.1.0
files:
  - url: Artemis-0.1.0-arm64-mac.zip
    sha512: Sj+Lvs7AJgDuOyY3zOPtZwXwcixRcMrocnGzqyTUzVncfmhp7SrvOKHH68XDYgdd0TMWNiTuTFrhNW/CRYk6sQ==
    size: 194634891
  - url: Artemis-0.1.0-arm64.dmg
    sha512: GJXN9R++1kYh1CY2BHukxi3DAaKdueDa9Nd3/f91ToFkXJJftQwv+TusCYnzDzggK3T4VzOd8rp5tuD9h6JnJQ==
    size: 201104523
path: Artemis-0.1.0-arm64-mac.zip
sha512: Sj+Lvs7AJgDuOyY3zOPtZwXwcixRcMrocnGzqyTUzVncfmhp7SrvOKHH68XDYgdd0TMWNiTuTFrhNW/CRYk6sQ==
releaseDate: '2026-08-11T09:24:38.108Z'
`;

describe('parseUpdateFeed', () => {
  it('reads version, artifact path and sha512 from a real feed', () => {
    expect(parseUpdateFeed(REAL_FEED)).toEqual({
      version: '0.1.0',
      artifactPath: 'Artemis-0.1.0-arm64-mac.zip',
      sha512:
        'Sj+Lvs7AJgDuOyY3zOPtZwXwcixRcMrocnGzqyTUzVncfmhp7SrvOKHH68XDYgdd0TMWNiTuTFrhNW/CRYk6sQ==',
    });
  });

  it('takes the top-level sha512, not one nested under files', () => {
    // The dmg's sha512 sits two lines above the top-level one; a parser that
    // matched by substring instead of by line position would grab it.
    const parsed = parseUpdateFeed(REAL_FEED);
    expect(parsed?.sha512.startsWith('Sj+')).toBe(true);
  });

  it('unquotes a quoted value', () => {
    const parsed = parseUpdateFeed(`version: '1.2.3'\npath: a.zip\nsha512: abc\n`);
    expect(parsed?.version).toBe('1.2.3');
  });

  it('returns null when any field is missing', () => {
    expect(parseUpdateFeed('version: 0.2.0\npath: a.zip\n')).toBeNull();
    expect(parseUpdateFeed('')).toBeNull();
  });

  it('returns null when the top-level path is not the extension asked for', () => {
    expect(parseUpdateFeed('version: 0.2.0\npath: a.dmg\nsha512: abc\n')).toBeNull();
  });

  /*
   * The Windows feed is `latest.yml` and names a setup exe. Reading it with the
   * default `.zip` must refuse it, and reading it with `.exe` must accept it —
   * the two halves of "a feed for someone else's platform is the same answer as
   * no feed at all".
   */
  it('reads a Windows feed when asked for an exe, and refuses it otherwise', () => {
    const windows = 'version: 2.2.0\npath: Artemis-2.2.0-x64-setup.exe\nsha512: abc\n';
    expect(parseUpdateFeed(windows)).toBeNull();
    expect(parseUpdateFeed(windows, '.exe')).toEqual({
      version: '2.2.0',
      artifactPath: 'Artemis-2.2.0-x64-setup.exe',
      sha512: 'abc',
    });
    // And the mac feed is refused by a Windows build, for the same reason.
    expect(parseUpdateFeed(REAL_FEED, '.exe')).toBeNull();
  });

  it('matches the extension case-insensitively', () => {
    const shouted = 'version: 2.2.0\npath: Artemis-2.2.0-x64-Setup.EXE\nsha512: abc\n';
    expect(parseUpdateFeed(shouted, '.exe')?.artifactPath).toBe('Artemis-2.2.0-x64-Setup.EXE');
  });
});

describe('isNewerVersion', () => {
  it('compares numerically, not lexically', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false);
  });

  it('treats equal versions as not newer', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
  });

  it('pads missing segments with zero', () => {
    expect(isNewerVersion('1.0.1', '1.0')).toBe(true);
    expect(isNewerVersion('1.0', '1.0.0')).toBe(false);
  });

  it('tolerates a leading v', () => {
    expect(isNewerVersion('v0.3.0', '0.2.0')).toBe(true);
  });

  it('fails toward silence on garbage', () => {
    expect(isNewerVersion('latest', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.3.0', 'unknown')).toBe(false);
    expect(isNewerVersion('', '0.2.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '')).toBe(false);
  });

  it('understands prereleases, which it used to treat as garbage', () => {
    // This assertion used to read the other way: a prerelease compared as *not
    // newer*, because the parser required every dot-separated part to be an
    // integer and `0-alpha` is not. That conflated two jobs. Deciding what a
    // machine is *shown* belongs to the update channel — GitHub's
    // /releases/latest excludes prereleases, so a stable installation never
    // sees one regardless of what this function says. Deciding what is *newer*
    // belongs here, and 0.3.0-alpha.1 is newer than 0.2.0.
    //
    // Left as it was, a beta build could never update itself: its own version
    // failed to parse, so nothing was ever newer than it.
    expect(isNewerVersion('0.3.0-alpha.1', '0.2.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0-beta.3')).toBe(true);
    expect(isNewerVersion('1.0.0-beta.3', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta.10', '1.0.0-beta.9')).toBe(true);
  });
});

describe('decideOffer', () => {
  it('offers a newer, undismissed version', () => {
    expect(
      decideOffer({ feedVersion: '0.3.0', currentVersion: '0.2.0', dismissedVersion: null }),
    ).toBe('offer');
  });

  it('stays silent on the dismissed version but offers the next one', () => {
    expect(
      decideOffer({ feedVersion: '0.3.0', currentVersion: '0.2.0', dismissedVersion: '0.3.0' }),
    ).toBe('silence');
    expect(
      decideOffer({ feedVersion: '0.4.0', currentVersion: '0.2.0', dismissedVersion: '0.3.0' }),
    ).toBe('offer');
  });

  /*
   * `silence` and `withdraw` are both "say nothing", and the difference between
   * them is what happens to a card that is already up. Every check re-reads the
   * feed now, so a card outlives the check that put it there and the two
   * answers have to be told apart.
   */
  it('withdraws when the feed has nothing newer than what is running', () => {
    // The release was pulled after it was published: a card offering it would
    // 404 at the download, so it is worth taking down.
    expect(
      decideOffer({ feedVersion: '0.2.0', currentVersion: '0.2.0', dismissedVersion: null }),
    ).toBe('withdraw');
    expect(
      decideOffer({ feedVersion: '0.1.0', currentVersion: '0.2.0', dismissedVersion: null }),
    ).toBe('withdraw');
  });

  it('stays silent rather than withdrawing over a version it cannot parse', () => {
    // A feed nobody can read is the same answer as a feed that never arrived,
    // and one malformed release must not take down a good offer.
    expect(
      decideOffer({ feedVersion: 'nightly', currentVersion: '0.2.0', dismissedVersion: null }),
    ).toBe('silence');
  });

  it('does not withdraw over a dismissal', () => {
    // A card can only be up because someone asked for one — a manual check
    // re-offers a dismissed version deliberately — and a decision recorded
    // before that ask must not quietly undo it.
    expect(
      decideOffer({ feedVersion: '0.3.0', currentVersion: '0.2.0', dismissedVersion: '0.3.0' }),
    ).not.toBe('withdraw');
  });
});
