/**
 * @vitest-environment jsdom
 *
 * The question card.
 *
 * A provider can only hand control back mid-turn through the permission
 * callback, so a tool whose whole purpose is to ask the user something arrives
 * on the same wire as "may I run `rm -rf`". Rendered as an approval it offers
 * Approve and Deny to a question that wanted an answer: approving sends the
 * model nothing, denying sends it a refusal, and either way the thing it asked
 * goes unanswered.
 *
 * So the assertions below are mostly about *not* being a permission prompt —
 * the options are controls rather than JSON, Escape skips instead of denying,
 * and what goes back is the user's choice rather than a verdict.
 *
 * The bridge is faked at `window.artemis` rather than mocked at the module
 * boundary, so these run through the real store: the real `respondToPermission`,
 * the real `call()` wrapper, the real queue handling. (Same harness as
 * `InlinePermission.test.tsx`, for the same reason.)
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  IpcResult,
  PermissionDecision,
  PermissionRequest,
  QuestionAnswer,
} from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

let respond: (decision: PermissionDecision) => IpcResult<{ requestId: string }>;
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
      respondToPermission: async ({ decision }: { decision: PermissionDecision }) => {
        sent.push(decision);
        return respond(decision);
      },
    },
  },
});

const { InlinePermission } = await import('@/components/InlinePermission');
const { appSession, appTranscript, seedApp } = await import('@/state/testkit');

/**
 * A two-question prompt: one single-select with a preview, one multi-select.
 * Enough to exercise every path without a fixture nobody can read.
 */
const REQUEST: PermissionRequest = {
  id: 'perm-1',
  runId: 'run-1',
  toolName: 'AskUserQuestion',
  input: {},
  requestedAt: Date.now(),
  question: {
    questions: [
      {
        question: 'Which date library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'date-fns', description: 'Tree-shakeable, function per import.' },
          {
            label: 'Luxon',
            description: 'Immutable, good zone support.',
            preview: 'DateTime.now().toISO()',
          },
        ],
      },
      {
        question: 'Which checks should run?',
        header: 'Checks',
        multiSelect: true,
        options: [
          { label: 'lint', description: 'ESLint over the diff.' },
          { label: 'types', description: 'A full tsc build.' },
          { label: 'tests', description: 'Vitest, all packages.' },
        ],
      },
    ],
  },
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

/** The answers of the one decision that was sent. */
function answersSent(): readonly QuestionAnswer[] | undefined {
  const decision = sent[0];
  return decision?.behavior === 'allow' ? decision.answers : undefined;
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

/* -------------------------------------------------------------------------- */

describe('the ask', () => {
  it('renders a question rather than a permission prompt', () => {
    mount(<InlinePermission item={pending()} />);

    expect(screen.getByText('Which date library?')).toBeTruthy();
    expect(screen.getByText('Which checks should run?')).toBeTruthy();
    // The options are controls the user can pick, not arguments to authorise.
    expect(screen.getByRole('radio', { name: /date-fns/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /tests/ })).toBeTruthy();
    // And none of the approval vocabulary survives.
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Deny/ })).toBeNull();
  });

  it('shows what each option means, which is the reason the model wrote it down', () => {
    mount(<InlinePermission item={pending()} />);
    expect(screen.getByText('Tree-shakeable, function per import.')).toBeTruthy();
    expect(screen.getByText('A full tsc build.')).toBeTruthy();
  });

  it('renders an option preview as text, never as markup', () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.click(screen.getByRole('button', { name: /preview/ }));
    // Model-authored content arriving through a tool argument does not get to
    // paint the app's own chrome, so it lands in a `pre`.
    const preview = screen.getByText('DateTime.now().toISO()');
    expect(preview.closest('pre')).toBeTruthy();
  });

  it('does not put focus on a control', () => {
    mount(<InlinePermission item={pending()} />);
    // Focus lands on the card, so a screen reader announces the whole ask and
    // the composer yields.
    expect(document.activeElement?.getAttribute('role')).toBe('group');
  });

  it('offers nothing to send until the user has said something', () => {
    mount(<InlinePermission item={pending()} />);
    const send = screen.getByRole('button', { name: /Send answer/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /date-fns/ }));
    expect((screen.getByRole('button', { name: /Send answer/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('answering', () => {
  it('sends the chosen option, keyed to the question it answers', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.click(screen.getByRole('radio', { name: /date-fns/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    });

    // Answering *is* allowing: the tool's only job is to carry the answers back.
    expect(sent[0]).toMatchObject({ behavior: 'allow' });
    expect(answersSent()).toEqual([{ question: 'Which date library?', options: ['date-fns'] }]);
  });

  it('keeps one choice per single-select question', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.click(screen.getByRole('radio', { name: /date-fns/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    });
    expect(answersSent()).toEqual([{ question: 'Which date library?', options: ['Luxon'] }]);
  });

  it('collects several choices for a multi-select question, in the order offered', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /tests/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    });
    expect(answersSent()).toEqual([
      { question: 'Which checks should run?', options: ['lint', 'tests'] },
    ]);
  });

  /**
   * Two boxes ticked inside one React batch. A toggle that read the current
   * selection through its props closure would see the pre-batch value twice and
   * silently drop the first tick — which is exactly what a fast pair of clicks
   * produces.
   */
  it('does not lose a choice when two are made before a re-render', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      screen.getByRole('checkbox', { name: /tests/ }).click();
      screen.getByRole('checkbox', { name: /lint/ }).click();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    });
    expect(answersSent()).toEqual([
      { question: 'Which checks should run?', options: ['lint', 'tests'] },
    ]);
  });

  it('sends free text alongside the choice, because the options may not be exhaustive', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.click(screen.getByRole('radio', { name: /date-fns/ }));
    fireEvent.change(screen.getAllByRole('textbox')[0] as HTMLTextAreaElement, {
      target: { value: 'but pin the version' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    });
    expect(answersSent()).toEqual([
      { question: 'Which date library?', options: ['date-fns'], notes: 'but pin the version' },
    ]);
  });

  it('takes an answer that is only prose', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.change(screen.getAllByRole('textbox')[0] as HTMLTextAreaElement, {
      target: { value: 'neither — use Temporal' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    });
    expect(answersSent()).toEqual([
      { question: 'Which date library?', options: [], notes: 'neither — use Temporal' },
    ]);
  });

  it('omits questions the user left alone rather than inventing an answer', async () => {
    mount(<InlinePermission item={pending()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /types/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    });
    expect(answersSent()).toEqual([{ question: 'Which checks should run?', options: ['types'] }]);
  });
});

