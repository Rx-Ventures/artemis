/**
 * @vitest-environment jsdom
 *
 * The permission prompt's failure path.
 *
 * This is the one surface where "report the error somewhere" is not good
 * enough. The run is *parked* while a prompt is open — the adapter is blocked
 * inside its `canUseTool` callback with no deadline — so a decision that fails
 * to send leaves the agent waiting forever. If that failure is not reported
 * where the user is looking, they are left staring at a card that appeared to
 * do nothing.
 *
 * That is the argument for rendering the prompt inline rather than in a modal,
 * and this file is what holds the argument to account: it asserts the failure
 * message lands *on the card*, next to the buttons that produced it.
 *
 * The bridge is faked at `window.artemis` rather than mocked at the module
 * boundary, so these run through the real store: the real `respondToPermission`,
 * the real `call()` wrapper, the real queue handling.
 *
 * (Inherited from `PermissionModal.test.tsx`, which this replaces along with
 * the modal itself.)
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IpcResult, PermissionDecision, PermissionRequest } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** What the fake bridge should answer for the next decision. */
let respond: (decision: PermissionDecision) => IpcResult<{ requestId: string }>;
/** Decisions the renderer actually sent, in order. */
let sent: PermissionDecision[];

/*
 * `window.artemis` must exist before the store module resolves the bridge, which
 * it does lazily on the first call and then caches forever. Assigning it at
 * module scope — before the dynamic import below — is what makes the cached
 * binding point here rather than at the dev mock bridge.
 */
Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: {
      respondToPermission: async ({ decision }: { decision: PermissionDecision }) => {
        sent.push(decision);
        return respond(decision);
      },
    },
  },
});

const { InlinePermission } = await import('@/components/InlinePermission');
const { appSession, appTranscript, seedApp } = await import('@/state/testkit');

const REQUEST: PermissionRequest = {
  id: 'perm-1',
  runId: 'run-1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  title: 'Artemis wants to run a shell command',
  requestedAt: Date.now(),
};

function pending(): Parameters<typeof InlinePermission>[0]['item'] {
  return {
    id: 'p:perm-1',
    ts: Date.now(),
    kind: 'permission',
    requestId: REQUEST.id,
    request: REQUEST,
    state: 'pending',
  };
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

beforeEach(() => {
  sent = [];
  respond = () => ({ ok: true, value: { requestId: REQUEST.id } });
  appTranscript().reset();
  seedApp({
    run: {
      runId: 'run-1',
      status: 'awaiting_permission',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: {
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
      },
      startedAt: Date.now(),
    },
    permissionQueue: [REQUEST],
    banners: [],
  });
});

afterEach(cleanup);

describe('the ask', () => {
  it('renders the arguments verbatim rather than summarising them', () => {
    mount(<InlinePermission item={pending()} />);
    // A friendly sentence that hid `rm -rf` would be a security bug. The
    // arguments *are* the ask.
    expect(screen.getByText(/rm -rf build/)).toBeTruthy();
  });

  it('does not put focus on a button that Enter could fire', () => {
    mount(<InlinePermission item={pending()} />);
    const approve = screen.getByRole('button', { name: /Approve once/ });
    expect(document.activeElement).not.toBe(approve);
    // Focus lands on the card, so the shortcuts work and the composer yields.
    expect(document.activeElement?.getAttribute('role')).toBe('group');
  });
});

describe('the failure path', () => {
  it('reports a failed decision on the card itself', async () => {
    respond = () => ({
      ok: false,
      error: { code: 'transport', message: 'The main process did not respond.' },
    });

    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve once/ }));
    });

    await waitFor(() => {
      expect(screen.getByText('The decision did not reach the run')).toBeTruthy();
    });
    expect(screen.getByText('The main process did not respond.')).toBeTruthy();
    // And the buttons stay live, because retrying is the only way out.
    expect((screen.getByRole('button', { name: /Approve once/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /**
   * `invalid_request` means the request is gone for good: the provider withdrew
   * it and answered it itself. Retrying can only fail the same way, so the
   * store drops it from the queue rather than leaving a prompt on screen that
   * can never be resolved.
   */
  it('clears a request the provider has already withdrawn', async () => {
    respond = () => ({
      ok: false,
      error: { code: 'invalid_request', message: 'That request is no longer open.' },
    });

    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });

    await waitFor(() => {
      expect(appSession().permissionQueue).toHaveLength(0);
    });
  });
});

describe('decisions', () => {
  it('sends a bare allow for "approve once"', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve once/ }));
    });
    expect(sent).toEqual([{ behavior: 'allow', scope: 'once' }]);
  });

  it('substitutes a neutral message when the user gives no denial reason', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });
    expect(sent[0]).toMatchObject({ behavior: 'deny' });
    expect((sent[0] as { message?: string }).message).toBeTruthy();
  });

  it('passes the typed denial reason through to the model', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.change(screen.getByLabelText(/reason for denial/i), {
      target: { value: 'Do not touch the build directory.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });
    expect(sent[0]).toMatchObject({
      behavior: 'deny',
      message: 'Do not touch the build directory.',
    });
  });

  it('denies on Escape, because that unblocks the run rather than stranding it', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    });
    expect(sent[0]).toMatchObject({ behavior: 'deny' });
  });

  it('requires a modifier to approve from the keyboard', async () => {
    mount(<InlinePermission item={pending()} />);
    const card = screen.getByRole('group');

    // A bare Enter must do nothing. This is the one control in the app where a
    // reflex must not be able to authorise something unread.
    await act(async () => {
      fireEvent.keyDown(card, { key: 'Enter' });
    });
    expect(sent).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(card, { key: 'Enter', metaKey: true });
    });
    expect(sent[0]).toMatchObject({ behavior: 'allow' });
  });
});

describe('the record it leaves', () => {
  it('shows the decision instead of the controls once answered', () => {
    mount(
      <InlinePermission
        item={{ ...pending(), state: 'denied', note: 'Denied by the user.' }}
      />,
    );
    expect(screen.queryByRole('button', { name: /Approve once/ })).toBeNull();
    expect(screen.getByText('denied')).toBeTruthy();
    expect(screen.getByText('Denied by the user.')).toBeTruthy();
  });
});
