/**
 * The prompt library on disk, against a real filesystem.
 *
 * No mocked `fs`, for the reason the shared-config probe's suite gives: the
 * value of this module is that it agrees with the disk, and the two properties
 * worth having — that a save is atomic, and that a corrupt file costs the pane
 * rather than the app — are both properties of real files.
 *
 * What is *not* tested here is the repair logic itself. That lives in the
 * protocol package and is tested there against every malformed shape; this file
 * only checks that the store runs it on both paths, which is what makes a saved
 * document identical to a read one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILT_IN_PROMPT_IDS, type AgentPrompt } from '@rx-artemis/protocol';

import { AGENT_PROMPTS_FILE, AgentPromptStore } from './agentPrompts.js';

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'artemis-prompts-'));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    rmSync(sandboxes.pop()!, { recursive: true, force: true });
  }
});

function userPrompt(over: Partial<AgentPrompt> = {}): AgentPrompt {
  return {
    id: 'p1',
    name: 'House style',
    markdown: 'Run the typechecker.',
    enabled: true,
    scope: { kind: 'all' },
    ...over,
  };
}

describe('AgentPromptStore', () => {
  it('reads a machine that has never saved as the shipped defaults', async () => {
    const store = new AgentPromptStore({ userDataDir: sandbox() });
    const document = await store.read();
    expect(document.prompts.map((p) => p.builtIn)).toEqual([...BUILT_IN_PROMPT_IDS]);
  });

  it('does not create the file just by being read', async () => {
    // A read on the path of every run must not touch the disk. Writing defaults
    // here would also mean a user who never opened the pane acquires a document
    // recording choices they never made.
    const dir = sandbox();
    await new AgentPromptStore({ userDataDir: dir }).read();
    expect(() => readFileSync(path.join(dir, AGENT_PROMPTS_FILE))).toThrow();
  });

  it('round-trips a save through a second store', async () => {
    const dir = sandbox();
    const written = await new AgentPromptStore({ userDataDir: dir }).write({
      version: 1,
      prompts: [userPrompt()],
    });
    // A second instance, so the assertion is about the file and not the cache.
    const read = await new AgentPromptStore({ userDataDir: dir }).read();
    expect(read).toEqual(written);
    expect(read.prompts[0]).toEqual(userPrompt());
  });

  it('keeps a built-in the user took over across a save and a fresh read', async () => {
    // The one claim the override feature makes about disk. The repairs run on
    // both paths, so a flag that did not survive `JSON.stringify` would revert
    // the user's text on the very next save — silently, since the pane does not
    // apply what a save answers with.
    const dir = sandbox();
    await new AgentPromptStore({ userDataDir: dir }).write({
      version: 1,
      prompts: [
        {
          id: 'builtin:cerebro',
          name: 'Use the team memory bank',
          markdown: 'Our bank, our rules.',
          enabled: true,
          scope: { kind: 'all' },
          builtIn: 'builtin:cerebro',
          overridden: true,
        },
      ],
    });
    const read = await new AgentPromptStore({ userDataDir: dir }).read();
    expect(read.prompts[0]?.overridden).toBe(true);
    expect(read.prompts[0]?.markdown).toBe('Our bank, our rules.');
  });

  it('answers a save with what landed, not with what was asked for', async () => {
    // Main restores the library's invariants on write, so the response can
    // differ from the request — the built-in the request omitted is back.
    const store = new AgentPromptStore({ userDataDir: sandbox() });
    const landed = await store.write({ version: 1, prompts: [userPrompt()] });
    expect(landed.prompts).toHaveLength(1 + BUILT_IN_PROMPT_IDS.length);
  });

  it('reads a corrupt file as the defaults instead of throwing', async () => {
    // The load-bearing case: this read is on the path of every run, and a run
    // that refused to start because a settings file was hand-edited badly would
    // be Artemis failing at its actual job over a feature the user may not have
    // touched.
    const dir = sandbox();
    writeFileSync(path.join(dir, AGENT_PROMPTS_FILE), '{ not json at all');
    const document = await new AgentPromptStore({ userDataDir: dir }).read();
    expect(document.prompts.map((p) => p.builtIn)).toEqual([...BUILT_IN_PROMPT_IDS]);
  });

  it('leaves no temp file behind after a save', async () => {
    // The write is temp-file-plus-rename. A `.tmp` surviving means the rename
    // did not happen and the document on disk is the *old* one.
    const dir = sandbox();
    await new AgentPromptStore({ userDataDir: dir }).write({ version: 1, prompts: [userPrompt()] });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('serialises overlapping saves so the last one wins', async () => {
    // Saves come from a debounced editor, so two really can be in flight. Without
    // the queue the earlier write's `rename` can land after the later one's.
    const dir = sandbox();
    const store = new AgentPromptStore({ userDataDir: dir });
    await Promise.all([
      store.write({ version: 1, prompts: [userPrompt({ name: 'first' })] }),
      store.write({ version: 1, prompts: [userPrompt({ name: 'second' })] }),
      store.write({ version: 1, prompts: [userPrompt({ name: 'third' })] }),
    ]);
    const read = await new AgentPromptStore({ userDataDir: dir }).read();
    expect(read.prompts[0]?.name).toBe('third');
  });

  it('keeps serving saves after one fails', async () => {
    // The write queue chains every save onto the last, so a rejection left on
    // the tail would reject every save after it — one transient disk error
    // locking the user out of the pane for the rest of the session. The
    // obstruction here is a *file* where the store wants a directory, which is
    // what makes the first `mkdir` fail and the second one succeed once it is
    // cleared.
    const dir = sandbox();
    const blocked = path.join(dir, 'store');
    writeFileSync(blocked, 'not a directory');

    const store = new AgentPromptStore({ userDataDir: blocked });
    await expect(store.write({ version: 1, prompts: [userPrompt()] })).rejects.toThrow();

    rmSync(blocked);
    await expect(store.write({ version: 1, prompts: [userPrompt()] })).resolves.toBeDefined();
    expect((await new AgentPromptStore({ userDataDir: blocked }).read()).prompts[0]).toEqual(
      userPrompt(),
    );
  });

  it('refuses a relative user-data directory', async () => {
    expect(() => new AgentPromptStore({ userDataDir: 'relative/path' })).toThrow();
  });

  it('re-reads from disk after reload()', async () => {
    const dir = sandbox();
    const store = new AgentPromptStore({ userDataDir: dir });
    await store.write({ version: 1, prompts: [userPrompt({ name: 'before' })] });

    writeFileSync(
      path.join(dir, AGENT_PROMPTS_FILE),
      JSON.stringify({ version: 1, prompts: [userPrompt({ name: 'edited by hand' })] }),
    );
    expect((await store.read()).prompts[0]?.name).toBe('before');

    store.reload();
    expect((await store.read()).prompts[0]?.name).toBe('edited by hand');
  });
});
