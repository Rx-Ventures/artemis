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
 * The scoping was itself a fix for a real complaint, which is why these
 * assertions cover both halves rather than just the new one: every project is
 * listed, *and* the one you are in is still first. Losing the second half would
 * re-create the problem that caused the scoping.
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
  useApp.setState({
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
    sessionsCollapsed: false,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
  });
});

afterEach(cleanup);

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
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

  it('puts the current project first even when it is the stalest', () => {
    mount(<SessionList />);

    const headings = screen.getAllByText(/^(api|web|cli)$/).map((el) => el.textContent);
    // /code/api was last touched at 10, against 90 and 50. Recency alone would
    // bury it; the pin is what keeps "what was I doing in this repo" answerable
    // without scrolling.
    expect(headings[0]).toBe('api');
  });

  it('counts every session in the header, across all projects', () => {
    mount(<SessionList />);

    const header = screen.getByRole('button', { expanded: true });
    expect(within(header).getByText('·3')).not.toBeNull();
  });

  it('carries the directory across when a row from another project is picked', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByText('Login redirect'));

    // The other half of what was asked for: seeing the row is only useful if
    // clicking it moves you there. `resumeSession` already did the full switch —
    // it has to, since a session id only resolves against the directory it ran
    // in — so this asserts the sidebar hands it a cross-project session at all.
    expect(useApp.getState().cwd).toBe('/code/web');
    expect(useApp.getState().resumeSessionId).toBe('s2');
  });

  it('leaves the picked session marked as the current one', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByText('Flag parsing'));

    expect(useApp.getState().cwd).toBe('/code/cli');
    expect(useApp.getState().resumeSessionId).toBe('s3');
  });
});
