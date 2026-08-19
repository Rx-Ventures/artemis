/**
 * @vitest-environment jsdom
 *
 * The command bar searching what it says it searches.
 *
 * The bar's own description reads "Search sessions, switch profile or model,
 * and run commands", and the header's entry says "Search sessions and
 * commands" — and until this, typing a session's name into it produced
 * "Nothing matches that". Sessions were a page down, behind a row called
 * "Resume a past session…", which is a thing you cannot find by searching for
 * the thing you actually want.
 *
 * So the claims here are about the *root* page, because that is the surface the
 * promise is made on:
 *
 *  - a query matches sessions by title, by opening prompt, by project and by
 *    profile — everything `SessionRow` puts in its search value;
 *  - an empty query does not list them, because a palette that opens onto a
 *    hundred sessions has buried its commands;
 *  - picking one resumes it, which is the only reason to have found it.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** Sessions the fake main process would hand back. */
const resumed: string[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  version: 'test',
  platform: 'darwin',
  runs: { list: async () => ({ ok: true, value: { runs: [] } }), onEvent: () => () => undefined },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
  },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

const { CommandPalette } = await import('@/components/CommandPalette');
const { setPalette, useApp } = await import('@/state/store');
const { capabilities, seedApp } = await import('@/state/testkit');

vi.mock('@/state/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/state/store')>();
  return {
    ...real,
    resumeSession: (session: { readonly id: string }) => {
      resumed.push(session.id);
    },
  };
});

const CAPABILITIES = capabilities();

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 's1',
    title: 'Untitled',
    cwd: '/Users/me/project',
    updatedAt: 1_700_000_000_000,
    profileId: 'p1',
    ...over,
  }) as SessionSummary;

const SESSIONS = [
  session({ id: 's1', title: 'Rename the mapper', firstPrompt: 'rename mapSession to adopt' }),
  session({ id: 's2', title: 'Auth flow', cwd: '/Users/me/other', firstPrompt: 'why is login 401' }),
  session({ id: 's3', title: 'Icon rounding', firstPrompt: 'the square icon breaks the dock' }),
];

function mount(): void {
  render(
    <TooltipProvider>
      <CommandPalette />
    </TooltipProvider>,
  );
}

/** Type into the palette's own input, which is what cmdk filters on. */
function type(query: string): void {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
}

beforeEach(() => {
  resumed.length = 0;
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [
      { id: 'p1', label: 'Work', providerId: 'claude', configDir: '/Users/me/.claude' },
    ],
    activeProfileId: 'p1',
    run: null,
    permissionQueue: [],
  } as never);
  useApp.setState({ sessions: SESSIONS, sessionsLoading: false, sessionsError: null });
  act(() => setPalette(true));
});

afterEach(() => {
  act(() => setPalette(false));
  cleanup();
});

describe('the command bar, on the page it opens onto', () => {
  it('does not list sessions before anything is typed', () => {
    mount();

    // A palette that opens onto the whole history is a menu, not a search —
    // and the commands it also carries would be unreachable by eye.
    expect(screen.queryByText('Rename the mapper')).toBeNull();
    expect(screen.getByText('New session')).not.toBeNull();
  });

  it('finds a session by its title, without leaving the page', () => {
    mount();
    type('mapper');

    expect(screen.getByText('Rename the mapper')).not.toBeNull();
    // And only that one: the other two do not match, so cmdk drops them.
    expect(screen.queryByText('Auth flow')).toBeNull();
  });

  it('finds one by its opening prompt, which is often all anyone remembers', () => {
    mount();
    type('401');

    expect(screen.getByText('Auth flow')).not.toBeNull();
    expect(screen.queryByText('Rename the mapper')).toBeNull();
  });

  it('finds one by the project it was in', () => {
    mount();
    type('other');

    expect(screen.getByText('Auth flow')).not.toBeNull();
  });

  it('resumes the one that is picked', () => {
    mount();
    type('mapper');
    fireEvent.click(screen.getByText('Rename the mapper'));

    expect(resumed).toEqual(['s1']);
    // And closes, because the palette's job is done the moment it is answered.
    expect(useApp.getState().paletteOpen).toBe(false);
  });

  it('still finds commands, which are what it was already good at', () => {
    mount();
    type('probe');

    expect(screen.getByText('Re-probe providers')).not.toBeNull();
    // No session says "probe", so no session row is drawn. cmdk keeps the
    // group's heading in the DOM and hides it, which is why this asks about a
    // row rather than about the heading.
    expect(screen.queryByText('Rename the mapper')).toBeNull();
  });
});
