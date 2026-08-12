/**
 * @vitest-environment jsdom
 *
 * The sidebar lists every project, not just the one you are standing in.
 *
 * This was reported as losing sessions: switching folders emptied the sidebar of
 * everything that had been in it. Nothing was lost — the list was scoped to the
 * working directory, so the other projects' history was filtered out on the way
 * to the screen, and the only route back to it was to change directory again,
 * which ends the current session. History you have to destroy your place to look
 * at is not history you can browse.
 *
 * The scoping was itself a fix for a real complaint — an undifferentiated stream
 * of every repository buried "what was I doing in *this* repo". What answers it
 * now is recency plus a per-project fold, so the assertions below cover the
 * order and the folding as well as the listing: the project you touched last
 * leads, and any project can be put away without taking the others with it.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionList } from '@/components/SessionList';
import { focusedPane, useApp } from '@/state/store';
import { setPaneState } from '@/state/pane';
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

function session(id: string, cwd: string, updatedAt: number, title: string): SessionSummary {
  return { id, cwd, updatedAt, title, providerId: 'claude', profileId: 'p1' } as SessionSummary;
}

/**
 * Three projects. `/code/api` is where the window is pointed and is also the
 * *stalest*, so any ordering that merely fell out of recency would put it last.
 */
const SESSIONS = [
  session('s1', '/code/api', 10, 'Adapter seam'),
  session('s2', '/code/web', 90, 'Login redirect'),
  session('s3', '/code/cli', 50, 'Flag parsing'),
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
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions: SESSIONS,
    sessionsLoading: false,
    sessionsError: null,
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

/**
 * Put a live run on the focused column, the way starting one does.
 *
 * Deliberately not `useApp.setState({ runningSessions, sessionOrderHold })`:
 * both are projections of the panes, and the subscription that maintains them
 * would recompute from the (idle) panes and wipe the injected values on the very
 * next store write. The run is the input; everything else follows from it.
 */
function startRunning(sessionId: string): void {
  act(() => {
    setPaneState(focusedPane(), {
      run: {
        runId: 'run-1',
        status: 'running',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/code/api',
        capabilities: CAPABILITIES,
        startedAt: 1,
        sessionId,
      },
    } as never);
  });
}

describe('the session list', () => {
  it('shows sessions from every project, not only the current one', () => {
    mount(<SessionList />);

    // The reported bug, stated directly: two of these three used to be filtered
    // out because the window happened to be pointed at /code/api.
    expect(screen.getByText('Adapter seam')).not.toBeNull();
    expect(screen.getByText('Login redirect')).not.toBeNull();
    expect(screen.getByText('Flag parsing')).not.toBeNull();
  });

  it('heads each project with its folder name', () => {
    mount(<SessionList />);

    expect(screen.getByText('api')).not.toBeNull();
    expect(screen.getByText('web')).not.toBeNull();
    expect(screen.getByText('cli')).not.toBeNull();
  });

  it('orders projects by the most recent session, newest first', () => {
    mount(<SessionList />);

    const headings = screen.getAllByText(/^(api|web|cli)$/).map((el) => el.textContent);
    // /code/web was touched at 90, /code/cli at 50, /code/api at 10 — and
    // /code/api is where the window is pointed, which now buys it nothing. The
    // top of the list is wherever you were last, not wherever you are.
    expect(headings).toEqual(['web', 'cli', 'api']);
  });

  it('folds one project without touching the others', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByRole('button', { name: /web/ }));

    // `web`'s own session goes; every other project's stays. The heading
    // remains, so the project has not disappeared — it is put away.
    expect(screen.queryByText('Login redirect')).toBeNull();
    expect(screen.getByText('Flag parsing')).not.toBeNull();
    expect(screen.getByText('Adapter seam')).not.toBeNull();
    expect(screen.getByText('web')).not.toBeNull();
  });

  it('keeps a folded project’s count on its heading', () => {
    mount(<SessionList />);
    fireEvent.click(screen.getByRole('button', { name: /web/ }));

    const heading = screen.getByRole('button', { name: /web/ });
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(within(heading).getByText('·1')).not.toBeNull();
  });

  it('remembers which projects are folded', () => {
    mount(<SessionList />);
    fireEvent.click(screen.getByRole('button', { name: /web/ }));

    // Stored as the shut ones, so a project nobody has touched — including one
    // that first appears later — arrives open rather than folded away.
    expect(useApp.getState().collapsedProjects).toEqual(['/code/web']);
  });

  it('carries the directory across when a row from another project is picked', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByText('Login redirect'));

    // The other half of what was asked for: seeing the row is only useful if
    // clicking it moves you there. `resumeSession` already did the full switch —
    // it has to, since a session id only resolves against the directory it ran
    // in — so this asserts the sidebar hands it a cross-project session at all.
    expect(appSession().cwd).toBe('/code/web');
    expect(appSession().resumeSessionId).toBe('s2');
  });

  it('leaves the picked session marked as the current one', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByText('Flag parsing'));

    expect(appSession().cwd).toBe('/code/cli');
    expect(appSession().resumeSessionId).toBe('s3');
  });

  /*
   * The rendered half of `AppState.sessionOrderHold`.
   *
   * The rules themselves are pinned down in `state/sessionOrder.test.ts`; what
   * this adds is that the list actually *subscribes* to the hold — a memo that
   * left it out of its dependencies would keep sorting by a stale record, and
   * every assertion over there would still pass.
   */
  it('re-sorts when a run takes hold of a row', () => {
    mount(<SessionList />);
    expect(screen.getAllByText(/^(api|web|cli)$/).map((el) => el.textContent)).toEqual([
      'web',
      'cli',
      'api',
    ]);

    // The stalest project starts working: it leads until its run ends.
    startRunning('s1');

    expect(screen.getAllByText(/^(api|web|cli)$/).map((el) => el.textContent)).toEqual([
      'api',
      'web',
      'cli',
    ]);
  });

  it('holds that row still while the poll reports newer mtimes', () => {
    startRunning('s1');
    mount(<SessionList />);

    // A poll lands: every session's file has moved on, `/code/web`'s most of
    // all. Nothing on screen may move — this is the four-second shuffle.
    useApp.setState({
      sessions: [
        session('s1', '/code/api', 2_000, 'Adapter seam'),
        session('s2', '/code/web', 3_000, 'Login redirect'),
        session('s3', '/code/cli', 2_500, 'Flag parsing'),
      ],
    });

    expect(screen.getAllByText(/^(api|web|cli)$/).map((el) => el.textContent)).toEqual([
      'api',
      'web',
      'cli',
    ]);
  });
});
