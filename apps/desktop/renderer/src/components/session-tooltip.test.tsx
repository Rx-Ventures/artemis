/**
 * @vitest-environment jsdom
 *
 * The sidebar's hover card.
 *
 * Reported as "sidebar items overflow" (#85): the row's tooltip was one
 * dash-joined sentence, a working directory is one unbroken token, and a token
 * wider than the bubble's `max-w` walked straight past its border. The fix is
 * structural — a labelled card whose long-token values carry `break-all` — and
 * these tests pin the structure, which is as much of it as jsdom can see: it
 * lays no text out, so "stays inside the bubble" is asserted as "the value is
 * in a node whose classes make it breakable", plus the content contract that
 * made the card worth building — the *full* title, where the row shows eight
 * words.
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

/** The kind of token that escaped the bubble: long, and with no spaces. */
const LONG_CWD = '/Users/ada/Documents/artemis/.claude/worktrees/agent-acaa86d825afa821e';
/** Twelve words, so the row shows `condenseTitle`'s eight and the card all. */
const LONG_TITLE =
  'Stop the working directory from walking straight out of the sidebar tooltip bubble';
const CONDENSED_TITLE = 'Stop the working directory from walking straight out…';

const SESSIONS: readonly SessionSummary[] = [
  {
    id: 's1',
    providerId: 'claude',
    profileId: 'p1',
    cwd: LONG_CWD,
    title: LONG_TITLE,
    updatedAt: Date.now() - 4 * 60_000,
    gitBranch: 'release/0.8.1-tooltip-overflow',
    model: 'claude-fable-5',
    messageCount: 34,
  } as SessionSummary,
  {
    id: 's2',
    providerId: 'claude',
    profileId: 'p1',
    cwd: LONG_CWD,
    title: 'Second session, same project',
    updatedAt: Date.now() - 60 * 60_000,
  } as SessionSummary,
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
    profiles: [
      {
        id: 'p1',
        label: 'Work',
        providerId: 'claude',
        configDir: '/home/u/.claude',
        color: '#7c9a72',
      },
    ],
    activeProfileId: 'p1',
    cwd: LONG_CWD,
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

/** The session row's button, found by its condensed first line. */
function rowButton(condensed: string): HTMLElement {
  const button = screen.getByText(condensed).closest('button');
  if (!button) throw new Error(`no row button for “${condensed}”`);
  return button;
}

/** Focus opens the tooltip the same way hover does, minus jsdom's no-layout. */
async function openTooltipOn(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.focus(element);
  });
}

describe('the session row tooltip', () => {
  it('shows the whole title where the row shows eight words', async () => {
    mount(<SessionList />);

    // The row is folded; the full string is nowhere in the DOM yet.
    expect(screen.queryByText(LONG_TITLE)).toBeNull();

    await openTooltipOn(rowButton(CONDENSED_TITLE));
    expect(await screen.findAllByText(LONG_TITLE)).not.toHaveLength(0);
  });

  it('lays the facts out as labelled rows rather than one sentence', async () => {
    mount(<SessionList />);
    await openTooltipOn(rowButton(CONDENSED_TITLE));

    for (const label of ['directory', 'branch', 'profile', 'model', 'messages', 'activity']) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    }
    expect((await screen.findAllByText(LONG_CWD)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('claude-fable-5')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('34')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('4m ago')).length).toBeGreaterThan(0);
  });

  it('makes the directory breakable, which is what kept it inside the bubble', async () => {
    mount(<SessionList />);
    await openTooltipOn(rowButton(CONDENSED_TITLE));

    // jsdom lays nothing out, so the wrapping contract is asserted as the
    // class that implements it: an unbroken token in a `break-all` node
    // cannot overrun the bubble the way the old sentence did.
    const values = await screen.findAllByText(LONG_CWD);
    expect(values.some((el) => el.className.includes('break-all'))).toBe(true);
  });

  it('says a session is running now, and only when it is', async () => {
    mount(<SessionList />);
    await openTooltipOn(rowButton(CONDENSED_TITLE));
    expect(screen.queryByText('Running now')).toBeNull();

    /*
     * Through the pane, the way a real run arrives. `runningSessions` is a
     * projection recomputed from the panes on every window write
     * (`syncFromPanes`), so seeding it directly is a write the store itself
     * reverts.
     */
    act(() => {
      setPaneState(focusedPane(), {
        run: {
          runId: 'run-1',
          status: 'running',
          providerId: 'claude',
          profileId: 'p1',
          cwd: LONG_CWD,
          capabilities: CAPABILITIES,
          startedAt: 1,
          sessionId: 's1',
        },
      } as never);
    });

    await openTooltipOn(rowButton(CONDENSED_TITLE));
    expect((await screen.findAllByText('Running now')).length).toBeGreaterThan(0);
  });
});

describe('the project heading tooltip', () => {
  it('carries the full root the heading truncates to a basename', async () => {
    mount(<SessionList />);

    const heading = screen.getByRole('button', { name: /agent-acaa86d825afa821e/ });
    await openTooltipOn(heading);

    expect((await screen.findAllByText(LONG_CWD)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('2 sessions')).length).toBeGreaterThan(0);
    // And the root is breakable, like the session row's directory.
    const values = await screen.findAllByText(LONG_CWD);
    expect(values.some((el) => el.className.includes('break-all'))).toBe(true);
  });
});
