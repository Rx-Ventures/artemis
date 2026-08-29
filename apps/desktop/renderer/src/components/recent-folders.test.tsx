/**
 * @vitest-environment jsdom
 *
 * The folder menu above the composer, and the pane that edits its list.
 *
 * The chip used to open the host's file dialog; it now opens a menu of folders
 * the window has worked in, with that dialog one row further down. Three things
 * about that are worth holding still:
 *
 *  1. **The trigger is wired.** It is a `DropdownMenuTrigger asChild` inside a
 *     `TooltipTrigger asChild` — two Slots merging props onto one button. A
 *     button that renders perfectly and opens nothing is exactly what a dropped
 *     spread produces, and only opening it catches that. See the same warning
 *     over `status line / the pickers actually open`.
 *  2. **Rows are alphabetical.** The list is *stored* most-recent-first because
 *     that is what decides which folder is dropped at the cap; drawing it in
 *     that order would rearrange the menu around whatever the user last did, so
 *     the row they are aiming at is never where it was. The seed below is in
 *     recency order deliberately, so a render that forgot to sort would fail.
 *  3. **Add folder… still reaches the dialog.** The menu is a shortcut past the
 *     chooser, not a replacement for it — a folder the app has never been in has
 *     no other way in.
 *
 * The This-machine half (the list is edited in the pane at the `advanced` id
 * now — a record the installation keeps, not a taste) asserts that removal
 * exists in both shapes the user needs — one row, or a ticked set — and that
 * neither touches the working directory.
 *
 * As elsewhere, `renderer/tsconfig.json` excludes test files, so the assertions
 * are behavioural rather than typed.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Composer } from '@/components/Composer';
import { AdvancedSection } from '@/components/settings/AdvancedSection';
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
/* Radix's dismissable layer measures the pointer capture surface. */
Element.prototype.hasPointerCapture ??= function hasPointerCapture(): boolean {
  return false;
};
Element.prototype.releasePointerCapture ??= function releasePointerCapture(): void {};

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default', 'plan'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

/**
 * Three folders, seeded in recency order and *not* in alphabetical order.
 *
 * `web` is the working directory and the most recently opened, so a menu drawn
 * in stored order would put it first. Alphabetically it is last. Every ordering
 * assertion below rests on that disagreement.
 */
const FOLDERS = ['/Users/me/work/web', '/Users/me/work/api', '/Users/me/archive/docs'];

beforeEach(() => {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/Users/me/work/web',
    workspace: null,
    run: null,
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
    sidebarCollapsed: false,
    model: null,
    effort: null,
    permissionMode: 'default',
    paletteOpen: false,
    infoOpen: false,
    promptHistory: [],
    recentFolders: FOLDERS,
  });
});

afterEach(cleanup);

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/**
 * Open the chip's menu the way Radix listens for it, and wait for the menu.
 *
 * `aria-expanded` rather than `data-state`, and the difference is a trap worth
 * naming: this trigger is wrapped in a tooltip, and Radix's trigger spreads the
 * props it was handed *after* its own — so the `data-state` on this button is
 * the tooltip's, permanently "closed" while the menu beside it is open. The
 * expanded flag has only one owner.
 */
async function openFolderMenu(): Promise<HTMLElement> {
  const trigger = screen.getByLabelText('Working directory — change it');
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
  return trigger;
}

const folderRows = (): readonly string[] =>
  screen.getAllByRole('menuitemradio').map((row) => row.textContent ?? '');

