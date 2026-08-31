/**
 * @vitest-environment jsdom
 *
 * A mid-run message's delivery state, under the message itself.
 *
 * The composer's strip answers "is anything waiting". Standing over a
 * conversation with several turns in it, that is not quite the question a
 * person is asking — they want to know whether *the thing they just typed* has
 * been heard, and the place to answer that is under the words they typed.
 *
 * So the user row's control strip — the one that already carries fork and
 * rewind — carries two more things while the message is waiting: the state
 * itself, and the lever that changes it. The lever is the interrupt, which the
 * CLI's queue survives by design; it makes the provider read the message now
 * rather than at its next tool break.
 *
 * What these pin:
 *
 *  - The indicator is on the *queued* message and on no other, keyed on the
 *    identity `submitPrompt` filed it under. A conversation full of settled
 *    turns must not sprout a "Queued" chip under every one of them.
 *  - It **resolves by leaving**. Once the provider is seen to read the message
 *    the row goes back to looking like every other settled turn, which is what
 *    keeps it honest against the strip: both read the pane's one queued set,
 *    so they cannot disagree about a message the way a count and a fold did.
 *  - The lever is the interrupt and nothing else — the message is already with
 *    the provider, and re-sending it would be a second copy.
 *  - Fork and rewind still work while a message is queued. The new controls
 *    join that row; they do not take it over.
 *
 * As with the neighbouring component tests, `renderer/tsconfig.json` excludes
 * these, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Transcript } from '@/components/Transcript';
import { TooltipProvider } from '@/components/ui/tooltip';
import { handleAgentEvent, resetRunStreamState } from '@/state/store';
import { appTranscript, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const interruptRun = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const submitPrompt = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const rewindConversationTo = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  interruptRun,
  submitPrompt,
  rewindConversationTo,
}));

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
 * A pane mid-turn, holding `queued` as the set of messages the provider has
 * not been seen to read.
 */
function setUp(queuedSteers: readonly string[]): void {
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
    capabilities: CAPABILITIES,
    cwd: '/w',
    draft: '',
    permissionQueue: [],
    banners: [],
    promptHistory: [],
    suggestion: null,
    run: {
      runId: 'run_1',
      status: 'running',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: CAPABILITIES,
      startedAt: 0,
      sessionId: 'sess-1',
      promptsSent: 2,
      queuedSteers,
    },
  });
}

/**
 * Two settled user rows: the turn's opening prompt, and a steer typed into it.
 *
 * Drawn the way the window draws them — optimistically, claiming the identity
 * the registry will retain each under — because that claim is exactly what the
 * queued set is keyed on.
 */
function drawTurn(): void {
  act(() => {
    const model = appTranscript();
    const opening = model.pushUserMessage('start the refactor', undefined, 'run_1:prompt:1');
    model.confirmUserMessage(opening);
    const steer = model.pushUserMessage('actually, do the tests first', undefined, 'run_1:prompt:2');
    model.confirmUserMessage(steer);
    model.flush();
  });
}

function mount(ui: ReactNode = <Transcript />): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

const readNow = (): HTMLElement[] =>
  screen.queryAllByRole('button', { name: /Interrupt the turn so this message is read now/ });

beforeEach(() => {
  interruptRun.mockClear();
  submitPrompt.mockClear();
  rewindConversationTo.mockClear();
  // The transcript is a singleton across a file's tests, and these draw the
  // same two rows in each of them.
  resetRunStreamState();
  appTranscript().reset();
});

afterEach(cleanup);

describe('the delivery state under a mid-run message', () => {
  it('marks the queued message, and only that one', () => {
    setUp(['run_1:prompt:2']);
    mount();
    drawTurn();

    // One chip and one lever, for the one message that is waiting — not one
    // under every settled turn in the thread.
    expect(screen.getAllByText('Queued')).toHaveLength(1);
    expect(readNow()).toHaveLength(1);

    // And it is under the steer, not under the prompt that opened the turn.
    const turn = screen.getByText('Queued').closest('[class*="group/turn"]');
    expect(turn?.textContent).toContain('actually, do the tests first');
    expect(turn?.textContent).not.toContain('start the refactor');
  });

  it('resolves once the provider has read it', () => {
    setUp(['run_1:prompt:2']);
    mount();
    drawTurn();
    expect(screen.getAllByText('Queued')).toHaveLength(1);

    /*
     * The fold, as the adapter reports it. This is the signal the strip never
     * had — and running it through the real event door is the point of the
     * test: the same `message.delivered` that takes the composer's count down
     * is what takes this row's chip away, because both are reading the pane's
     * one queued set.
     */
    act(() => {
      handleAgentEvent({
        type: 'message.delivered',
        runId: 'run_1',
        seq: 9,
        ts: 2000,
        messageId: 'run_1:prompt:2',
      } as never);
    });

    // It resolves by leaving: a settled turn is just a settled turn again.
    expect(screen.queryByText('Queued')).toBeNull();
    expect(readNow()).toHaveLength(0);
  });

  it('offers the interrupt, and the lever is exactly that', () => {
    setUp(['run_1:prompt:2']);
    mount();
    drawTurn();

    const button = readNow()[0];
    expect(button).toBeTruthy();
    if (button === undefined) throw new Error('no interrupt control');
    fireEvent.click(button);

    expect(interruptRun).toHaveBeenCalledTimes(1);
    // The message is already with the provider; nothing is re-sent on the
    // user's behalf.
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it('leaves fork and rewind where they were', () => {
    // The new controls join the existing row rather than replacing it — a
    // queued message is still a message you can branch from.
    setUp(['run_1:prompt:2']);
    mount();
    drawTurn();

    expect(
      screen.getAllByRole('button', { name: /Fork the conversation from this message/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /Rewind the conversation to before this message/ })
        .length,
    ).toBeGreaterThan(0);
  });

  it('says nothing about a message on a run that is no longer live', () => {
    // Between `run.end` and the continuation claim there is nothing to
    // interrupt, so there is nothing worth saying about the wait either.
    setUp(['run_1:prompt:2']);
    act(() => {
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
        capabilities: CAPABILITIES,
        cwd: '/w',
        draft: '',
        permissionQueue: [],
        banners: [],
        promptHistory: [],
        suggestion: null,
        run: {
          runId: 'run_1',
          status: 'ended',
          providerId: 'claude',
          profileId: 'p1',
          cwd: '/w',
          capabilities: CAPABILITIES,
          startedAt: 0,
          sessionId: 'sess-1',
          promptsSent: 2,
          queuedSteers: ['run_1:prompt:2'],
        },
      });
    });
    mount();
    drawTurn();

    expect(screen.queryByText('Queued')).toBeNull();
    expect(readNow()).toHaveLength(0);
  });
});
