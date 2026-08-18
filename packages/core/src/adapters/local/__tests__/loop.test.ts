/**
 * The agent loop.
 *
 * Driven against a scripted completion function rather than a model, because
 * the cases worth testing are the ones a real model will not produce on demand:
 * looping forever, naming a tool that does not exist, and being refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runAgentLoop } from '../loop.js';
import type { ChatMessage, CompletionRequest, CompletionResult } from '../loop.js';
import { READ_FILE, SHELL, WRITE_FILE } from '../tools.js';
import type { ToolContext } from '../tools.js';

let base: string;
let root: string;
let ctx: ToolContext;

const USER: readonly ChatMessage[] = [{ role: 'user', content: 'do the thing' }];

/** A completion function that replays a script, then answers plainly. */
function scripted(...steps: CompletionResult[]): {
  complete: (r: CompletionRequest) => Promise<CompletionResult>;
  seen: CompletionRequest[];
} {
  const seen: CompletionRequest[] = [];
  let i = 0;
  return {
    seen,
    complete: async (request) => {
      seen.push({ messages: [...request.messages], tools: request.tools });
      return steps[i++] ?? { text: 'done', toolCalls: [] };
    },
  };
}

const call = (name: string, args: unknown, id = 'c1') => ({
  id,
  name,
  argumentsJson: JSON.stringify(args),
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'artemis-loop-')));
  root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'hello\n');

  ctx = {
    root,
    env: {},
    signal: new AbortController().signal,
    shell: async (command) => ({ output: `ran: ${command}` }),
  };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('runAgentLoop', () => {
  it('returns the answer when the model asks for no tools', async () => {
    const { complete } = scripted({ text: 'the answer', toolCalls: [] });

    const out = await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
    });

    expect(out).toBe('the answer');
  });

  it('executes a tool and feeds the result back for a second completion', async () => {
    const { complete, seen } = scripted(
      { text: '', toolCalls: [call('read_file', { path: 'a.txt' })] },
      { text: 'the file says hello', toolCalls: [] },
    );

    const out = await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
    });

    expect(out).toBe('the file says hello');
    // The second request carries the assistant's call and the tool's answer.
    const second = seen[1]?.messages ?? [];
    expect(second.at(-2)?.role).toBe('assistant');
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(second.at(-1)?.content).toContain('hello');
  });

  it('PROTOCOL: records the assistant call before the result that answers it', async () => {
    // A server handed results for calls it has no record of asking for rejects
    // the request outright.
    const { complete, seen } = scripted(
      { text: '', toolCalls: [call('read_file', { path: 'a.txt' })] },
      { text: 'done', toolCalls: [] },
    );

    await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
    });

    const messages = seen[1]?.messages ?? [];
    const assistant = messages.findIndex((m) => m.role === 'assistant');
    const tool = messages.findIndex((m) => m.role === 'tool');
    expect(assistant).toBeGreaterThanOrEqual(0);
    expect(assistant).toBeLessThan(tool);
    expect(messages[assistant]?.tool_calls?.[0]?.id).toBe('c1');
  });

  it('runs two calls in one round, keeping their ids apart', async () => {
    const { complete } = scripted(
      {
        text: '',
        toolCalls: [call('read_file', { path: 'a.txt' }, 'x'), call('read_file', { path: 'a.txt' }, 'y')],
      },
      { text: 'both read', toolCalls: [] },
    );
    const ended: string[] = [];

    await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
      onToolEnd: (c) => ended.push(c.id),
    });

    expect(ended).toEqual(['x', 'y']);
  });

  it('DENY: a refusal is a result the model can respond to, not the end of the run', async () => {
    const { complete, seen } = scripted(
      { text: '', toolCalls: [call('write_file', { path: 'b.txt', content: 'x' })] },
      { text: 'understood, I will not', toolCalls: [] },
    );

    const out = await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [WRITE_FILE],
      context: ctx,
      approve: async () => 'deny',
    });

    expect(out).toBe('understood, I will not');
    expect(seen[1]?.messages.at(-1)?.content).toMatch(/declined/);
    // And nothing was written.
    await expect(readFile(path.join(root, 'b.txt'), 'utf8')).rejects.toThrow();
  });

  it('asks about each call, and is told which tool it is', async () => {
    const approve = vi.fn(async () => 'allow' as const);
    const { complete } = scripted(
      { text: '', toolCalls: [call('write_file', { path: 'b.txt', content: 'x' })] },
      { text: 'done', toolCalls: [] },
    );

    await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [WRITE_FILE],
      context: ctx,
      approve,
    });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]?.[1]).toMatchObject({ name: 'write_file', risk: 'write' });
  });

  it('UNKNOWN TOOL: answers the model instead of asking the user about nothing', async () => {
    const approve = vi.fn(async () => 'allow' as const);
    const { complete, seen } = scripted(
      { text: '', toolCalls: [call('rm_rf', {})] },
      { text: 'oh, my mistake', toolCalls: [] },
    );

    const out = await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve,
    });

    expect(approve).not.toHaveBeenCalled();
    expect(seen[1]?.messages.at(-1)?.content).toMatch(/No tool called "rm_rf"/);
    expect(out).toBe('oh, my mistake');
  });

  it('feeds a tool failure back rather than ending the run', async () => {
    const { complete, seen } = scripted(
      { text: '', toolCalls: [call('read_file', { path: '../escape' })] },
      { text: 'I will stay inside', toolCalls: [] },
    );

    const out = await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
    });

    expect(seen[1]?.messages.at(-1)?.content).toMatch(/outside this run's directory/);
    expect(out).toBe('I will stay inside');
  });

  it('LOOPING: stops at the ceiling and says so rather than passing it off as an answer', async () => {
    // The most common small-model failure: the same call, forever. Without a
    // bound one prompt runs until the user kills the app.
    const complete = async (): Promise<CompletionResult> => ({
      text: 'thinking',
      toolCalls: [call('read_file', { path: 'a.txt' })],
    });

    const out = await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
      maxIterations: 3,
    });

    expect(out).toMatch(/Stopped after 3 tool rounds/);
    expect(out).toMatch(/looping/);
  });

  it('says so even when the looping model produced no text at all', async () => {
    const complete = async (): Promise<CompletionResult> => ({
      text: '',
      toolCalls: [call('read_file', { path: 'a.txt' })],
    });

    const out = await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
      maxIterations: 2,
    });

    expect(out).toMatch(/without a final answer/);
  });

  it('reports every call and result for the transcript, as they happen', async () => {
    const events: string[] = [];
    const { complete } = scripted(
      { text: '', toolCalls: [call('read_file', { path: 'a.txt' })] },
      { text: 'done', toolCalls: [] },
    );

    await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
      onToolStart: (c) => events.push(`start:${c.name}`),
      onToolEnd: (c, _out, failed) => events.push(`end:${c.name}:${failed}`),
    });

    expect(events).toEqual(['start:read_file', 'end:read_file:false']);
  });

  it('offers the model only the tools it was given', async () => {
    const { complete, seen } = scripted({ text: 'done', toolCalls: [] });

    await runAgentLoop({
      initialMessages: USER,
      complete,
      tools: [READ_FILE],
      context: ctx,
      approve: async () => 'allow',
    });

    expect(seen[0]?.tools.map((t) => t.name)).toEqual([READ_FILE.name]);
    expect(seen[0]?.tools).not.toContain(SHELL);
  });

  it('starts from the conversation it was given', async () => {
    const { complete, seen } = scripted({ text: 'done', toolCalls: [] });

    await runAgentLoop({
      initialMessages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
      complete,
      tools: [],
      context: ctx,
      approve: async () => 'allow',
    });

    expect(seen[0]?.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});
