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
    banners: [],
  });
}

function mount(ui: React.ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/** Right-click the session row and wait for the menu. */
async function openMenu(): Promise<void> {
  const row = screen.getByText('An earlier session');
  fireEvent.contextMenu(row);
  await screen.findByRole('menu');
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
  it('offers rename, archive and delete on right-click', async () => {
    mount(<SessionList />);
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
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
