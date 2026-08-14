/**
 * The seam where the prompt library meets a run.
 *
 * `withSystemPromptAppended` is small, and it is the last thing standing
 * between a library the user has curated and the model actually being told
 * about it — so its three branches are worth stating as tests rather than
 * leaving to a reading of the function.
 *
 * The composition it is handed is tested in `protocol/agentPrompts.test.ts`;
 * what is here is only what happens to a `RunInput` afterwards.
 */

import { describe, expect, it } from 'vitest';

import type { RunInput } from '@rx-artemis/protocol';

import { withSystemPromptAppended } from './engine.js';

const RUN: RunInput = {
  providerId: 'claude',
  profileId: 'work',
  cwd: '/repo',
  prompt: 'do the thing',
};

describe('withSystemPromptAppended', () => {
  it('leaves the run untouched when the library says nothing', () => {
    // Absent rather than an empty `append`: an omitted `systemPrompt` is what
    // lets the provider's preset through, and an append carrying nothing would
    // still cost a prompt-cache round to say it.
    expect(withSystemPromptAppended(RUN, undefined)).toBe(RUN);
    expect(withSystemPromptAppended(RUN, '')).toBe(RUN);
  });

  it('appends to the provider preset on an ordinary run', () => {
    expect(withSystemPromptAppended(RUN, 'Run the typechecker.').systemPrompt).toEqual({
      kind: 'append',
      text: 'Run the typechecker.',
    });
  });

  it('treats an explicit default the same as an absent one', () => {
    const asked: RunInput = { ...RUN, systemPrompt: { kind: 'default' } };
    expect(withSystemPromptAppended(asked, 'Library.').systemPrompt).toEqual({
      kind: 'append',
      text: 'Library.',
    });
  });

  it("keeps a caller's own append, and puts it first", () => {
    // Both were asked for, so neither is dropped — and the caller's is the more
    // specific request, so it is the one the model reads first.
    const asked: RunInput = { ...RUN, systemPrompt: { kind: 'append', text: 'Caller.' } };
    expect(withSystemPromptAppended(asked, 'Library.').systemPrompt).toEqual({
      kind: 'append',
      text: 'Caller.\n\nLibrary.',
    });
  });

  it('refuses to fold the library into a replaced prompt', () => {
    // `replace` means the provider's preset should not be there. The library's
    // prompts are written to sit after a preset that has already described the
    // tools, so appending here would quietly change what they are added to.
    const asked: RunInput = { ...RUN, systemPrompt: { kind: 'replace', text: 'Only this.' } };
    expect(withSystemPromptAppended(asked, 'Library.')).toBe(asked);
  });

  it('does not mutate the input it was given', () => {
    const asked: RunInput = { ...RUN };
    withSystemPromptAppended(asked, 'Library.');
    expect(asked.systemPrompt).toBeUndefined();
  });
});
