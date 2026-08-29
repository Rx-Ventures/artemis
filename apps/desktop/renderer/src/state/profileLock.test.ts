/**
 * @vitest-environment jsdom
 *
 * The account belongs to the session, not to the window.
 *
 * The sibling of `cwd.test.ts`, and it exists because the two halves of one rule
 * had drifted apart. A session id only resolves under the config directory it
 * was written in *and* against the directory it ran in. `setCwd` had always
 * enforced the second half; `setProfile` swapped the account and returned, so
 * the next prompt ran under different credentials and resumed a transcript
 * living in the previous profile's `projects/`.
 *
 * That failure has two shapes and neither is visible at the moment it is caused:
 * where the stores are separate the provider complains about an id the user
 * never saw, seconds after they typed a prompt; where the shared-config feature
 * has symlinked `projects/` across profiles it *succeeds*, and the wrong account
 * is billed for the continuation of a conversation it never had.
 *
 * Same caveat as the sibling: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 *
 * jsdom, unlike the sibling, because the second door into this rule — creating
 * an account — goes through the bridge, and `resolveBridge` picks the dev mock
 * when there is no `window` to hang a stub on. The mock would answer
 * `profiles.list` with its own seeded accounts and overwrite the fixture every
 * assertion here depends on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProfile, focusedPane, handOffToProfile, newSession, setProfile, useApp } from './store';
import { paneState, setPaneState } from './pane';

const pane = () => focusedPane();
const session = () => paneState(pane());
const setSession = (patch) => setPaneState(pane(), patch);
const transcript = () => pane().transcript;

const CAPABILITIES = {
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

const PROFILES = [
  { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.p1' },
  { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.p2' },
];

const LIVE_RUN = {
  runId: 'r1',
  status: 'running',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/a',
  capabilities: CAPABILITIES,
  startedAt: 1_000,
};

/** The account `profiles.create` answers with, for the second door into the rule. */
const CREATED = { id: 'p9', label: 'Fresh', providerId: 'claude', configDir: '/home/u/.p9' };

/**
 * Installed at module scope, not per test: `resolveBridge` memoises its binding
 * the first time anything asks, so a later assignment would never be seen.
 *
 * `profiles.create` and `profiles.list` are what the assertions are about. The
 * rest are here because moving an account fans out into re-reads — the session
 * list, the model catalogue — and those are not all wrapped in `call`, so a
 * missing method surfaces as an unhandled rejection that fails the run around
 * assertions that passed. Each answers the emptiest valid shape: enough to be
 * ignored, not enough to be mistaken for a fixture.
 */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  profiles: {
    create: async () => ({ ok: true as const, value: { profile: CREATED } }),
    list: async () => ({ ok: true as const, value: { profiles: [...PROFILES, CREATED] } }),
  },
  providers: {
    list: async () => ({ ok: true as const, value: { providers: [] } }),
    models: async () => ({ ok: true as const, value: { models: [], live: false } }),
  },
  sessions: {
    list: async () => ({ ok: true as const, value: { sessions: [], hasMore: false } }),
    listAll: async () => ({ ok: true as const, value: { sessions: [], unreadableProfiles: [] } }),
  },
  auth: { status: async () => ({ ok: false as const, error: { code: 'unknown', message: 'stub' } }) },
  usagePlan: {
    cached: async () => ({ ok: true as const, value: { usage: null } }),
    refresh: async () => ({ ok: true as const, value: { usage: null } }),
    onChange: () => () => undefined,
  },
};

/** See the sibling file: the model coalesces, and outside a browser that is a timer. */
function flushed(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 32));
}

/** A column on `p1` in `/a`, with an earlier session selected and something on screen. */
function withSelectedSession(): void {
  setSession({
    cwd: '/a',
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    resumeSessionId: 'sess-1111',
    run: null,
    permissionQueue: [],
  });
  transcript().reset();
  transcript().note('info', 'Something the user was reading');
}

beforeEach(() => {
  useApp.setState({
    banners: [],
    profiles: PROFILES,
    // No readings, so nothing recommends an account. `newSession`'s adoption is
    // covered in `newSession.test.ts`; here it would only add a second reason
    // for the profile to move and make every assertion ambiguous.
    planUsageByProfile: {},
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
  });
  setSession({
    profiles: PROFILES,
    cwd: '/a',
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    resumeSessionId: null,
    run: null,
  });
  transcript().reset();
});

afterEach(() => transcript().reset());

