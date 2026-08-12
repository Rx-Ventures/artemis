/**
 * @vitest-environment jsdom
 *
 * A plan, rendered as a plan.
 *
 * `ExitPlanMode` parks a run on the permission callback like any other tool,
 * and for a long time that is exactly how it was rendered: a markdown document
 * JSON-escaped into a four-line code block, under a heading reading
 * `arguments`, above buttons offering "Approve once", "Deny" and "Allow for
 * this session". The user could not read the plan and none of the verbs
 * described what they were being asked.
 *
 * So the assertions here are about *what the user is asked*, not about
 * plumbing. They pin the two things that were wrong: the plan has to arrive as
 * readable prose, and the choices have to be the ones a plan actually offers —
 * approve it, or send it back to be revised.
 *
 * Bridge faked at `window.artemis` rather than mocked at the module boundary,
 * so these run through the real store, the real `respondToPermission` and the
 * real queue handling — same arrangement as `InlinePermission.test.tsx`.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

/** Decisions the renderer actually sent, in order. */
let sent: PermissionDecision[];

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: {
      respondToPermission: async ({
        decision,
      }: {
        decision: PermissionDecision;
      }): Promise<IpcResult<{ requestId: string }>> => {
        sent.push(decision);
        return { ok: true, value: { requestId: 'perm-1' } };
      },
    },
  },
});

const { InlinePermission } = await import('@/components/InlinePermission');
const { appSession, appTranscript, seedApp } = await import('@/state/testkit');

const PLAN = [
  '# Replace the polling loop',
  '',
  '## Context',
  '',
  'It runs every 2s whether or not anything changed.',
  '',
  '1. Add a watcher.',
  '2. Drop the interval to 30s.',
].join('\n');

const REQUEST: PermissionRequest = {
  id: 'perm-1',
  runId: 'run-1',
  toolName: 'ExitPlanMode',
  input: { plan: PLAN, planFilePath: '/u/.claude/plans/mock.md' },
  plan: { plan: PLAN, planPath: '/u/.claude/plans/mock.md' },
  title: 'Artemis has a plan',
  suggestions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
  requestedAt: Date.now(),
};

function pending(
  request: PermissionRequest = REQUEST,
): Parameters<typeof InlinePermission>[0]['item'] {
  return {
    id: 'p:perm-1',
    ts: Date.now(),
    kind: 'permission',
    requestId: request.id,
    request,
    state: 'pending',
  };
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

beforeEach(() => {
  sent = [];
  appTranscript().reset();
  seedApp({
    permissionMode: 'plan',
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
        permissionModes: ['plan', 'default', 'acceptEdits'],
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
  it('renders the plan as prose rather than as escaped JSON', () => {
    mount(<InlinePermission item={pending()} />);

    // The markdown was parsed: the heading is a heading, not a `#` inside a
    // string. This is the whole reason the card exists.
    const heading = screen.getByText('Replace the polling loop');
    expect(heading.tagName).toBe('H1');
    expect(screen.getByText('Context').tagName).toBe('H2');
    // And nothing is showing the raw arguments blob.
    expect(screen.queryByText(/planFilePath/)).toBeNull();
  });

  it('says where the plan was saved, so it can be opened later', () => {
    mount(<InlinePermission item={pending()} />);
    expect(screen.getByText(/\/u\/\.claude\/plans\/mock\.md/)).toBeTruthy();
  });

  it('offers plan verbs, not permission verbs', () => {
    mount(<InlinePermission item={pending()} />);
    expect(screen.getByRole('button', { name: /Approve plan/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Keep planning/ })).toBeTruthy();
    // "Allow for this session" persists a rule, and there is no rule here — a
    // plan is proposed once and answered once.
    expect(screen.queryByRole('button', { name: /this session/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve once/ })).toBeNull();
  });

  it('does not put focus on a button that Enter could fire', () => {
    mount(<InlinePermission item={pending()} />);
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /Approve plan/ }));
    // Focus lands on the card, so the shortcuts work and the composer yields.
    expect(document.activeElement?.getAttribute('role')).toBe('group');
  });

  /**
   * A plan with arguments that did not decode is not rendered as an empty plan
   * card — it falls back to the verbatim-arguments approval, which is ugly but
   * answerable. A parked run needs an answer above all else.
   */
  it('falls back to the ordinary approval when there is no plan to show', () => {
    const undecoded: PermissionRequest = {
      ...REQUEST,
      input: { allowedPrompts: [] },
      plan: undefined,
    };
    mount(<InlinePermission item={pending(undecoded)} />);
    expect(screen.getByRole('button', { name: /Approve once/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve plan/ })).toBeNull();
  });
});

