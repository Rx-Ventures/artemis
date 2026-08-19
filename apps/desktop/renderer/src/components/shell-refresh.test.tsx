/**
 * @vitest-environment jsdom
 *
 * The two structural changes from `docs/design/_layout.md`.
 *
 * **The rail never disappears (item 1).** It used to be the collapsed *state*
 * of the sidebar — one or the other, never both — which is a narrower thing
 * than it looks. A rail that exists only while the list is shut is not a
 * navigator, it is an undo button for having shut it. And it is the reason the
 * header grew a sidebar toggle in the first place: the thing that collapsed
 * vanished with the click, so something else had to hold the way back.
 *
 * **One update surface (item 3).** The update had three homes, each added
 * because the one before it could disappear: a card in the sidebar, a dot on
 * the rail once the sidebar was shut, and a strip under the header for when
 * both were gone. The command bar cannot disappear, so it carries the one and
 * the other two are gone.
 *
 * Same caveat as the sibling component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UpdateState } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from '@/components/Sidebar';
import { TasksPane } from '@/components/TasksPane';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { AppHeader } from '@/components/AppHeader';
import { seedApp } from '@/state/testkit';
import { allLivePanes, focusedPane, splitPane, useApp } from '@/state/store';
import { setPaneState } from '@/state/pane';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** The updater's push, captured so a test can drive it. */
let pushState: ((next: UpdateState) => void) | null = null;
const installed: string[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  version: '1.0.0',
  platform: 'darwin',
  runs: { list: async () => ({ ok: true, value: { runs: [] } }), onEvent: () => () => undefined },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
  window: {
    state: async () => ({ ok: true, value: { state: { fullScreen: false, maximized: false } } }),
    onStateChange: () => () => undefined,
  },
  updates: {
    state: async () => ({ ok: true, value: { state: IDLE } }),
    install: async () => {
      installed.push('install');
      return { ok: true, value: { state: IDLE } };
    },
    restart: async () => {
      installed.push('restart');
      return { ok: true, value: { state: IDLE } };
    },
    onChange: (listener: (next: UpdateState) => void) => {
      pushState = listener;
      return () => {
        pushState = null;
      };
    },
  },
};

const IDLE: UpdateState = { phase: 'idle', version: null, message: null, releaseUrl: null };

const mount = (ui: React.ReactNode): void => {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
};

beforeEach(() => {
  installed.length = 0;
  seedApp({
    providers: [],
    profiles: [],
    sessions: [],
    banners: [],
    cwd: '/repo',
    sidebarCollapsed: false,
  } as never);
});

afterEach(cleanup);

describe('the navigator rail', () => {
  it('is mounted whether the list is open or shut', () => {
    // By role, not by label: the rail carries a *button* called "Sessions" as
    // well, and `getByLabelText` cannot tell the column from the control that
    // selects it.
    const column = () => screen.queryByRole('complementary', { name: 'Sessions' });
    const rail = () => screen.queryByRole('complementary', { name: 'Navigator' });

    mount(<Sidebar />);
    expect(rail()).toBeTruthy();
    expect(column()).toBeTruthy();

    cleanup();
    useApp.setState({ sidebarCollapsed: true });
    mount(<Sidebar />);

    // The rail survives; only the list goes.
    expect(rail()).toBeTruthy();
    expect(column()).toBeNull();
  });

  it('toggles the list in both directions from the same place', () => {
    // The whole reason it is permanent. Collapse used to be reversible only
    // from a control in the header, because the button that collapsed the
    // sidebar went with it.
    mount(<Sidebar />);

    // The caption's chevron shuts it; the rail's view button brings it back.
    // Two controls, two jobs — not one job twice.
    fireEvent.click(screen.getByRole('button', { name: /Hide the sidebar/ }));
    expect(useApp.getState().sidebarCollapsed).toBe(true);

    cleanup();
    mount(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Show sessions/ }));
    expect(useApp.getState().sidebarCollapsed).toBe(false);
  });
});

