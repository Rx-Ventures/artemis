/**
 * @vitest-environment jsdom
 *
 * The Advanced pane: the gate in front of the script, and the reading that sits
 * beside it.
 *
 * The generator itself is tested against a real filesystem in
 * `lib/sharedClaudeConfig.test.ts` — whether the shell is correct is settled
 * there, along with the pure judgements the pane makes about a reading. The
 * probe that takes the reading is tested against a real filesystem too, in
 * `main/sharedConfig.test.ts`. What is left for this file is what a person sees.
 *
 * Two properties, and they pull in opposite directions.
 *
 * **The gate.** The script is not on screen until the user has answered the
 * warning. That is the whole point of the feature's design: a wall of `ln -s`
 * reads as boilerplate, and the consequence that surprises people (one shared
 * `projects/`, so history stops being per-account) is not visible anywhere in
 * it. If the script can be reached without the dialog, the dialog is decoration.
 *
 * **The reading.** Which is allowed to reach past the gate in exactly one
 * direction: a disk with links on it makes the *undo* relevant to a user who
 * never accepted anything, because the thing being undone demonstrably happened.
 * The share script stays behind the dialog no matter what the disk says.
 *
 * The bridge is stubbed rather than left to the dev mock. The mock reports a
 * half-shared machine, which is the right thing for developing the pane and
 * exactly the wrong thing for a test of what a *clean* machine shows — and
 * because the reading is asynchronous, a test that did not control it would pass
 * or fail on whether the promise happened to resolve first.
 *
 * Same caveat as the sibling component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SHARED_ENTRIES } from '@rx-artemis/protocol';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AdvancedSection } from '@/components/settings/AdvancedSection';
import { seedApp } from '@/state/testkit';
import { setSharedClaudeConfig, useApp } from '@/state/store';

const CLAUDE_PROFILES = [
  { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.personal' },
  { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
];

/* -------------------------------------------------------------------------- */
/* The stubbed reading                                                        */
/* -------------------------------------------------------------------------- */

type Entry = { name: string; state: string; backup?: boolean; target?: string };
type Dir = { dir: string; state: string; entries: Entry[] };

/** Every entry linked, except the names overridden. */
const checked = (dir: string, over: Record<string, Entry> = {}): Dir => ({
  dir,
  state: 'checked',
  entries: SHARED_ENTRIES.map((name) => over[name] ?? { name, state: 'linked' }),
});

/** Nothing there at all — a profile the script has never covered. */
const untouched = (dir: string): Dir => ({
  dir,
  state: 'checked',
  entries: SHARED_ENTRIES.map((name) => ({ name, state: 'missing' })),
});

/** What the next read answers with. Reassigned per test, before rendering. */
let reading: { root: string; rootMissing: string[]; dirs: Dir[] } = {
  root: '/home/u/.claude',
  rootMissing: [],
  dirs: [],
};
/** Set to make the read fail instead. Cleared before each test. */
let failure: string | null = null;
let reads = 0;

/**
 * Installed before the first render: `resolveBridge` memoises its binding on
 * first use, so a later assignment would never be seen. Which is also why the
 * failure case is a variable this reads rather than a second stub swapped in —
 * a test that swapped one in and then failed before swapping it back would take
 * every test after it down with it.
 */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  sharedConfig: {
    status: async () => {
      reads += 1;
      return failure === null
        ? { ok: true as const, value: reading }
        : { ok: false as const, error: { code: 'unknown', message: failure } };
    },
  },
};

function renderPane(): void {
  render(
    <TooltipProvider>
      <AdvancedSection />
    </TooltipProvider>,
  );
}

/** Render, and wait for the reading to have landed on screen. */
async function renderRead(): Promise<void> {
  renderPane();
  await waitFor(() => expect(screen.getByText(/Compared against/)).toBeTruthy());
}

const toggle = (): HTMLElement =>
  screen.getByRole('switch', { name: 'Share one ~/.claude across profiles' });

/** The generated script, or null when no script is on screen. */
function script(): string | null {
  const block = document.querySelector('pre');
  return block?.textContent ?? null;
}

beforeEach(() => {
  // Both flags down: a user who has never met this feature.
  useApp.setState({ sharedClaudeConfig: false, sharedClaudeConfigAcknowledged: false });
  seedApp({ profiles: CLAUDE_PROFILES as never });
  // And a disk that has never been touched, so the default fixture cannot
  // accidentally supply the state a test is meant to set up for itself.
  reading = {
    root: '/home/u/.claude',
    rootMissing: [],
    dirs: CLAUDE_PROFILES.map((profile) => untouched(profile.configDir)),
  };
  failure = null;
  reads = 0;
});

