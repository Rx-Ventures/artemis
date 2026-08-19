/**
 * @vitest-environment jsdom
 *
 * The working folder, listed — through the real store and the real dock.
 *
 * Before this pane the only file Artemis would show you was one the *agent* had
 * mentioned: the viewer opens what a transcript links to, and a path nobody had
 * written about was unreachable. So the claims worth pinning are the ones that
 * make it a browser rather than a decoration:
 *
 *  - it **lists the column's own folder**, not some app-wide notion of where
 *    you are — two columns on two repos is the normal case here;
 *  - a directory **opens into the pane** and the header offers the way back,
 *    which is the whole of its navigation model;
 *  - a file **opens in the file tab**, reusing the reader the transcript's
 *    links already use rather than growing a second one;
 *  - it **says when a listing was capped**, because a list that stops silently
 *    reads as a complete account of a folder that is not.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DirectoryEntry } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);

vi.mock('@/lib/terminalSessions', () => ({
  ensureTerminalSession: vi.fn(),
  attachTerminal: vi.fn(() => null),
  detachTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  focusTerminal: vi.fn(),
  requestTerminalFocus: vi.fn(),
  writeToTerminal: vi.fn(),
  noteTerminalExit: vi.fn(),
  disposeTerminalSession: vi.fn(),
  setTerminalSessionHooks: vi.fn(),
  retheme: vi.fn(),
}));

/** Every path the pane asked main for, in order. */
let listed: string[];
/** What the next `files.list` should answer with, keyed by path. */
let tree: Record<string, { entries: DirectoryEntry[]; truncated?: boolean }>;
/** Paths handed to the file reader — the tab the pane is supposed to reuse. */
let read: string[];

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    preview: {},
    terminal: { onEvent: () => () => undefined },
    runs: { onEvent: () => () => undefined },
    files: {
      list: async ({ path }: { path: string }) => {
        listed.push(path);
        const at = tree[path];
        if (at === undefined) {
          return { ok: false, error: { code: 'invalid_request', message: `No such folder: ${path}` } };
        }
        return { ok: true, value: { path, entries: at.entries, truncated: at.truncated ?? false } };
      },
      read: async ({ path }: { path: string }) => {
        read.push(path);
        return { ok: true, value: { path, title: path, bytes: 3, text: 'ok', truncated: false } };
      },
    },
  },
});

const { DockPane } = await import('@/components/DockPane');
const { closePane, focusedPane, toggleFiles, useApp } = await import('@/state/store');
const { paneState, setPaneState } = await import('@/state/pane');

const dir = (name: string): DirectoryEntry => ({ name, kind: 'directory' });
const file = (name: string, bytes?: number): DirectoryEntry => ({ name, kind: 'file', bytes });

function renderDock(): void {
  render(
    <TooltipProvider>
      <DockPane />
    </TooltipProvider>,
  );
}

/** Open the tab the way the rail and the header button both do. */
function openFiles(): void {
  act(() => {
    toggleFiles(focusedPane());
  });
}

beforeEach(() => {
  listed = [];
  read = [];
  tree = {
    '/Users/me/project': {
      entries: [dir('apps'), dir('packages'), file('README.md', 2_048), file('.gitignore', 40)],
    },
    '/Users/me/project/apps': { entries: [dir('desktop'), file('index.ts', 900)] },
    '/Users/me': { entries: [dir('project')] },
  };

  // The grid outlives each `it`, and a survivor would double every tab query.
  for (const extra of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    closePane(extra.id);
  }
  // `files` among them: the case below that opens one leaves it in the dock,
  // and a survivor would put an extra tab in the strip every test after it.
  useApp.setState({
    preview: null,
    files: [],
    terminals: [],
    activeDockTab: null,
    visibleDockTabs: [],
  });
  setPaneState(focusedPane(), {
    cwd: '/Users/me/project',
    filesRequested: false,
    tasks: [],
    run: null,
  } as never);
});

afterEach(cleanup);