describe('the folder menu', () => {
  it('opens from the chip', async () => {
    mount(<Composer />);

    const trigger = screen.getByLabelText('Working directory — change it');
    // Radix writes this onto whatever element the Slot cloned. Absent means the
    // trigger's props were dropped somewhere in the two nested `asChild`s.
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

    await openFolderMenu();
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('lists every remembered folder', async () => {
    mount(<Composer />);
    await openFolderMenu();

    expect(folderRows()).toHaveLength(FOLDERS.length);
  });

  it('draws them alphabetically rather than in the order they were used', async () => {
    mount(<Composer />);
    await openFolderMenu();

    // Each row is a name over a path; the leading run before the path is the
    // name the user actually reads down the menu.
    const names = folderRows().map((text) => /^[^~/]*/.exec(text)?.[0]);
    // `web` was seeded first and is the current directory; alphabetically it is
    // last. A menu that reorders itself around recent use cannot be learned.
    expect(names).toEqual(['api', 'docs', 'web']);
  });

  it('shows the path under each name, for two folders of the same name', async () => {
    mount(<Composer />);
    await openFolderMenu();

    // Shortened for width, with the home directory collapsed — the full path is
    // on the row's `title`, which is the rule for every shortened path here.
    expect(screen.getByRole('menuitemradio', { name: /~\/work\/api/ })).toBeTruthy();
  });

  it('ticks the folder currently being worked in', async () => {
    mount(<Composer />);
    await openFolderMenu();

    const current = screen.getByRole('menuitemradio', { name: /web/ });
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByRole('menuitemradio', { name: /api/ }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('moves the working directory when a folder is chosen', async () => {
    mount(<Composer />);
    await openFolderMenu();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /api/ }));

    // Through `setCwd`, so this inherits its rules whole — the selected session
    // is dropped rather than aimed at a directory it cannot resolve in.
    await waitFor(() => expect(appSession().cwd).toBe('/Users/me/work/api'));
  });

  it('offers the folder chooser as its last row', async () => {
    mount(<Composer />);
    await openFolderMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /Add folder/ }));

    // The dialog that was previously the chip's only behaviour. A folder the app
    // has never been in has no other way in.
    expect(await screen.findByText('Set working directory')).toBeTruthy();
  });

  it('still offers Add folder… when nothing has been remembered', async () => {
    seedApp({ recentFolders: [] });
    mount(<Composer />);
    await openFolderMenu();

    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(screen.getByText(/No folders remembered yet/)).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Add folder/ })).toBeTruthy();
  });
});

describe('this machine / recent folders', () => {
  const rowNames = (): readonly string[] =>
    screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label') ?? '');

  it('lists the folders alphabetically, as the menu does', () => {
    mount(<AdvancedSection />);

    // Rows are labelled by path — two checkouts of one repository would sound
    // identical otherwise — and ordered by name, so `web` is last despite being
    // both the current directory and the most recently used.
    expect(rowNames()).toEqual([
      'Select /Users/me/work/api',
      'Select /Users/me/archive/docs',
      'Select /Users/me/work/web',
    ]);
  });

  it('forgets one folder from its own row', async () => {
    mount(<AdvancedSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Forget /Users/me/work/api' }));

    await waitFor(() => expect(useApp.getState().recentFolders).not.toContain('/Users/me/work/api'));
    expect(useApp.getState().recentFolders).toHaveLength(2);
  });

  it('forgets a ticked set in one go', async () => {
    mount(<AdvancedSection />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select /Users/me/work/api' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select /Users/me/archive/docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2 folders' }));

    await waitFor(() =>
      expect(useApp.getState().recentFolders).toEqual(['/Users/me/work/web']),
    );
  });

  it('ticks every folder at once', async () => {
    mount(<AdvancedSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove 3 folders' }));

    await waitFor(() => expect(useApp.getState().recentFolders).toEqual([]));
  });

  it('will not remove until something is ticked, and says so', async () => {
    mount(<AdvancedSection />);

    const remove = screen.getByRole('button', { name: 'Remove selected' });
    // The app's rule for every gated control: present, disabled, and carrying
    // the reason — never silently missing. `aria-disabled` rather than
    // `disabled`, because a truly disabled button cannot be hovered for the
    // explanation; see `ReasonButton`.
    expect(remove.getAttribute('aria-disabled')).toBe('true');

    fireEvent.focus(remove);
    expect(await screen.findByText(/Tick the folders you want removed first/)).toBeTruthy();
  });

  it('leaves the working directory where it is', async () => {
    mount(<AdvancedSection />);

    // `web` is the directory the session is running in. Forgetting it is
    // bookkeeping; moving it would end a session from a settings pane.
    fireEvent.click(screen.getByRole('button', { name: 'Forget /Users/me/work/web' }));

    await waitFor(() => expect(useApp.getState().recentFolders).not.toContain('/Users/me/work/web'));
    expect(appSession().cwd).toBe('/Users/me/work/web');
  });

  it('says what the list is when it is empty', () => {
    seedApp({ recentFolders: [] });
    mount(<AdvancedSection />);

    expect(screen.getByText(/No folders remembered yet/)).toBeTruthy();
  });
});