describe('skipping', () => {
  /**
   * There is nothing here to refuse. A skip tells the model the questions went
   * unanswered and to use its own judgement, which is what a person who does
   * not want to choose means. A denial would read as a rejection of the asking
   * — and would leave the model with a permission error instead of an answer.
   */
  it('skips with an allow carrying no answers, not a denial', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    });
    expect(sent).toEqual([{ behavior: 'allow', answers: [] }]);
  });

  it('skips on Escape, which unblocks the run rather than stranding it', async () => {
    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole('group')[0] as HTMLElement, { key: 'Escape' });
    });
    expect(sent).toEqual([{ behavior: 'allow', answers: [] }]);
  });

  it('sends from the keyboard with a modifier, so Enter stays with the notes fields', async () => {
    mount(<InlinePermission item={pending()} />);
    const card = screen.getAllByRole('group')[0] as HTMLElement;
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));

    await act(async () => {
      fireEvent.keyDown(card, { key: 'Enter' });
    });
    expect(sent).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(card, { key: 'Enter', metaKey: true });
    });
    expect(answersSent()).toEqual([{ question: 'Which date library?', options: ['Luxon'] }]);
  });
});

describe('the failure path', () => {
  it('reports a failed answer on the card itself', async () => {
    respond = () => ({
      ok: false,
      error: { code: 'transport', message: 'The main process did not respond.' },
    });

    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    });

    await waitFor(() => {
      expect(screen.getByText('The answer did not reach the run')).toBeTruthy();
    });
    // The controls stay live, because retrying is the only way out of a park.
    expect((screen.getByRole('button', { name: 'Skip' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears a question the provider has already withdrawn', async () => {
    respond = () => ({
      ok: false,
      error: { code: 'invalid_request', message: 'That request is no longer open.' },
    });

    mount(<InlinePermission item={pending()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    });

    await waitFor(() => {
      expect(appSession().permissionQueue).toHaveLength(0);
    });
  });
});

describe('the record it leaves', () => {
  it('shows the questions with what was chosen, not a bare verdict', () => {
    mount(
      <InlinePermission
        item={{
          ...pending(),
          state: 'answered',
          answers: [
            { question: 'Which date library?', options: ['Luxon'], notes: 'zones matter here' },
          ],
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: /Send answer/ })).toBeNull();
    expect(screen.getByText('answered')).toBeTruthy();
    // The question is kept alongside the answer: "Luxon" a screen further down
    // is unreadable without it.
    expect(screen.getByText('Which date library?')).toBeTruthy();
    expect(screen.getByText('Luxon')).toBeTruthy();
    expect(screen.getByText(/zones matter here/)).toBeTruthy();
    // A question that was left alone says so rather than looking answered.
    expect(screen.getByText('no option chosen')).toBeTruthy();
  });

  it('records a skip as a skip', () => {
    mount(
      <InlinePermission
        item={{ ...pending(), state: 'skipped', note: 'Left unanswered.', answers: [] }}
      />,
    );
    expect(screen.getByText('skipped')).toBeTruthy();
    expect(screen.getByText('Left unanswered.')).toBeTruthy();
  });
});
