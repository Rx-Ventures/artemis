/**
 * Semver precedence, and the two rules that make a beta channel behave.
 *
 * The stable channel only ever compares `1.2.3` shapes, so the app has never
 * needed prerelease ordering before. Getting it wrong is user-visible in both
 * directions: offer a beta user a downgrade, or strand them on a prerelease
 * while the release it led up to ships without them.
 */

import { describe, expect, it } from 'vitest';

import { compareVersions, isNewer, tagForChannel } from './updateChannel';

describe('compareVersions', () => {
  it('orders by core version first', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('ranks a release above its own prereleases', () => {
    // semver §11: 1.0.0-beta.2 < 1.0.0. This is the rule that lets a beta user
    // move on to the stable release rather than being held on the prerelease.
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
  });

  it('compares prerelease numbers numerically, not as strings', () => {
    // A string compare puts beta.10 before beta.2, which would offer a
    // downgrade to everyone past the ninth beta.
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.9', '1.0.0-beta.10')).toBeLessThan(0);
  });

  it('ranks fewer identifiers below more', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0);
  });

  it('ranks numeric identifiers below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+abc', '1.0.0+def')).toBe(0);
    expect(compareVersions('1.0.0-beta.1+abc', '1.0.0-beta.1')).toBe(0);
  });

  it('orders a realistic beta run', () => {
    const run = ['1.0.0-beta.2', '1.0.0', '1.0.0-beta.10', '0.20.0', '1.0.0-beta.1'];
    expect([...run].sort(compareVersions)).toEqual([
      '0.20.0',
      '1.0.0-beta.1',
      '1.0.0-beta.2',
      '1.0.0-beta.10',
      '1.0.0',
    ]);
  });
});

describe('isNewer', () => {
  it('does not offer what is already installed', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0-beta.1', '1.0.0-beta.1')).toBe(false);
  });

  it('offers the stable release to someone on its beta', () => {
    expect(isNewer('1.0.0', '1.0.0-beta.3')).toBe(true);
  });

  it('does not offer a beta to someone already on the release', () => {
    expect(isNewer('1.0.0-beta.3', '1.0.0')).toBe(false);
  });
});

describe('tagForChannel', () => {
  const release = (tag: string, prerelease = false, draft = false) => ({
    tag_name: tag,
    prerelease,
    draft,
  });

  it('asks for no tag on stable, which is the /releases/latest path', () => {
    // Stable deliberately makes no API call: GitHub's own "latest" already
    // excludes prereleases, so the channel needs no filtering of its own.
    expect(tagForChannel('stable', [release('v1.0.0-beta.1', true)])).toBe('');
  });

  it('takes the newest release on beta, prerelease or not', () => {
    expect(
      tagForChannel('beta', [release('v1.1.0-beta.1', true), release('v1.0.0')]),
    ).toBe('v1.1.0-beta.1');
    // Beta means earlier, not a separate product: once the stable release is
    // newest, that is what a beta user should be offered.
    expect(
      tagForChannel('beta', [release('v1.1.0'), release('v1.1.0-beta.1', true)]),
    ).toBe('v1.1.0');
  });

  it('skips drafts, which nobody can download', () => {
    expect(
      tagForChannel('beta', [release('v1.2.0', false, true), release('v1.1.0')]),
    ).toBe('v1.1.0');
  });

  it('falls back to the latest path when there is nothing to choose', () => {
    expect(tagForChannel('beta', [])).toBe('');
  });
});
