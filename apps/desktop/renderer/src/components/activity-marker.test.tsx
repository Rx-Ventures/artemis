/**
 * @vitest-environment jsdom
 *
 * What the transcript says about a burst of work, and who it says spoke.
 *
 * Four things here are easy to break silently, which is why they are asserted
 * rather than eyeballed:
 *
 *  - **The roll-up.** A turn that ran forty tools must render as one line, not
 *    forty rows. The failure mode is not a crash — it is a pane that quietly
 *    goes back to being unreadable, which no other test would notice.
 *  - **What counts as one burst.** Thinking between two calls belongs to the
 *    same stretch of work. If it starts breaking the run again, the roll-up
 *    still passes its own test and the pane is unreadable anyway — a marker
 *    around every single call, with a thinking row between each pair.
 *  - **The failure that must not be summarised away.** "Ran 36 commands" has to
 *    read differently when one of them failed. A regression here hides errors
 *    behind a cheerful summary, which is the worst thing this marker could do.
 *  - **Whose mark is on the answer.** With two accounts signed in, the provider
 *    logo is the only thing on screen saying which model wrote a turn, and it
 *    belongs on the agent's side only.
 *
 * As with the other test files, `renderer/tsconfig.json` excludes these, so
 * `pnpm typecheck` never sees them and the assertions stay behavioural.
 */

import type { AgentEvent } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Transcript } from '@/components/Transcript';
import { forgetFolds } from '@/lib/foldMemory';
import { useApp } from '@/state/store';
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

/** Envelope filler, so the tests read as event bodies rather than plumbing. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({
    ...draft,
    runId: 'run_1',
    seq: index,
    ts: 1000 + index,
  })) as AgentEvent[];
}

/** Feed the singleton the way a run would, then settle it synchronously. */
function play(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): void {
  for (const event of stream(...drafts)) appTranscript().apply(event);
  appTranscript().flush();
}

