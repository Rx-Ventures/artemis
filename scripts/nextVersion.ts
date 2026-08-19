/**
 * What the next version should be, worked out from what actually changed.
 * ============================================================================
 *
 *   $ pnpm next-version
 *   v0.10.0 → 0.11.0  (minor)
 *     • a new IPC channel: runsStopTask
 *     • new public API in packages/protocol/src/events.ts
 *     • a new surface: apps/desktop/renderer/src/components/TasksPane.tsx
 *
 * Version numbers were being chosen by whoever was cutting the release, from
 * memory, at the end of the work rather than during it — which is exactly when
 * "did anything grow a new surface?" is hardest to answer honestly. This answers
 * it from the diff.
 *
 * ## Why not conventional commits
 *
 * The usual way to do this is `feat:` / `fix:` prefixes, and this repo does not
 * write commit subjects that way — they are sentences about what changed ("The
 * sidebar's projects hold still, and only their rows move"), which is a
 * deliberate and better convention for reading history. So the classification
 * comes from the diff itself, which has the advantage of being the thing that
 * ships rather than a claim about it: a commit message can say `fix:` over a new
 * IPC channel, and a diff cannot.
 *
 * ## What counts as what
 *
 * **Minor** is "something grew or something went away" — a release that adds a
 * surface, or that takes away a gesture people have in their hands. Detected as
 * any of:
 *
 *  - a new channel in protocol's `IPC` map, which is a new thing the renderer
 *    can ask the main process to do;
 *  - a new variant in the `AgentEvent` union, which every exhaustive switch in
 *    the app has to grow a case for;
 *  - a new or removed `export` in a package's source — the published surface of
 *    `@rx-artemis/protocol` and `@rx-artemis/core`;
 *  - a new component or state module in the renderer, which is a surface a
 *    person can see.
 *
 * **Patch** is everything else that touches shipped code. **None** is a release
 * with nothing in it but notes and tests.
 *
 * **Major is never inferred.** At 0.x it would be a statement about the project
 * rather than about a diff, and a tool that talked itself into one would be
 * wrong in the most expensive available direction. Say it explicitly.
 *
 * ## The override, and why it is a trailer
 *
 * A commit carrying `Release: minor` (or `patch`, or `major`) decides the answer
 * for the whole range. Inference proposes; the person who knew what they were
 * doing disposes — and the record of that decision lives in the history rather
 * than in someone's memory of a conversation. The highest level named wins, so
 * one commit cannot quietly talk a release *down*.
 */

import { execFileSync } from 'node:child_process';

/** How much of the version number moves. */
export type Bump = 'major' | 'minor' | 'patch' | 'none';

/** One commit, reduced to what the classification actually reads. */
export interface Change {
  /** The whole commit message, subject and body. */
  readonly message: string;
  /** Paths touched, repo-relative. */
  readonly files: readonly string[];
  /** Added lines, without the leading `+`. Empty when only paths were collected. */
  readonly added: readonly string[];
  /** Removed lines, without the leading `-`. */
  readonly removed: readonly string[];
  /**
   * Files this range *added*, as git reports them.
   *
   * Asked rather than inferred. The first version of this guessed — a file with
   * additions and no removals looked new — and called every file that had merely
   * gained a field a new surface, which is how a one-line addition to a state
   * module ended up arguing for a minor.
   */
  readonly newFiles: readonly string[];
}

export interface Verdict {
  readonly bump: Bump;
  /** Why, in sentences, most significant first. Empty when `bump` is `none`. */
  readonly reasons: readonly string[];
  /** Set when a `Release:` trailer decided it, rather than the diff. */
  readonly declaredBy: string | null;
}

const RANK: Readonly<Record<Bump, number>> = { none: 0, patch: 1, minor: 2, major: 3 };

/** A `Release: <level>` trailer, anywhere in a commit message. */
const DECLARED = /^\s*Release:\s*(major|minor|patch)\s*$/im;

/** A channel added to protocol's `IPC` map: `  runsStopTask: 'artemis:runs:stop-task',` */
const IPC_CHANNEL = /^\s*(\w+):\s*'artemis:[\w:-]+'/;

/** A variant added to the `AgentEvent` union: `  | BackgroundTasksEvent` */
const EVENT_VARIANT = /^\s*\|\s*(\w+Event)\s*$/;

