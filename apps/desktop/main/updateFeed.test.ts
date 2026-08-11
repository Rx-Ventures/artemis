import { describe, expect, it } from 'vitest';

import { isNewerVersion, parseUpdateFeed, shouldOffer } from './updateFeed';

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
  it('reads version, zip path and sha512 from a real feed', () => {
    expect(parseUpdateFeed(REAL_FEED)).toEqual({
      version: '0.1.0',
      zipPath: 'Artemis-0.1.0-arm64-mac.zip',
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

  it('returns null when the top-level path is not a zip', () => {
    expect(parseUpdateFeed('version: 0.2.0\npath: a.dmg\nsha512: abc\n')).toBeNull();
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
    expect(isNewerVersion('0.3.0-alpha.1', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.3.0', 'unknown')).toBe(false);
  });
});

describe('shouldOffer', () => {
  it('offers a newer, undismissed version', () => {
    expect(
      shouldOffer({ feedVersion: '0.3.0', currentVersion: '0.2.0', dismissedVersion: null }),
    ).toBe(true);
  });

  it('stays silent on the dismissed version but offers the next one', () => {
    expect(
      shouldOffer({ feedVersion: '0.3.0', currentVersion: '0.2.0', dismissedVersion: '0.3.0' }),
    ).toBe(false);
    expect(
      shouldOffer({ feedVersion: '0.4.0', currentVersion: '0.2.0', dismissedVersion: '0.3.0' }),
    ).toBe(true);
  });

  it('never offers the running version or older', () => {
    expect(
      shouldOffer({ feedVersion: '0.2.0', currentVersion: '0.2.0', dismissedVersion: null }),
    ).toBe(false);
    expect(
      shouldOffer({ feedVersion: '0.1.0', currentVersion: '0.2.0', dismissedVersion: null }),
    ).toBe(false);
  });
});
