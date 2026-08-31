/**
 * @vitest-environment jsdom
 *
 * Accounts on a *remote* Artemis, as the profile card shows them.
 *
 * The server end of this is pinned in core (`server/__tests__/http.test.ts` and
 * `signin.test.ts`); what matters here is what a person is shown, and three
 * things about that are load-bearing:
 *
 *  - **The surface is gated on the grant, not on an error.** A connection token
 *    without account administration gets a 404 from the server for every write,
 *    so a pane that rendered the controls anyway would offer a button that
 *    cannot work. It says why instead.
 *  - **The verification URL is rendered verbatim.** It arrives from a
 *    subprocess on another machine and the user is being invited to sign in at
 *    it. Nothing shortens it, restyles it, or opens a second Electron window on
 *    the way — a plain anchor with no `target`, which `main/security.ts` hands
 *    to the system browser.
 *  - **A rejected code is a retry.** The CLI stays alive and asks again, and a
 *    pane that treated the first refusal as terminal would tear down a login
 *    the user was one paste away from finishing.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/** What the fake server answers, rewritten per test. */
let manageProfiles = true;
let accounts: Record<string, unknown>[] = [];
let signIn: Record<string, unknown> | null = null;
const submitted: string[] = [];
const started: string[] = [];

/*
 * A bridge stub installed before anything resolves one. `resolveBridge` reads
 * `window.artemis` on its first call and memoises the answer, so this has to be
 * in place before the first store action rather than merely before the render.
 */
vi.stubGlobal('artemis', {
  version: 'test',
  platform: 'darwin',
  profiles: {
    list: async () => ({ ok: true, value: { profiles: stored } }),
    suggestDir: async () => ({ ok: true, value: { configDir: '/home/u/.artemis' } }),
  },
  auth: { status: async () => ({ ok: true, value: { status: { loggedIn: true } } }) },
  sessions: { list: async () => ({ ok: true, value: { sessions: [] } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
  serverAccounts: {
    list: async () => ({ ok: true, value: { manageProfiles, accounts } }),
    create: async ({ label }: { label: string }) => ({
      ok: true,
      value: {
        account: {
          object: 'artemis.profile',
          id: 'remote-new',
          label,
          providerId: 'claude',
          configDir: `/data/profiles/${label}`,
        },
      },
    }),
    signIn: async ({ accountId }: { accountId: string }) => {
      started.push(accountId);
      signIn = {
        object: 'artemis.signin',
        profileId: accountId,
        state: 'awaiting_code',
        verificationUrl: 'https://claude.ai/oauth/authorize?code=true&state=xyz',
        startedAt: 0,
        expiresAt: 600_000,
      };
      return { ok: true, value: { signIn } };
    },
    signInStatus: async () => ({ ok: true, value: { signIn } }),
    submitCode: async ({ code }: { code: string }) => {
      submitted.push(code);
      signIn =
        code === 'GOOD'
          ? { ...signIn, state: 'done', account: { email: 'someone@example.com' } }
          : {
              ...signIn,
              state: 'awaiting_code',
              codeError: 'Invalid code. Please make sure the full code was copied.',
            };
      return { ok: true, value: { signIn } };
    },
    cancelSignIn: async () => ({ ok: true, value: { signIn: null } }),
  },
});

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ARTEMIS_PROFILE = {
  id: 'p1',
  label: 'Kronos',
  providerId: 'artemis',
  configDir: '/home/u/.artemis',
};

let stored: Record<string, unknown>[] = [ARTEMIS_PROFILE];

const { ProfilesSection } = await import('@/components/ProfilesScreen');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { seedApp } = await import('@/state/testkit');

function seed(profile: Record<string, unknown> = ARTEMIS_PROFILE): void {
  stored = [profile];
  seedApp({
    providers: [
      { id: 'artemis', label: 'Artemis Server', kind: 'local', available: true, capabilities: {} },
      { id: 'claude', label: 'Claude', kind: 'hosted', available: true, capabilities: {} },
    ],
    profiles: [profile],
    activeProviderId: profile['providerId'] as string,
    activeProfileId: 'p1',
    platform: 'darwin',
    sessions: [],
    banners: [],
  });
  render(
    <TooltipProvider delayDuration={0}>
      <ProfilesSection />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  manageProfiles = true;
  accounts = [
    {
      id: 'remote-work',
      slug: 'work',
      label: 'work',
      provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
      available: true,
      disabled: false,
      live: true,
      capabilities: {},
      models: [{ id: 'opus' }],
    },
  ];
  signIn = null;
  submitted.length = 0;
  started.length = 0;
});
afterEach(cleanup);

describe('the accounts-on-this-server section', () => {
  it('lists what the server serves, for an Artemis Server profile', async () => {
    seed();
    expect(await screen.findByText('Accounts on this server')).toBeTruthy();
    expect(await screen.findByText('work')).toBeTruthy();
    expect(await screen.findByText('1 models')).toBeTruthy();
  });

  it('is absent for a profile whose account lives on this machine', async () => {
    // A Claude profile has no server behind it. The section would be asking a
    // question with no address to send it to.
    seed({ ...ARTEMIS_PROFILE, providerId: 'claude', configDir: '/home/u/.claude' });
    await waitFor(() => expect(screen.getByText('Kronos')).toBeTruthy());
    expect(screen.queryByText('Accounts on this server')).toBeNull();
  });

  it('hides the controls, and says why, for a token without the grant', async () => {
    manageProfiles = false;
    seed();

    await screen.findByText('work');
    expect(screen.queryByRole('button', { name: /add account/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^sign in/i })).toBeNull();
    // Absent is not enough on its own: the fix is a flag on a command the user
    // runs somewhere else, so it has to be named.
    expect(screen.getByText(/--manage-profiles/)).toBeTruthy();
  });

  it('says a server with nothing on it has nothing to route to', async () => {
    accounts = [];
    seed();
    expect(await screen.findByText(/serves no accounts yet/i)).toBeTruthy();
  });

  it('shows the verification URL exactly as it arrived, as an ordinary link', async () => {
    seed();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));

    const link = (await screen.findByText(
      'https://claude.ai/oauth/authorize?code=true&state=xyz',
    )) as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      'https://claude.ai/oauth/authorize?code=true&state=xyz',
    );
    // No `target`: a second Electron window would inherit the app's privileges
    // on the way to a page `security.ts` is already going to hand the browser.
    expect(link.getAttribute('target')).toBeNull();
  });

  it('keeps asking after the server refuses a code', async () => {
    seed();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));

    const box = await screen.findByLabelText('Sign-in code');
    fireEvent.change(box, { target: { value: 'HALF' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText(/full code was copied/i)).toBeTruthy();
    // Still a code box, because the subprocess is still waiting on one.
    expect(screen.getByLabelText('Sign-in code')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: 'GOOD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText('Signed in on the server')).toBeTruthy();
    expect(submitted).toEqual(['HALF', 'GOOD']);
  });

  it('adds an account and goes straight into its login', async () => {
    // Adding one and not signing it in is a half-finished job, and the server
    // has just said which id to drive.
    seed();
    fireEvent.click(await screen.findByRole('button', { name: /add account/i }));
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'personal' } });
    fireEvent.click(screen.getByRole('button', { name: /add & sign in/i }));

    await waitFor(() => expect(started).toEqual(['remote-new']));
    expect(await screen.findByLabelText('Sign-in code')).toBeTruthy();
  });
});