describe('the folder browser', () => {
  it('lists the column it was opened from', async () => {
    openFiles();
    renderDock();

    await screen.findByText('README.md');
    expect(listed).toEqual(['/Users/me/project']);
    expect(screen.getByText('apps')).not.toBeNull();
    // Dotfiles are listed like anything else. They are most of what is
    // interesting at the top of a repo, and a browser that hid them would send
    // the reader back to a terminal for the file they came to read.
    expect(screen.getByText('.gitignore')).not.toBeNull();
  });

  it('follows the column when the conversation moves', async () => {
    openFiles();
    renderDock();
    await screen.findByText('README.md');

    act(() => {
      setPaneState(focusedPane(), { cwd: '/Users/me/project/apps' } as never);
    });

    // Pointing the conversation somewhere else and finding the browser still in
    // the old tree would be a stale view of a question nobody asked twice.
    await screen.findByText('desktop');
    expect(listed).toEqual(['/Users/me/project', '/Users/me/project/apps']);
  });

  it('opens a folder into the pane, and offers the way back', async () => {
    openFiles();
    renderDock();
    await screen.findByText('apps');

    fireEvent.click(screen.getByText('apps'));
    await screen.findByText('index.ts');
    expect(read).toEqual([]);

    fireEvent.click(screen.getByLabelText('Up one folder'));
    await screen.findByText('README.md');
  });

  it('offers `..` in the list, where a hand that just clicked a folder already is', async () => {
    openFiles();
    renderDock();
    await screen.findByText('apps');

    fireEvent.click(screen.getByText('apps'));
    await screen.findByText('index.ts');

    fireEvent.click(screen.getByText('..'));

    await screen.findByText('README.md');
    expect(listed).toEqual([
      '/Users/me/project',
      '/Users/me/project/apps',
      '/Users/me/project',
    ]);
  });

  it('leaves `..` out at the top of the filesystem', async () => {
    tree['/'] = { entries: [dir('Users')] };
    setPaneState(focusedPane(), { cwd: '/' } as never);
    openFiles();
    renderDock();
    await screen.findByText('Users');

    // A row that navigates nowhere is worse than no row: it invites the click
    // that proves it does nothing.
    expect(screen.queryByText('..')).toBeNull();
  });

  it('walks up past the working directory, which is where the file channel ends', async () => {
    openFiles();
    renderDock();
    await screen.findByText('README.md');

    fireEvent.click(screen.getByLabelText('Up one folder'));

    // Not bounded by `cwd`. Someone who has walked up out of the working
    // directory is looking at the machine, which is what the channel already
    // permits — the boundary that matters is enforced in main, not by hiding a
    // chevron here.
    await screen.findByText('project');
    expect(listed).toContain('/Users/me');
  });

  it('opens a file in the tab the transcript already uses', async () => {
    openFiles();
    renderDock();
    await screen.findByText('README.md');

    fireEvent.click(screen.getByText('README.md'));

    // Same channel, same gates, same tab — two readers for one kind of thing
    // would be two places to fix a bug in.
    await waitFor(() => expect(read).toEqual(['/Users/me/project/README.md']));
  });

  it('says so when the listing was capped', async () => {
    tree['/Users/me/project'] = { entries: [file('one.ts')], truncated: true };
    openFiles();
    renderDock();

    await screen.findByText(/more than can be listed at once/);
  });

  it('shows what went wrong rather than an empty pane', async () => {
    setPaneState(focusedPane(), { cwd: '/Users/me/gone' } as never);
    openFiles();
    renderDock();

    await screen.findByText('No such folder: /Users/me/gone');
  });

  it('reads the folder again when asked, because the agent is editing it', async () => {
    openFiles();
    renderDock();
    await screen.findByText('README.md');

    tree['/Users/me/project'] = { entries: [file('README.md'), file('NOTES.md')] };
    fireEvent.click(screen.getByLabelText('Read this folder again'));

    await screen.findByText('NOTES.md');
  });

  it('closes, and comes back to the folder the column is in now', async () => {
    openFiles();
    renderDock();
    await screen.findByText('README.md');

    openFiles();
    expect(screen.queryByText('README.md')).toBeNull();
    expect(useApp.getState().visibleDockTabs).toEqual([]);

    openFiles();
    await screen.findByText('README.md');
  });
});
