/**
 * GitHub pull requests, as far as a transcript needs to know about them.
 * ============================================================================
 *
 * An agent that opens a PR says so by pasting its URL, and from that moment the
 * most useful thing on screen is a link that answers nothing. Did it merge? Are
 * the checks green? How big is it? Every one of those costs a trip to a browser,
 * and the answer is a two-second `gh` call away.
 *
 * ## Why this is a URL parser and not a GitHub client
 *
 * The renderer sees text. What it can do — the only thing it can do — is decide
 * whether a link is *shaped* like a pull request and hand the pieces to someone
 * who can ask. That is exactly the split `filePaths.ts` and `fileReach.ts` make
 * for file paths, and it is made here for the same reason: shape is decidable
 * from a string, existence is not.
 *
 * So this module holds the shape half, and it is pure. {@link parsePullRequestUrl}
 * is the whole of it, plus the vocabulary a reading comes back in.
 *
 * ## Where the credential is
 *
 * Nowhere in Artemis, which is the same answer the README gives for provider
 * accounts and is not a coincidence. The reading is taken by shelling out to the
 * user's own `gh`, which holds its own auth in its own place. Artemis stores no
 * token, offers no field to paste one into, and cannot see the one `gh` has.
 *
 * The cost is that this feature is only as available as `gh` is: no CLI, or a
 * CLI that has never been logged in, and a PR link stays exactly the link it was
 * before. That is the right way round — a degraded link is a working link, and
 * the alternative is a credential store this project deliberately does not have.
 */

/* -------------------------------------------------------------------------- */
/* What a link points at                                                      */
/* -------------------------------------------------------------------------- */

/** One pull request, named the way `gh` names one. */
export interface PullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * A stable string for one ref, for use as a cache key.
 *
 * `owner/repo#number`, which is how a person writes it and how `gh` prints it,
 * so a key that turns up in a log is readable rather than an opaque hash.
 */
export function pullRequestKey(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`;
}

/**
 * A pull request URL, in one anchored pattern.
 *
 * A regular expression rather than `new URL()`, and not for taste: this package
 * compiles with `"lib": ["ES2023"]` and `"types": []` — no DOM, no Node — because
 * it is the one thing both the renderer and the main process import, and it must
 * not assume either environment. `URL` is a global in both and a type in
 * neither.
 *
 * Anchored at `^`, which is the part doing the security work. An unanchored
 * pattern matches `https://evil.example/https://github.com/o/r/pull/1` and hands
 * back a ref that would send `gh` at a repository the link never named.
 *
 * The character classes are GitHub's own: owners are alphanumeric and hyphen,
 * repositories additionally allow `.` and `_`, and neither may begin with a
 * hyphen — an argument starting with `-` is an option rather than a value to
 * every CLI ever written. `validate.ts` applies the same classes again on the
 * other side of the IPC boundary, which is not redundancy: this copy decides
 * whether to draw a link, in the process that is untrusted by construction, and
 * that one is the gate.
 *
 * The number is `[1-9][0-9]*`, so `pull/0` and `pull/007` are not pull requests.
 * GitHub resolves neither, and normalising them would make this parser cleverer
 * than the site it describes.
 *
 * The tail is `[/?#]` or end-of-string, which accepts the sub-pages a person is
 * as likely to have copied — `/files`, `/commits` — while refusing `pull/12abc`.
 * Scheme and host are matched lowercase because that is what a browser puts on
 * the clipboard and what GitHub itself emits.
 */
const PULL_REQUEST_URL =
  /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/pull\/([1-9][0-9]*)(?:[/?#]|$)/;

/**
 * The pull request a URL points at, or `null` for every other link.
 *
 * Accepts exactly what GitHub itself serves at a PR: the canonical
 * `https://github.com/<owner>/<repo>/pull/<number>`, and the sub-pages a person
 * is just as likely to have copied out of their address bar — `/files`,
 * `/commits`, and the rest — since those describe the same pull request and
 * refusing them would mean the popover appearing or not depending on which tab
 * the link was copied from.
 *
 * Refused, deliberately:
 *
 *  - **`http`.** A PR link that is not `https` did not come from GitHub's own
 *    UI, and the reading would be taken over a channel nobody chose.
 *  - **Any host but `github.com`.** Enterprise installs serve pull requests at
 *    their own hostnames and `gh` can reach them, but a host allow-list is a
 *    decision about which server Artemis contacts on the strength of text an
 *    agent produced. One host, named here.
 *  - **`/pulls`, `/pull/` with no number, a non-integer, a leading zero.**
 *    `pull/007` is not a pull request GitHub will resolve, and normalising it to
 *    `7` would make this parser cleverer than the site it describes.
 *
 * Everything about the answer is a fact about the *string*. Whether the pull
 * request exists, and whether this machine may see it, is the reading's business
 * and not this function's — same rule, and same failure direction, as
 * `parseFileReference`: where it is unsure, no link.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const match = PULL_REQUEST_URL.exec(url);
  if (match === null) return null;

  const [, owner, repo, digits] = match;
  if (owner === undefined || repo === undefined || digits === undefined) return null;

  const number = Number.parseInt(digits, 10);
  // A pull request number past 2^53 is not one GitHub has ever issued, but the
  // pattern above permits any run of digits and an unsafe integer would go on to
  // be stringified back into an argument as `1e+21`.
  if (!Number.isSafeInteger(number)) return null;

  return { owner, repo, number };
}

/* -------------------------------------------------------------------------- */
/* What came back                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where a pull request stands.
 *
 * `draft` is a fourth state beside GitHub's three rather than a flag on `open`,
 * because it is the distinction a reader most wants from a glance: an open PR is
 * asking for review and a draft is not, and collapsing them loses the only part
 * of "open" that changes what you would do about it.
 */
export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

/**
 * What CI says, rolled up to the one word worth showing.
 *
 * `none` is not a failure — a repository with no checks configured is the
 * ordinary case for most of them, and rendering that as a grey nothing is
 * honest where a green tick would be a claim nobody made.
 *
 * The rollup is deliberately pessimistic in the same direction the plan meter
 * is: any failure makes the whole thing `failing`, because one red check is the
 * fact you need, and an "8 of 9 passed" that reads as mostly-green is how a
 * broken build gets merged.
 */
export type PullRequestChecks = 'passing' | 'failing' | 'pending' | 'none';

/** One pull request, as a popover renders it. */
export interface PullRequestSummary {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly state: PullRequestState;
  readonly title: string;
  /** Login of whoever opened it, or `null` when the account is gone. */
  readonly author: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly checks: PullRequestChecks;
}

/**
 * Why there is no summary for a ref.
 *
 * A closed set rather than a message, because the renderer says something
 * different for each and a string it had to pattern-match would be a contract
 * nobody wrote down:
 *
 *  - `no-cli`      — `gh` is not on `PATH`. Offer the install line.
 *  - `not-signed-in` — `gh` is there and has no credential for this host.
 *  - `not-found`   — no such pull request, or this account cannot see it. The
 *                    two are indistinguishable from outside and GitHub means
 *                    them to be: a 404 on a private repository is how it avoids
 *                    confirming that the repository exists.
 *  - `failed`      — anything else. A network that is down, a rate limit, a `gh`
 *                    that changed its output.
 */
export type PullRequestProblem = 'no-cli' | 'not-signed-in' | 'not-found' | 'failed';

/** One ref's answer: a reading, or why there is not one. */
export interface PullRequestResult {
  readonly key: string;
  readonly summary?: PullRequestSummary;
  readonly problem?: PullRequestProblem;
}
