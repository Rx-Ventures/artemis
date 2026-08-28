/**
 * @vitest-environment jsdom
 *
 * A slash command in the thread, as a line rather than as markup.
 *
 * When the user runs `/model`, the CLI narrates it down the message stream as
 * two ordinary user messages wrapped in its own XML — the invocation, then
 * whatever it printed. Rendered literally, that is two full-width chat bubbles
 * of `<command-name>…</command-name>` per command, which is what this replaces.
 *
 * What is pinned here is what a reader actually gets, end to end from the
 * events the adapter emits:
 *
 *  - **The markup is gone.** Not merely prettier — the angle brackets must not
 *    be on screen at all, in any row. This is the whole complaint.
 *  - **The command and its result read as one thing**, because they are one
 *    thing that happened, and the wire's two-message shape is an accident of
 *    the CLI's presentation.
 *  - **It is not a chat turn.** `/model` never reached the model. Drawing it in
 *    the user's bubble files a settings change as something the user said.
 *
 * As with the other test files, `renderer/tsconfig.json` excludes these, so
 * `pnpm typecheck` never sees them and the assertions stay behavioural.
 */

import type { AgentEvent } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { Transcript } from '@/components/Transcript';
import { TooltipProvider } from '@/components/ui/tooltip';
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

function play(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): void {
  act(() => {
    drafts.forEach((draft, index) => {
      appTranscript().apply({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index } as AgentEvent);
    });
    appTranscript().flush();
  });
}

beforeEach(() => {
  seedApp({ capabilities: CAPABILITIES });
});

afterEach(() => {
  cleanup();
});

function mount(): void {
  render(
    <TooltipProvider>
      <Transcript />
    </TooltipProvider>,
  );
}

describe('a slash command in the thread', () => {
  it('draws the command and what it printed as one row', () => {
    mount();
    play({
      type: 'command.run',
      command: { name: 'model', args: 'opus[1m]', output: 'Set model to Opus 5 (1M context)' },
    });

    expect(screen.getByText('/model')).toBeTruthy();
    expect(screen.getByText('opus[1m]')).toBeTruthy();
    expect(screen.getByText('Set model to Opus 5 (1M context)')).toBeTruthy();
  });

  it('never puts the CLI markup on screen', () => {
    mount();
    play({
      type: 'command.run',
      command: { name: 'effort', output: 'Set effort level to ultracode (this session only)' },
    });

    // The complaint, asserted directly: no angle-bracket envelope anywhere in
    // the rendered thread, under any row kind.
    expect(document.body.textContent).not.toContain('<command-name>');
    expect(document.body.textContent).not.toContain('<local-command-stdout>');
    expect(document.body.textContent).toContain('Set effort level to ultracode');
  });

  it('is not drawn as something the user said', () => {
    mount();
    play(
      { type: 'command.run', command: { name: 'model', output: 'Set model to Fable 5' } },
      {
        type: 'text.complete',
        messageId: 'm1',
        role: 'user',
        text: 'now ship it',
        replay: true,
      },
    );

    // One "you" turn in the thread — the sentence the user typed. The command
    // is a record of a session change, not a turn.
    expect(screen.getAllByText('you')).toHaveLength(1);
    expect(screen.getByText('now ship it')).toBeTruthy();
  });

  it('shows a command that printed nothing', () => {
    // A plugin command expands into a prompt and prints not one word. It is
    // still the reason the next turn happened.
    mount();
    play({ type: 'command.run', command: { name: 'mattpocock-skills:implement' } });

    expect(screen.getByText('/mattpocock-skills:implement')).toBeTruthy();
  });

  it('marks output that came from the error stream', () => {
    mount();
    play({
      type: 'command.run',
      command: { name: 'nope', output: 'unknown command', failed: true },
    });

    const output = screen.getByText('unknown command');
    expect(output.className).toContain('signal');
    // The name is not tinted with it: the command ran, its result failed.
    expect(screen.getByText('/nope').className).not.toContain('signal');
  });
});