afterEach(() => {
  cleanup();
  useApp.setState({ sharedClaudeConfig: false, sharedClaudeConfigAcknowledged: false });
});

describe('the warning gate', () => {
  it('shows no script before the switch is touched', async () => {
    renderPane();
    // Waited for on purpose: the reading is what could newly put a script on
    // screen, and a synchronous assertion would pass by finishing first.
    await waitFor(() => expect(reads).toBe(1));

    expect(script()).toBeNull();
    // And nothing about the disk either. Nine `missing` entries per profile is
    // the ordinary state of a machine that never wanted this.
    expect(screen.queryByText(/Compared against/)).toBeNull();
  });

  it('does not enable or reveal anything when the warning is cancelled', () => {
    renderPane();
    fireEvent.click(toggle());

    // The dialog is up and naming the consequence, not just saying "advanced".
    // A shared store is listed once per conversation rather than once per
    // profile, so the first consequence is the merged history itself.
    expect(screen.getByText(/Every account’s history arrives in one list/)).toBeTruthy();
    // The count is still stated where it is still true: a plugin expecting to
    // be alone sees every profile sharing the directory, and a user with two
    // accounts is told "2 profiles" rather than "several".
    expect(screen.getByText(/all 2 profiles/)).toBeTruthy();
    expect(screen.getByText(/Plugins and skills are shared wholesale/)).toBeTruthy();
    expect(script()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(useApp.getState().sharedClaudeConfig).toBe(false);
    expect(useApp.getState().sharedClaudeConfigAcknowledged).toBe(false);
    expect(script()).toBeNull();
  });

  it('reveals the sharing script once the warning is accepted', () => {
    renderPane();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Show me the script' }));

    expect(useApp.getState().sharedClaudeConfig).toBe(true);

    const text = script() ?? '';
    // Both profile directories, quoted, and the entries the user asked for.
    expect(text).toContain("profile '/home/u/.personal'");
    expect(text).toContain("profile '/home/u/.work'");
    // Literal words in the `for` list, not a variable the loop expands: zsh does
    // not split on IFS, and this script reaches the user through a Copy button.
    expect(text).toContain(
      "for name in 'commands' 'ide' 'plans' 'plugins' 'skills' 'todos' 'session-env' 'projects'",
    );
    expect(text).toContain("for name in 'CLAUDE.md'");
  });
});

describe('backing out', () => {
  it('offers the undo script after the switch goes down', () => {
    renderPane();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Show me the script' }));
    fireEvent.click(toggle());

    expect(useApp.getState().sharedClaudeConfig).toBe(false);
    // The acknowledgement latches — it is what makes the undo reachable at all.
    expect(useApp.getState().sharedClaudeConfigAcknowledged).toBe(true);
    expect(script() ?? '').toContain('Stop sharing the Claude config');
  });

  it('turning it off does not ask for confirmation', () => {
    setSharedClaudeConfig(true);
    renderPane();
    fireEvent.click(toggle());

    // Nothing is at stake in asking for the undo, so no dialog stands in front
    // of the exit.
    expect(screen.queryByRole('button', { name: 'Show me the script' })).toBeNull();
    expect(useApp.getState().sharedClaudeConfig).toBe(false);
  });
});

describe('what the pane covers', () => {
  it('leaves out profiles belonging to another provider', () => {
    seedApp({
      profiles: [
        ...CLAUDE_PROFILES,
        { id: 'p3', label: 'Codex', providerId: 'codex', configDir: '/home/u/.codex' },
      ] as never,
    });
    setSharedClaudeConfig(true);
    renderPane();

    // The entry names are Claude's vocabulary and mean nothing elsewhere.
    expect(script() ?? '').not.toContain('/home/u/.codex');
  });

  it('says so rather than emitting an empty script when there are no Claude profiles', () => {
    seedApp({ profiles: [] as never });
    setSharedClaudeConfig(true);
    renderPane();

    expect(screen.getByText('No Claude profiles to name')).toBeTruthy();
    expect(script()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* What is on disk                                                            */
/* -------------------------------------------------------------------------- */

describe('the reading', () => {
  it('says something about every profile, and what it is compared against', async () => {
    reading.dirs = [checked('/home/u/.personal'), untouched('/home/u/.work')];
    setSharedClaudeConfig(true);
    await renderRead();

    expect(screen.getByText(`all ${SHARED_ENTRIES.length} linked`)).toBeTruthy();
    expect(screen.getByText('nothing linked')).toBeTruthy();
    // The root is named once, because every state above is a state relative to
    // it and the renderer cannot work it out for itself.
    expect(screen.getByText('/home/u/.claude')).toBeTruthy();
  });

  it('names the entries a half-linked profile is missing, and what they are instead', async () => {
    reading.dirs = [
      checked('/home/u/.personal', {
        skills: { name: 'skills', state: 'own', backup: true },
        plans: { name: 'plans', state: 'missing' },
        ide: { name: 'ide', state: 'foreign', target: '/home/u/dotfiles/ide' },
      }),
      checked('/home/u/.work'),
    ];
    setSharedClaudeConfig(true);
    await renderRead();

    expect(screen.getByText(`${SHARED_ENTRIES.length - 3} linked, 3 not`)).toBeTruthy();
    // Grouped by what they actually are, in the scripts' own vocabulary: a
    // folder of its own will be moved aside, an absence costs nothing to link,
    // and a foreign link is somebody else's arrangement the undo refuses to
    // touch. "3 not" alone would have flattened three situations into a number.
    expect(screen.getByText('own')).toBeTruthy();
    expect(screen.getByText('skills')).toBeTruthy();
    expect(screen.getByText('missing')).toBeTruthy();
    expect(screen.getByText('plans')).toBeTruthy();
    expect(screen.getByText('foreign')).toBeTruthy();
    expect(screen.getByText('ide')).toBeTruthy();
    // The displaced folder is named too. Nothing in the app has ever mentioned
    // these exist, and for `projects` one holds months of transcripts.
    expect(screen.getByText('skills.pre-shared')).toBeTruthy();
  });

  it('reads the profile that is ~/.claude itself as the root', async () => {
    seedApp({
      profiles: [
        { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.claude' },
        ...CLAUDE_PROFILES.slice(1),
      ] as never,
    });
    reading.dirs = [
      { dir: '/home/u/.claude', state: 'root', entries: [] },
      checked('/home/u/.work'),
    ];
    setSharedClaudeConfig(true);
    await renderRead();

    // Not "nothing linked": it is the thing everything else points at, and both
    // scripts skip it. Otherwise the user's own config directory reads as
    // permanently broken.
    expect(screen.getByText('is the root')).toBeTruthy();
    // And it is not counted as a disagreement.
    expect(screen.queryByText(/does not match it/)).toBeNull();
  });

  it('reads a directory that is not there as missing rather than unshared', async () => {
    reading.dirs = [
      checked('/home/u/.personal'),
      { dir: '/home/u/.work', state: 'absent', entries: [] },
    ];
    setSharedClaudeConfig(true);
    await renderRead();

    expect(screen.getByText('no such directory')).toBeTruthy();
  });

  it('says so when the read fails, rather than showing states it does not have', async () => {
    failure = 'no luck';
    setSharedClaudeConfig(true);
    renderPane();

    await waitFor(() => expect(screen.getByText('no luck')).toBeTruthy());
    expect(screen.queryByText(/Compared against/)).toBeNull();
    // The paths are still listed — the pane still knows which profiles a script
    // would cover, and only the state column is unknown. A row that vanished
    // until the read landed would be a profile the user could not see was
    // covered.
    expect(screen.getAllByTitle('/home/u/.personal').length).toBeGreaterThan(0);
    expect(screen.queryByText('nothing linked')).toBeNull();
  });

  it('reads again when asked to', async () => {
    reading.dirs = [checked('/home/u/.personal'), checked('/home/u/.work')];
    setSharedClaudeConfig(true);
    await renderRead();
    expect(reads).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Re-read the links on disk' }));

    // The one moment a re-read is genuinely needed: the user has just run the
    // script in the other window. Nothing polls for it.
    await waitFor(() => expect(reads).toBe(2));
  });
});

describe('when the switch and the disk disagree', () => {
  it('says so when the switch is on and a profile was left behind', async () => {
    reading.dirs = [checked('/home/u/.personal'), untouched('/home/u/.work')];
    setSharedClaudeConfig(true);
    await renderRead();

    // The failure the display exists for: the script covered the profiles that
    // existed when it was generated.
    expect(screen.getByText(/The switch is on, but the disk does not match it/)).toBeTruthy();
  });

  it('says nothing when the switch is on and everything is linked', async () => {
    reading.dirs = [checked('/home/u/.personal'), checked('/home/u/.work')];
    setSharedClaudeConfig(true);
    await renderRead();

    expect(screen.queryByText(/does not match it/)).toBeNull();
  });

  it('offers the undo when the disk still has links and the switch never did', async () => {
    // Prefs reset, or a fresh install on a machine that was shared months ago.
    // The acknowledgement cannot cover this, and the pane would otherwise claim
    // an isolation the accounts do not have.
    reading.dirs = [checked('/home/u/.personal'), checked('/home/u/.work')];
    await renderRead();

    expect(useApp.getState().sharedClaudeConfigAcknowledged).toBe(false);
    expect(screen.getByText(/still point at your ~\/.claude/)).toBeTruthy();
    expect(script() ?? '').toContain('Stop sharing the Claude config');
    // The reading reaches past the gate in one direction only. Nothing here
    // offers the share script, and the switch has not moved.
    expect(script() ?? '').not.toContain('Shared Claude config — generated by Artemis');
    expect(useApp.getState().sharedClaudeConfig).toBe(false);
  });

  it('explains a CLAUDE.md the root does not have instead of calling it a gap', async () => {
    const noFile = { 'CLAUDE.md': { name: 'CLAUDE.md', state: 'missing' } };
    reading.rootMissing = ['CLAUDE.md'];
    reading.dirs = [
      checked('/home/u/.personal', noFile),
      checked('/home/u/.work', noFile),
    ];
    setSharedClaudeConfig(true);
    await renderRead();

    // A perfectly-run share leaves this unlinked, and that `skip` line scrolled
    // past in a terminal is otherwise the only record of why.
    expect(screen.getByText(/That is a skip, not a gap/)).toBeTruthy();
    expect(screen.queryByText(/does not match it/)).toBeNull();
    expect(screen.getAllByText(`all ${SHARED_ENTRIES.length - 1} linked`)).toHaveLength(2);
  });
});

describe('the narrow script', () => {
  it('covers only the profile that is not linked, and can be widened', async () => {
    reading.dirs = [checked('/home/u/.personal'), untouched('/home/u/.work')];
    setSharedClaudeConfig(true);
    await renderRead();

    // Defaults to the short one: it is the whole reason the reading is on
    // screen, and it changes nothing that is already the way the user wants it.
    await waitFor(() => expect(script() ?? '').toContain("profile '/home/u/.work'"));
    expect(script() ?? '').not.toContain("profile '/home/u/.personal'");
    // And it can count to one. "the one profile that are not linked" is what
    // composing this out of a plural helper produces.
    expect(screen.getByText('Only the profile that is not linked')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /All 2 profiles/ }));

    // And the full script is still one click away — it is safe over everything,
    // which is what its note says.
    expect(script() ?? '').toContain("profile '/home/u/.personal'");
    expect(script() ?? '').toContain("profile '/home/u/.work'");
  });

  it('offers no choice when every profile needs the same script', async () => {
    reading.dirs = [untouched('/home/u/.personal'), untouched('/home/u/.work')];
    setSharedClaudeConfig(true);
    await renderRead();

    // Two identical scripts under two labels is a decision with no content.
    expect(screen.queryByRole('radio', { name: /All 2 profiles/ })).toBeNull();
    expect(script() ?? '').toContain("profile '/home/u/.personal'");
  });

  it('narrows the undo to the profiles that still have links', async () => {
    reading.dirs = [checked('/home/u/.personal'), untouched('/home/u/.work')];
    setSharedClaudeConfig(true);
    setSharedClaudeConfig(false);
    await renderRead();

    await waitFor(() => expect(script() ?? '').toContain('Stop sharing the Claude config'));
    expect(script() ?? '').toContain("profile '/home/u/.personal'");
    // Nothing to undo in a profile that was never linked.
    expect(script() ?? '').not.toContain("profile '/home/u/.work'");
  });
});

describe('copying', () => {
  it('reports a refused clipboard instead of ticking', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    setSharedClaudeConfig(true);
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the sharing script' }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    // The button must not claim success the write never had.
    expect(screen.queryByText('Copied')).toBeNull();

    vi.unstubAllGlobals();
  });
});
