/**
 * @vitest-environment jsdom
 *
 * The prompt library (the rule half of the Instructions pane): what a person
 * sees, and what they are prevented from claiming.
 *
 * Composition is settled in `protocol/agentPrompts.test.ts` and storage in
 * `main/agentPrompts.test.ts`. What is left here is the pane's own judgements,
 * and three of them are worth a test because getting any one wrong produces a
 * prompt the user believes is being sent and is not:
 *
 *  1. **A profile whose provider cannot take an appended system prompt is
 *     shown, disabled, with the reason.** The failure this prevents is the
 *     quiet one — a Codex profile ticked in a settings pane while the model is
 *     never told a word of it. Hiding the row would be the same lie with better
 *     manners.
 *  2. **A built-in cannot be edited or deleted.** Its text ships with Artemis;
 *     an editable copy would drift from the one actually sent, and a deleted
 *     one would come back on the next read and read as the app overruling the
 *     user.
 *  3. **"Every profile" is not the same as ticking every box.** Unticking it
 *     has to produce a concrete list, and that list has to exclude the profiles
 *     that could not have received it anyway.
 *
 * The bridge is stubbed rather than left to the dev mock, for the reason the
 * shared-config suite gives: the mock reports a populated library, which is
 * right for developing the pane and wrong for a test that needs to control what
 * is on screen.
 *
 * Same caveat as the sibling component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BUILT_IN_AGENT_PROMPTS, NO_CAPABILITIES } from '@rx-artemis/protocol';
import { TooltipProvider } from '@/components/ui/tooltip';
import { InstructionsSection } from '@/components/settings/InstructionsSection';
import { seedApp } from '@/state/testkit';

/* -------------------------------------------------------------------------- */
/* The world the pane is rendered into                                        */
/* -------------------------------------------------------------------------- */

const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    capabilities: { ...NO_CAPABILITIES, systemPromptAppend: true },
  },
  {
    // The provider that cannot take one. This is the whole reason the pane has
    // a disabled state at all.
    id: 'codex',
    label: 'Codex',
    capabilities: { ...NO_CAPABILITIES, systemPromptAppend: false },
  },
];

const PROFILES = [
  { id: 'work', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
  { id: 'side', label: 'Side', providerId: 'codex', configDir: '/home/u/.side' },
];

const HOUSE_STYLE = {
  id: 'p1',
  name: 'House style',
  markdown: 'Run the typechecker.',
  enabled: true,
  scope: { kind: 'all' as const },
};

const CEREBRO_ROW = {
  id: 'builtin:cerebro',
  name: BUILT_IN_AGENT_PROMPTS['builtin:cerebro'].name,
  markdown: '',
  enabled: true,
  scope: { kind: 'all' as const },
  builtIn: 'builtin:cerebro' as const,
};

/** The library the next `list` answers with. Reassigned per test before rendering. */
let library: unknown[] = [];
/** Whether the stubbed banks report an enabled bank behind an open master gate. */
let cerebroInstalled = true;
/** Every document the pane has saved, oldest first. */
let saved: { prompts: unknown[] }[] = [];

/*
 * Installed once, before the first render: `resolveBridge` memoises its binding
 * on first use, so a stub swapped in later would never be seen. Behaviour is
 * varied through the variables above instead.
 *
 * The banks channel answers with the smallest status that decides the one
 * thing this file cares about — whether the built-in memory-banks prompt is
 * actually being sent. The pane derives that from the same reading its banks
 * half renders from (`banksAvailability`), so the stub is the shared source of
 * both.
 */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  agentPrompts: {
    list: async () => ({ ok: true as const, value: { document: { version: 1, prompts: library } } }),
    save: async (request: { document: { prompts: unknown[] } }) => {
      saved.push(request.document);
      return { ok: true as const, value: { document: request.document } };
    },
  },
  memoryBanks: {
    status: async () => ({
      ok: true as const,
      value: {
        masterEnabled: cerebroInstalled,
        banks: cerebroInstalled
          ? [
              {
                slug: 'team',
                path: '/x/team',
                remote: null,
                role: 'readwrite',
                enabled: true,
                exists: true,
                isDefault: true,
                memories: 0,
                validationErrors: 0,
                projects: 0,
              },
            ]
          : [],
      },
    }),
    preflight: async () => ({ ok: true as const, value: { ready: true, checks: [] } }),
  },
};

function renderPane(): void {
  render(
    <TooltipProvider>
      <InstructionsSection />
    </TooltipProvider>,
  );
}

/** Render, and wait for the library to have landed. */
async function renderLoaded(): Promise<void> {
  renderPane();
  await waitFor(() => expect(screen.queryByText('Reading the library…')).toBeNull());
}

/**
 * Let the save debounce elapse, without spending it.
 *
 * `useAgentPrompts` saves on a 600ms debounce, and this file used to wait it
 * out five times on the wall clock — three seconds in isolation, and far worse
 * inside the full suite, where the run competes for CPU and a real timer that
 * asks for 600ms gets whatever it gets. That is what made this file the
 * slowest in the suite and the one that looked flaky: it was not racing, it was
 * queueing.
 *
 * Fake timers make it exact instead. `advanceTimersByTimeAsync` also flushes
 * the microtasks the save promise resolves through, which `advanceTimersByTime`
 * would not.
 */
async function flushSave(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
  });
}

/** Must match `useAgentPrompts`. A test that waits less than the real debounce
 *  would pass by accident today and fail the day the value changes. */
const SAVE_DEBOUNCE_MS = 600;

/** The most recent saved document, or null. */
function lastSave(): { prompts: any[] } | null {
  return (saved.at(-1) as { prompts: any[] } | undefined) ?? null;
}

