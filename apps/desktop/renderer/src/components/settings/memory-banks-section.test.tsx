/**
 * @vitest-environment jsdom
 *
 * The Memory Banks pane, and the property this phase was about: **joining a
 * team bank from your own git URL is possible.**
 *
 * Three things used to make it impossible, and all three are behavioural
 * rather than visual, so they are what is pinned here:
 *
 *  - **The submit button was gated on the whole machine.** `doctor` answers
 *    for a destination directory, a `PATH` shim and — before any bank exists —
 *    reachability of *this project's own* upstream, which is a private repo an
 *    outside user can only fail. Any one of those turned off the button that
 *    joins a bank none of them are about. Now the gate is per mode, and a
 *    failing check outside the mode's list still renders while blocking
 *    nothing.
 *  - **A failed preflight read rendered as "Checking…", forever.** The hook
 *    coerced the error to `null`, which is also what "still loading" looks
 *    like. On Windows — where the read fails with "Python 3 is required" —
 *    that sentence was the whole of what the user was told.
 *  - **There was nowhere to put a token, and no way to try a URL** short of
 *    committing to a clone that takes minutes to fail.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  IpcResult,
  MemoryBankCheck,
  MemoryBankPreflight,
  MemoryBankVerifyRemoteRequest,
  MemoryBankVerifyRemoteResponse,
  MemoryBanksStatus,
} from '@rx-artemis/protocol';

import { MemoryBankGroups } from '@/components/settings/MemoryBanksSection';
import { useMemoryBanks } from '@/hooks/useMemoryBanks';
import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ok = <T,>(value: T) => ({ ok: true as const, value });

/** A machine with nothing set up yet — the state onboarding actually happens in. */
const NO_BANKS: MemoryBanksStatus = {
  cliAvailable: true,
  masterEnabled: false,
  banks: [],
  profiles: [],
};

const check = (id: string, state: MemoryBankCheck['state']): MemoryBankCheck => ({
  id,
  label: id,
  state,
  detail: `${id} detail`,
  remedy: null,
});

/** Every check green — the baseline the gating tests vary one row from. */
const HEALTHY: MemoryBankPreflight = {
  ready: true,
  checks: [check('python', 'ok'), check('git', 'ok'), check('git-identity', 'ok'), check('repo', 'ok')],
};

let preflight: IpcResult<MemoryBankPreflight> = ok(HEALTHY);
let verifyAnswer: MemoryBankVerifyRemoteResponse = {
  outcome: 'ok',
  headPresent: true,
  detail: 'HEAD is 52a0a327',
};
const verifyCalls: MemoryBankVerifyRemoteRequest[] = [];
const addCalls: unknown[] = [];

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  memoryBanks: {
    status: async () => ok(NO_BANKS),
    preflight: async () => preflight,
    memories: async () => ok({ memories: [] }),
    verifyRemote: async (request: MemoryBankVerifyRemoteRequest) => {
      verifyCalls.push(request);
      return ok(verifyAnswer);
    },
    add: async (request: unknown) => {
      addCalls.push(request);
      return ok({ message: 'Joined.' });
    },
    sync: async () => ok({ message: '' }),
    retire: async () => ok({ message: '' }),
    setEnabled: async () => ok({ message: '' }),
    forget: async () => ok({ message: '' }),
    setMasterEnabled: async () => ok({ message: '' }),
  },
};

/*
 * The banks half of the Instructions pane, wired the way `InstructionsSection`
 * wires it: one `useMemoryBanks` in the parent, threaded down as a prop. The
 * groups are rendered without the prompts half so that a failure here is about
 * the banks and not about the agent-prompts channel this file does not stub.
 */
function BanksHalf(): ReactElement {
  return <MemoryBankGroups pane={useMemoryBanks()} />;
}

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <BanksHalf />
    </TooltipProvider>,
  );
  await act(async () => {});
}

/** Fill in the two fields a join needs, so only the gating is under test. */
function fillJoin(remote = 'https://git.example.com/team/bank.git'): void {
  fireEvent.change(screen.getByLabelText('Bank slug'), { target: { value: 'team' } });
  fireEvent.change(screen.getByLabelText('Bank remote URL'), { target: { value: remote } });
}

const joinButton = (): HTMLElement => screen.getByRole('button', { name: 'Join bank' });

beforeEach(() => {
  preflight = ok(HEALTHY);
  verifyAnswer = { outcome: 'ok', headPresent: true, detail: 'HEAD is 52a0a327' };
});

afterEach(() => {
  cleanup();
  verifyCalls.length = 0;
  addCalls.length = 0;
});

describe('joining a private bank', () => {
  it('offers a token field and a way to check the URL before committing to it', async () => {
    await renderPane();
    expect(screen.getByLabelText(/Access token/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeTruthy();
  });

  it('masks the token, and keeps it out of autofill', async () => {
    await renderPane();
    const field = screen.getByLabelText(/Access token/) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
  });

  it('keeps the username behind a toggle, with the hosts that need one named', async () => {
    // Almost nobody has to touch it — GitHub, Forgejo and Gitea ignore the
    // field entirely — so it is collapsed rather than a fourth input to read
    // past. The hosts that do need it are named where it opens.
    await renderPane();
    expect(screen.queryByLabelText('Username')).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: /Username/ }).click();
    });
    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.getByText(/GitLab deploy token/)).toBeTruthy();
  });

  it('offers none of that for a local bank, which has no remote to authenticate to', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Create local' }).click();
    });
    expect(screen.queryByLabelText(/Access token/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('sends the token with the join, and only with the join', async () => {
    await renderPane();
    fillJoin();
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'glpat-secret' } });

    await act(async () => {
      joinButton().click();
    });

    expect(addCalls).toEqual([
      {
        mode: 'join',
        slug: 'team',
        role: 'readwrite',
        remote: 'https://git.example.com/team/bank.git',
        auth: { token: 'glpat-secret' },
      },
    ]);
  });

  it('clears the token once the bank is joined', async () => {
    // Main has stored it encrypted by now. A copy left in a mounted form is a
    // copy nothing needs.
    await renderPane();
    fillJoin();
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'glpat-secret' } });
    await act(async () => {
      joinButton().click();
    });
    expect((screen.getByLabelText(/Access token/) as HTMLInputElement).value).toBe('');
  });
});

