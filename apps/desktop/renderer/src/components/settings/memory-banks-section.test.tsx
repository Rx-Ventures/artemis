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
  SecretConnectionState,
  SecretProviderDescriptor,
  SecretRefTestResult,
  SecretsRefTestRequest,
} from '@rx-artemis/protocol';

import { MemoryBankGroups, slugFromRemote } from '@/components/settings/MemoryBanksSection';
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
let status: MemoryBanksStatus = NO_BANKS;
let verifyAnswer: MemoryBankVerifyRemoteResponse = {
  outcome: 'ok',
  headPresent: true,
  detail: 'HEAD is 52a0a327',
};
const verifyCalls: MemoryBankVerifyRemoteRequest[] = [];
const addCalls: unknown[] = [];

/* -------------------------------------------------------------------------- */
/* The key managers this machine has                                          */
/* -------------------------------------------------------------------------- */

/**
 * Two connections, one of each provider, because the reference form is built
 * from the provider's declared fields — and a fixture with one provider would
 * let that stop being true without any test noticing.
 */
const CONNECTIONS: readonly SecretConnectionState[] = [
  {
    connection: {
      id: 'sec-1',
      label: 'Work vault',
      provider: 'openbao',
      address: 'https://vault.example.com:8200',
      authMethod: 'userpass',
      username: 'demo',
    },
    hasCredential: true,
    lastVerify: null,
  },
  {
    connection: {
      id: 'sec-2',
      label: 'Team Doppler',
      provider: 'doppler',
      address: 'https://api.doppler.com',
      authMethod: 'token',
    },
    hasCredential: true,
    lastVerify: null,
  },
];

const SECRET_PROVIDERS: readonly SecretProviderDescriptor[] = [
  {
    id: 'openbao',
    label: 'OpenBao',
    note: 'Self-hosted.',
    authMethods: ['userpass', 'token'],
    configFields: [],
    refFields: [
      { id: 'mount', label: 'Mount', required: true, kind: 'text' },
      { id: 'path', label: 'Path', required: true, kind: 'text' },
      { id: 'key', label: 'Key', required: true, kind: 'text' },
    ],
  },
  {
    id: 'doppler',
    label: 'Doppler',
    note: 'Hosted.',
    authMethods: ['token'],
    configFields: [],
    refFields: [{ id: 'name', label: 'Secret', required: true, kind: 'text' }],
  },
];

let connections: readonly SecretConnectionState[] = CONNECTIONS;
let refTestAnswer: SecretRefTestResult = { found: true, keysAtPath: ['git_token', 'username'] };
const testRefCalls: SecretsRefTestRequest[] = [];

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  secrets: {
    listConnections: async () => ok({ connections, providers: SECRET_PROVIDERS }),
    saveConnection: async () => ok({ connections, providers: SECRET_PROVIDERS, id: 'sec-1', verify: { ok: true, detail: '' } }),
    deleteConnection: async () => ok({ connections, providers: SECRET_PROVIDERS }),
    verifyConnection: async () => ok({ connections, providers: SECRET_PROVIDERS, verify: { ok: true, detail: '' } }),
    fetchServerCert: async () => ({ ok: false, error: { code: 'internal', message: 'not in this test', retryable: false } }),
    testRef: async (request: SecretsRefTestRequest) => {
      testRefCalls.push(request);
      return ok(refTestAnswer);
    },
  },
  memoryBanks: {
    status: async () => ok(status),
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
  status = NO_BANKS;
  verifyAnswer = { outcome: 'ok', headPresent: true, detail: 'HEAD is 52a0a327' };
  connections = CONNECTIONS;
  refTestAnswer = { found: true, keysAtPath: ['git_token', 'username'] };
});

