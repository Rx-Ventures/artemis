/**
 * Reading where a pull request stands, through the user's own `gh`.
 * ============================================================================
 *
 * An agent that opens a PR pastes its URL, and the link answers nothing. This is
 * what turns it into a reading: state, checks, and the size of the diff.
 *
 * ## The credential is `gh`'s, and Artemis never sees it
 *
 * The same arrangement the README describes for provider logins, for the same
 * reason. Artemis has no GitHub token, no field to paste one into, and no way to
 * read the one `gh` keeps. It composes an argument vector and reads stdout.
 *
 * The consequence is that the feature is exactly as available as `gh` is, and
 * that is the intended trade: no CLI, or a CLI nobody has signed in, and a PR
 * link stays the link it already was. The alternative is a credential store this
 * project deliberately does not have.
 *
 * ## Why `execFile` and never a shell
 *
 * `owner` and `repo` arrive from the renderer, which means they arrive from text
 * an *agent* produced, which means an injected instruction can choose them.
 * `execFile` with an argument vector has no shell to metacharacter its way out
 * of, and {@link parsePullRequestUrl}'s character classes are re-checked by the
 * validator before anything gets here. Two independent reasons a crafted repo
 * name cannot become a command; either alone would do.
 *
 * `--` is passed before the number for the ordinary CLI reason, and the repo is
 * passed as `--repo owner/name` rather than by making `gh` guess from a working
 * directory — there is no working directory here that means anything, and one
 * inferred from whichever pane happened to ask would read a different repository
 * than the link names.
 *
 * ## Serial, cached, and bounded
 *
 * Each reading spawns a process, so a screenful of PR links must not become a
 * screenful of subprocesses. Three things stop that:
 *
 *  - **A cache**, with separate lifetimes for a settled PR and a live one — see
 *    {@link ttlFor}. A merged pull request does not become unmerged, and asking
 *    again is a subprocess spent confirming something that cannot change.
 *  - **A serial queue.** The batch is walked one at a time, the same rule
 *    `planUsagePoll` keeps and for the same reason.
 *  - **A cap** on the batch, enforced by the validator.
 *
 * ## `gh` is probed once, and re-probed when it fails
 *
 * `no-cli` is sticky enough to avoid a spawn per link on a machine without `gh`,
 * and not so sticky that installing it mid-session leaves the feature dead until
 * a restart. See {@link cliMissingUntil}.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  PullRequestChecks,
  PullRequestProblem,
  PullRequestRef,
  PullRequestResult,
  PullRequestState,
  PullRequestSummary,
} from '@rx-artemis/protocol';
import { pullRequestKey } from '@rx-artemis/protocol';

import { createLogger } from './log.js';

const log = createLogger('github');
const execFileAsync = promisify(execFile);

/** How long one `gh` call may take before it is abandoned. */
const TIMEOUT_MS = 15_000;

/**
 * Most stdout `gh` may produce for one pull request.
 *
 * A bound on a hostile or broken answer rather than on a plausible one: the
 * fields asked for below are a few hundred bytes, and `statusCheckRollup` on a
 * repository with a hundred checks is still tens of kilobytes. A megabyte is far
 * past any of that and well short of anything that would trouble the heap.
 */
const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * How long a reading is trusted for, by what it says.
 *
 * A **settled** pull request — merged or closed — is cached for an hour. Neither
 * state comes back, so a re-read is a subprocess spent learning nothing. The
 * hour rather than forever is for the one case that does move: a closed PR can
 * be reopened, and an hour is short enough that nobody is looking at a stale
 * badge for a working day.
 *
 * A **live** one is cached for a minute, which is about how long it takes to
 * notice a check went green and hover the link again.
 */
function ttlFor(state: PullRequestState): number {
  return state === 'merged' || state === 'closed' ? 60 * 60_000 : 60_000;
}

/** How long a problem is trusted for. Short — every one of them is fixable. */
const PROBLEM_TTL_MS = 30_000;

/**
 * How long a missing `gh` is believed.
 *
 * Longer than {@link PROBLEM_TTL_MS} because the answer costs a spawn *per link*
 * to re-establish and is the same for all of them, and short enough that
 * `brew install gh` takes effect without a restart.
 */
const NO_CLI_TTL_MS = 5 * 60_000;

interface Entry {
  readonly result: PullRequestResult;
  readonly until: number;
}

const cache = new Map<string, Entry>();