describe('verifying a remote', () => {
  it('is disabled until the URL parses, and asks about that URL', async () => {
    await renderPane();
    expect(screen.getByRole('button', { name: 'Verify' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Bank remote URL'), {
      target: { value: 'https://git.example.com/team/bank.git' },
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });

    // Enabled on a URL alone — no slug, no preflight, no other field.
    expect(verifyCalls).toEqual([{ remote: 'https://git.example.com/team/bank.git' }]);
  });

  it('reports a reachable remote', async () => {
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/can read it/)).toBeTruthy();
    expect(screen.getByText('HEAD is 52a0a327')).toBeTruthy();
  });

  it('reports an empty repository as reachable, because it is a bank to join', async () => {
    verifyAnswer = { outcome: 'ok', headPresent: false, detail: 'readable, and empty' };
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/Reachable, and empty/)).toBeTruthy();
  });

  it('suggests a token when the remote asks for credentials', async () => {
    // Amber, and worded as one more thing to supply: nothing is wrong here.
    verifyAnswer = {
      outcome: 'auth-required',
      headPresent: false,
      detail: "fatal: could not read Username for 'https://git.example.com'",
    };
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/add an access token/)).toBeTruthy();
    expect(screen.getByText(/could not read Username/)).toBeTruthy();
  });

  it('separates a repository that is not there from a host that will not answer', async () => {
    verifyAnswer = { outcome: 'not-found', headPresent: false, detail: 'remote: Repository not found.' };
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/No repository there/)).toBeTruthy();
    expect(screen.getByText('remote: Repository not found.')).toBeTruthy();

    verifyAnswer = { outcome: 'unreachable', headPresent: false, detail: 'Could not resolve host' };
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/Could not reach the remote/)).toBeTruthy();
  });

  it('drops the result when the URL it was about changes', async () => {
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/can read it/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Bank remote URL'), {
      target: { value: 'https://git.example.com/team/other.git' },
    });
    expect(screen.queryByText(/can read it/)).toBeNull();
  });
});

describe('what actually blocks the button', () => {
  it('joins with a failing check that has nothing to do with joining', async () => {
    // `remote` is the doctor's probe of the CLI's *default* upstream, which an
    // outside user can only ever fail; `repo` is about a destination directory
    // a join does not use. Neither is a reason to refuse the button.
    preflight = ok({
      ready: false,
      checks: [check('git', 'ok'), check('python', 'ok'), check('remote', 'fail'), check('repo', 'fail')],
    });
    await renderPane();
    fillJoin();

    expect(joinButton().hasAttribute('disabled')).toBe(false);
    // The rows are still on screen — they are the machine's honest condition —
    // marked as not standing in the way.
    expect(screen.getAllByText('not needed to join').length).toBe(2);
  });

  it('refuses to join without git, which a join genuinely cannot do without', async () => {
    preflight = ok({ ready: false, checks: [check('git', 'fail'), check('python', 'ok')] });
    await renderPane();
    fillJoin();

    expect(joinButton().hasAttribute('disabled')).toBe(true);
    // The row that did it is marked, and the hint below the button says which
    // mark to look for — a disabled button with no explanation is the thing
    // this pane spent its first version being.
    expect(screen.getAllByText('required').length).toBeGreaterThan(0);
    expect(screen.getByText(/Fix the requirements marked/)).toBeTruthy();
  });

  it('still refuses to create a bank with no git identity, because creating commits', async () => {
    // The same failed check gates the two modes differently, which is the
    // whole point of a per-mode list: joining is a clone, creating is a commit.
    preflight = ok({ ready: false, checks: [check('git', 'ok'), check('git-identity', 'fail')] });
    await renderPane();
    fillJoin();
    expect(joinButton().hasAttribute('disabled')).toBe(false);

    await act(async () => {
      screen.getByRole('button', { name: 'Create local' }).click();
    });
    expect(screen.getByRole('button', { name: 'Create bank' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('a preflight that could not be read', () => {
  it('says what went wrong instead of claiming it is still checking', async () => {
    // The Windows case. `Checking what this machine needs…` was the only thing
    // this pane ever said on a machine with no Python — a sentence that is
    // never true once the read has finished.
    preflight = {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Python 3 is required for the team memory bank CLI, and this machine has none.',
        retryable: false,
      },
    };
    await renderPane();

    expect(screen.queryByText(/Checking what this machine needs/)).toBeNull();
    expect(screen.getByText(/Python 3 is required/)).toBeTruthy();
  });

  it('does not block the join on a preflight it never got', async () => {
    // An unreadable preflight is not evidence of a broken machine, and the
    // add's own error is a better teacher than a disabled button.
    preflight = {
      ok: false,
      error: { code: 'internal', message: 'the CLI did not respond', retryable: true },
    };
    await renderPane();
    fillJoin();
    expect(joinButton().hasAttribute('disabled')).toBe(false);
  });
});
