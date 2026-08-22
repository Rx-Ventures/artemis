/**
 * @vitest-environment jsdom
 *
 * The slash commands a column knows before it has run anything.
 *
 * The menu's list used to come only from `RunState.slashCommands`, which arrives
 * with `session.started` — so a column between conversations had nothing to
 * offer and the menu stayed shut until the first message. That is precisely
 * where a slash command is most often typed, which made the one reliably-shut
 * moment the one that mattered.
 *
 * `refreshCommands` fills that gap by asking the provider what a run here would
 * offer. What these pin down is the part that is easy to get subtly wrong: that
 * a failure keeps whatever the column already had rather than emptying the menu,
 * and that two columns on two accounts cannot answer each other's question.
 *
 * Same caveat as `models.test.ts`: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { allPanes, closePane, focusedPane, paneCount, refreshCommands, splitPane } from './store';
import { paneState, setPaneState } from './pane';

/**
 * What the next `providers:commands` call answers, keyed by profile.
 *
 * A mutable box for the reason `models.test.ts` gives: `resolveBridge` memoises
 * its binding on first use, so a second `window.artemis` installed later would
 * never be seen. Keyed by profile because one assertion below is precisely that
 * two columns get their own answer.
 */
let answers: Record<string, readonly string[] | 'fail'> = {};

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  providers: {
    commands: async ({ profileId }: { profileId: string }) => {
      const answer = answers[profileId] ?? [];
      return answer === 'fail'
        ? { ok: false, error: { code: 'unknown', message: 'no CLI here' } }
        : { ok: true, value: { commands: answer } };
    },
  },
};

beforeEach(() => {
  for (let guard = 0; guard < 20 && paneCount() > 1; guard += 1) {
    const last = allPanes()[paneCount() - 1];
    if (last) closePane(last.id);
  }
  answers = {};
  setPaneState(focusedPane(), {
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/repo',
    commands: null,
    run: null,
  });
});

describe('refreshCommands', () => {
  it('gives a column that has never run something to offer', async () => {
    answers['p1'] = ['compact', 'artemis-skills:cerebro'];

    await refreshCommands(focusedPane());

    expect(paneState(focusedPane()).commands).toEqual(['compact', 'artemis-skills:cerebro']);
  });

  it('records an empty answer, so a provider with no commands is a settled question', async () => {
    // `null` means "not asked" and drives the composer's fallback fetch; a
    // provider that genuinely has none has to be able to say so, or every `/`
    // typed in a Codex column would ask again.
    answers['p1'] = [];

    await refreshCommands(focusedPane());

    expect(paneState(focusedPane()).commands).toEqual([]);
  });

  it('keeps the list it has when the provider cannot be reached', async () => {
    answers['p1'] = ['compact'];
    await refreshCommands(focusedPane());

    answers['p1'] = 'fail';
    await refreshCommands(focusedPane());

    // Emptying here would take the menu away from under someone mid-session on a
    // transient failure — the same rule `refreshModels` keeps for the picker.
    expect(paneState(focusedPane()).commands).toEqual(['compact']);
  });

  it('does not ask at all without a profile, having nobody to ask as', async () => {
    setPaneState(focusedPane(), { activeProfileId: null });
    answers['p1'] = ['compact'];

    await refreshCommands(focusedPane());

    expect(paneState(focusedPane()).commands).toBeNull();
  });

  it('answers each column from its own account', async () => {
    const first = focusedPane();
    const second = splitPane();
    setPaneState(second, {
      activeProviderId: 'claude',
      activeProfileId: 'p2',
      cwd: '/repo',
      commands: null,
      run: null,
    });
    answers['p1'] = ['compact'];
    answers['p2'] = ['compact', 'mattpocock-skills:tdd'];

    await Promise.all([refreshCommands(first), refreshCommands(second)]);

    expect(paneState(first).commands).toEqual(['compact']);
    expect(paneState(second).commands).toEqual(['compact', 'mattpocock-skills:tdd']);
  });
});
