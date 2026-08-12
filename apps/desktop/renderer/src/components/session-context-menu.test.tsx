/**
 * @vitest-environment jsdom
 *
 * The session row's right-click menu, and the two dialogs that guard delete.
 *
 * What is worth testing here is not that a menu opens — it is the three places
 * this feature can quietly do the wrong thing, each of which looks fine on
 * screen:
 *
 *  1. **The running-session confirmation replacing the ordinary one.** A
 *     warning bolted onto the familiar dialog is the thing a practised eye
 *     skips. The test asserts the ordinary copy is *absent*, not merely that
 *     the warning is present — "both dialogs at once" would pass a
 *     present-only check and defeat the entire point.
 *  2. **Delete leaving the row alone until the write is confirmed.** An
 *     optimistic delete tells the user their data is gone while it is still
 *     there.
 *  3. **Archive not touching the provider's store.** Archive and delete are one
 *     click apart in the same menu; the test that they route to different
 *     places is the one that catches a wiring mistake between them.
 *  4. **A letter doing something other than what its item says.** The hotkeys
 *     resolve through the DOM, so a key that found the wrong item — or found a
 *     disabled one and fired it anyway — would look exactly like a key that
 *     worked. `D` is the one that matters: it must reach the confirmation and
 *     never the delete itself.
 *
 * Radix menus and dialogs need a handful of browser APIs jsdom lacks; the stubs
 * at the top are the standard set this repo already uses for floating layers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Capabilities, ProviderDescriptor, SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { DeleteSessionDialog } from '@/components/DeleteSessionDialog';
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
/* Radix's dismissable layer measures the pointer capture surface. */
Element.prototype.hasPointerCapture ??= function hasPointerCapture(): boolean {
  return false;
};
Element.prototype.releasePointerCapture ??= function releasePointerCapture(): void {};

const ALL: Capabilities = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  renameSession: true,
  deleteSession: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

const SESSION: SessionSummary = {
  id: 'sess-1111-2222',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/w',
  title: 'An earlier session',
  updatedAt: Date.now(),
};

/** A second row, so a project heading survives lifting the first one out. */
const OTHER: SessionSummary = {
  id: 'sess-3333-4444',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/w',
  title: 'Some other session',
  updatedAt: Date.now() - 1_000,
};

function descriptor(capabilities: Capabilities): ProviderDescriptor {
  return {
    id: 'claude',
    label: 'Test Provider',
    capabilities,
    models: [],
    effortLevels: [],
    available: true,
  };
}

/*
 * One bridge, installed once, driven by mutable boxes.
 *
 * `resolveBridge` memoises its binding on the first call, so a second
 * `window.artemis` assigned in a `beforeEach` would never be seen — the same
 * constraint `models.test.ts` and `sessionSelection.test.ts` are written
 * around. Per-test behaviour therefore lives in the variables below rather
 * than in a freshly-built stub.
 */
const calls: { renamed: string[]; deleted: string[] } = { renamed: [], deleted: [] };
/** Run status `runs.list` reports for this session. `null` = no run at all. */
let runStatus: 'running' | 'ended' | null = null;
/** Whether the next delete succeeds. */
let deleteOk = true;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  version: '0.0.0',
  platform: 'darwin',
  runs: {
    list: async () => ({
      ok: true,
      value: {
        runs:
          runStatus === null
            ? []
            : [{ runId: 'r1', status: runStatus, sessionId: SESSION.id, cwd: '/w' }],
      },
    }),
    onEvent: () => () => {},
  },
  sessions: {
    rename: async ({ title }: { title: string }) => {
      calls.renamed.push(title);
      // Trims, as the main process does — so a test can tell the stored title
      // apart from the typed one.
      return { ok: true, value: { title: title.trim() } };
    },
    delete: async ({ sessionId }: { sessionId: string }) => {
      calls.deleted.push(sessionId);
      return deleteOk
        ? { ok: true, value: { deleted: true } }
        : { ok: false, error: { code: 'unknown', message: 'disk is read-only' } };
    },
  },
};

