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
    // And it opens itself, so the error output is on screen without a click.
    expect(screen.getAllByText('Bash').length).toBe(3);
  });

  it('folds the thinking between two calls into the same marker', () => {
    play(
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'where does this live' },
      ...call('c1', 'Grep'),
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 1, text: 'now the other file' },
      ...call('c2', 'Read'),
    );
    render(<Transcript />);

    expect(screen.getByText('Read a file, searched the code')).not.toBeNull();
    // Both blocks are inside the fold. Either one on screen means the burst
    // was cut in two and the marker is back to wrapping one call at a time.
    expect(screen.queryByText('where does this live')).toBeNull();
    expect(screen.queryByText('now the other file')).toBeNull();
  });

  it('gives the thinking back too when the marker is opened', () => {
    play(
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'where does this live' },
      ...call('c1', 'Grep'),
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 1, text: 'now the other file' },
      ...call('c2', 'Read'),
    );
    render(<Transcript />);

    fireEvent.click(screen.getByText('Read a file, searched the code'));

    expect(screen.getAllByText('thinking').length).toBe(2);
    expect(screen.getByText('where does this live')).not.toBeNull();
    expect(screen.getByText('Grep')).not.toBeNull();
    expect(screen.getByText('Read')).not.toBeNull();
  });

  it('leaves thinking that did no work as its own row', () => {
    play(
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'the short answer will do' },
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'no' },
    );
    render(<Transcript />);

    // Nothing to summarise, so nothing is hidden: the preview is on screen
    // without a click, which a marker would have cost.
    expect(screen.getByText('the short answer will do')).not.toBeNull();
  });

  it('starts a new marker when the agent says something mid-burst', () => {
    play(
      ...call('c1', 'Bash'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'halfway there' },
      ...call('c2', 'Read'),
    );
    render(<Transcript />);

    expect(screen.getByText('Ran a command')).not.toBeNull();
    expect(screen.getByText('Read a file')).not.toBeNull();
    expect(screen.getByText('halfway there')).not.toBeNull();
  });
});

describe('the provider mark', () => {
  it('sits on the agent’s turn, naming who answered', () => {
    play({ type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'done' });
    render(<Transcript />);

    expect(screen.getByTitle('Claude')).not.toBeNull();
  });

  it('does not appear on our own turns', () => {
    appTranscript().pushUserMessage('fix the auth bug');
    appTranscript().flush();
    render(<Transcript />);

    expect(screen.getByText('fix the auth bug')).not.toBeNull();
    expect(screen.queryByTitle('Claude')).toBeNull();
  });

  it('keeps saying who actually answered after the account is switched', () => {
    play({ type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'done' });
    seedApp({
      providers: [
        ...useApp.getState().providers,
        {
          id: 'codex',
          label: 'Codex',
          capabilities: CAPABILITIES,
          models: [],
          effortLevels: [],
          available: true,
        },
      ],
      run: {
        runId: 'run_1',
        status: 'running',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/w',
        capabilities: CAPABILITIES,
        startedAt: 0,
      },
      // The window has moved on to the other account; the transcript has not.
      activeProviderId: 'codex',
    });
    render(<Transcript />);

    expect(screen.getByTitle('Claude')).not.toBeNull();
    expect(screen.queryByTitle('Codex')).toBeNull();
  });
});
