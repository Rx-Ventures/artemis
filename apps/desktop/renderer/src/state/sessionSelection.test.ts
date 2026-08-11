/**
 * @vitest-environment jsdom
 *
 * The sidebar keeps showing the sessions it is pointed at.
 *
 * Two failures shipped together and read as one symptom — "sessions keep
 * disappearing from the sidebar" — because both end with a list that is empty
 * or wrong for twenty seconds at a time. They are separate bugs and they are
 * tested separately here.
 *
 * ## A profile carries its provider
 *
 * `createProfile` moves `activeProviderId` to the new profile's provider, which
 * is correct — a profile belongs to exactly one CLI. But the status line's
 * profile picker was filtered to the active provider, so creating a Codex
 * profile emptied the menu of every Claude account at the same instant, and the
 * only other provider control is a page inside the command palette. The list is
 * provider-scoped in the backend too (`listAllSessions` reads
 * `profiles.list(providerId)`), so all of that history left the sidebar with it
 * and there was no visible way back.
 *
 * The fix is that `setProfile` moves the provider itself, which is what lets the
 * picker span providers safely. These assertions are the load-bearing half: a
 * picker offering a cross-provider profile is only correct while selecting one
 * cannot desync the two.
 *
 * ## A listing answers the selection it was asked about
 *
 * `refreshSessions` reads the selection, awaits a listing, then writes. A user
 * switching provider, profile or directory inside that window used to get both
 * halves of the race wrong: the in-flight read wrote the *previous* provider's
 * sessions over a list already cleared for the new one, and the refresh the
 * switch asked for was dropped by the re-entrancy guard — so nothing re-read
 * until the next poll.
 *
 * Same caveat as `cwd.test.ts` and `models.test.ts`: `renderer/tsconfig.json`
 * excludes test files, so `pnpm typecheck` never sees this one and the
 * assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Capabilities,
  ProfileMetadata,
  ProviderDescriptor,
  SessionSummary,
} from '@rx-artemis/protocol';

import { focusedPane, refreshSessions, setProfile, useApp } from './store';
import { paneState, setPaneState } from './pane';

/*
 * One column, and it is the one the sidebar's listing answers for.
 *
 * `setProfile` and the rest write to a pane now — see `state/pane.ts`. The
 * session list itself stays the window's: it spans every provider and both
 * columns browse the same history.
 */
const pane = () => focusedPane();
const session_ = () => paneState(pane());
const setSession = (patch) => setPaneState(pane(), patch);

const CAPABLE: Capabilities = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

const CLAUDE: ProviderDescriptor = {
  id: 'claude',
  label: 'Claude',
  capabilities: CAPABLE,
  models: [],
  effortLevels: [],
  available: true,
};

const CODEX: ProviderDescriptor = { ...CLAUDE, id: 'codex', label: 'Codex' };

function profile(id: string, providerId: string): ProfileMetadata {
  return {
    id,
    label: id,
    providerId,
    configDir: `/home/u/.${providerId}-${id}`,
  } as ProfileMetadata;
}

const CLAUDE_WORK = profile('claude-work', 'claude');
const CODEX_NEW = profile('codex-new', 'codex');

function session(id: string, cwd: string, profileId: string): SessionSummary {
  return { id, title: id, cwd, profileId, updatedAt: 1_000, providerId: 'claude' } as SessionSummary;
}

/* -------------------------------------------------------------------------- */
/* A bridge whose listing can be held open                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sessions the next `listAll` resolves with, and a latch to hold it open.
 *
 * A mutable box rather than a fresh stub per test, for the reason
 * `models.test.ts` gives: `resolveBridge` memoises its binding on the first
 * call, so a second `window.artemis` would never be seen.
 */
let nextSessions: readonly SessionSummary[] = [];
let release: (() => void) | null = null;
let listCalls = 0;
/** What the last `listAll` was actually asked for. */
let lastListAllRequest: { providerId?: string } = {};

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  sessions: {
    listAll: async (request: { providerId?: string }) => {
      listCalls += 1;
      lastListAllRequest = request;
      // Captured at call time, so a test can change the answer while a read is
      // held open and see which one the store actually wrote.
      const answering = nextSessions;
      if (release !== null) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true, value: { sessions: answering, hasMore: false } };
    },
  },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

/** Hold the next listing open until `letListingFinish` is called. */
function holdNextListing(): void {
  release = () => undefined;
}

function letListingFinish(): void {
  const resume = release;
  release = null;
  resume?.();
}

/** Let every pending microtask and the queued re-run settle. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 8));
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  nextSessions = [];
  release = null;
  listCalls = 0;
  lastListAllRequest = {};
  useApp.setState({
    providers: [CLAUDE, CODEX],
    profiles: [CLAUDE_WORK, CODEX_NEW],
    sessions: [],
    sessionsError: null,
    sessionsLoading: false,
  });
  setSession({
    activeProviderId: 'claude',
    activeProfileId: CLAUDE_WORK.id,
    run: null,
    cwd: '/proj',
    models: [],
  });
});

/* -------------------------------------------------------------------------- */

