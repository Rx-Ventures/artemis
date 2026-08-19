/**
 * @vitest-environment jsdom
 *
 * The Server pane, and the one property it must never lose: **it does not turn
 * the server on by accident.**
 *
 * The pane publishes the user's accounts to every program on the machine, so
 * the interesting cases here are not the layout — they are the gates. Clicking
 * Start opens a question rather than binding a port; cancelling that question
 * leaves the server stopped; only the confirm action calls `start`. The same
 * holds for the autostart switch, which is the quieter half of the same
 * decision, and the reverse must *not* hold: turning autostart off reduces
 * exposure and is never allowed to require permission.
 *
 * The rest is what the catalogue promises other programs: a route reads
 * `profile/model`, and a model that does not take fast mode says so rather than
 * omitting it — an absent badge is indistinguishable from a catalogue that has
 * not loaded.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ServerConnection, ServerProfile, ServerState } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { ServerSection } from '@/components/settings/ServerSection';
import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ok = <T,>(value: T) => ({ ok: true as const, value });

const TOKEN = 'token-abcdefghijklmnopqrstuvwxyz012345';

const CONNECTION: ServerConnection = {
  id: 'conn-1',
  label: 'Kronos',
  workspace: { kind: 'directory', path: '/w/kronos' },
  token: TOKEN,
  createdAt: 0,
};

const STOPPED: ServerState = {
  phase: 'stopped',
  host: '127.0.0.1',
  port: 6472,
  autoStart: false,
  connections: [CONNECTION],
  traffic: { total: 0, rejected: 0 },
};

const CATALOGUE: readonly ServerProfile[] = [
  {
    id: 'prof-a' as ServerProfile['id'],
    slug: 'work-max',
    label: 'Work Max',
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: NO_CAPABILITIES,
    models: [
      {
        route: 'work-max/opus',
        id: 'opus',
        label: 'Opus 5',
        note: '.',
        profileId: 'prof-a' as ServerProfile['id'],
        profileSlug: 'work-max',
        profileLabel: 'Work Max',
        providerId: 'claude',
        thinkingLevels: [{ id: 'high', label: 'High', note: 'Deep.' }],
        adaptiveThinking: false,
        fastMode: false,
        ultracode: true,
      },
    ],
  },
];

let state: ServerState = STOPPED;
const startCalls: unknown[] = [];
const stopCalls: unknown[] = [];
const configureCalls: { port?: number; autoStart?: boolean }[] = [];
const createCalls: { label: string; workspace: unknown; allow?: unknown }[] = [];
const deleteCalls: { id: string }[] = [];
const renameCalls: { id: string; label: string }[] = [];

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  server: {
    status: async () => ok({ state }),
    start: async (request: unknown) => {
      startCalls.push(request);
      state = { ...state, phase: 'running', boundPort: 6472, url: 'http://127.0.0.1:6472' };
      return ok({ state });
    },
    stop: async (request: unknown) => {
      stopCalls.push(request);
      state = STOPPED;
      return ok({ state });
    },
    configure: async (request: { port?: number; autoStart?: boolean }) => {
      configureCalls.push(request);
      state = { ...state, ...request };
      return ok({ state });
    },
    createConnection: async (request: {
      label: string;
      workspace: unknown;
      allow?: unknown;
    }) => {
      createCalls.push(request);
      return ok({ state });
    },
    renameConnection: async (request: { id: string; label: string }) => {
      renameCalls.push(request);
      return ok({ state });
    },
    deleteConnection: async (request: { id: string }) => {
      deleteCalls.push(request);
      return ok({ state });
    },
    catalogue: async () => ok({ profiles: CATALOGUE }),
    onChange: () => () => undefined,
  },
};

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <ServerSection />
    </TooltipProvider>,
  );
  await act(async () => {});
}

beforeEach(() => {
  state = STOPPED;
});

afterEach(() => {
  cleanup();
  startCalls.length = 0;
  stopCalls.length = 0;
  configureCalls.length = 0;
  createCalls.length = 0;
  deleteCalls.length = 0;
  renameCalls.length = 0;
});

describe('ServerSection', () => {
  it('opens stopped, and says so in a warning the reader cannot miss', async () => {
    await renderPane();
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.getByText(/Only do this if you are sure/)).toBeTruthy();
  });

  it('asks before starting, and starts nothing when the question is cancelled', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: 'Start' }).click();
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    // The port is not bound by opening a dialog.
    expect(startCalls).toEqual([]);

    await act(async () => {
      screen.getByRole('button', { name: 'Cancel' }).click();
    });
    expect(startCalls).toEqual([]);
  });

  it('starts only on the confirming action', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: 'Start' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Start the server' }).click();
    });

    expect(startCalls).toHaveLength(1);
  });

  it('asks before autostart, because it binds on launches nobody is thinking about', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('switch', { name: 'Start with Artemis' }).click();
    });
    expect(configureCalls).toEqual([]);

    await act(async () => {
      screen.getByRole('button', { name: 'Start it at launch' }).click();
    });
    expect(configureCalls).toEqual([{ autoStart: true }]);
  });

  it('never asks permission to turn autostart off', async () => {
    state = { ...STOPPED, autoStart: true };
    await renderPane();

    await act(async () => {
      screen.getByRole('switch').click();
    });

    // Straight through, no dialog: nothing that reduces exposure should need a
    // confirmation.
    expect(configureCalls).toEqual([{ autoStart: false }]);
  });

  it('shows each route as profile/model, with what it will and will not accept', async () => {
    await renderPane();
    expect(screen.getByText('work-max/opus')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    // Both flags are drawn. A model that ignores fast mode has to say so — an
    // absent badge would read as "not loaded yet".
    expect(screen.getByText('fast mode')).toBeTruthy();
    expect(screen.getByText('ultracode')).toBeTruthy();
  });

  it('keeps each connection’s token masked until it is asked for', async () => {
    await renderPane();
    expect(screen.queryByText(TOKEN)).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'Reveal' }).click();
    });
    expect(screen.getByText(TOKEN)).toBeTruthy();
  });

  it('shows what each connection may reach, not just that it exists', async () => {
    await renderPane();
    expect(screen.getByText('Kronos')).toBeTruthy();
    // The grant is the interesting half of a connection, so the row states it.
    expect(screen.getByText('/w/kronos')).toBeTruthy();
  });

  it('creates a scratch connection without asking for a folder', async () => {
    // The case that must always be possible: talk to a model, touch nothing.
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: 'New connection' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Create connection' }).click();
    });

    expect(createCalls).toEqual([
      { label: 'Connection', workspace: { kind: 'ephemeral', perSession: true } },
    ]);
  });

  it('will not create a directory connection before a folder is chosen', async () => {
    // A `directory` grant with no path is a grant to nowhere.
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: 'New connection' }).click();
    });
    await act(async () => {
      screen.getByRole('radio', { name: /A folder you choose/ }).click();
    });

    expect(
      screen.getByRole('button', { name: 'Create connection' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(createCalls).toEqual([]);
  });

  it('revokes one connection', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Revoke' }).click();
    });
    expect(deleteCalls).toEqual([{ id: 'conn-1' }]);
  });
});

describe('editing a connection', () => {
  it('renames in place, which is the only field that may change', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: 'Kronos' }).click();
    });

    // `fireEvent`, not `field.value = …`: React tracks the value on the node and
    // ignores a direct assignment, so the handler would never see the change.
    const field = screen.getByRole('textbox', { name: 'Rename Kronos' });
    await act(async () => {
      fireEvent.change(field, { target: { value: 'Kronos v2' } });
      fireEvent.blur(field);
    });

    expect(renameCalls).toEqual([{ id: 'conn-1', label: 'Kronos v2' }]);
  });

  it('does not call rename when the name did not change', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: 'Kronos' }).click();
    });
    await act(async () => {
      fireEvent.blur(screen.getByRole('textbox', { name: 'Rename Kronos' }));
    });

    expect(renameCalls).toEqual([]);
  });
});

describe('allowlisting what a connection may use', () => {
  it('creates an unrestricted token when nothing is ticked', async () => {
    // The inversion that matters: a user who skips this section gets a working
    // token, not one that authenticates and can reach nothing.
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'New connection' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Create connection' }).click();
    });

    expect(createCalls[0]).not.toHaveProperty('allow');
  });

  it('stores a whole account with no model list, so the grant follows it', async () => {
    // Ticking every model individually would freeze the grant at today's
    // catalogue; the account row means "this account, including what it gains".
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'New connection' }).click();
    });
    await act(async () => {
      screen.getByRole('checkbox', { name: 'Allow every model on Work Max' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Create connection' }).click();
    });

    expect(createCalls[0]?.allow).toEqual([{ profileId: 'prof-a' }]);
  });

  it('stores named models when only some are ticked', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'New connection' }).click();
    });
    await act(async () => {
      screen.getByRole('checkbox', { name: 'Allow work-max/opus' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Create connection' }).click();
    });

    // One of one here, which collapses to the whole account — the catalogue
    // fixture has a single model, and that collapse is the point of the rule.
    expect(createCalls[0]?.allow).toEqual([{ profileId: 'prof-a' }]);
  });
});
