/**
 * The pure half of `github.ts` — turning `gh pr view --json` into a summary,
 * and turning a `gh` failure into the one word the popover renders.
 *
 * Fixtures mirror real output from `gh` 2.97. The two interesting shapes are
 * both about `statusCheckRollup`, which is not a uniform array: GitHub Actions
 * contribute `CheckRun` nodes carrying `status` plus `conclusion`, and the older
 * commit-status API contributes `StatusContext` nodes carrying `state`. A
 * repository can have either, and a pull request can have both at once.
 *
 * The rollup is asserted pessimistic throughout, which is the decision worth
 * pinning: one red check is the fact a reader needs, and a rollup that averaged
 * its way to green is how a broken build gets merged.
 */

import { describe, expect, it } from 'vitest';

import { parsePullRequestView, problemFrom } from './github';

const REF = { owner: 'Rx-Ventures', repo: 'artemis', number: 141 };

function view(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'OPEN',
    title: 'Delegated work splits live from finished',
    author: { login: 'seth-torrence' },
    additions: 128,
    deletions: 34,
    changedFiles: 6,
    isDraft: false,
    statusCheckRollup: [],
    ...over,
  });
}

/** A GitHub Actions check run, as `gh` reports one. */
function run(conclusion: string, status = 'COMPLETED'): Record<string, unknown> {
  return { __typename: 'CheckRun', name: 'build', status, conclusion };
}

/** An old-style commit status, which carries `state` and no `status`. */
function context(state: string): Record<string, unknown> {
  return { __typename: 'StatusContext', context: 'ci/legacy', state };
}

describe('parsePullRequestView', () => {
  it('reads a whole pull request', () => {
    expect(parsePullRequestView(REF, view())).toEqual({
      owner: 'Rx-Ventures',
      repo: 'artemis',
      number: 141,
      state: 'open',
      title: 'Delegated work splits live from finished',
      author: 'seth-torrence',
      additions: 128,
      deletions: 34,
      changedFiles: 6,
      checks: 'none',
    });
  });

  it('folds isDraft into the state, but only while it is open', () => {
    expect(parsePullRequestView(REF, view({ isDraft: true }))?.state).toBe('draft');
    expect(parsePullRequestView(REF, view({ state: 'MERGED' }))?.state).toBe('merged');
    expect(parsePullRequestView(REF, view({ state: 'CLOSED' }))?.state).toBe('closed');
    // A merged PR that was once a draft is merged. Reporting it as a draft
    // because the flag lingered is the one reading nobody could explain.
    expect(parsePullRequestView(REF, view({ state: 'MERGED', isDraft: true }))?.state).toBe('merged');
  });

  it('survives an author whose account is gone', () => {
    expect(parsePullRequestView(REF, view({ author: null }))?.author).toBeNull();
    expect(parsePullRequestView(REF, view({ author: {} }))?.author).toBeNull();
  });

  it('refuses anything that is not a JSON object', () => {
    expect(parsePullRequestView(REF, '')).toBeNull();
    expect(parsePullRequestView(REF, 'not json')).toBeNull();
    expect(parsePullRequestView(REF, '[]')).toBeNull();
    expect(parsePullRequestView(REF, 'null')).toBeNull();
  });

  it('does not trust the numbers', () => {
    // A `gh` that changed a field's type must not put `undefined` through a
    // template string in the middle of a transcript render.
    const odd = parsePullRequestView(REF, view({ additions: null, deletions: 'x', changedFiles: -4 }));
    expect(odd?.additions).toBe(0);
    expect(odd?.deletions).toBe(0);
    expect(odd?.changedFiles).toBe(0);
  });

  it('does not trust the strings', () => {
    expect(parsePullRequestView(REF, view({ title: 42 }))?.title).toBe('');
    // An unrecognised state is open rather than a crash: it is the state a live
    // pull request is in, and the popover has something true to draw.
    expect(parsePullRequestView(REF, view({ state: 'SOMETHING_NEW' }))?.state).toBe('open');
  });
});

