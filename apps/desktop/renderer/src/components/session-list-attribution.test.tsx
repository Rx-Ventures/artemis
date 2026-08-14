/**
 * @vitest-environment jsdom
 *
 * Whose conversation is this?
 *
 * Reported as every row in the sidebar naming the same account after the shared
 * `~/.claude` arrangement was switched on. Nothing was mislabelled by accident:
 * sharing symlinks `projects/` from each profile into the user's own config
 * directory, all the profiles then read one store, and the adapter — which
 * cannot tell from a transcript who ran it, because Claude does not record that
 * anywhere — puts the first sharer on every summary and marks the pick with
 * `profileIsUnknown`. Stable, and meaningless, and rendered as a fact it was a
 * confident wrong answer to the only question the account marker exists for.
 *
 * Two halves are asserted here, and the second is why this is not simply a
 * hidden badge:
 *
 *  1. A row with no recorded owner shows no account at all. Absent is honest
 *     where arbitrary is not, and a placeholder word would sit on most rows of
 *     a shared install's history reading like a field that failed to load.
 *  2. A row whose owner *has* been recorded shows it — and the filing the user
 *     did while it was unattributed survives the change. Pins and archive are
 *     persisted as `profileId:id`, so attribution moves the key; a pinned
 *     conversation quietly leaving the Pinned section the first time it is
 *     opened would be their own filing undone by a correction they never asked
 *     for.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionList } from '@/components/SessionList';
import { toggleSessionPinned, useApp } from '@/state/store';
import { sessionKeyAliases } from '@/lib/sessionGroups';
import { sessionTooltipRows } from '@/lib/sessionTooltip';
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

/**
 * Three accounts sharing one store, which is the arrangement under test.
 *
 * Named as the reporter's are, because the bug is about which of several
 * plausible labels lands on a row, and `p1`/`p2`/`p3` would let a wrong answer
 * read as a right one.
 */
const PROFILES = [
  { id: 'p1', label: 'storrence.dev', providerId: 'claude', configDir: '/u/.a' },
  { id: 'p2', label: 'Work - Team', providerId: 'claude', configDir: '/u/.b' },
  { id: 'p3', label: 'Work - Max', providerId: 'claude', configDir: '/u/.c' },
];

/** A row out of a shared store: first sharer on it, and the pick flagged as one. */
function unattributed(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    cwd: '/code/api',
    updatedAt: 10,
    providerId: 'claude',
    profileId: 'p1',
    alsoInProfiles: ['p2', 'p3'],
    profileIsUnknown: true,
  } as SessionSummary;
}

/** The same row after the ledger settled it: a real owner, and no flag. */
function attributed(id: string, title: string, profileId: string): SessionSummary {
  return {
    id,
    title,
    cwd: '/code/api',
    updatedAt: 10,
    providerId: 'claude',
    profileId,
    alsoInProfiles: ['p1', 'p2', 'p3'].filter((p) => p !== profileId),
  } as SessionSummary;
}

function seed(sessions: readonly SessionSummary[]): void {
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
    profiles: PROFILES,
    activeProfileId: 'p1',
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions,
    sessionsLoading: false,
    sessionsError: null,
    collapsedProjects: [],
    pinnedSessions: [],
    archivedSessions: [],
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
  });
}

beforeEach(() => {
  seed([unattributed('s1', 'Adapter seam')]);
});

afterEach(cleanup);

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