afterEach(() => {
  cleanup();
  verifyCalls.length = 0;
  addCalls.length = 0;
  testRefCalls.length = 0;
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

describe('slugFromRemote', () => {
  it('names the bank after the repository, lowercased', () => {
    // The reported case. `Cortex` is what the URL shows the user, and it is
    // exactly what the slug grammar refuses — so the suggestion has to do the
    // lowercasing rather than leave them guessing at a dead button.
    expect(slugFromRemote('http://system-dokploy:8300/david/Cortex.git')).toBe('cortex');
  });

  it('handles the shapes a remote actually arrives in', () => {
    expect(slugFromRemote('https://forgejo.example.com/team/Team_Docs.git')).toBe('team-docs');
    expect(slugFromRemote('git@github.com:org/my-bank.git')).toBe('my-bank');
    expect(slugFromRemote('https://host/x/Cortex')).toBe('cortex');
    expect(slugFromRemote('http://host:8300/david/bank/')).toBe('bank');
  });

  it('suggests nothing rather than something wrong', () => {
    // It runs on every keystroke of a half-typed URL, so silence is the only
    // safe answer for input that does not reduce to a legal slug.
    expect(slugFromRemote('')).toBe('');
    expect(slugFromRemote('   ')).toBe('');
    expect(slugFromRemote('https://host/x/___')).toBe('');
  });
});

/**
 * The alternative this phase added: point the bank at a secret's *address*
 * instead of pasting the secret.
 *
 * What is pinned here is the shape of the offer rather than its styling.
 * Pasting a token stays exactly as it was — a machine with no key manager
 * meets the form it always met — and the second source, when chosen, produces
 * a request carrying a `ref` and no `token`, which is the whole difference
 * between a bank that holds a credential and one that does not.
 *
 * The Test button gets its own tests because it is the difference between
 * finding a mistyped key here and finding it days later in a background sync
 * that quietly stopped.
 */
describe('joining a bank with a key-manager reference', () => {
  const chooseKeyManager = async (): Promise<void> => {
    await act(async () => {
      screen.getByRole('button', { name: 'From a key manager' }).click();
    });
  };

  it('leaves "paste a token" as the default, so nothing changes for a machine without one', async () => {
    await renderPane();
    expect(screen.getByLabelText(/Access token/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'From a key manager' })).toBeTruthy();
  });

  it('points at the Key managers pane when there is no manager to choose', async () => {
    connections = [];
    await renderPane();
    await chooseKeyManager();
    // A dead end with no instruction is how a user concludes the feature is
    // broken rather than unconfigured.
    expect(screen.getByText(/No key manager is connected/)).toBeTruthy();
  });

  it('replaces the token field with the provider’s own reference fields', async () => {
    await renderPane();
    await chooseKeyManager();
    // The token field is gone — the point of choosing this source is that
    // there is no token to type.
    expect(screen.queryByLabelText(/Access token/)).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    expect(screen.getByLabelText('Mount')).toBeTruthy();
    expect(screen.getByLabelText('Path')).toBeTruthy();
    expect(screen.getByLabelText('Key')).toBeTruthy();
    // Doppler's fields, not OpenBao's, when a Doppler connection is chosen.
    await act(async () => {
      screen.getByRole('button', { name: 'Team Doppler' }).click();
    });
    expect(screen.getByLabelText('Secret')).toBeTruthy();
    expect(screen.queryByLabelText('Mount')).toBeNull();
  });

  const fillOpenBaoRef = (over: { key?: string } = {}): void => {
    fireEvent.change(screen.getByLabelText('Mount'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'claude/artemis' } });
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: over.key ?? 'git_token' } });
  };

  it('will not test an incomplete reference', async () => {
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });

    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(true);
    await act(async () => {
      fillOpenBaoRef();
    });
    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(false);
  });

  it('will not test a reference the shared grammar refuses', async () => {
    // The same function main validates with. A pane that let a `..` through
    // and waited for the rejection would be teaching the rule twice.
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
      fireEvent.change(screen.getByLabelText('Path'), { target: { value: '../sys/seal' } });
    });
    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(true);
    expect(testRefCalls).toEqual([]);
  });

  it('resolves the reference for real and says so without showing a value', async () => {
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(testRefCalls).toEqual([
      {
        ref: {
          provider: 'openbao',
          connectionId: 'sec-1',
          mount: 'secret',
          path: 'claude/artemis',
          key: 'git_token',
        },
      },
    ]);
    expect(screen.getByText(/Resolved\./)).toBeTruthy();
    expect(screen.getByText(/discarded/)).toBeTruthy();
  });

  it('renders the key names on a miss, because that is the sentence that fixes it', async () => {
    refTestAnswer = {
      found: false,
      problem: 'secret/claude/artemis has no key named “git-token”.',
      keysAtPath: ['git_token', 'username'],
    };
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef({ key: 'git-token' });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(screen.getByText(/no key named/)).toBeTruthy();
    expect(screen.getByText(/git_token, username/)).toBeTruthy();
  });

  it('renders a denial as a denial, never as "not found"', async () => {
    refTestAnswer = {
      found: false,
      problem:
        'OpenBao refused kv/team (403). It answers identically for a path this token’s policy does not allow, for a path that does not exist, and for a mount that does not exist, so this is “denied, or absent” and it will not say which.',
    };
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(screen.getByText(/denied, or absent/)).toBeTruthy();
  });

  it('sends a ref and no token with the join', async () => {
    await renderPane();
    fillJoin();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
    });
    await act(async () => {
      joinButton().click();
    });

    expect(addCalls).toHaveLength(1);
    const request = addCalls[0] as { auth?: Record<string, unknown> };
    expect(request.auth).toEqual({
      ref: {
        provider: 'openbao',
        connectionId: 'sec-1',
        mount: 'secret',
        path: 'claude/artemis',
        key: 'git_token',
      },
    });
    // Exactly one of the two: a request carrying both would be two answers to
    // one question, and main refuses it.
    expect(request.auth).not.toHaveProperty('token');
  });

  it('builds a Doppler reference against the Doppler connection, not the first one', async () => {
    // The other provider, end to end through the same form: a different
    // connection id, a different field set, and a differently shaped ref. With
    // one connection and one provider in the fixture none of that is proven —
    // and "both providers are first class" is exactly the claim being made.
    await renderPane();
    fillJoin();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Team Doppler' }).click();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'GIT_TOKEN' } });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(testRefCalls).toEqual([
      { ref: { provider: 'doppler', connectionId: 'sec-2', name: 'GIT_TOKEN' } },
    ]);

    await act(async () => {
      joinButton().click();
    });
    const request = addCalls[0] as { auth?: Record<string, unknown> };
    expect(request.auth).toEqual({
      ref: { provider: 'doppler', connectionId: 'sec-2', name: 'GIT_TOKEN' },
    });
    // No mount and no path: Doppler has neither, and a ref carrying OpenBao's
    // shape would be the form remembering the provider it was last on.
    expect(request.auth?.['ref']).not.toHaveProperty('mount');
    expect(request.auth?.['ref']).not.toHaveProperty('path');
  });

  it('still offers the username, because git echoes it either way', async () => {
    await renderPane();
    await chooseKeyManager();
    expect(screen.queryByLabelText('Username')).toBeNull();
    await act(async () => {
      screen.getByRole('button', { name: /Username/ }).click();
    });
    expect(screen.getByLabelText('Username')).toBeTruthy();
  });
});

describe('a bank whose credential lives in a key manager', () => {
  it('says so on the row, and says when it has stopped resolving', async () => {
    status = {
      ...NO_BANKS,
      masterEnabled: true,
      banks: [
        {
          slug: 'team',
          path: '/Users/demo/Documents/team',
          remote: 'https://git.example.com/team/bank.git',
          role: 'readwrite',
          enabled: true,
          isDefault: true,
          exists: true,
          source: 'cerebro@52a0a32',
          memories: 3,
          mirrored: 0,
          validationErrors: 0,
          projects: 2,
          credential: { kind: 'ref' },
        },
      ],
    };
    await renderPane();
    expect(screen.getByText('key manager')).toBeTruthy();

    cleanup();
    // The degraded case: the sync did not happen, nothing blocked, and the
    // pane is where a person finds out why.
    status = {
      ...status,
      banks: [
        {
          ...status.banks[0]!,
          credential: { kind: 'ref', problem: 'OpenBao is sealed, so it cannot be read.' },
        },
      ],
    };
    await renderPane();
    expect(screen.getByText('key manager unreachable')).toBeTruthy();
    expect(screen.getByText(/OpenBao is sealed/)).toBeTruthy();
  });
});
