/**
 * @vitest-environment jsdom
 *
 * A worktree's sessions stay in the project they belong to.
 *
 * Reported directly: splitting work off into a linked worktree — which an agent
 * does routinely, at `<repo>/.claude/worktrees/<branch>` — took those sessions
 * out of the repository's group in the sidebar and gave them a group of their
 * own, headed with the branch name. Nothing was lost, but the project a person
 * scans for no longer held the work they had just done in it, and a repository
 * they had never worked in appeared above it.
 *
 * The directory is still the directory: it is what a resume runs in and what the
 * row's tooltip states. Only the grouping changed, and it changed to the answer
 * the header has always given — work in a worktree of Artemis is work on
 * Artemis.
 *
 * `projectRoots` is seeded here rather than resolved, because the resolution is
 * a bridge call tested in `state/projects.test.ts` and the walk behind it in
 * core's `repo.test.ts`. What is asserted here is what the list does with the
 * answer.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionList } from '@/components/SessionList';
import { useApp } from '@/state/store';
import { appSession, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const CAPABILITIES = {
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

const REPO = '/code/artemis';
/** Where an agent puts a worktree it split off for a branch. */
const WORKTREE = '/code/artemis/.claude/worktrees/adapter-seam';

function session(id: string, cwd: string, updatedAt: number, title: string): SessionSummary {
  return { id, cwd, updatedAt, title, providerId: 'claude', profileId: 'p1' } as SessionSummary;
}

const SESSIONS = [
  session('s1', REPO, 10, 'Wire the adapter seam'),
  session('s2', WORKTREE, 90, 'Split the adapter out'),
  session('s3', '/code/api', 50, 'Flag parsing'),
];

beforeEach(() => {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'Work', providerId: 'claude', configDir: '/home/u/.claude' }],
    activeProfileId: 'p1',
    cwd: WORKTREE,
    workspace: null,
    run: null,
    sessions: SESSIONS,
    sessionsLoading: false,
    sessionsError: null,
    // What the bridge answers for these directories: the worktree belongs to the
    // checkout, and everything else is already its own project and so absent.
    projectRoots: { [WORKTREE]: REPO },
    collapsedProjects: [],
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
  });
});

afterEach(cleanup);

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

describe('a session run in a worktree', () => {
  it('is listed under the repository, not under the branch', () => {
    mount(<SessionList />);

    // The bug, stated: a heading called `adapter-seam` appeared, and `artemis`
    // no longer held the session that had just been worked on.
    expect(screen.queryByText('adapter-seam')).toBeNull();
    const heading = screen.getByRole('button', { name: /artemis/ });
    // The bare number — the count is right-aligned on the heading now, so it
    // no longer carries the `·` that used to tie it to the name beside it.
    expect(within(heading).getByText('2')).not.toBeNull();
  });

  it('is folded away with the rest of the project', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByRole('button', { name: /artemis/ }));

    // Both of artemis's sessions go, wherever each one ran; the other project
    // is untouched.
    expect(screen.queryByText('Split the adapter out')).toBeNull();
    expect(screen.queryByText('Wire the adapter seam')).toBeNull();
    expect(screen.getByText('Flag parsing')).not.toBeNull();
  });

  it('folds under the project’s path, so the fold survives the worktree', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByRole('button', { name: /artemis/ }));

    // Keyed on the checkout rather than on any one directory inside it. A fold
    // stored against a worktree would be a preference about a directory that is
    // deleted when its branch lands.
    expect(useApp.getState().collapsedProjects).toEqual([REPO]);
  });

  it('does not move the project it merges into', () => {
    mount(<SessionList />);

    // The worktree holds the most recent session in the window, and that decides
    // nothing about where its project sits: headings are ordered by name. What
    // the merge changes is which rows are *inside* artemis — asserted above —
    // not where the heading is, which is the point of a folder that holds still.
    const headings = screen.getAllByText(/^(artemis|api)$/).map((el) => el.textContent);
    expect(headings).toEqual(['api', 'artemis']);
  });

  it('still resumes in the directory it ran in', () => {
    // The column starts in the checkout, so picking the worktree's row has
    // somewhere to move to.
    seedApp({ cwd: REPO });
    mount(<SessionList />);

    fireEvent.click(screen.getByText('Split the adapter out'));

    // Grouping moved; the session did not. A session id only resolves against
    // the directory it was created in, so a row filed under the repository must
    // still carry its own worktree across.
    expect(appSession().cwd).toBe(WORKTREE);
  });
});