/** When the `gh`-is-missing verdict expires. Zero means "ask". */
let cliMissingUntil = 0;

/** Readings run one at a time. See the header. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run) as Promise<T>;
  // Swallowed on the *chain* rather than on the returned promise: a rejection
  // here must not become an unhandled one, and must not stop the next reading.
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/* -------------------------------------------------------------------------- */
/* Reading one                                                                */
/* -------------------------------------------------------------------------- */

/** The fields worth a round trip. Anything not rendered is not asked for. */
const FIELDS = 'state,title,author,additions,deletions,changedFiles,isDraft,statusCheckRollup';

/**
 * What `gh pr view --json` gives back, as far as this file trusts it.
 *
 * Every field optional and every one re-checked below. This is a subprocess's
 * stdout, not a typed call: a `gh` a version ahead may rename a field, and a
 * cast would turn that into `undefined.toLowerCase()` in the middle of a
 * transcript render.
 */
interface RawPullRequest {
  readonly state?: unknown;
  readonly title?: unknown;
  readonly author?: { readonly login?: unknown } | null;
  readonly additions?: unknown;
  readonly deletions?: unknown;
  readonly changedFiles?: unknown;
  readonly isDraft?: unknown;
  readonly statusCheckRollup?: unknown;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * The one word CI gets.
 *
 * `gh` reports a heterogeneous array: check runs carry `status`/`conclusion`,
 * while the older commit statuses carry `state`. Both are read, because a
 * repository can have either and a PR can have both.
 *
 * Pessimistic by construction — any failure wins, then any pending, then
 * passing. One red check is the fact you need, and a rollup that averaged its
 * way to green is how a broken build gets merged.
 */
function rollUpChecks(value: unknown): PullRequestChecks {
  if (!Array.isArray(value) || value.length === 0) return 'none';

  let sawPending = false;
  let sawPassing = false;

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const node = entry as Record<string, unknown>;

    // A check run that has not finished has no conclusion yet. A commit status
    // says `PENDING` in `state`. Both mean the same thing here.
    const status = typeof node['status'] === 'string' ? node['status'].toUpperCase() : null;
    if (status !== null && status !== 'COMPLETED') {
      sawPending = true;
      continue;
    }

    const verdict =
      typeof node['conclusion'] === 'string'
        ? node['conclusion'].toUpperCase()
        : typeof node['state'] === 'string'
          ? node['state'].toUpperCase()
          : null;
    if (verdict === null) continue;

    switch (verdict) {
      case 'SUCCESS':
        sawPassing = true;
        break;
      // Neutral and skipped are not failures and are not achievements. They are
      // ignored so that a PR whose only checks were skipped reads as `none`
      // rather than as passing.
      case 'NEUTRAL':
      case 'SKIPPED':
        break;
      case 'PENDING':
      case 'EXPECTED':
      case 'QUEUED':
      case 'IN_PROGRESS':
      case 'WAITING':
        sawPending = true;
        break;
      default:
        // FAILURE, ERROR, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE
        return 'failing';
    }
  }

  if (sawPending) return 'pending';
  return sawPassing ? 'passing' : 'none';
}

/**
 * `state` and `isDraft` folded into the four states a reader cares about.
 *
 * `gh` reports `OPEN`/`CLOSED`/`MERGED` in `state` and drafts as `OPEN` with
 * `isDraft: true`, so the flag is consulted only on an open one — a merged pull
 * request that was once a draft is merged, and reporting it as a draft because
 * the field lingered would be the one reading nobody could explain.
 */
function toState(raw: unknown, isDraft: unknown): PullRequestState {
  const state = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return isDraft === true ? 'draft' : 'open';
}

/**
 * One `gh pr view --json` document, as a summary.
 *
 * Exported and pure so it can be tested against fixtures of real `gh` output,
 * which is the arrangement `cerebro.ts` uses for the same reason: the mapping is
 * where the judgement lives, and the subprocess around it is not worth mocking
 * to exercise it.
 *
 * `null` for anything that is not a JSON object — a `gh` that printed a warning,
 * an empty stdout, a version that changed its mind about the shape. Every field
 * inside is re-checked rather than cast, because this is a subprocess's stdout
 * and not a typed call.
 */
export function parsePullRequestView(ref: PullRequestRef, stdout: string): PullRequestSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return toSummary(ref, parsed as RawPullRequest);
}