/** A public export in a package's source. */
const EXPORTED = /^export\s+(?:declare\s+)?(?:async\s+)?(function|const|class|interface|type|enum)\s+(\w+)/;

/**
 * Split a `path line` entry back into its two halves.
 *
 * On the *first* space only. A line of source contains plenty of others, and
 * splitting on all of them leaves the classifier matching its patterns against
 * the second word of every line — which reads as "nothing here is public API".
 */
function splitEntry(entry: string): { readonly file: string; readonly text: string } {
  const gap = entry.indexOf(' ');
  if (gap < 0) return { file: entry, text: '' };
  return { file: entry.slice(0, gap), text: entry.slice(gap + 1) };
}

const isTest = (file: string): boolean => /\.test\.[cm]?tsx?$/.test(file);

const isPackageSource = (file: string): boolean =>
  /^packages\/[^/]+\/src\//.test(file) && !isTest(file);

const isRendererSurface = (file: string): boolean =>
  /^apps\/desktop\/renderer\/src\/(components|state)\/[^/]+\.tsx?$/.test(file) && !isTest(file);

/**
 * Does this change ship anything at all?
 *
 * Notes, tests and CI config do not: a release with nothing else in it has
 * nothing for a user to notice, and calling that a patch would put a version
 * number on an empty box.
 */
const isShipped = (file: string): boolean => {
  if (isTest(file)) return false;
  if (file.startsWith('.github/')) return false;
  if (file.endsWith('.md')) return false;
  return true;
};

/**
 * Read a range of commits out of git.
 *
 * `--no-merges`, because a merge commit's diff is the sum of what it brought in
 * and would count every change twice.
 *
 * Two answers are read and cross-checked. `git log --name-only` interleaves
 * each message with the paths that commit touched, and `git diff --name-only`
 * over the whole range says which files the *release* actually contains. The
 * parse needs both: the log's blocks cannot be told apart from message text by
 * their shape (see `parseLog`), and the endpoint list on its own has no
 * messages, so no `Release:` trailer.
 */
export function readChanges(from: string, to = 'HEAD'): readonly Change[] {
  const raw = execFileSync(
    'git',
    // NUL before each message. A commit body can contain any printable
    // sentinel someone invents — this parser's first separator was the literal
    // string ` COMMIT `, which a commit quoting this very file would split on
    // — but git strips NUL out of commit messages, so `%x00` is the one
    // delimiter no message can carry.
    ['log', '--no-merges', '--format=%x00%B', '--name-only', `${from}..${to}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const touched = execFileSync('git', ['diff', '--name-only', `${from}..${to}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.length > 0);
  return parseLog(raw, touched);
}

/**
 * Split `git log --format=%x00%B --name-only` output into one `Change` per
 * commit, counting a line as a file iff git's endpoint diff says that file was
 * touched in the range.
 *
 * Telling paths from message text by *shape* is the mistake this replaces: the
 * old rule ("contains `/`, contains no space") filed every root-level path as
 * prose — so a release that only moved `package.json` and `pnpm-lock.yaml`
 * classified as `none` and release.ts refused to cut it — and filed every
 * message line that happened to look like a path as a file. Git already knows
 * exactly which paths the range touched, so the parse asks it instead of
 * guessing. A file changed and then fully reverted inside the range is absent
 * from the endpoint diff, which is correct twice over: it is not in the
 * release, and it must not argue for a phantom patch.
 */
export function parseLog(raw: string, touched: readonly string[]): readonly Change[] {
  const inRange = new Set(touched);
  const changes: Change[] = [];
  for (const block of raw.split('\0')) {
    if (block.trim().length === 0) continue;
    const files: string[] = [];
    const message: string[] = [];
    for (const line of block.split('\n')) {
      if (inRange.has(line)) files.push(line);
      else message.push(line);
    }
    changes.push({ message: message.join('\n'), files, added: [], removed: [], newFiles: [] });
  }
  return changes;
}

/** The files a range added outright, as git reports them. */
export function readAddedFiles(from: string, to = 'HEAD'): readonly string[] {
  const raw = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', `${from}..${to}`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return raw.split('\n').filter((line) => line.length > 0);
}

/** The added and removed lines for a range, as one bundle. */
export function readDiff(from: string, to = 'HEAD'): { added: string[]; removed: string[] } {
  const raw = execFileSync('git', ['diff', '--unified=0', `${from}..${to}`], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseDiff(raw);
}

/**
 * Attribute a unified diff's added and removed lines to their files.
 *
 * The b-side header names the file — except for a deletion, whose b-side is
 * `+++ /dev/null`. Its removed lines belong to the a-side path; forgetting
 * that assigns them to whichever file the diff happened to print before it,
 * which misclassifies releases in both directions (a deleted package export
 * goes unnoticed, a deleted renderer file reads as one).
 */
export function parseDiff(raw: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  let file = '';
  let aSide = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('--- a/')) {
      aSide = line.slice('--- a/'.length);
      continue;
    }
    if (line.startsWith('--- ')) {
      // `--- /dev/null`: a brand-new file has no a-side.
      aSide = '';
      continue;
    }
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('+++ ')) {
      // `+++ /dev/null`: a deletion. Its removed lines are the a-side's.
      file = aSide;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added.push(`${file} ${line.slice(1)}`);
    else if (line.startsWith('-') && !line.startsWith('---'))
      removed.push(`${file} ${line.slice(1)}`);
  }
  return { added, removed };
}