describe('setProfile', () => {
  it('just moves when no session is selected', () => {
    setProfile('p2');

    expect(session().activeProfileId).toBe('p2');
    expect(session().resumeSessionId).toBeNull();
    // Nothing was left behind, so nothing is announced.
    expect(transcript().isEmpty).toBe(true);
  });

  it('drops the selected session rather than resuming it on another account', () => {
    withSelectedSession();

    setProfile('p2');

    expect(session().activeProfileId).toBe('p2');
    // The whole point: an id written into `p1`'s config directory must not
    // survive into a column pointed at `p2`, which cannot resolve it — or, with
    // `projects/` shared, resolves it and bills the wrong account.
    expect(session().resumeSessionId).toBeNull();
  });

  it('says that it started a new session, in the new transcript', async () => {
    withSelectedSession();

    setProfile('p2');

    // One item: the note. The previous conversation was reset out from under it,
    // so the note has to land after that reset or it goes with it.
    expect(transcript().length).toBe(1);

    await flushed();

    const [id] = transcript().getListSnapshot();
    const item = transcript().getItem(id ?? '');
    expect(item?.kind).toBe('notice');
    expect(item?.text).toContain('new session');
    // Named, because silently changing which account pays is the one thing the
    // status line exists to keep answerable.
    expect(item?.detail).toContain('Work');
  });

  it('ignores a re-pick of the account already selected', () => {
    withSelectedSession();
    const before = transcript().length;

    setProfile('p1');

    expect(session().activeProfileId).toBe('p1');
    expect(session().resumeSessionId).toBe('sess-1111');
    expect(transcript().length).toBe(before);
  });

  it('ignores an id that names no profile', () => {
    withSelectedSession();

    // Only reachable from a stale render of a profile since deleted. Honouring
    // it would point the column at an account that is not there — and, now that
    // this function ends sessions, would end one to do it.
    setProfile('gone');

    expect(session().activeProfileId).toBe('p1');
    expect(session().resumeSessionId).toBe('sess-1111');
  });

  it('refuses while a run is live, and says why', () => {
    withSelectedSession();
    setSession({ run: LIVE_RUN });

    setProfile('p2');

    // The same refusal `setCwd` makes, for the same reason: ending work in
    // progress is not what reaching for the account picker asks for.
    expect(session().activeProfileId).toBe('p1');
    expect(session().resumeSessionId).toBe('sess-1111');

    const banner = useApp.getState().banners.at(-1);
    expect(banner?.level).toBe('warn');
    expect(banner?.message).toContain('run is still going');
  });

  it('moves the provider with the account', () => {
    useApp.setState({
      profiles: [...PROFILES, { id: 'p3', label: 'Codex', providerId: 'codex', configDir: '/c' }],
    });
    setSession({
      profiles: [...PROFILES, { id: 'p3', label: 'Codex', providerId: 'codex', configDir: '/c' }],
    });

    setProfile('p3');

    // A profile belongs to exactly one CLI. Leaving the provider behind would
    // ask the Claude adapter to answer for an account it has never heard of.
    expect(session().activeProfileId).toBe('p3');
    expect(session().activeProviderId).toBe('codex');
  });
});

describe('creating an account', () => {
  const DRAFT = { label: 'Fresh', providerId: 'claude', configDir: '/home/u/.p9' };

  it('adopts the new account when there is no conversation to protect', async () => {
    await createProfile(DRAFT);

    // First run, which is the case adoption exists for at all.
    expect(session().activeProfileId).toBe('p9');
  });

  it('leaves a column that is holding a conversation exactly where it is', async () => {
    withSelectedSession();

    await createProfile(DRAFT);

    // The same cross-account resume `setProfile` refuses, arriving by another
    // door — and worse here, since a brand-new account is signed out, so the
    // next prompt would fail on credentials against a transcript it could not
    // have read anyway.
    expect(session().activeProfileId).toBe('p1');
    expect(session().resumeSessionId).toBe('sess-1111');
    // And the conversation is not ended to make room: account admin is not a
    // request about the conversation on screen.
    expect(transcript().length).toBe(1);

    const banner = useApp.getState().banners.at(-1);
    expect(banner?.level).toBe('info');
    expect(banner?.message).toContain('Fresh');
  });

});

describe('the account a fresh session starts on', () => {
  it('is still free to move, because there is no session to protect', () => {
    withSelectedSession();

    // `newSession` resets the conversation and *then* adopts a recommended
    // account. That write goes through `applyProfile`, not the gate — going
    // through the gate would be the function asking itself for permission, and
    // would recurse if a blank pane ever carried a session id forward.
    newSession(pane(), { adoptRecommendedProfile: false });
    expect(session().resumeSessionId).toBeNull();

    setProfile('p2');

    // No second "started a new session" note: the session was already gone, so
    // there was nothing to leave.
    expect(session().activeProfileId).toBe('p2');
    expect(transcript().isEmpty).toBe(true);
  });
});

/**
 * The narrower door (ADR 0003).
 *
 * The invariant above did not relax — it sharpened. `setProfile` still drops
 * the session for an arbitrary pick, because for an arbitrary pick nothing
 * guarantees the target reaches the transcript's store or should be billed for
 * it. `handOffToProfile` is allowed to keep the session precisely because it
 * proves what `setProfile` cannot: the target *shares the store*
 * (`alsoInProfiles`), is *signed in*, and has a *fresh, unrejected* plan
 * reading. One rule, two doors: the general one ends the session, the proven
 * one carries it — and every unproven condition below lands back on "nothing
 * moves".
 */