describe('decisions', () => {
  it('approves with the provider’s own rule updates echoed back', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve plan/ }));
    });

    expect(sent).toEqual([
      {
        behavior: 'allow',
        scope: 'once',
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
      },
    ]);
  });

  it('sends the typed note back so the agent can revise', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.change(screen.getByLabelText(/what to change/i), {
      target: { value: 'Do step 2 first.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Keep planning/ }));
    });

    expect(sent).toEqual([{ behavior: 'deny', message: 'Do step 2 first.' }]);
  });

  it('substitutes a "keep planning" message when nothing was typed', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Keep planning/ }));
    });

    // Not a bare refusal: the agent is being sent back to revise, and what it
    // gets told has to say so or it will abandon the task instead.
    expect(sent).toEqual([
      { behavior: 'deny', message: expect.stringContaining('keep planning') as unknown as string },
    ]);
  });

  it('stops the run outright when asked to', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop the run/ }));
    });
    expect(sent[0]).toMatchObject({ behavior: 'deny', interrupt: true });
  });

  /**
   * Escape has to resolve rather than dismiss: the provider is blocked with no
   * deadline, so the reflex that means "get this off my screen" must unblock
   * the run. For a plan the safe resolution is to keep planning, not to refuse.
   */
  it('keeps planning on Escape', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    });
    expect(sent[0]).toMatchObject({ behavior: 'deny' });
    expect(sent[0]).not.toMatchObject({ interrupt: true });
  });

  it('approves on ⌘↵', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('group'), { key: 'Enter', metaKey: true });
    });
    expect(sent[0]).toMatchObject({ behavior: 'allow' });
  });
});

/* -------------------------------------------------------------------------- */
/* The mode the column claims to be in                                        */
/* -------------------------------------------------------------------------- */

/**
 * The picker is a stored preference this column sends at the *start* of a run,
 * so nothing tells it that plan mode ended. Left alone it goes on reading
 * `plan`, and the next prompt is sent in plan mode: the user approves a plan,
 * asks the agent to get on with it, and watches it refuse to edit anything.
 */
describe('leaving plan mode', () => {
  it('follows the mode the provider named', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve plan/ }));
    });
    expect(appSession().permissionMode).toBe('acceptEdits');
  });

  it('falls back to default when the provider named none', async () => {
    const noSuggestions: PermissionRequest = { ...REQUEST, suggestions: undefined };
    seedApp({ permissionQueue: [noSuggestions] });
    mount(<InlinePermission item={pending(noSuggestions)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve plan/ }));
    });
    // `default` asks about everything, which is the safe direction to guess in.
    expect(appSession().permissionMode).toBe('default');
  });

  it('stays in plan mode when the plan was sent back', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Keep planning/ }));
    });
    // Still planning — that is the entire meaning of the button.
    expect(appSession().permissionMode).toBe('plan');
  });
});

/* -------------------------------------------------------------------------- */
/* Afterwards                                                                 */
/* -------------------------------------------------------------------------- */

describe('the settled record', () => {
  it('records an approved plan without repeating the whole document', () => {
    mount(
      <InlinePermission
        item={{ ...pending(), state: 'allowed' }}
      />,
    );
    expect(screen.getByText('plan approved')).toBeTruthy();
    // The plan is about to be carried out in the transcript directly below.
    // Printing it twice would say everything twice.
    expect(screen.queryByText('Replace the polling loop')).toBeNull();
  });

  it('records a plan that was sent back as still planning', () => {
    mount(
      <InlinePermission
        item={{ ...pending(), state: 'denied', note: 'Do step 2 first.' }}
      />,
    );
    expect(screen.getByText('plan sent back')).toBeTruthy();
    expect(screen.getByText('Do step 2 first.')).toBeTruthy();
  });
});