function toSummary(ref: PullRequestRef, raw: RawPullRequest): PullRequestSummary {
  const login = raw.author?.login;
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    state: toState(raw.state, raw.isDraft),
    title: typeof raw.title === 'string' ? raw.title : '',
    author: typeof login === 'string' && login.length > 0 ? login : null,
    additions: asCount(raw.additions),
    deletions: asCount(raw.deletions),
    changedFiles: asCount(raw.changedFiles),
    checks: rollUpChecks(raw.statusCheckRollup),
  };
}

/**
 * Read `gh`'s complaint and decide which problem it is.
 *
 * String matching on a CLI's stderr, which is a contract nobody signed — so the
 * default is `failed` and every branch below is an *improvement* on it rather
 * than something the caller depends on. The worst a `gh` that rewords its errors
 * can do is send a signed-out user to the generic message.
 */
export function problemFrom(error: unknown): PullRequestProblem {
  const stderr = String(
    (error as { stderr?: unknown })?.stderr ?? (error as { message?: unknown })?.message ?? '',
  ).toLowerCase();

  if (stderr.includes('not logged') || stderr.includes('authentication') || stderr.includes('gh auth login')) {
    return 'not-signed-in';
  }
  // `gh` says "no pull requests found" / "could not resolve to a PullRequest".
  // A private repository this account cannot see answers the same way, which is
  // GitHub's intent — see `PullRequestProblem`.
  if (stderr.includes('not found') || stderr.includes('could not resolve') || stderr.includes('no pull requests')) {
    return 'not-found';
  }
  return 'failed';
}

/** Is this the "there is no `gh`" failure, as opposed to `gh` failing? */
function isMissingCli(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'ENOENT';
}

async function read(ref: PullRequestRef): Promise<PullRequestResult> {
  const key = pullRequestKey(ref);

  if (Date.now() < cliMissingUntil) return { key, problem: 'no-cli' };

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        String(ref.number),
        '--repo',
        `${ref.owner}/${ref.repo}`,
        '--json',
        FIELDS,
      ],
      {
        timeout: TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        // No inherited stdin: `gh` prompts for auth on a TTY, and a main process
        // waiting on an answer nobody can give is a hang rather than an error.
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      },
    );

    const summary = parsePullRequestView(ref, stdout);
    return summary === null ? { key, problem: 'failed' } : { key, summary };
  } catch (error) {
    if (isMissingCli(error)) {
      cliMissingUntil = Date.now() + NO_CLI_TTL_MS;
      return { key, problem: 'no-cli' };
    }
    const problem = problemFrom(error);
    // Debug rather than error: a link to a PR on a repository this machine
    // cannot see is an ordinary thing for an agent to have written, and a
    // logged error per hover would bury the log for a working feature.
    log.debug(`Could not read ${key}`, error);
    return { key, problem };
  }
}

/* -------------------------------------------------------------------------- */
/* The batch                                                                  */
/* -------------------------------------------------------------------------- */

function cached(key: string): PullRequestResult | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (Date.now() >= entry.until) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function remember(result: PullRequestResult): void {
  const ttl =
    result.summary === undefined
      ? result.problem === 'no-cli'
        ? NO_CLI_TTL_MS
        : PROBLEM_TTL_MS
      : ttlFor(result.summary.state);
  cache.set(result.key, { result, until: Date.now() + ttl });
}

/**
 * Where each of these pull requests stands.
 *
 * One entry per ref, in the order asked. Never throws for a pull request's sake
 * — every way this can fail to answer is itself an answer.
 *
 * Duplicates in one batch are read once: the renderer deduplicates before
 * asking, but the contract should not depend on it having done so.
 */
export async function readPullRequests(
  refs: readonly PullRequestRef[],
): Promise<readonly PullRequestResult[]> {
  const answers = new Map<string, PullRequestResult>();

  for (const ref of refs) {
    const key = pullRequestKey(ref);
    if (answers.has(key)) continue;

    const hit = cached(key);
    if (hit !== null) {
      answers.set(key, hit);
      continue;
    }

    const result = await enqueue(() => read(ref));
    remember(result);
    answers.set(key, result);
  }

  return refs.map((ref) => answers.get(pullRequestKey(ref)) ?? { key: pullRequestKey(ref), problem: 'failed' });
}

/** Forget every reading. For tests, and for nothing else. */
export function resetPullRequestCache(): void {
  cache.clear();
  cliMissingUntil = 0;
  queue = Promise.resolve();
}