function seedStore(sessions: readonly SessionSummary[] = [SESSION]): void {
  useApp.setState({
    providers: [descriptor(ALL)],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/w',
    run: null,
    sessions,
    sessionsLoading: false,
    sessionsError: null,
    resumeSessionId: null,
    collapsedProjects: [],
    archivedSessions: [],
    archivedExpanded: false,
    pinnedSessions: [],
    pinnedCollapsed: false,
    banners: [],
  });
}

function mount(ui: React.ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/** Right-click the session row and wait for the menu. */
async function openMenu(): Promise<HTMLElement> {
  const row = screen.getByText('An earlier session');
  fireEvent.contextMenu(row);
  return screen.findByRole('menu');
}

/**
 * Press a letter at the open menu.
 *
 * On the menu itself rather than on an item, because that is where the handler
 * lives and where a real press lands: Radix focuses the content, not an item,
 * until the user arrows into one.
 */
function press(menu: HTMLElement, key: string, modifier?: 'metaKey' | 'ctrlKey' | 'altKey'): void {
  fireEvent.keyDown(menu, { key, ...(modifier ? { [modifier]: true } : {}) });
}

beforeEach(() => {
  calls.renamed.length = 0;
  calls.deleted.length = 0;
  runStatus = null;
  deleteOk = true;
  seedStore();
});
afterEach(cleanup);

/* -------------------------------------------------------------------------- */
/* The menu                                                                   */
/* -------------------------------------------------------------------------- */

describe('session context menu', () => {
  it('offers rename, pin, archive and delete on right-click', async () => {
    mount(<SessionList />);
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Pin' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
  });

  it('shows each item’s letter without putting it in the item’s name', async () => {
    // The cap is `aria-hidden` and the shortcut is announced through
    // `aria-keyshortcuts` instead, so the item is still called "Rename" rather
    // than "Rename R" — which is both how a screen reader should hear it and
    // what every query in this file depends on.
    mount(<SessionList />);
    const menu = await openMenu();

    expect(menu.textContent).toContain('R');
    for (const [name, key] of [
      ['Rename', 'R'],
      ['Pin', 'P'],
      ['Archive', 'A'],
      ['Delete…', 'D'],
    ] as const) {
      expect(screen.getByRole('menuitem', { name }).getAttribute('aria-keyshortcuts')).toBe(key);
    }
  });

  it('disables rename and delete when the provider cannot do them, and says why', async () => {
    // The menu stays present rather than losing its items: a control that
    // explains itself beats one that silently is not there.
    useApp.setState({
      providers: [descriptor({ ...ALL, renameSession: false, deleteSession: false })],
    });
    mount(<SessionList />);
    await openMenu();

    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    expect(rename.getAttribute('data-disabled')).not.toBeNull();
    expect(rename.getAttribute('title')).toContain('Test Provider does not support');
  });

  it('still offers archive when the provider can neither rename nor delete', async () => {
    // Archiving is Artemis's own bookkeeping, so it must survive a provider
    // that cannot write to its own session store at all.
    useApp.setState({
      providers: [descriptor({ ...ALL, renameSession: false, deleteSession: false })],
    });
    mount(<SessionList />);
    await openMenu();

    expect(
      screen.getByRole('menuitem', { name: 'Archive' }).getAttribute('data-disabled'),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Hotkeys                                                                    */
/* -------------------------------------------------------------------------- */

describe('menu hotkeys', () => {
  it('archives on A', async () => {
    mount(<SessionList />);
    press(await openMenu(), 'a');

    await waitFor(() => {
      expect(useApp.getState().archivedSessions).toEqual([`p1:${SESSION.id}`]);
    });
  });

  it('pins on P', async () => {
    mount(<SessionList />);
    press(await openMenu(), 'p');

    await waitFor(() => {
      expect(useApp.getState().pinnedSessions).toEqual([`p1:${SESSION.id}`]);
    });
  });

  it('opens the rename field on R', async () => {
    mount(<SessionList />);
    press(await openMenu(), 'r');

    expect(await screen.findByLabelText(`Rename session: ${SESSION.title}`)).toBeTruthy();
  });

  it('asks before deleting on D, rather than deleting', async () => {
    // The letter must land on the same confirmation the click does. A hotkey
    // that reached `deleteSession` directly would destroy a transcript on one
    // keystroke, which is the one thing this menu is built not to do.
    mount(<SessionList />);
    press(await openMenu(), 'd');

    expect(await screen.findByText('Delete this session?')).toBeTruthy();
    expect(calls.deleted).toEqual([]);
  });

  it('takes the letter in either case', async () => {
    mount(<SessionList />);
    press(await openMenu(), 'A');

    await waitFor(() => {
      expect(useApp.getState().archivedSessions).toEqual([`p1:${SESSION.id}`]);
    });
  });

  it('ignores a letter whose item is disabled', async () => {
    // Gating lives on the item, and the key goes through the item's own click
    // path precisely so it inherits that. A provider that cannot delete must
    // not be made to by a keystroke.
    useApp.setState({ providers: [descriptor({ ...ALL, deleteSession: false })] });
    mount(<SessionList />);
    const menu = await openMenu();

    press(menu, 'd');

    // Still open, nothing asked, no dialog.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeTruthy());
    expect(screen.queryByText('Delete this session?')).toBeNull();
    expect(calls.deleted).toEqual([]);
  });

  it('leaves modified presses alone', async () => {
    // ⌘R is the window reloading. A menu that swallowed it because it happened
    // to be open would be taking a key that was never aimed at it.
    mount(<SessionList />);
    const menu = await openMenu();

    press(menu, 'r', 'metaKey');
    press(menu, 'a', 'ctrlKey');

    expect(screen.queryByLabelText(`Rename session: ${SESSION.title}`)).toBeNull();
    expect(useApp.getState().archivedSessions).toEqual([]);
  });

  it('toggles back on the same letter, from a row that is already pinned', async () => {
    // `P` is "the pin", not "pin" — the key does not move when the item's word
    // changes to Unpin, so it is still one key for one idea.
    useApp.setState({ pinnedSessions: [`p1:${SESSION.id}`] });
    mount(<SessionList />);

    expect(await screen.findByText('An earlier session')).toBeTruthy();
    press(await openMenu(), 'p');

    await waitFor(() => expect(useApp.getState().pinnedSessions).toEqual([]));
  });
});

/* -------------------------------------------------------------------------- */
/* Pinning                                                                    */
/* -------------------------------------------------------------------------- */

describe('pin', () => {
  it('lifts the row into a Pinned section above every project', async () => {
    useApp.setState({ sessions: [SESSION, OTHER], pinnedSessions: [`p1:${SESSION.id}`] });
    mount(<SessionList />);

    const headings = (await screen.findAllByRole('button')).filter((b) =>
      b.hasAttribute('aria-expanded'),
    );

    expect(headings.map((h) => h.textContent)).toEqual(['Pinned·1', 'w·1']);
    // Above the projects, and open — a pin is a request to keep something in
    // view, so the section it makes is not folded shut on arrival.
    expect(headings[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('An earlier session')).toBeTruthy();
  });

  it('shows no Pinned section at all when nothing is pinned', async () => {
    // The requirement from the issue: the folder exists only once there is
    // something in it.
    mount(<SessionList />);

    await screen.findByText('An earlier session');
    expect(screen.queryByRole('button', { name: /Pinned/ })).toBeNull();
  });

  it('offers Unpin for a row that is already pinned', async () => {
    useApp.setState({ pinnedSessions: [`p1:${SESSION.id}`] });
    mount(<SessionList />);

    await screen.findByText('An earlier session');
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Unpin' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Pin' })).toBeNull();
  });

  it('changes nothing on disk, like archiving', async () => {
    mount(<SessionList />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));

    await waitFor(() => {
      expect(useApp.getState().pinnedSessions).toEqual([`p1:${SESSION.id}`]);
    });
    expect(calls.deleted).toEqual([]);
    expect(calls.renamed).toEqual([]);
    expect(useApp.getState().sessions).toHaveLength(1);
  });

  it('folds the section away without unpinning anything', async () => {
    useApp.setState({ sessions: [SESSION, OTHER], pinnedSessions: [`p1:${SESSION.id}`] });
    mount(<SessionList />);

    fireEvent.click(await screen.findByRole('button', { name: /Pinned/ }));

    await waitFor(() => expect(screen.queryByText('An earlier session')).toBeNull());
    // The count survives the fold: it is the one thing worth reading while the
    // section is shut.
    expect(screen.getByRole('button', { name: /Pinned/ }).textContent).toBe('Pinned·1');
    expect(useApp.getState().pinnedSessions).toEqual([`p1:${SESSION.id}`]);
  });

  it('archiving a pinned session unpins it, so it is never in both places', async () => {
    useApp.setState({ pinnedSessions: [`p1:${SESSION.id}`] });
    mount(<SessionList />);

    await screen.findByText('An earlier session');
    press(await openMenu(), 'a');

    await waitFor(() => {
      expect(useApp.getState().archivedSessions).toEqual([`p1:${SESSION.id}`]);
    });
    expect(useApp.getState().pinnedSessions).toEqual([]);
  });

  it('pinning an archived session takes it back out of the archive', async () => {
    useApp.setState({ archivedSessions: [`p1:${SESSION.id}`], archivedExpanded: true });
    mount(<SessionList />);

    await screen.findByText('An earlier session');
    press(await openMenu(), 'p');

    await waitFor(() => {
      expect(useApp.getState().pinnedSessions).toEqual([`p1:${SESSION.id}`]);
    });
    expect(useApp.getState().archivedSessions).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Archive                                                                    */
/* -------------------------------------------------------------------------- */

describe('archive', () => {
  it('moves the row into the Archived section without touching the provider', async () => {
    mount(<SessionList />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => {
      expect(useApp.getState().archivedSessions).toEqual([`p1:${SESSION.id}`]);
    });
    // The distinction that matters: nothing on disk was asked to change.
    expect(calls.deleted).toEqual([]);
    expect(useApp.getState().sessions).toHaveLength(1);
  });

  it('gathers archived sessions under a collapsed Archived heading', async () => {
    useApp.setState({ archivedSessions: [`p1:${SESSION.id}`] });
    mount(<SessionList />);

    const heading = await screen.findByRole('button', { name: /Archived/ });
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    // Shut by default, so the row itself is not rendered.
    expect(screen.queryByText('An earlier session')).toBeNull();
  });

  it('shows the archived rows once the section is opened', async () => {
    useApp.setState({ archivedSessions: [`p1:${SESSION.id}`], archivedExpanded: true });
    mount(<SessionList />);

    expect(await screen.findByText('An earlier session')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

describe('delete confirmation', () => {
  it('asks before deleting, and names the consequence', async () => {
    mount(<DeleteSessionDialog session={SESSION} onClose={() => {}} />);

    expect(await screen.findByText('Delete this session?')).toBeTruthy();
    expect(screen.getByRole('alertdialog').textContent).toContain('cannot be undone');
  });

  it('deletes nothing when cancelled', async () => {
    const onClose = vi.fn();
    mount(<DeleteSessionDialog session={SESSION} onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.deleted).toEqual([]);
  });

  it('removes the row only after the write is confirmed', async () => {
    mount(<DeleteSessionDialog session={SESSION} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(calls.deleted).toEqual([SESSION.id]));
    await waitFor(() => expect(useApp.getState().sessions).toEqual([]));
  });

  it('REGRESSION: keeps the row when the delete fails', async () => {
    // An optimistic delete would have told the user their transcript was gone
    // while it was still on disk — the one outcome this feature must never
    // produce.
    deleteOk = false;
    mount(<DeleteSessionDialog session={SESSION} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(useApp.getState().banners).toHaveLength(1));
    expect(useApp.getState().sessions).toHaveLength(1);
    expect(useApp.getState().banners[0]?.message).toContain('Could not delete that session');
  });
});

describe('delete confirmation for a running session', () => {
  it('replaces the ordinary dialog rather than adding a warning to it', async () => {
    runStatus = 'running';
    mount(<DeleteSessionDialog session={SESSION} onClose={() => {}} />);

    expect(await screen.findByText('This session is still running')).toBeTruthy();
    // The absence is the assertion. Both dialogs at once would pass a
    // present-only check while defeating the reason this variant exists.
    expect(screen.queryByText('Delete this session?')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete anyway' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('says the run may be in another window, because that is why it asked', async () => {
    runStatus = 'running';
    mount(<DeleteSessionDialog session={SESSION} onClose={() => {}} />);

    await screen.findByText('This session is still running');
    expect(screen.getByRole('alertdialog').textContent).toContain('another window');
  });

  it('still deletes when confirmed', async () => {
    runStatus = 'running';
    mount(<DeleteSessionDialog session={SESSION} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete anyway' }));

    await waitFor(() => expect(calls.deleted).toEqual([SESSION.id]));
  });

  it('shows the ordinary dialog for a run that has already ended', async () => {
    // `runs.list` reports recently-finished runs too; only a live one is a
    // reason to warn.
    (globalThis as Record<string, unknown>)['artemis'] = {
      ...((globalThis as Record<string, unknown>)['artemis'] as object),
      runs: {
        list: async () => ({
          ok: true,
          value: { runs: [{ runId: 'r1', status: 'ended', sessionId: SESSION.id, cwd: '/w' }] },
        }),
        onEvent: () => () => {},
      },
    };
    mount(<DeleteSessionDialog session={SESSION} onClose={() => {}} />);

    expect(await screen.findByText('Delete this session?')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Rename                                                                     */
/* -------------------------------------------------------------------------- */

describe('rename', () => {
  it('commits on Enter and shows the stored title', async () => {
    mount(<SessionList />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const field = await screen.findByLabelText(`Rename session: ${SESSION.title}`);
    fireEvent.change(field, { target: { value: '  Auth redirect fix  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(calls.renamed).toEqual(['Auth redirect fix']));
    // The *stored* title, trimmed by the backend — not the string that was typed.
    await waitFor(() => {
      expect(useApp.getState().sessions[0]?.title).toBe('Auth redirect fix');
    });
  });

  it('abandons the edit on Escape', async () => {
    mount(<SessionList />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const field = await screen.findByLabelText(`Rename session: ${SESSION.title}`);
    fireEvent.change(field, { target: { value: 'discard me' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    await waitFor(() => expect(screen.getByText('An earlier session')).toBeTruthy());
    expect(calls.renamed).toEqual([]);
  });

  it('writes once when Enter is followed by the blur it causes', async () => {
    mount(<SessionList />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const field = await screen.findByLabelText(`Rename session: ${SESSION.title}`);
    fireEvent.change(field, { target: { value: 'once only' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);

    await waitFor(() => expect(calls.renamed).toEqual(['once only']));
  });

  it('sends nothing when the title is unchanged', async () => {
    mount(<SessionList />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const field = await screen.findByLabelText(`Rename session: ${SESSION.title}`);
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('An earlier session')).toBeTruthy());
    expect(calls.renamed).toEqual([]);
  });
});