describe('one update surface', () => {
  it('says nothing while the updater is idle', () => {
    mount(<AppHeader />);
    expect(screen.queryByRole('button', { name: /Artemis .* is available/ })).toBeNull();
  });

  it('appears in the command bar when there is something to say', async () => {
    mount(<AppHeader />);
    await act(async () => {
      pushState?.({ phase: 'available', version: '1.1.0', message: null, releaseUrl: null });
    });

    const chip = screen.getByRole('button', { name: 'Artemis 1.1.0 is available' });
    fireEvent.click(chip);
    expect(installed).toEqual(['install']);
  });

  it('offers the restart once the new version is staged', async () => {
    // The two things anyone wants from an update surface. Everything the card
    // used to say was a consequence of one of them.
    mount(<AppHeader />);
    await act(async () => {
      pushState?.({ phase: 'ready', version: '1.1.0', message: null, releaseUrl: null });
    });

    fireEvent.click(screen.getByRole('button', { name: /ready — restart to use it/ }));
    expect(installed).toEqual(['restart']);
  });

  it('does not offer a click while it is working', async () => {
    mount(<AppHeader />);
    await act(async () => {
      pushState?.({ phase: 'working', version: '1.1.0', message: null, releaseUrl: null });
    });

    const chip = screen.getByRole('button', { name: /Working on Artemis/ });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    expect(installed).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The dock's scope (item 5)                                                  */
/* -------------------------------------------------------------------------- */

/** A delegated task, with the fields the row actually reads. */
const task = (id: string, status = 'running') =>
  ({
    id,
    status,
    kind: 'agent',
    name: `task ${id}`,
    description: `task ${id}`,
    startedAt: 1,
  }) as never;

describe('the delegated view has a scope', () => {
  beforeEach(() => {
    useApp.setState({ dockScope: 'pane' });
    setPaneState(focusedPane(), { tasks: [task('a')] } as never);
  });

  it('shows this column by default, because the tab names one conversation', () => {
    const pane = focusedPane();
    mount(<TasksPane paneId={pane.id} />);

    expect(screen.getByRole('button', { name: 'this pane' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByLabelText('Delegated work').children).toHaveLength(1);
  });

  it('gathers every column when asked, and persists the choice', () => {
    const pane = focusedPane();
    mount(<TasksPane paneId={pane.id} />);

    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(useApp.getState().dockScope).toBe('all');

    const stored = JSON.parse(localStorage.getItem('artemis.prefs.v1') ?? '{}');
    expect(stored.dockScope).toBe('all');
  });

  it('survives a split while it is showing every column', () => {
    /*
     * The case the first implementation would have thrown on.
     *
     * It called `usePaneTasks` inside a `map` over the panes, so the number of
     * hooks this component ran was the number of columns open — and splitting
     * one changes that mid-life, which is exactly the invariant React enforces.
     * One subscription over every store keeps the count fixed.
     */
    useApp.setState({ dockScope: 'all' });
    const pane = focusedPane();
    mount(<TasksPane paneId={pane.id} />);

    expect(() => {
      act(() => {
        splitPane(pane);
      });
    }).not.toThrow();

    expect(allLivePanes(useApp.getState()).length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'all' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the command bar carries the way into search', () => {
  it('offers a search entry that opens the palette', () => {
    // `_layout.md` item 2. A button dressed as a field: the palette owns the
    // input, and two text boxes for one query would be one too many — but
    // people look for search in something search-shaped, and ⌘K is both the
    // fastest way in and the one nobody finds unaided.
    mount(<AppHeader />);

    fireEvent.click(screen.getByRole('button', { name: /Search sessions, files and commands/ }));
    expect(useApp.getState().paletteOpen).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The prompt bubble keeps its shape                                          */
/* -------------------------------------------------------------------------- */

/**
 * Moving the user bubble off the accent broke it, and the break was invisible
 * to every existing test.
 *
 * The fill was changed by switching to `variant="ghost"` and adding the colours
 * as classes. `ghost` is the "no bubble at all" variant: it sets
 * `rounded-none`, `p-0` and `bg-transparent` on the content and `max-w-full` on
 * the root, all through `*:data-[slot=...]` selectors that outrank anything the
 * caller passes. The prompt shipped as a full-width square with no padding.
 *
 * So the fill lives in a `surface` variant now, and this pins the three things
 * that went missing. Asserted on the class list rather than on computed style
 * because jsdom does not run Tailwind — what is being checked is that the
 * variant does not *strip* the geometry, which is a fact about the class list.
 */
describe('the prompt bubble', () => {
  it('keeps its radius, padding and width cap on the surface variant', () => {
    render(
      <Bubble align="end" variant="surface">
        <BubbleContent className="rounded-2xl rounded-br-sm px-3.5 py-2">hello</BubbleContent>
      </Bubble>,
    );

    const content = screen.getByText('hello');
    expect(content.className).toContain('rounded-2xl');
    expect(content.className).toContain('px-3.5');
    expect(content.className).not.toContain('rounded-none');
    expect(content.className).not.toContain('p-0');
  });

  it('does not let the variant widen the bubble to the full column', () => {
    // `max-w-[80%]` is what makes an aligned bubble read as *from* someone.
    // `ghost` removes it; `surface` must not.
    const { container } = render(
      <Bubble align="end" variant="surface">
        <BubbleContent>hello</BubbleContent>
      </Bubble>,
    );

    const root = container.firstElementChild;
    expect(root?.className).toContain('max-w-[80%]');
    /*
     * On the attribute, not the class list. The base string carries
     * `data-[variant=ghost]:max-w-full`, which contains the literal
     * "max-w-full" but only applies when the variant *is* ghost — a substring
     * check would fail on a bubble that is behaving perfectly. What matters is
     * that this bubble is not the ghost one.
     */
    expect(root?.getAttribute('data-variant')).toBe('surface');
  });
});