describe('a row whose account was never recorded', () => {
  it('names no account at all', () => {
    mount(<SessionList />);

    // The report, stated directly. `storrence.dev` is on the summary — it is
    // the adapter's pick — and it must not reach the screen, because the same
    // pick lands on every shared row.
    expect(screen.getByText('Adapter seam')).not.toBeNull();
    expect(screen.queryByText('storrence.dev')).toBeNull();
  });

  it('does not name one of the others either', () => {
    mount(<SessionList />);

    expect(screen.queryByText('Work - Team')).toBeNull();
    expect(screen.queryByText('Work - Max')).toBeNull();
  });

  it('stays resumable, because every sharer can still reach it', () => {
    mount(<SessionList />);

    // Not orphaned: an unknown owner is not a missing one. The transcript is
    // there and three accounts can open it.
    const row = screen.getByText('Adapter seam').closest('button');
    expect(row?.hasAttribute('disabled')).toBe(false);
  });

  it('says which of the two it is, where there is room to say it', () => {
    // The row is silent by design, and silence reads as a field that failed to
    // load. The tooltip is the surface with room for the distinction.
    const rows = sessionTooltipRows(unattributed('s1', 'Adapter seam'), {
      profileLabel: 'storrence.dev',
      now: 20,
    });
    const profile = rows.find((row) => row.label === 'profile');

    expect(profile?.value).toBe('not recorded — 3 accounts share this history');
    // And emphatically not the pick, even though it was offered.
    expect(profile?.value).not.toContain('storrence.dev');
  });
});

describe('a row whose account is known', () => {
  it('names it', () => {
    seed([attributed('s1', 'Adapter seam', 'p3')]);
    mount(<SessionList />);

    // The account that actually ran it — not `p1`, which is what every row said
    // before the ledger existed.
    expect(screen.getByText('Work - Max')).not.toBeNull();
    expect(screen.queryByText('storrence.dev')).toBeNull();
  });

  it('is still reachable when the profile the adapter had picked is deleted', () => {
    seed([attributed('s1', 'Adapter seam', 'p3')]);
    act(() => {
      useApp.setState({ profiles: PROFILES.filter((p) => p.id !== 'p1') });
    });
    mount(<SessionList />);

    // With `projects/` shared, deleting one sharer leaves the transcript where
    // it was and two accounts still reading it. Treating the row as orphaned
    // would disable a resume that works.
    const row = screen.getByText('Adapter seam').closest('button');
    expect(row?.hasAttribute('disabled')).toBe(false);
  });
});

describe('filing that survives being attributed', () => {
  it('keeps a pin made before the owner was known', () => {
    const before = unattributed('s1', 'Adapter seam');
    seed([before]);

    act(() => {
      toggleSessionPinned(before);
    });
    expect(useApp.getState().pinnedSessions).toEqual(['p1:s1']);

    // The user opens it; the ledger records `p3`; the next listing names `p3`.
    // The id did not change and the transcript did not move — only the key.
    act(() => {
      useApp.setState({ sessions: [attributed('s1', 'Adapter seam', 'p3')] });
    });

    mount(<SessionList />);
    expect(screen.getByText('Pinned')).not.toBeNull();
    // Under the Pinned heading, which is the whole assertion: keyed on `p1:s1`
    // and matched through the sharer set.
    expect(screen.getByText('Adapter seam')).not.toBeNull();
    expect(useApp.getState().pinnedSessions).toEqual(['p1:s1']);
  });

  it('converges the stored key the next time the row is toggled', () => {
    seed([unattributed('s1', 'Adapter seam')]);
    act(() => {
      toggleSessionPinned(unattributed('s1', 'Adapter seam'));
    });

    const now = attributed('s1', 'Adapter seam', 'p3');
    act(() => {
      useApp.setState({ sessions: [now] });
    });

    // Unpinning has to find the old key to clear it, or the row would stay
    // pinned and the click would look ignored.
    act(() => {
      toggleSessionPinned(now);
    });
    expect(useApp.getState().pinnedSessions).toEqual([]);

    // And pinning again writes the canonical key, so the aliases do not
    // accumulate in the preferences file forever.
    act(() => {
      toggleSessionPinned(now);
    });
    expect(useApp.getState().pinnedSessions).toEqual(['p3:s1']);
  });

  it('lists an unshared session under exactly one key, as it always did', () => {
    const solo = {
      id: 's9',
      title: 'Private',
      cwd: '/code/api',
      updatedAt: 10,
      providerId: 'claude',
      profileId: 'p2',
    } as SessionSummary;

    // The ordinary case is untouched: one profile, one store, one key — the
    // same string and the same cost as before any of this.
    expect(sessionKeyAliases(solo)).toEqual(['p2:s9']);
  });
});
