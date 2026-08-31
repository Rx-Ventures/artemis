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

import { mergeAdditionalDirectories, withSystemPromptAppended } from './engine.js';

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

/**
 * The other per-run transform: folding the enabled memory banks into the
 * directories a run may reach. The engine's gating and the `banksForRun` read
 * are I/O; what is pure and worth pinning is the merge itself — that it never
 * drops the user's own folders, never doubles a bank, and leaves a machine with
 * the switch off exactly as it was.
 */
describe('mergeAdditionalDirectories', () => {
  const BANKS = ['/home/me/Documents/cortex', '/home/me/Documents/team'];

  it('does nothing when the master switch is off — reference returned untouched', () => {
    // A machine that has not opted in starts exactly the run it always did,
    // undefined included.
    expect(mergeAdditionalDirectories(undefined, BANKS, false)).toBeUndefined();
    const own = ['/work/extra'];
    expect(mergeAdditionalDirectories(own, BANKS, false)).toBe(own);
  });

  it('does nothing when there are no banks to add', () => {
    const own = ['/work/extra'];
    expect(mergeAdditionalDirectories(own, [], true)).toBe(own);
    expect(mergeAdditionalDirectories(undefined, [], true)).toBeUndefined();
  });

  it('attaches the banks when the switch is on and the run brought none', () => {
    expect(mergeAdditionalDirectories(undefined, BANKS, true)).toEqual(BANKS);
  });

  it("keeps the user's own directories first, then the banks", () => {
    expect(mergeAdditionalDirectories(['/work/extra'], BANKS, true)).toEqual([
      '/work/extra',
      ...BANKS,
    ]);
  });

  it('is idempotent: a resumed run already carrying its banks is handed back unchanged', () => {
    const already = ['/work/extra', ...BANKS];
    expect(mergeAdditionalDirectories(already, BANKS, true)).toBe(already);
  });

  it('dedupes a path present on both sides without disturbing order', () => {
    const own = ['/home/me/Documents/cortex', '/work/extra'];
    expect(mergeAdditionalDirectories(own, BANKS, true)).toEqual([
      '/home/me/Documents/cortex',
      '/work/extra',
      '/home/me/Documents/team',
    ]);
  });
});
