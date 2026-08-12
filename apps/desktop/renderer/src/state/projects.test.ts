/**
 * @vitest-environment jsdom
 *
 * Which project a session's directory belongs to.
 *
 * The sidebar groups history by project, and the renderer cannot work out what
 * a project is: it takes a `.git` file and the `gitdir:` pointer inside it to
 * know that `…/.claude/worktrees/adapter-seam` is a worktree of the checkout two
 * directories up. So the answers arrive over the bridge, one directory at a
 * time, and land in `projectRoots` — which is what these assertions are about.
 * The grouping that consumes it is tested in `lib/sessionGroups.test.ts`, and
 * the walk that produces the answer in core's `repo.test.ts`.
 *
 * Three properties, each with a failure that costs something real:
 *
 *  1. **A worktree resolves to its checkout.** The reported bug: work split off
 *     into a worktree left the project it belonged to and appeared as a
 *     repository of its own, named after the branch.
 *  2. **Directories that are their own project are not stored.** The map would
 *     otherwise grow one entry per session directory in the history, and its
 *     identity would change on every poll — which re-renders the sidebar.
 *  3. **Each directory is asked about once.** The listing re-reads every few
 *     seconds while an agent is working; asking again per poll would be a
 *     filesystem walk per directory per four seconds for an answer already held.
 *
 * Same caveat as the other state tests: `renderer/tsconfig.json` excludes them,
 * so `pnpm typecheck` never sees this file and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Capabilities, ProfileMetadata, ProviderDescriptor } from '@rx-artemis/protocol';

import { focusedPane, refreshSessions, setCwd, useApp } from './store';
import { setPaneState } from './pane';

const CAPABLE: Capabilities = {
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
};

const CLAUDE: ProviderDescriptor = {
  id: 'claude',
  label: 'Claude',
  capabilities: CAPABLE,
  models: [],
  effortLevels: [],
  available: true,
};

const WORK = { id: 'work', label: 'Work', providerId: 'claude', configDir: '/home/u/.claude' };

/** The repository, and a worktree of it — the shape an agent's split produces. */
const REPO = '/code/artemis';
const WORKTREE = '/code/artemis/.claude/worktrees/adapter-seam';
/** A repository the describe below answers about without moving it anywhere. */
const OTHER = '/code/api';

function session(id: string, cwd: string): unknown {
  return { id, title: id, cwd, profileId: 'work', updatedAt: 1_000, providerId: 'claude' };
}

/*
 * A bridge that lists sessions and describes directories.
 *
 * A mutable box rather than a fresh stub per test, for the reason
 * `models.test.ts` gives: `resolveBridge` memoises its binding on the first
 * call, so a second `window.artemis` would never be seen.
 */
let nextSessions: readonly unknown[] = [];
/** Every path `describe` was asked about, in order, including repeats. */
let described: string[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: nextSessions, hasMore: false } }),
  },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
  workspace: {
    describe: async ({ path }: { path: string }) => {
      described.push(path);
      const name = path.split('/').at(-1) ?? path;
      // What the real walk answers for these three: a worktree belongs to the
      // checkout it was split off from, and a checkout belongs to itself.
      const projectRoot = path === WORKTREE ? REPO : path;
      return {
        ok: true,
        value: {
          path,
          name,
          repoRoot: path,
          repoName: name,
          projectRoot,
          ...(path === WORKTREE ? { worktree: true } : {}),
        },
      };
    },
  },
};

/** Let the listing, and the descriptions it kicks off, come back. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 8));

beforeEach(async () => {
  await settled();
  nextSessions = [];
  described = [];
  useApp.setState({
    providers: [CLAUDE],
    profiles: [WORK as ProfileMetadata],
    sessions: [],
    sessionsError: null,
    sessionsLoading: false,
    projectRoots: {},
  });
  setPaneState(focusedPane(), {
    activeProviderId: 'claude',
    activeProfileId: 'work',
    run: null,
    cwd: REPO,
  } as never);
});

describe('learning a session directory’s project', () => {
  it('files a worktree under the checkout it was split off from', async () => {
    nextSessions = [session('s1', WORKTREE)];

    await refreshSessions();
    await settled();

    // The reported bug in one line: without this the sidebar showed a project
    // called `adapter-seam` and took the session out of `artemis`.
    expect(useApp.getState().projectRoots[WORKTREE]).toBe(REPO);
  });

  it('stores nothing for a directory that is its own project', async () => {
    nextSessions = [session('s1', OTHER)];

    await refreshSessions();
    await settled();

    // The lookup falls back to the directory, so an entry saying so would be
    // the whole history in a map whose identity re-renders the sidebar.
    expect(useApp.getState().projectRoots).toEqual({});
  });

  it('asks about each directory once, however often the listing re-reads', async () => {
    // Its own directories, because "asked already" is remembered for the life of
    // the window rather than per listing — which is the property under test, and
    // which the tests above have already exercised for `WORKTREE` and `OTHER`.
    const cli = '/code/cli';
    const split = '/code/cli/.claude/worktrees/flags';
    nextSessions = [session('s1', split), session('s2', cli), session('s3', split)];

    await refreshSessions();
    await settled();
    await refreshSessions();
    await settled();

    // Two directories, three sessions, two listings — and one question each.
    // The listing polls every few seconds while an agent is working.
    expect([...described].sort()).toEqual([cli, split].sort());
  });

  it('learns the directory a column moves to, before any session runs in it', async () => {
    // `setCwd` describes the directory for the header anyway; the project falls
    // out of the same answer, so a freshly opened worktree is grouped correctly
    // the moment its first session appears rather than a poll later.
    setCwd(WORKTREE);
    await settled();

    expect(useApp.getState().projectRoots[WORKTREE]).toBe(REPO);
  });
});
