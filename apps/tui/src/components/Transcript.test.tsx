/**
 * The fold: a run's calls read as one count, what is still running or went
 * wrong stays out in full, and the count sits where the first call was made
 * rather than after the answer the calls produced.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AgentEvent } from '@rx-artemis/protocol';

import { ReplayRows } from './Transcript.js';

/** Envelope filler; timestamps rise with position, which is what the order rests on. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('the transcript fold', () => {
  it('counts what finished, shows what is running and what failed, in the order things began', async () => {
    const events = stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Looking around.' },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'README.md' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: 'README.md' } },
      { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: '# Artemis' },
      { type: 'tool.start', toolCallId: 'c3', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'tool.end', toolCallId: 'c3', status: 'error', error: { message: 'exit code 1' } },
      { type: 'tool.start', toolCallId: 'c4', name: 'Bash', input: { command: 'sleep 100' } },
      { type: 'text.delta', messageId: 'm2', blockIndex: 0, text: 'Still going.' },
    );
    const { lastFrame } = render(<ReplayRows events={events} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Ran a command, read a file');
    expect(frame).toContain('Bash(pnpm test)');
    expect(frame).toContain('Error: exit code 1');
    expect(frame).toContain('Bash(sleep 100)');
    // Folded away: a finished call is a number, not a row.
    expect(frame).not.toContain('Bash(ls)');
    expect(frame).not.toContain('README.md');

    const at = (text: string): number => frame.indexOf(text);
    expect(at('Looking around.')).toBeLessThan(at('Ran a command'));
    expect(at('Ran a command')).toBeLessThan(at('Bash(sleep 100)'));
    expect(at('Bash(sleep 100)')).toBeLessThan(at('Still going.'));
  });
});
