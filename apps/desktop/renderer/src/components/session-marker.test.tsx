/**
 * @vitest-environment jsdom
 *
 * The sidebar marks the conversation you are looking at.
 *
 * Reported as "sidebar items never show as selected", and it arrived with the
 * fix that made clicking an already-open row a no-op. Before that, clicking the
 * row of the session in front of you fell through to the resume path, which set
 * `resumeSessionId` — so the mark appeared, as a side effect of the bug that
 * backgrounded your own live run. Take the bug away and nothing was left to
 * light the row.
 *
 * Underneath were two separate mistakes, and each is asserted here on its own
 * because either one alone still leaves rows dark.
 *
 * ## It asked the panes from inside a window selector
 *
 * The marker read `allPanes(s).some(p => paneState(p).resumeSessionId === id)`
 * from inside `useApp(...)`. `useApp` subscribes to the *window* store; the
 * panes are one store each. Nothing about a pane can invalidate that selector,
 * so the row repainted only when some unrelated window write happened along —
 * which is the exact trap `syncRunningSessions` was written to get out of, one
 * field over. The answer is now projected into the window by the same
 * subscription, as `AppState.openSessions`.
 *
 * ## It compared the wrong id
 *
 * `resumeSessionId` is the session the *next prompt* continues, which is not
 * the same as the session on screen. It is null for a brand-new conversation
 * until the first turn ends, and after a fork it still names the history the
 * fork came out of. So the two cases where the mark matters most — the run you
 * are watching right now, and the fork you just made — were the two it got
 * wrong. `sessionShownBy` is the question the row is actually asking.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionList } from '@/components/SessionList';
import { focusedPane, useApp } from '@/state/store';
import { setPaneState } from '@/state/pane';
import { seedApp } from '@/state/testkit';

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

const SESSIONS = [
  session('s1', '/code/api', 10, 'Adapter seam'),
  session('s2', '/code/api', 90, 'Login redirect'),
];

beforeEach(() => {
  useApp.setState({ background: [], runningSessions: [], openSessions: [], sessionOrderHold: {} });
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
 * Whether a row is drawn as the open one.
 *
 * The marker is a *ground*: `bg-wash-strong` on the row's button — see the
 * `active` branch in `SessionList`. It used to be a left border as well, and
 * the Console pass took that away because the language marks a selection by
 * fill and not by edge; the fill is what both spellings always agreed on, so
 * this assertion did not have to change its subject, only its token.
 *
 * Asserted on the class rather than on a computed style because jsdom has no
 * stylesheet: what is being pinned down is that the component decided the row
 * was open, which is the half that broke.
 */
function marked(title: string): boolean {
  const button = screen.getByText(title).closest('button');
  if (!button) throw new Error(`no row button for “${title}”`);
  return button.className.includes('bg-wash-strong');
}

/**
 * Put a run on the focused column, the way the provider's events do.
 *
 * `session.started` sets the run's own id and touches nothing else;
 * `resumeSessionId` is not written until `run.end`. That gap is the bug, so the
 * tests reproduce it exactly rather than seeding both fields.
 */
function startRunning(sessionId?: string): void {
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
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    } as never);
  });
}

describe('the open-session marker', () => {
  it('marks the row of a session running in a column', () => {
    mount(<SessionList />);
    expect(marked('Adapter seam')).toBe(false);

    startRunning('s1');

    // The reported symptom at its plainest: the conversation is on screen, its
    // row is in the list, and the row said nothing. `resumeSessionId` is still
    // null here — the first turn has not ended — which is why reading it alone
    // could never have marked this row.
    expect(marked('Adapter seam')).toBe(true);
  });

  it('repaints on a pane write, with nothing else touching the window', () => {
    mount(<SessionList />);

    act(() => {
      setPaneState(focusedPane(), { resumeSessionId: 's1' } as never);
    });

    // No `useApp.setState` anywhere in that act. The old selector reached into
    // the panes from a window subscription and so sat stale until something
    // unrelated wrote to the window — a refresh, a banner, the palette opening.
    // The projection is what makes a pane write reach the sidebar at all.
    expect(marked('Adapter seam')).toBe(true);
  });

  it('marks the session a fork is showing, not the one it came out of', () => {
    mount(<SessionList />);

    // What forking leaves behind: a new run, and `resumeSessionId` still naming
    // the history the fork was taken from.
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
          sessionId: 's2',
        },
        resumeSessionId: 's1',
      } as never);
    });

    expect(marked('Login redirect')).toBe(true);
    // And the row it forked from is not also lit. Two marked rows for one
    // column is a claim that the user has two conversations open.
    expect(marked('Adapter seam')).toBe(false);
  });

  it('marks a row picked out of history', () => {
    mount(<SessionList />);

    fireEvent.click(screen.getByText('Login redirect'));

    expect(marked('Login redirect')).toBe(true);
    expect(marked('Adapter seam')).toBe(false);
  });

  it('leaves the mark where it is when the row is clicked again', () => {
    mount(<SessionList />);
    fireEvent.click(screen.getByText('Login redirect'));

    // Clicking the open row is a no-op by design — it must not background the
    // conversation and reopen it. The mark has to survive that, which is the
    // whole point: it can no longer be a side effect of the click.
    fireEvent.click(screen.getByText('Login redirect'));

    expect(marked('Login redirect')).toBe(true);
  });

  it('clears the mark when the column moves to another session', () => {
    mount(<SessionList />);
    fireEvent.click(screen.getByText('Login redirect'));
    expect(marked('Login redirect')).toBe(true);

    fireEvent.click(screen.getByText('Adapter seam'));

    // One column, one open session. A marker that only ever accumulated would
    // end the day claiming every row in the list.
    expect(marked('Adapter seam')).toBe(true);
    expect(marked('Login redirect')).toBe(false);
  });

  it('does not mark a conversation that has no column', () => {
    mount(<SessionList />);
    startRunning('s1');
    expect(marked('Adapter seam')).toBe(true);

    // Backgrounded: the run carries on, but nothing on screen is showing it.
    act(() => {
      const pane = focusedPane();
      setPaneState(pane, { run: null, resumeSessionId: null } as never);
      useApp.setState((s) => ({ background: [...s.background, pane] }));
    });

    // It keeps its running dot — `runningSessions` spans the background on
    // purpose — but "open" is a claim about a column, and there is not one.
    expect(marked('Adapter seam')).toBe(false);
    expect(useApp.getState().runningSessions).toEqual([]);
  });
});
