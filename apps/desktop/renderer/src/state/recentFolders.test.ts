/**
 * The folders the composer's menu offers.
 *
 * The list fills itself, which is the whole feature and also the whole risk: a
 * user never adds an entry here deliberately, so anything that records the wrong
 * path — or fails to record the right one — produces a menu that is quietly
 * wrong and that nobody can correct except by hand in Appearance.
 *
 * Five rules are asserted, and each has a failure that looks like nothing:
 *
 *  1. **Only directories actually adopted are recorded.** A refused move (a live
 *     run) offering its folder in the menu afterwards would advertise a place
 *     the app was told it could not go.
 *  2. **Re-opening promotes.** The stored order is the *eviction* order, so a
 *     folder in daily use that never moves up would age out from under the user
 *     while ten one-off checkouts stayed.
 *  3. **The cap holds and drops the right one.** Off-by-one here is invisible
 *     until the eleventh project.
 *  4. **Forgetting is bookkeeping.** It must not touch the working directory,
 *     which is the one thing in this area that ends a session.
 *  5. **Directories that will not last are not recorded.** A worktree is made
 *     for one branch and deleted when that branch lands; a temporary directory
 *     is deleted by the OS. Ten of either evict every real project from a list
 *     of ten. Moving there still works — only the remembering is declined.
 *
 * Recording is asynchronous, because only the filesystem knows what a worktree
 * is and the renderer has none. Every assertion here therefore goes through
 * {@link settled}, and one that forgets would pass against an empty list rather
 * than fail — which is why the negative cases below assert *after* settling too.
 *
 * Display order is *not* here: the menu and the settings pane both sort
 * alphabetically at render (`sortFoldersByName`), and this list is deliberately
 * not in that order. See `lib/paths.test.ts` and `recent-folders.test.tsx`.
 *
 * Same caveat as the other state tests: `renderer/tsconfig.json` excludes them,
 * so `pnpm typecheck` never sees this file and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  RECENT_FOLDERS_LIMIT,
  clearRecentFolders,
  focusedPane,
  forgetFolders,
  setCwd,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

const pane = () => focusedPane();
const session = () => paneState(pane());
const folders = () => useApp.getState().recentFolders;

/**
 * Let the pending "is this a worktree?" answers come back.
 *
 * A macrotask is enough, and deliberately so: the check is one bridge call deep
 * and the dev bridge answering it is timer-free, so anything still outstanding
 * after this is a bug in the chain rather than a slow reply worth polling for.
 */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A directory the bridge answers `worktree: true` for.
 *
 * The dev bridge keys off the path because it has no filesystem to read; the
 * real check reads the `gitdir:` pointer out of the worktree's `.git` file and
 * is tested against actual directories in core's `repo.test.ts`. What is being
 * asserted here is what the store does with the answer, not how it is reached.
 */
const WORKTREE = '/work/worktrees/fix-login';

/**
 * A directory the bridge answers `temporary: true` for.
 *
 * `/tmp` because it is the one spelling recognisable without a filesystem; the
 * real check knows this machine's `tmpdir()`, which on macOS is an opaque path
 * under `/var/folders`. Tested for itself in core's `temp.test.ts`.
 */
const TEMP = '/tmp/agent-run-3f2a/checkout';

const LIVE_RUN = {
  runId: 'r1',
  status: 'running',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/a',
  capabilities: {
    interactivePermissions: true,
    partialMessages: true,
    midRunSteering: true,
    forkSession: true,
    listSessions: true,
    subagents: true,
    permissionModes: ['default'],
    resumeSession: true,
    usageReporting: true,
    costReporting: true,
    planUsageReporting: true,
  },
  startedAt: 1_000,
};

beforeEach(async () => {
  // Settle *before* clearing, not after: a recording still queued from the
  // previous test would otherwise land in this one's list and fail it somewhere
  // unrelated.
  await settled();
  useApp.setState({ banners: [], recentFolders: [] });
  setPaneState(pane(), { cwd: '', resumeSessionId: null, run: null });
  pane().transcript.reset();
});

describe('recording', () => {
  it('remembers each directory worked in', async () => {
    setCwd('/work/api');
    setCwd('/work/web');
    await settled();

    expect([...folders()].sort()).toEqual(['/work/api', '/work/web']);
  });

  it('records the trimmed path, so the menu matches the working directory', async () => {
    setCwd('  /work/api  ');
    await settled();

    // `setCwd` stores the trimmed form; an untrimmed twin in this list would
    // render as a second row that never shows as the current one.
    expect(session().cwd).toBe('/work/api');
    expect(folders()).toEqual(['/work/api']);
  });

  it('never records an empty directory', async () => {
    setCwd('   ');
    await settled();

    // An unconfigured window has `cwd === ''`. There is no folder to go back to.
    expect(folders()).toEqual([]);
  });

  it('records a folder once, however many times it is opened', async () => {
    setCwd('/work/api');
    setCwd('/work/web');
    setCwd('/work/api');
    await settled();

    expect(folders()).toHaveLength(2);
  });

  it('promotes a re-opened folder, because the order decides what is dropped', async () => {
    setCwd('/work/api');
    setCwd('/work/web');
    setCwd('/work/api');
    await settled();

    // Front is "most recently worked in". A folder in daily rotation must not
    // age out just because it was first seen a long time ago.
    expect(folders()[0]).toBe('/work/api');
  });

  it('does not record a move that was refused', async () => {
    setCwd('/work/api');
    setPaneState(pane(), { run: LIVE_RUN });

    setCwd('/work/web');
    await settled();

    // The run is live, so `setCwd` refused and said so. Offering `/work/web` in
    // the menu afterwards would list a folder the app never went to.
    expect(session().cwd).toBe('/work/api');
    expect(folders()).toEqual(['/work/api']);
    expect(useApp.getState().banners.at(-1)?.message).toContain('run is still going');
  });
});

