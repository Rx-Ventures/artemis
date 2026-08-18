/**
 * @vitest-environment jsdom
 *
 * Watching the model think: the Appearance switch, and what it moves.
 *
 * The setting makes one claim with four parts, and each part fails somewhere
 * different, so each is pinned on its own:
 *
 *  - **It is on screen without a click.** The default folds reasoning into the
 *    activity marker, which is two clicks from the text. The whole request is
 *    that turning this on removes both, and the failure mode is quiet: the
 *    switch flips, the store is right, and the reader still has to go digging.
 *  - **It is in the thread, not in the marker.** Rendering it open inside the
 *    fold would satisfy the sentence above and still be the wrong shape — the
 *    reasoning has to sit between the work it came from, which is a question
 *    about grouping and is answered in the transcript model.
 *  - **It is muted.** The one visual promise the setting makes in words: that
 *    reasoning cannot be mistaken for the answer. Asserted on the class,
 *    unusually for this suite, because it is the requirement rather than a
 *    styling detail — sage prose was the shape this had before and it read as
 *    emphasis.
 *  - **It applies to the transcript already on screen.** How a reader tries
 *    this: open settings, flip it, look at the conversation behind the dialog.
 *    A standalone thinking row keeps its id across the change and so is never
 *    remounted, which is exactly the case a `defaultOpen` cannot reach.
 *
 * As with the other test files, `renderer/tsconfig.json` excludes these, so
 * `pnpm typecheck` never sees them and the assertions stay behavioural.
 */

import type { AgentEvent } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Transcript } from '@/components/Transcript';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { forgetFolds } from '@/lib/foldMemory';
import { setShowThinking, useApp } from '@/state/store';
import { appTranscript, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);

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
 * Longer than the 64 characters the collapsed line keeps.
 *
 * Load-bearing, not scene-setting: a short block's preview *is* its text, so a
 * `getByText` would match the closed trigger and every assertion below would
 * pass against a fold that never opened.
 */
const REASONING =
  'The composer owns the draft, so the send path is where the attachment has to be cleared';
const SECOND_THOUGHT =
  'That leaves the resume case, which reads the same draft back out of preferences on boot';

function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({
    ...draft,
    runId: 'run_1',
    seq: index,
    ts: 1000 + index,
  })) as AgentEvent[];
}

/*
 * `act` because half the assertions below are about a transcript that is
 * already mounted. The model notifies through `useSyncExternalStore`, which is
 * not a React event and so is not batched into a paint on its own — outside
 * `act` the DOM the query reads is the one from before the flush.
 */
function play(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): void {
  act(() => {
    for (const event of stream(...drafts)) appTranscript().apply(event);
    appTranscript().flush();
  });
}

/**
 * Move the switch the way the settings pane does, and let the pane catch up.
 *
 * The explicit flush is the real behaviour rather than a test convenience:
 * `setThinkingFolds` marks the model pending and the rebuild lands on the next
 * frame, which nothing here is waiting around for.
 */
function flip(on: boolean): void {
  act(() => {
    setShowThinking(on);
    appTranscript().flush();
  });
}

function call(id: string, name: string): Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>> {
  return [
    { type: 'tool.start', toolCallId: id, name, input: { command: 'ls' } },
    { type: 'tool.end', toolCallId: id, status: 'ok' },
  ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
}

function thought(blockIndex: number, text: string): Omit<AgentEvent, 'runId' | 'seq' | 'ts'> {
  return { type: 'thinking.delta', messageId: 'm1', blockIndex, text } as Omit<
    AgentEvent,
    'runId' | 'seq' | 'ts'
  >;
}

/** The element the block's prose was actually drawn into. */
function bodyOf(text: string): HTMLElement {
  return screen.getByText(text);
}

beforeEach(() => {
  forgetFolds();
  setShowThinking(false);
  appTranscript().reset();
  appTranscript().flush();
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    run: null,
    permissionQueue: [],
    conversationWidth: 'comfortable',
    runSummary: 'always',
  });
});

afterEach(() => {
  cleanup();
  setShowThinking(false);
});

describe('the Appearance switch', () => {
  it('is off to begin with, so the transcript reads as it always did', () => {
    expect(useApp.getState().showThinking).toBe(false);
  });

  it('writes the store, and back again', () => {
    render(
      <TooltipProvider>
        <AppearanceSection />
      </TooltipProvider>,
    );

    const toggle = screen.getByRole('switch', { name: 'Show the model’s reasoning' });
    fireEvent.click(toggle);
    expect(useApp.getState().showThinking).toBe(true);

    fireEvent.click(toggle);
    expect(useApp.getState().showThinking).toBe(false);
  });
});