/**
 * What the changes add up to.
 *
 * Pure, and takes everything it reads as an argument, so the rules can be argued
 * with in a test rather than against a repository.
 */
export function classifyChanges(changes: readonly Change[]): Verdict {
  const declared = declaredBump(changes);

  // Kept apart so the list reads most-significant-first: the reason a release is
  // a minor is the thing someone wants to see, and "changes to shipped code" is
  // true of every release ever cut.
  const strong: string[] = [];
  const weak: string[] = [];
  let inferred: Bump = 'none';
  const raise = (bump: Bump, reason: string): void => {
    if (RANK[bump] > RANK[inferred]) inferred = bump;
    const into = RANK[bump] >= RANK.minor ? strong : weak;
    if (!into.includes(reason)) into.push(reason);
  };

  for (const change of changes) {
    for (const entry of change.added) {
      const { file, text } = splitEntry(entry);
      if (file === 'packages/protocol/src/ipc.ts') {
        const channel = IPC_CHANNEL.exec(text);
        if (channel) raise('minor', `a new IPC channel: ${channel[1] ?? 'unnamed'}`);
      }
      if (file === 'packages/protocol/src/events.ts') {
        const variant = EVENT_VARIANT.exec(text);
        if (variant) raise('minor', `a new event: ${variant[1] ?? 'unnamed'}`);
      }
      if (isPackageSource(file)) {
        const exported = EXPORTED.exec(text);
        if (exported) raise('minor', `new public API: ${exported[2] ?? 'unnamed'} in ${file}`);
      }
    }

    for (const entry of change.removed) {
      const { file, text } = splitEntry(entry);
      if (!isPackageSource(file)) continue;
      const exported = EXPORTED.exec(text);
      // A removal is a minor for the same reason an addition is: at 0.x, taking
      // away something people were using is the kind of change a version number
      // has to warn about, and it is the rule this repo already applied by hand.
      if (exported) raise('minor', `public API removed: ${exported[2] ?? 'unnamed'} from ${file}`);
    }

    for (const file of change.files) {
      if (isRendererSurface(file) && change.newFiles.includes(file)) {
        raise('minor', `a new surface: ${file}`);
      }
      if (isShipped(file)) raise('patch', 'changes to shipped code');
    }
  }

  const reasons = [...strong, ...weak];

  if (declared !== null) {
    return {
      bump: declared.bump,
      declaredBy: declared.subject,
      reasons: [
        `declared by a commit: “${declared.subject}”`,
        ...reasons.map((reason) => `also seen: ${reason}`),
      ],
    };
  }

  return { bump: inferred, reasons, declaredBy: null };
}

/** The strongest `Release:` trailer in the range, if any. */
function declaredBump(
  changes: readonly Change[],
): { readonly bump: Bump; readonly subject: string } | null {
  let best: { bump: Bump; subject: string } | null = null;
  for (const change of changes) {
    const match = DECLARED.exec(change.message);
    const bump = match?.[1] as Bump | undefined;
    if (bump === undefined) continue;
    // The highest wins, so one commit cannot talk a release down.
    if (best === null || RANK[bump] > RANK[best.bump]) {
      best = { bump, subject: (change.message.split('\n')[0] ?? '').trim() };
    }
  }
  return best;
}