describe('directories that will not last', () => {
  it.each([
    ['a worktree', WORKTREE],
    ['a temporary directory', TEMP],
  ])('moves to %s without recording it', async (_label, path) => {
    setCwd(path);
    await settled();

    // Both halves matter. Working in one is ordinary and must not be
    // obstructed; remembering it is the promise the directory will not keep.
    expect(session().cwd).toBe(path);
    expect(folders()).toEqual([]);
  });

  it('records the ordinary checkouts either side of one', async () => {
    setCwd('/work/api');
    setCwd(WORKTREE);
    setCwd(TEMP);
    setCwd('/work/web');
    await settled();

    // Skipped rather than the list being suspended: a trip through scratch
    // space must not cost the projects on either side of it.
    expect([...folders()].sort()).toEqual(['/work/api', '/work/web']);
  });

  it('spends none of the cap on them', async () => {
    for (let i = 0; i < RECENT_FOLDERS_LIMIT; i += 1) setCwd(`/work/worktrees/branch-${i}`);
    for (let i = 0; i < RECENT_FOLDERS_LIMIT; i += 1) setCwd(`/tmp/agent-run-${i}`);
    setCwd('/work/api');
    await settled();

    // The failure this exists to catch: twenty scratch directories evicting
    // every real project from a list of ten, which is what the whole change is
    // for.
    expect(folders()).toEqual(['/work/api']);
  });

  it('keeps one already in the list until it is forgotten', async () => {
    // Stored preferences predate this rule, so a list restored from disk can
    // hold them. They are left alone rather than pruned on sight: this decides
    // what gets *added*, and silently editing a restored list would be a
    // second, unasked-for behaviour on top of that.
    useApp.setState({ recentFolders: [WORKTREE, TEMP] });
    setCwd('/work/api');
    await settled();

    expect(folders()).toEqual(['/work/api', WORKTREE, TEMP]);

    forgetFolders([WORKTREE, TEMP]);
    expect(folders()).toEqual(['/work/api']);
  });
});

describe('the cap', () => {
  it(`keeps at most ${RECENT_FOLDERS_LIMIT}, dropping the one untouched longest`, async () => {
    for (let i = 0; i <= RECENT_FOLDERS_LIMIT; i += 1) setCwd(`/work/p${i}`);
    await settled();

    expect(folders()).toHaveLength(RECENT_FOLDERS_LIMIT);
    // `p0` was the first opened and never re-opened, so it is the one that made
    // way for `p10`.
    expect(folders()).not.toContain('/work/p0');
    expect(folders()).toContain('/work/p10');
  });

  it('spares a folder that was re-opened, however early it was first seen', async () => {
    for (let i = 0; i < RECENT_FOLDERS_LIMIT; i += 1) setCwd(`/work/p${i}`);
    setCwd('/work/p0');
    setCwd('/work/new');
    await settled();

    // `p0` was oldest by first-seen and newest by last-used. The list is about
    // last-used, so `p1` is what makes way.
    expect(folders()).toContain('/work/p0');
    expect(folders()).not.toContain('/work/p1');
  });
});

describe('forgetting', () => {
  beforeEach(async () => {
    setCwd('/work/api');
    setCwd('/work/web');
    setCwd('/work/docs');
    // The list has to be real before anything can be removed from it.
    await settled();
  });

  it('removes one', () => {
    forgetFolders(['/work/web']);

    expect(folders()).not.toContain('/work/web');
    expect(folders()).toHaveLength(2);
  });

  it('removes several in one write', () => {
    forgetFolders(['/work/web', '/work/api']);

    // One call, not a loop of single removes: a half-finished batch is a state
    // the user could quit inside of.
    expect(folders()).toEqual(['/work/docs']);
  });

  it('ignores paths that are not in the list', () => {
    forgetFolders(['/somewhere/else']);

    expect(folders()).toHaveLength(3);
  });

  it('leaves the working directory alone, even when it is the folder forgotten', () => {
    forgetFolders(['/work/docs']);

    // Forgetting is bookkeeping. Moving the directory is what ends a session,
    // and nothing in this pane is allowed to do that.
    expect(session().cwd).toBe('/work/docs');
    expect(folders()).not.toContain('/work/docs');
  });

  it('takes the folder back the next time it is opened', async () => {
    forgetFolders(['/work/api']);
    setCwd('/work/api');
    await settled();

    // Which is why removal needs no confirmation and no undo.
    expect(folders()).toContain('/work/api');
  });

  it('empties the whole list on request', () => {
    clearRecentFolders();

    expect(folders()).toEqual([]);
    expect(session().cwd).toBe('/work/docs');
  });
});