describe('setProfile', () => {
  it('moves the provider to the one the profile belongs to', () => {
    setProfile(CODEX_NEW.id);

    // The whole reason the picker can span providers. Selecting a Codex account
    // while `activeProviderId` still said `claude` would point every catalogue
    // fetch, session list and run at the wrong binary.
    expect(session_().activeProfileId).toBe(CODEX_NEW.id);
    expect(session_().activeProviderId).toBe('codex');
  });

  it('gets back to a Claude account from a Codex one', () => {
    setProfile(CODEX_NEW.id);
    setProfile(CLAUDE_WORK.id);

    // The reported bug, read forwards: after initialising a Codex profile there
    // was no route back to the Claude accounts, because the only picker on
    // screen had filtered them out.
    expect(session_().activeProfileId).toBe(CLAUDE_WORK.id);
    expect(session_().activeProviderId).toBe('claude');
  });

  it('ignores an id no profile has', () => {
    setProfile('deleted-while-the-menu-was-open');

    expect(session_().activeProfileId).toBe(CLAUDE_WORK.id);
    expect(session_().activeProviderId).toBe('claude');
  });

  it('keeps the loaded catalogue when the provider does not change', () => {
    const models = [{ id: 'opus', label: 'Opus 5', resolvedModel: 'claude-opus-5', note: '' }];
    useApp.setState({ profiles: [CLAUDE_WORK, profile('claude-personal', 'claude')] });
    setSession({ models });

    setProfile('claude-personal');

    // Same provider, so the list is still the right shape of answer. Clearing
    // would flash the picker back to the built-in list and forward again.
    expect(session_().models).toEqual(models);
  });
});

describe('refreshSessions', () => {
  it('discards a listing whose selection has moved on', async () => {
    const claudeHistory = [session('s-claude', '/proj', CLAUDE_WORK.id)];
    nextSessions = claudeHistory;
    holdNextListing();

    const inFlight = refreshSessions();

    // The switch lands mid-read, clearing the list and asking for a new one.
    nextSessions = [];
    setProfile(CODEX_NEW.id);
    expect(useApp.getState().sessions).toEqual([]);

    letListingFinish();
    await inFlight;
    await settled();

    // The held listing was answering for the Claude profile. Writing it here
    // would repopulate the sidebar with an account's history the app is no
    // longer pointed at — and it stayed that way until the next poll.
    expect(useApp.getState().sessions).toEqual([]);
  });

  it('re-reads for the selection that superseded the one in flight', async () => {
    holdNextListing();
    const inFlight = refreshSessions();

    const codexHistory = [session('s-codex', '/proj', CODEX_NEW.id)];
    nextSessions = codexHistory;
    setProfile(CODEX_NEW.id);

    letListingFinish();
    await inFlight;
    await settled();

    // The re-entrancy guard used to drop this read entirely, leaving the
    // sidebar empty until the idle poll came round up to twenty seconds later.
    expect(listCalls).toBe(2);
    expect(useApp.getState().sessions).toEqual(codexHistory);
    expect(useApp.getState().sessionsLoading).toBe(false);
  });

  it('coalesces concurrent refreshes into one re-read', async () => {
    holdNextListing();
    const inFlight = refreshSessions();

    void refreshSessions();
    void refreshSessions();
    void refreshSessions();

    letListingFinish();
    await inFlight;
    await settled();

    // Three callers, one queued re-read — not three. Every listing reads the
    // same directories off disk, so stacking them buys nothing.
    expect(listCalls).toBe(2);
  });

  it('still lists everything when the selected provider cannot enumerate its own history', async () => {
    const history = [session('s-other', '/proj', CLAUDE_WORK.id)];
    nextSessions = history;
    useApp.setState({
      providers: [{ ...CLAUDE, capabilities: { ...CAPABLE, listSessions: false } }, CODEX],
    });

    await refreshSessions();

    // This used to clear the list and skip the read entirely, so selecting an
    // account whose CLI cannot enumerate history removed every *other*
    // provider's sessions from the sidebar too. The listing spans providers:
    // the selected one's capability decides what is missing from the result,
    // not whether the result is worth having. The sidebar says as much above
    // the rows rather than in place of them.
    expect(listCalls).toBe(1);
    expect(useApp.getState().sessions).toEqual(history);
  });

  it('asks for every provider rather than the selected one', async () => {
    await refreshSessions();

    // The reported bug, at its source. `listAllSessions` scopes to
    // `query.providerId` when it is given one, so passing the active provider
    // made the sidebar a view onto the current account: signing into Codex
    // removed every Claude session from it. The contract says to omit the
    // field for "every provider that can list history", which is what a
    // history pane wants.
    expect(lastListAllRequest.providerId).toBeUndefined();
  });

  it('keeps the same sessions across a profile switch', async () => {
    const history = [session('s1', '/proj', CLAUDE_WORK.id)];
    nextSessions = history;
    await refreshSessions();
    expect(useApp.getState().sessions).toEqual(history);

    setProfile(CODEX_NEW.id);
    await settled();

    // Switching to a Codex account does not empty the list of Claude work.
    // Which account a session belongs to is on its row; it is not a filter.
    expect(useApp.getState().sessions).toEqual(history);
  });
});