/**
 * The three numbers, with `v` and any prerelease or build metadata dropped.
 *
 * `1.0.0-beta.1` is the same release as `1.0.0` as far as every judgement in
 * this file is concerned — it is that version, arriving early. Splitting on `.`
 * without this gave `[1, 0, NaN, NaN]`, and `NaN` compares false against
 * everything, so a beta silently registered as no bump at all.
 */
function core(version: string): readonly [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .replace(/[-+].*$/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

/** Whether a version or tag names a prerelease: `1.0.0-beta.1`, `v2.0.0-rc.2`. */
export function isPrerelease(version: string): boolean {
  return version.replace(/^v/, '').includes('-');
}

/** Apply a bump to a semver string. `none` leaves it alone. */
export function applyBump(version: string, bump: Bump): string {
  const [major, minor, patch] = core(version);

  switch (bump) {
    case 'major':
      return `${String(major + 1)}.0.0`;
    case 'minor':
      return `${String(major)}.${String(minor + 1)}.0`;
    case 'patch':
      return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
    default:
      return `${String(major)}.${String(minor)}.${String(patch)}`;
  }
}

/**
 * Is `version` at least what the changes call for, measured from `from`?
 *
 * "At least", not "exactly": deciding to ship a minor where a patch would do is
 * a judgement call someone is allowed to make, and shipping a patch where the
 * surface grew is the mistake worth catching.
 */
export function satisfies(from: string, version: string, bump: Bump): boolean {
  const [bMajor, bMinor, bPatch] = core(from);
  const [nMajor, nMinor, nPatch] = core(version);

  const actual: Bump =
    nMajor > bMajor ? 'major' : nMinor > bMinor ? 'minor' : nPatch > bPatch ? 'patch' : 'none';
  return RANK[actual] >= RANK[bump];
}

/**
 * The most recent *stable* version tag, or `null` in a repository that has none.
 *
 * Prereleases are skipped on purpose, and it is the promotion that makes the
 * case: cut `v1.0.0-beta.1`, fix nothing, then cut `v1.0.0`. Measured from the
 * beta the range is empty, so the verdict is `none` and the release script
 * refuses to ship the version the beta existed to rehearse. Measured from the
 * last stable tag it is the same major it always was, and the beta is what it
 * claims to be — that release, arriving early, judged against the same baseline.
 *
 * `--exclude '*-*'` rather than filtering a `git tag` listing: `describe` answers
 * with the most recent tag *reachable from HEAD*, and a plain listing would
 * answer with the highest version anywhere in the repository — including one on
 * a branch this commit knows nothing about.
 */
export function lastTag(): string | null {
  try {
    return (
      execFileSync(
        'git',
        ['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', '*-*'],
        { encoding: 'utf8' },
      ).trim() || null
    );
  } catch {
    return null;
  }
}

/** Everything the release script needs, in one call. */
export function inspectSinceLastTag(): {
  readonly from: string | null;
  readonly verdict: Verdict;
} {
  const from = lastTag();
  if (from === null) return { from: null, verdict: { bump: 'minor', reasons: [], declaredBy: null } };

  const changes = readChanges(from);
  const diff = readDiff(from);
  const newFiles = readAddedFiles(from);
  // The diff is read for the range as a whole rather than per commit: what
  // matters is what the release contains, and a line added in one commit and
  // removed in the next is not in it.
  const merged: Change[] = changes.map((change, index) =>
    index === 0 ? { ...change, added: diff.added, removed: diff.removed, newFiles } : change,
  );
  return { from, verdict: classifyChanges(merged) };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

/** True when this module was run directly rather than imported. */
const isMain = process.argv[1]?.includes('nextVersion') === true;

if (isMain) {
  const { from, verdict } = inspectSinceLastTag();
  if (from === null) {
    console.log('No version tag yet — start wherever you like.');
  } else {
    const next = applyBump(from, verdict.bump);
    console.log(`${from} → ${next}  (${verdict.bump})`);
    for (const reason of verdict.reasons) console.log(`  • ${reason}`);
    if (verdict.reasons.length === 0) console.log('  • nothing shipped: notes and tests only');
  }
}