function call(id: string, name: string, status = 'ok'): Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>> {
  return [
    { type: 'tool.start', toolCallId: id, name, input: { command: 'ls' } },
    { type: 'tool.end', toolCallId: id, status },
  ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
}

beforeEach(() => {
  // A fresh transcript, and no memory of folds opened in the last test: fold
  // state is keyed by transcript id and these fixtures reuse ids.
  forgetFolds();
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

afterEach(cleanup);

describe('the activity marker', () => {
  it('rolls a burst of tool calls into one line instead of one row each', () => {
    play(...call('c1', 'Bash'), ...call('c2', 'Bash'), ...call('c3', 'Read'));
    render(<Transcript />);

    expect(screen.getByText('Ran 2 commands, read a file')).not.toBeNull();

    // The individual calls are folded away until asked for. If this starts
    // failing, the roll-up has stopped rolling anything up.
    expect(screen.queryByText('Bash')).toBeNull();
    expect(screen.queryByText('Read')).toBeNull();
  });

  it('gives the calls back when the marker is opened', () => {
    play(...call('c1', 'Bash'), ...call('c2', 'Read'));
    render(<Transcript />);

    fireEvent.click(screen.getByText('Ran a command, read a file'));

    expect(screen.getByText('Bash')).not.toBeNull();
    expect(screen.getByText('Read')).not.toBeNull();
  });

  it('reads in the present tense while a call is still running', () => {
    play({ type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: {} });
    render(<Transcript />);

    expect(screen.getByText('Running a command')).not.toBeNull();
  });

  it('never lets a failure hide behind a cheerful summary', () => {
    play(
      ...call('c1', 'Bash'),
      ...call('c2', 'Bash', 'error'),
      ...call('c3', 'Bash', 'denied'),
    );
    render(<Transcript />);

    expect(screen.getByText('· 2 failed')).not.toBeNull();
    // Said on the line, and the line is all it does. A failure used to open the
    // marker, which read as protective and was not: `defaultOpen` is consulted
    // once per mount, so it never caught a group failing under a reader who was
    // watching — only a reader arriving at a conversation, who was dropped at
    // the foot of every failed call in it. See `ActivityMarker`.
    expect(screen.queryByText('Bash')).toBeNull();
  });

  it('leaves the thinking between two calls on screen, and folds only the calls', () => {
    play(
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'where does this live' },
      ...call('c1', 'Grep'),
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 1, text: 'now the other file' },
      ...call('c2', 'Read'),
    );
    render(<Transcript />);

    // One marker for the work, and both blocks of reasoning readable without a
    // click. Reasoning is what the model was working out and belongs in the
    // conversation; the marker is the account of how, and belongs under it.
    //
    // Both blocks in one row, since the call that separated them is in the
    // marker rather than between them on screen — see `thinkingRow` in
    // `state/transcript.ts`.
    expect(screen.getByText('Read a file, searched the code')).not.toBeNull();
    expect(screen.getByText('where does this live now the other file')).not.toBeNull();
  });

  it('gives back the calls, and only the calls, when the marker is opened', () => {
    play(
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'where does this live' },
      ...call('c1', 'Grep'),
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 1, text: 'now the other file' },
      ...call('c2', 'Read'),
    );
    render(<Transcript />);

    // Counted before, so the assertion is about what opening the marker *adds*
    // rather than about how many times a thinking row spells its own name.
    const before = screen.getAllByText('thinking').length;
    fireEvent.click(screen.getByText('Read a file, searched the code'));

    expect(screen.getByText('Grep')).not.toBeNull();
    expect(screen.getByText('Read')).not.toBeNull();
    // No reasoning came out of the fold, because none went in.
    expect(screen.getAllByText('thinking').length).toBe(before);
  });

  it('puts thinking that did no work where the model wrote it', () => {
    play(
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'the short answer will do' },
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'no' },
    );
    render(<Transcript />);

    /*
     * Reasoning, then answer, in that order — which is the order it happened in
     * and the order it reads in. Both on screen without a click.
     */
    expect(screen.getByText('the short answer will do')).not.toBeNull();
    expect(screen.getByText('no')).not.toBeNull();
  });

  it('keeps one marker when the agent says something mid-run', () => {
    // The reported defect, inverted into a guarantee: a message no longer cuts
    // the work in two. Both calls collect into one marker under the prose.
    play(
      ...call('c1', 'Bash'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'halfway there' },
      ...call('c2', 'Read'),
    );
    render(<Transcript />);

    expect(screen.getByText('halfway there')).not.toBeNull();
    // One summary covering both, rather than "Ran a command" and "Read a file"
    // on either side of the sentence.
    expect(screen.getByText('Ran a command, read a file')).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Leaving the session and coming back                                        */
/* -------------------------------------------------------------------------- */

/**
 * Switching sessions resets the pane's transcript and replays the other one;
 * coming back resets it again and replays this one. `switchAway` is that round
 * trip, and it is deliberately the real thing rather than a re-render: the whole
 * defect was that a rebuilt row read its `defaultOpen` again and threw away what
 * the reader had done.
 *
 * The replay produces the same row ids because they are derived from what the
 * provider said — `t:<toolCallId>` here — which is the property the memory keys
 * depend on and the reason this can be tested at all.
 */
function switchAway(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): void {
  cleanup();
  appTranscript().reset();
  appTranscript().flush();
  play(...drafts);
  render(<Transcript />);
}

describe('a fold the reader operated', () => {
  it('stays closed after a session switch, even though it failed', () => {
    const burst = [...call('c1', 'Bash'), ...call('c2', 'Bash', 'error')];
    play(...burst);
    render(<Transcript />);

    // Shut on arrival, failure and all — the reported bug read from the other
    // end. Opening a conversation whose last turn had an error handed the
    // reader a marker holding every call in it, with the conversation itself
    // scrolled off the top of the column.
    expect(screen.queryByText('Bash')).toBeNull();

    // Opened by hand, then closed by hand: the two clicks are what makes this a
    // fact about the reader rather than about the default.
    fireEvent.click(screen.getByText('Ran 2 commands'));
    expect(screen.getAllByText('Bash').length).toBe(2);
    fireEvent.click(screen.getByText('Ran 2 commands'));
    expect(screen.queryByText('Bash')).toBeNull();

    switchAway(...burst);

    expect(screen.getByText('· 1 failed')).not.toBeNull();
    expect(screen.queryByText('Bash')).toBeNull();
  });

  it('stays open after a session switch, though nothing failed', () => {
    const burst = [...call('c1', 'Bash'), ...call('c2', 'Read')];
    play(...burst);
    render(<Transcript />);

    fireEvent.click(screen.getByText('Ran a command, read a file'));
    expect(screen.getByText('Bash')).not.toBeNull();

    switchAway(...burst);

    // The other direction, and the one a `defaultOpen`-only fix would miss: an
    // explicit open has to survive too, or the reader is told their click was
    // temporary in whichever direction the default happens to point.
    expect(screen.getByText('Bash')).not.toBeNull();
    expect(screen.getByText('Read')).not.toBeNull();
  });

  it('leaves a fold nobody touched to its own default', () => {
    const burst = [...call('c1', 'Bash'), ...call('c2', 'Bash', 'error')];
    play(...burst);
    render(<Transcript />);
    switchAway(...burst);

    // Memory is written by clicking, never by rendering, so a group nobody has
    // touched is still at its default — which is shut, whatever is inside it.
    expect(screen.queryByText('Bash')).toBeNull();
  });

  it('remembers a tool card and its result fold separately from the marker', () => {
    const burst = [...call('c1', 'Bash'), ...call('c2', 'Read')];
    play(...burst);
    render(<Transcript />);

    fireEvent.click(screen.getByText('Ran a command, read a file'));
    // Open the first card. Its `result` fold is closed by default — the call
    // succeeded — so opening that too is a second, independent choice.
    fireEvent.click(screen.getByText('Bash'));
    fireEvent.click(screen.getByRole('button', { name: 'result' }));
    expect(screen.getByRole('button', { name: 'result' }).getAttribute('aria-expanded')).toBe(
      'true',
    );

    switchAway(...burst);

    // All three choices come back: the marker open, that card open, its result
    // open — three keys off two ids, none of them standing in for another.
    expect(screen.getByText('Bash')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'result' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    // And the card the reader never touched is still closed: it has no folds on
    // screen to have an opinion about.
    expect(screen.getAllByRole('button', { name: 'result' }).length).toBe(1);
  });
});

/*
 * The provider mark used to sit in the gutter of every agent turn, and three
 * cases pinned it: that it named who answered, that it stayed off our own
 * turns, and that it kept naming the *run's* account after the window switched
 * to another one.
 *
 * It is gone. The fact it carried is real and does not change from row to row,
 * so repeating it under every paragraph was the one constant in the thread that
 * earned nothing — the status line and the header both name the provider, and
 * they name it once. What survives here is the claim that a turn's gutter stays
 * empty until the pointer arrives, because an avatar creeping back is exactly
 * the kind of change nobody notices in a diff.
 */
describe('the gutter of an agent turn', () => {
  it('carries no mark, on either side', () => {
    play({ type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'done' });
    appTranscript().pushUserMessage('fix the auth bug');
    appTranscript().flush();
    render(<Transcript />);

    expect(screen.getByText('done')).not.toBeNull();
    expect(screen.getByText('fix the auth bug')).not.toBeNull();
    expect(screen.queryByTitle('Claude')).toBeNull();
  });

  it('still names a subagent, which is a fact about the row rather than the thread', () => {
    play({
      type: 'text.complete',
      messageId: 'm1',
      role: 'assistant',
      text: 'searched the tree',
      agentId: 'task9',
    } as never);
    render(<Transcript />);

    expect(screen.getByText('subagent')).not.toBeNull();
  });
});
