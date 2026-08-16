/**
 * What counts as a pull request link.
 *
 * `parsePullRequestUrl` is the front door of the whole feature: whatever it
 * accepts becomes an `owner` and a `repo` on their way to being arguments to a
 * `gh` subprocess, and the URLs it reads come from text an *agent* wrote. So the
 * refusals matter more than the acceptances, and most of this file is refusals.
 *
 * The acceptances are here for a duller reason that is just as real: a popover
 * that appears on the canonical URL and not on the `/files` one — the two a
 * person is equally likely to have copied — reads as broken rather than as
 * careful.
 */

import { describe, expect, it } from 'vitest';

import { parsePullRequestUrl, pullRequestKey } from './github.js';

describe('parsePullRequestUrl', () => {
  it('reads the canonical form', () => {
    expect(parsePullRequestUrl('https://github.com/Rx-Ventures/artemis/pull/141')).toEqual({
      owner: 'Rx-Ventures',
      repo: 'artemis',
      number: 141,
    });
  });

  it('reads the sub-pages someone is as likely to have copied', () => {
    // Same pull request, different tab. Refusing these would make the popover
    // appear or not depending on where the link came from.
    for (const tail of ['/files', '/commits', '/checks', '/files#diff-abc', '?w=1', '#issuecomment-1']) {
      expect(parsePullRequestUrl(`https://github.com/o/r/pull/7${tail}`)).toEqual({
        owner: 'o',
        repo: 'r',
        number: 7,
      });
    }
  });

  it('accepts the dots, underscores and hyphens a repository name may carry', () => {
    expect(parsePullRequestUrl('https://github.com/my-org/my.repo_name/pull/2')).toEqual({
      owner: 'my-org',
      repo: 'my.repo_name',
      number: 2,
    });
  });

  it('accepts www', () => {
    expect(parsePullRequestUrl('https://www.github.com/o/r/pull/3')?.number).toBe(3);
  });

  it('refuses a host that merely contains the real one', () => {
    // The reason the pattern is anchored. Unanchored, this hands back
    // `{o, r, 1}` and sends `gh` at a repository the link never named.
    expect(parsePullRequestUrl('https://evil.example/https://github.com/o/r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('https://github.com.evil.example/o/r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('https://notgithub.com/o/r/pull/1')).toBeNull();
  });

  it('refuses anything but https', () => {
    expect(parsePullRequestUrl('http://github.com/o/r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('javascript:alert(1)//github.com/o/r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('file:///github.com/o/r/pull/1')).toBeNull();
  });

  it('refuses an owner or repo that could not be one', () => {
    // A leading hyphen is the interesting one: as an argument it is an option
    // rather than a value.
    expect(parsePullRequestUrl('https://github.com/-o/r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/-r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('https://github.com//r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o u/r/pull/1')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r;rm -rf ~/pull/1')).toBeNull();
    // `.` is legal in a repository and not as a whole path segment, but the
    // pattern cannot see path semantics — what stops this is that traversal
    // never reaches a subprocess: it would be a repo literally named "..".
    expect(parsePullRequestUrl('https://github.com/o/r/pull/1/../../pull/2')).toEqual({
      owner: 'o',
      repo: 'r',
      number: 1,
    });
  });

  it('refuses numbers GitHub would not resolve', () => {
    expect(parsePullRequestUrl('https://github.com/o/r/pull/0')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/pull/007')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/pull/12abc')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/pull/1e3')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/pull/')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/pull')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/pull/-1')).toBeNull();
  });

  it('refuses a number past what a JS integer holds exactly', () => {
    // The pattern permits any run of digits; an unsafe integer would be
    // stringified back into an argument as `1e+21`.
    expect(parsePullRequestUrl(`https://github.com/o/r/pull/${'9'.repeat(30)}`)).toBeNull();
  });

  it('refuses every other GitHub page', () => {
    expect(parsePullRequestUrl('https://github.com/o/r/issues/1')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/pulls')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/o/r/blob/main/pull/1')).toBeNull();
  });

  it('refuses what is not a URL at all', () => {
    expect(parsePullRequestUrl('')).toBeNull();
    expect(parsePullRequestUrl('#anchor')).toBeNull();
    expect(parsePullRequestUrl('/relative/pull/1')).toBeNull();
    expect(parsePullRequestUrl('github.com/o/r/pull/1')).toBeNull();
  });
});

describe('pullRequestKey', () => {
  it('is the way a person writes one', () => {
    expect(pullRequestKey({ owner: 'Rx-Ventures', repo: 'artemis', number: 141 })).toBe(
      'Rx-Ventures/artemis#141',
    );
  });

  it('separates two repositories that share a number', () => {
    const a = pullRequestKey({ owner: 'o', repo: 'one', number: 1 });
    const b = pullRequestKey({ owner: 'o', repo: 'two', number: 1 });
    expect(a).not.toBe(b);
  });
});