describe('the checks rollup', () => {
  const checksOf = (rollup: unknown): string | undefined =>
    parsePullRequestView(REF, view({ statusCheckRollup: rollup }))?.checks;

  it('is none when there are no checks', () => {
    expect(checksOf([])).toBe('none');
    expect(checksOf(null)).toBe('none');
    expect(checksOf(undefined)).toBe('none');
  });

  it('is passing when everything succeeded', () => {
    expect(checksOf([run('SUCCESS'), run('SUCCESS')])).toBe('passing');
    expect(checksOf([context('SUCCESS')])).toBe('passing');
  });

  it('is failing when anything failed, however much else passed', () => {
    expect(checksOf([run('SUCCESS'), run('SUCCESS'), run('FAILURE')])).toBe('failing');
    expect(checksOf([run('SUCCESS'), run('TIMED_OUT')])).toBe('failing');
    expect(checksOf([run('SUCCESS'), run('CANCELLED')])).toBe('failing');
    expect(checksOf([context('SUCCESS'), context('ERROR')])).toBe('failing');
  });

  it('prefers failing over pending', () => {
    // Both are true; only one of them is the reason to go and look.
    expect(checksOf([run('', 'IN_PROGRESS'), run('FAILURE')])).toBe('failing');
  });

  it('is pending while anything is still running', () => {
    expect(checksOf([run('SUCCESS'), run('', 'IN_PROGRESS')])).toBe('pending');
    expect(checksOf([run('SUCCESS'), run('', 'QUEUED')])).toBe('pending');
    expect(checksOf([context('PENDING')])).toBe('pending');
  });

  it('reads both node shapes in one rollup', () => {
    // A repository with Actions and a legacy status reporter. Neither shape may
    // be dropped, because either can be the one that is red.
    expect(checksOf([run('SUCCESS'), context('FAILURE')])).toBe('failing');
    expect(checksOf([run('FAILURE'), context('SUCCESS')])).toBe('failing');
  });

  it('treats neutral and skipped as neither', () => {
    // Not failures, and not achievements. A PR whose only checks were skipped
    // reads as having none rather than as passing.
    expect(checksOf([run('SKIPPED'), run('NEUTRAL')])).toBe('none');
    expect(checksOf([run('SUCCESS'), run('SKIPPED')])).toBe('passing');
  });

  it('ignores entries it cannot read', () => {
    expect(checksOf([null, 'nonsense', 42, run('SUCCESS')])).toBe('passing');
    expect(checksOf([{}])).toBe('none');
  });
});

describe('problemFrom', () => {
  it('recognises a signed-out CLI', () => {
    expect(problemFrom({ stderr: 'gh: To get started with GitHub CLI, please run: gh auth login' })).toBe(
      'not-signed-in',
    );
    expect(problemFrom({ stderr: 'error: not logged into any GitHub hosts' })).toBe('not-signed-in');
  });

  it('recognises a pull request nobody can see', () => {
    expect(problemFrom({ stderr: 'could not resolve to a PullRequest with the number of 9999' })).toBe(
      'not-found',
    );
    expect(problemFrom({ stderr: 'GraphQL: Could not resolve to a Repository (repository)' })).toBe(
      'not-found',
    );
  });

  it('falls back to a generic failure', () => {
    // The default matters more than the branches: this is string-matching a
    // CLI's stderr, and a `gh` that rewords its errors must degrade to the
    // generic message rather than to a confident wrong one.
    expect(problemFrom({ stderr: 'dial tcp: lookup api.github.com: no such host' })).toBe('failed');
    expect(problemFrom(new Error('spawn failed'))).toBe('failed');
    expect(problemFrom({})).toBe('failed');
    expect(problemFrom(null)).toBe('failed');
  });
});