describe('the hand-off door', () => {
  /** The row the sidebar would show: `p2` shares the store with `p1`. */
  const SHARED = {
    id: 'sess-1111',
    providerId: 'claude',
    profileId: 'p1',
    alsoInProfiles: ['p2'],
    cwd: '/a',
    title: 'One conversation',
    updatedAt: 10,
  };

  /** A reading fresh enough to act on, far from every limit. */
  const fresh = () => ({
    available: true,
    windows: [{ id: 'five_hour', label: '5 hours', utilization: 20, resetsAt: null }],
    fetchedAt: Date.now(),
  });

  /** `p2` proven: reachable, signed in, fresh reading. */
  function provenTarget(): void {
    useApp.setState({
      sessions: [SHARED],
      authByProfile: { p2: { loggedIn: true } },
      planUsageByProfile: { p2: fresh() },
    } as never);
  }

  it('moves the account and keeps the session — the one thing setProfile never does', async () => {
    withSelectedSession();
    provenTarget();

    expect(await handOffToProfile('p2')).toBe(true);

    expect(session().activeProfileId).toBe('p2');
    // The invariant's other half: the id survives, because the next prompt is
    // meant to resume THIS conversation under the new account.
    expect(session().resumeSessionId).toBe('sess-1111');
  });

  it('says what moved, in the transcript, without resetting it', async () => {
    withSelectedSession();
    provenTarget();

    await handOffToProfile('p2');
    await flushed();

    // Two items: what the user was reading, then the note. A door that reset
    // the transcript would defeat the entire point of carrying the session.
    expect(transcript().length).toBe(2);
    const id = transcript().getListSnapshot().at(-1);
    const item = transcript().getItem(id ?? '');
    expect(item?.kind).toBe('notice');
    expect(item?.text).toContain('Handed off to Work');
    expect(item?.detail).toContain('profile → Work');
  });

  it('refuses while a run is live, exactly as the gate does', async () => {
    withSelectedSession();
    provenTarget();
    setSession({ run: LIVE_RUN });

    expect(await handOffToProfile('p2')).toBe(false);

    expect(session().activeProfileId).toBe('p1');
    expect(session().resumeSessionId).toBe('sess-1111');
    expect(useApp.getState().banners.at(-1)?.message).toContain('run is still going');
  });

  it('refuses a target that cannot reach the transcript', async () => {
    withSelectedSession();
    provenTarget();
    // The same session with no sharers: p2's directory does not reach it, so
    // the resume the door promises would be aimed at a store the account
    // cannot read — the exact failure setProfile's gate exists to prevent.
    useApp.setState({ sessions: [{ ...SHARED, alsoInProfiles: [] }] } as never);

    expect(await handOffToProfile('p2')).toBe(false);

    expect(session().activeProfileId).toBe('p1');
    expect(session().resumeSessionId).toBe('sess-1111');
    expect(useApp.getState().banners.at(-1)?.message).toContain('Could not hand off');
  });

  it('refuses a signed-out target', async () => {
    withSelectedSession();
    provenTarget();
    useApp.setState({ authByProfile: { p2: { loggedIn: false } } } as never);

    expect(await handOffToProfile('p2')).toBe(false);
    expect(session().activeProfileId).toBe('p1');
    expect(useApp.getState().banners.at(-1)?.detail).toContain('signed out');
  });

  it('probes an unchecked target rather than guessing, and refuses when the probe fails', async () => {
    withSelectedSession();
    provenTarget();
    // Nobody has asked about p2. The module-scope bridge's `auth.status`
    // answers with a failure, so the probe learns nothing — and an account
    // whose sign-in state cannot be established is not one to move work to.
    useApp.setState({ authByProfile: {} } as never);

    expect(await handOffToProfile('p2')).toBe(false);
    expect(session().activeProfileId).toBe('p1');
  });

  it('refuses on a stale reading — six minutes, the recommender’s own bar', async () => {
    withSelectedSession();
    provenTarget();
    useApp.setState({
      planUsageByProfile: { p2: { ...fresh(), fetchedAt: Date.now() - 7 * 60_000 } },
    } as never);

    expect(await handOffToProfile('p2')).toBe(false);
    expect(useApp.getState().banners.at(-1)?.detail).toContain('fresh');
  });

  it('refuses an account whose own binding window is rejected', async () => {
    withSelectedSession();
    provenTarget();
    useApp.setState({
      planUsageByProfile: {
        p2: {
          available: true,
          windows: [
            { id: 'five_hour', label: '5 hours', utilization: 97, resetsAt: null, status: 'rejected' },
          ],
          fetchedAt: Date.now(),
        },
      },
    } as never);

    // Handing work to an account that immediately stalls is the failure mode
    // ADR 0003 names; the provider's own verdict outranks any percentage.
    expect(await handOffToProfile('p2')).toBe(false);
    expect(useApp.getState().banners.at(-1)?.detail).toContain('limit is reached');
  });

  it('does nothing without a session — the plain picker already covers that', async () => {
    provenTarget();

    expect(await handOffToProfile('p2')).toBe(false);
    expect(session().activeProfileId).toBe('p1');
  });
});
