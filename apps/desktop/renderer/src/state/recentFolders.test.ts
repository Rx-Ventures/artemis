/**
 * The folders the composer's menu offers.
 *
 * The list fills itself, which is the whole feature and also the whole risk: a
 * user never adds an entry here deliberately, so anything that records the wrong
 * path — or fails to record the right one — produces a menu that is quietly
 * wrong and that nobody can correct except by hand in Appearance.
 *
 * Four rules are asserted, and each has a failure that looks like nothing:
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

beforeEach(() => {
  useApp.setState({ banners: [], recentFolders: [] });
  setPaneState(pane(), { cwd: '', resumeSessionId: null, run: null });
  pane().transcript.reset();
});

describe('recording', () => {
  it('remembers each directory worked in', () => {
    setCwd('/work/api');
    setCwd('/work/web');

    expect([...folders()].sort()).toEqual(['/work/api', '/work/web']);
  });

  it('records the trimmed path, so the menu matches the working directory', () => {
    setCwd('  /work/api  ');

    // `setCwd` stores the trimmed form; an untrimmed twin in this list would
    // render as a second row that never shows as the current one.
    expect(session().cwd).toBe('/work/api');
    expect(folders()).toEqual(['/work/api']);
  });

  it('never records an empty directory', () => {
    setCwd('   ');

    // An unconfigured window has `cwd === ''`. There is no folder to go back to.
    expect(folders()).toEqual([]);
  });

  it('records a folder once, however many times it is opened', () => {
    setCwd('/work/api');
    setCwd('/work/web');
    setCwd('/work/api');

    expect(folders()).toHaveLength(2);
  });

  it('promotes a re-opened folder, because the order decides what is dropped', () => {
    setCwd('/work/api');
    setCwd('/work/web');
    setCwd('/work/api');

    // Front is "most recently worked in". A folder in daily rotation must not
    // age out just because it was first seen a long time ago.
    expect(folders()[0]).toBe('/work/api');
  });

  it('does not record a move that was refused', () => {
    setCwd('/work/api');
    setPaneState(pane(), { run: LIVE_RUN });

    setCwd('/work/web');

    // The run is live, so `setCwd` refused and said so. Offering `/work/web` in
    // the menu afterwards would list a folder the app never went to.
    expect(session().cwd).toBe('/work/api');
    expect(folders()).toEqual(['/work/api']);
    expect(useApp.getState().banners.at(-1)?.message).toContain('run is still going');
  });
});

describe('the cap', () => {
  it(`keeps at most ${RECENT_FOLDERS_LIMIT}, dropping the one untouched longest`, () => {
    for (let i = 0; i <= RECENT_FOLDERS_LIMIT; i += 1) setCwd(`/work/p${i}`);

    expect(folders()).toHaveLength(RECENT_FOLDERS_LIMIT);
    // `p0` was the first opened and never re-opened, so it is the one that made
    // way for `p10`.
    expect(folders()).not.toContain('/work/p0');
    expect(folders()).toContain('/work/p10');
  });

  it('spares a folder that was re-opened, however early it was first seen', () => {
    for (let i = 0; i < RECENT_FOLDERS_LIMIT; i += 1) setCwd(`/work/p${i}`);
    setCwd('/work/p0');
    setCwd('/work/new');

    // `p0` was oldest by first-seen and newest by last-used. The list is about
    // last-used, so `p1` is what makes way.
    expect(folders()).toContain('/work/p0');
    expect(folders()).not.toContain('/work/p1');
  });
});

describe('forgetting', () => {
  beforeEach(() => {
    setCwd('/work/api');
    setCwd('/work/web');
    setCwd('/work/docs');
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

  it('takes the folder back the next time it is opened', () => {
    forgetFolders(['/work/api']);
    setCwd('/work/api');

    // Which is why removal needs no confirmation and no undo.
    expect(folders()).toContain('/work/api');
  });

  it('empties the whole list on request', () => {
    clearRecentFolders();

    expect(folders()).toEqual([]);
    expect(session().cwd).toBe('/work/docs');
  });
});