describe('with the switch off', () => {
  it('keeps the reasoning folded into the work it belongs to', () => {
    play(thought(0, REASONING), ...call('c1', 'Grep'));
    render(<Transcript />);

    expect(screen.getByText('Searched the code')).not.toBeNull();
    expect(screen.queryByText(REASONING)).toBeNull();
  });
});

describe('with the switch on', () => {
  beforeEach(() => setShowThinking(true));

  it('puts the reasoning on screen without a click', () => {
    play(thought(0, REASONING), ...call('c1', 'Grep'));
    render(<Transcript />);

    expect(bodyOf(REASONING)).not.toBeNull();
  });

  it('stands it in the thread, with the work still folded around it', () => {
    play(
      thought(0, REASONING),
      ...call('c1', 'Grep'),
      ...call('c2', 'Grep'),
      thought(1, SECOND_THOUGHT),
      ...call('c3', 'Read'),
    );
    render(<Transcript />);

    // Both stretches of reasoning are readable, and the calls between them are
    // still one line each rather than five rows of machinery.
    expect(bodyOf(REASONING)).not.toBeNull();
    expect(bodyOf(SECOND_THOUGHT)).not.toBeNull();
    expect(screen.getByText('Searched the code 2 times')).not.toBeNull();
    expect(screen.getByText('Read a file')).not.toBeNull();
    // Nothing was unfolded to achieve it: the calls are still behind the marker.
    expect(screen.queryByText('Grep')).toBeNull();
  });

  it('draws it as muted prose rather than as the answer', () => {
    play(thought(0, REASONING));
    render(<Transcript />);

    // The promise the setting makes in words. Sage here would read as emphasis,
    // which is the opposite of "obviously not the answer".
    expect(bodyOf(REASONING).className).toContain('text-ink-muted');
  });

  it('grows as the model writes it', () => {
    play(thought(0, REASONING));
    render(<Transcript />);
    expect(bodyOf(REASONING)).not.toBeNull();

    play(thought(0, ` — ${SECOND_THOUGHT}`));
    expect(bodyOf(`${REASONING} — ${SECOND_THOUGHT}`)).not.toBeNull();
  });

  it('still lets one long block be collapsed on its own', () => {
    play(thought(0, REASONING));
    render(<Transcript />);

    // By role, not by text: the gutter beside it says "thinking" too, and only
    // one of the two is the disclosure.
    fireEvent.click(screen.getByRole('button', { name: 'thinking' }));
    expect(screen.queryByText(REASONING)).toBeNull();
    // And the collapsed line still says what is in there.
    expect(screen.getByText(/^The composer owns the draft/)).not.toBeNull();
  });

  it('says who is redacting, rather than showing an empty aside', () => {
    play({
      type: 'thinking.delta',
      messageId: 'm1',
      blockIndex: 0,
      text: '',
      redacted: true,
    } as Omit<AgentEvent, 'runId' | 'seq' | 'ts'>);
    render(<Transcript />);

    expect(
      screen.getByText('This thinking block was encrypted or withheld by the provider.'),
    ).not.toBeNull();
  });
});

describe('flipping the switch under a transcript already on screen', () => {
  it('unfolds the turn the reader is looking at', () => {
    play(thought(0, REASONING), ...call('c1', 'Grep'));
    render(<Transcript />);
    expect(screen.queryByText(REASONING)).toBeNull();

    flip(true);

    expect(bodyOf(REASONING)).not.toBeNull();
  });

  /*
   * The case a `defaultOpen` cannot reach, and the reason `ThinkingRow` keeps
   * its own state instead of using `useFold`. A lone thinking block is already
   * a row of its own with the switch off, so flipping it changes nothing
   * structural: same row id, same component instance, no remount. Read once at
   * mount, the default would still say "closed" and this row alone would sit
   * shut while the rest of the pane opened around it.
   */
  it('opens a block that was already standing on its own', () => {
    play(thought(0, REASONING), { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'done' });
    render(<Transcript />);
    expect(screen.queryByText(REASONING)).toBeNull();

    flip(true);

    expect(bodyOf(REASONING)).not.toBeNull();
  });

  it('folds it all back away when the switch goes off', () => {
    setShowThinking(true);
    play(thought(0, REASONING), ...call('c1', 'Grep'));
    render(<Transcript />);
    expect(bodyOf(REASONING)).not.toBeNull();

    flip(false);

    expect(screen.queryByText(REASONING)).toBeNull();
    expect(screen.getByText('Searched the code')).not.toBeNull();
  });
});