/**
 * Open one prompt in the editor.
 *
 * Anchored with `^` because the *selected* prompt also contributes a
 * `Delete “<name>”` button, and an unanchored name would match both. The row's
 * own accessible name is its title followed by the line describing its scope.
 */
function open(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
}

/** Turn "every profile" off, revealing the per-profile list. */
function narrow(): void {
  fireEvent.click(screen.getByText('Every profile'));
}

beforeEach(() => {
  // `shouldAdvanceTime` keeps the library's initial read — a real promise, not
  // a timer — from hanging while the clock is frozen. Without it `renderLoaded`
  // waits forever for "Reading the library…" to disappear.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seedApp({ providers: PROVIDERS as never, profiles: PROFILES as never });
  library = [HOUSE_STYLE, CEREBRO_ROW];
  cerebroInstalled = true;
  saved = [];
  // TipTap drives a contenteditable through ProseMirror, which reaches for
  // layout APIs jsdom does not implement. Stubbed rather than skipped: the
  // assertions below are about the pane's controls, and an editor that throws
  // on mount would take the whole pane down before any of them could run.
  Object.defineProperty(globalThis.Range.prototype, 'getBoundingClientRect', {
    value: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }),
    configurable: true,
  });
  Object.defineProperty(globalThis.Range.prototype, 'getClientRects', {
    value: () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }),
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

describe('who a prompt reaches', () => {
  it('shows a profile whose provider cannot take an appended prompt, disabled', async () => {
    await renderLoaded();
    open('House style');
    narrow();

    const boxes = screen.getAllByRole('checkbox');
    const labels = boxes.map((box) => box.closest('label')?.textContent ?? '');

    const side = boxes[labels.findIndex((text) => text.includes('Side'))];
    const work = boxes[labels.findIndex((text) => text.includes('Work'))];

    expect(side).toBeTruthy();
    // Present, so the account does not silently vanish from a list the user is
    // using to decide where a prompt goes — and unusable, because it is.
    expect(side!.getAttribute('disabled')).not.toBeNull();
    expect(work!.getAttribute('disabled')).toBeNull();
  });

  it('narrows to the profiles that can actually receive it, not to none', async () => {
    await renderLoaded();
    open('House style');
    narrow();

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const scope = lastSave()!.prompts[0].scope;
    // Not `[]` — that would turn the prompt off as a side effect of the user
    // asking to narrow it. Not `['work','side']` either: `side` could never
    // have received it.
    expect(scope).toEqual({ kind: 'profiles', profileIds: ['work'] });
  });

  it('says plainly when a prompt is scoped to nothing', async () => {
    library = [{ ...HOUSE_STYLE, scope: { kind: 'profiles', profileIds: [] } }, CEREBRO_ROW];
    await renderLoaded();
    expect(screen.getByText(/no profiles — it will not be sent/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Built-ins                                                                  */
/* -------------------------------------------------------------------------- */

describe("Artemis's own prompts", () => {
  it('shows the text it will actually send, and does not let it be edited', async () => {
    await renderLoaded();
    open('Use memory banks');

    const surface = document.querySelector('.ProseMirror');
    expect(surface).toBeTruthy();
    // Read-only rather than absent: "what exactly will be sent" is the reason
    // someone opens a built-in, and paraphrasing it would be Artemis describing
    // its own prompt instead of showing it.
    expect(surface!.getAttribute('contenteditable')).toBe('false');
    expect(surface!.textContent).toContain('memory bank');
  });

  it('offers no delete, because a deleted built-in comes straight back', async () => {
    await renderLoaded();
    open('Use memory banks');
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();

    // A user prompt does offer one.
    open('House style');
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeNull();
  });

  it('can still be turned off, which is the durable way to refuse it', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: /Use memory banks/ }));

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const row = lastSave()!.prompts.find((p: any) => p.builtIn === 'builtin:cerebro');
    expect(row.enabled).toBe(false);
  });

  it('reports an enabled built-in that its precondition has switched off', async () => {
    // The state a plain on/off flag cannot express: the switch says yes, the
    // machine says the tool is not there, and nothing is being sent.
    cerebroInstalled = false;
    await renderLoaded();
    await waitFor(() =>
      expect(screen.getByText(/On, but not sent/)).toBeTruthy(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Editing                                                                    */
/* -------------------------------------------------------------------------- */

describe('the library', () => {
  it('adds a prompt that reaches every profile until it is narrowed', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /New prompt/ }));

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const added = lastSave()!.prompts.at(-1);
    expect(added.scope).toEqual({ kind: 'all' });
    expect(added.enabled).toBe(true);
  });

  it('keeps a turned-off prompt rather than dropping it', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: /House style/ }));

    await flushSave();
    expect(lastSave()).not.toBeNull();
    const row = lastSave()!.prompts.find((p: any) => p.id === 'p1');
    // Off, and its text intact — "try without it" must not be an expensive
    // experiment.
    expect(row.enabled).toBe(false);
    expect(row.markdown).toBe('Run the typechecker.');
  });

  it('does not offer an editable library when the read failed', async () => {
    // Showing the defaults over a failed read would invite an edit whose first
    // save replaces whatever is really on disk.
    const artemis = (globalThis.window as unknown as { artemis: any }).artemis;
    const original = artemis.agentPrompts.list;
    artemis.agentPrompts.list = async () => ({
      ok: false as const,
      error: { code: 'unknown', message: 'could not read the library' },
    });

    await renderLoaded();
    expect(screen.getByText('could not read the library')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New prompt/ })).toBeNull();

    artemis.agentPrompts.list = original;
  });
});
