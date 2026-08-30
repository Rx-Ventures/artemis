/**
 * @vitest-environment jsdom
 *
 * A conversation keeps the model it was last set to run on.
 * ============================================================================
 *
 * `model`, `effort`, `fastMode` and `ultracode` live in the pane, and a pane
 * outlives the conversation inside it — the same seam `composerDrafts.test.ts`
 * opens with. Pointing a column at another session kept every one of them,
 * which made the model a property of the *column* rather than of the work:
 *
 *  - Open a session on Opus, click another conversation, switch that one to
 *    Haiku, click back. The first conversation came back on Haiku, and the
 *    status line said so a beat after the transcript had already reappeared —
 *    so the next prompt in a long Opus conversation billed a different model
 *    than every prompt before it, with nothing on screen marking the change.
 *  - The same for the thinking rung and fast mode, which are the same choice:
 *    a conversation run at `max` came back at whatever the other one was on.
 *
 * What these pin is the rule that replaced it: the whole model choice is filed
 * under the conversation it was made for and handed back on return, the way a
 * half-written prompt already was. A brand-new column still inherits whatever
 * the last one was using — there is no conversation to have a preference yet.
 *
 * Same caveat as the neighbouring files: `renderer/tsconfig.json` excludes test
 * files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities, ProviderDescriptor, SessionSummary } from '@rx-artemis/protocol';

import {
  focusedPane,
  newSession,
  resetRunStreamState,
  resumeSession,
  setFastMode,
  setModel,
  setThinkingLevel,
  useApp,
} from './store';
import { paneState, setPaneState, type Pane } from './pane';
import { seedApp } from './testkit';

const pane = (): Pane => focusedPane();
const modelOf = (of: Pane = pane()): string | null => paneState(of).model;

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
  models: [
    { id: 'opus', label: 'Opus 5', resolvedModel: 'claude-opus-5', note: '' },
    { id: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001', note: '' },
  ],
  effortLevels: [
    { id: 'low', label: 'Low', note: '' },
    { id: 'max', label: 'Max', note: '' },
  ],
  available: true,
};

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    title: id,
    updatedAt: 10,
    ...over,
  } as SessionSummary;
}

/**
 * A run this window believes is in flight, so the pane counts as working — and
 * one that has finished, so it does not.
 *
 * The distinction decides which of two quite different paths a resume takes. A
 * working column is handed off to a background pane that keeps its own state,
 * so returning to it never needed a record; a finished one is simply repointed,
 * taking the outgoing conversation's column — and its model — with it. Both are
 * asserted, because only the second was ever broken and a fix that quietly
 * moved the first would be a regression nobody was looking for.
 *
 * `sessionId` rides on the run rather than in `resumeSessionId`, which is where
 * a *new* conversation's id actually lands: the provider mints it mid-run and
 * `session.started` writes it onto the run alone.
 */
function liveRun(sessionId: string) {
  return {
    runId: `run-${sessionId}`,
    status: 'running' as const,
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    capabilities: CAPABLE,
    startedAt: 1,
    permissionMode: 'default' as const,
    sessionId,
  };
}

function endedRun(sessionId: string) {
  return { ...liveRun(sessionId), status: 'ended' as const };
}

beforeEach(() => {
  // Fixture run ids repeat across cases; production ids never do. See the
  // helper's own note in `store.ts`.
  resetRunStreamState();
  globalThis.localStorage?.clear();
  seedApp({
    providers: [CLAUDE],
    profiles: [{ id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.personal' }],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
    model: null,
    effort: null,
    fastMode: false,
    ultracode: false,
    draft: '',
    parkedDrafts: {},
  });
  // `modelBySession` explicitly, and it is not belt and braces: `loadPrefs`
  // runs at *module scope*, so the store is already carrying whatever the last
  // run of this suite wrote — locally, where `--localstorage-file` gives Node a
  // `localStorage` that outlives the process. Clearing the storage below only
  // affects the next load, which never happens. Without this every assertion
  // here passes against a record the previous run left behind, which is exactly
  // how a version of this file went green against a store that recorded nothing.
  useApp.setState({ background: [], sessions: [], modelBySession: {} });
  pane().transcript.reset();
});

describe('the model a conversation was left on', () => {
  it('comes back when the column returns to it', () => {
    resumeSession(summary('sess-a'));
    setModel('opus');

    resumeSession(summary('sess-b'));
    setModel('haiku');
    expect(modelOf()).toBe('haiku');

    resumeSession(summary('sess-a'));

    expect(modelOf()).toBe('opus');
  });

  it('comes back for a conversation still in flight', () => {
    // The reported case: the session being returned to never stopped running,
    // so it was handed to a background pane rather than resumed from scratch.
    resumeSession(summary('sess-a'));
    setModel('opus');
    setPaneState(pane(), { run: liveRun('sess-a') });

    resumeSession(summary('sess-b'));
    setModel('haiku');

    resumeSession(summary('sess-a'));

    expect(modelOf()).toBe('opus');
  });

  it('carries the thinking rung and fast mode with it', () => {
    resumeSession(summary('sess-a'));
    setModel('opus');
    setThinkingLevel('max');

    resumeSession(summary('sess-b'));
    setModel('haiku');
    setThinkingLevel('low');
    setFastMode(true);

    resumeSession(summary('sess-a'));

    expect(paneState(pane()).effort).toBe('max');
    expect(paneState(pane()).fastMode).toBe(false);
  });

  it('is remembered for a session whose id arrived after the choice was made', () => {
    // A new conversation has no id until its first run reports one, so the
    // choice is made at a moment there is nothing to file it under. The run has
    // since finished, so leaving does not background the column — the record is
    // the only thing that can bring the model back.
    newSession(pane());
    setModel('opus');
    setPaneState(pane(), { run: endedRun('sess-new') });

    resumeSession(summary('sess-b'));
    setModel('haiku');

    resumeSession(summary('sess-new'));

    expect(modelOf()).toBe('opus');
  });

  it('comes back after the run that made the choice has ended', () => {
    resumeSession(summary('sess-a'));
    setModel('opus');
    setPaneState(pane(), { run: endedRun('sess-a') });

    resumeSession(summary('sess-b'));
    setModel('haiku');

    resumeSession(summary('sess-a'));

    expect(modelOf()).toBe('opus');
  });

  it('reaches the preferences the moment it is chosen, not when the column moves on', () => {
    resumeSession(summary('sess-a'));
    setModel('opus');

    // Deliberately without leaving the conversation first. Quitting the app is
    // not a navigation, so a record written only on the way out would lose
    // every choice made in the conversation the user was still in.
    const saved = JSON.parse(globalThis.localStorage.getItem('artemis.prefs.v1') ?? '{}');

    expect(saved.modelBySession?.['sess-a']?.model).toBe('opus');
  });

  it('is filed by ⌘N as well, for a conversation cleared rather than left', () => {
    // Same gap as the resume above, on the other exit: the id lives on the run
    // and nothing has been set since it arrived, so the moment the column is
    // cleared is the last chance to write it down.
    newSession(pane());
    setModel('opus');
    setPaneState(pane(), { run: endedRun('sess-new') });

    newSession(pane());
    setModel('haiku');

    resumeSession(summary('sess-new'));

    expect(modelOf()).toBe('opus');
  });
});

describe('a conversation with no preference of its own', () => {
  it('inherits what the column was using', () => {
    setModel('opus');

    resumeSession(summary('sess-fresh'));

    // Nothing was ever recorded for this one, and blanking the picker on every
    // first open would be worse than carrying the obvious answer forward.
    expect(modelOf()).toBe('opus');
  });

  it('a new session keeps the column on the model it was set to', () => {
    resumeSession(summary('sess-a'));
    setModel('opus');

    newSession(pane());

    expect(modelOf()).toBe('opus');
  });
});

/**
 * The inheritance above stops at the provider boundary.
 * ============================================================================
 *
 * "No preference leaves the column on what it was using" is right within one
 * provider and wrong across two, because a model id is only meaningful in the
 * catalogue that named it. Clicking an OpenCode conversation and then a Claude
 * one used to leave `luna` selected under Claude, and nothing downstream
 * repaired it: `carryModelId` returns an id present in neither catalogue
 * unchanged so that another provider's *pins* survive a switch, and
 * `activeModel` passes an unlisted id through as itself because the catalogue
 * is what the UI offers rather than an allow-list. So the stale id reached
 * `RunInput.model` and the run started against a model the CLI cannot resolve.
 */
describe('crossing from one provider to another', () => {
  const OPENCODE: ProviderDescriptor = {
    ...CLAUDE,
    id: 'opencode',
    label: 'OpenCode',
    models: [{ id: 'luna', label: 'Luna', resolvedModel: 'luna', note: '' }],
  };

  function seedBothProviders(): void {
    seedApp({
      providers: [CLAUDE, OPENCODE],
      profiles: [
        { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.personal' },
        { id: 'p2', label: 'Work', providerId: 'opencode', configDir: '/u/.work' },
      ],
      activeProviderId: 'opencode',
      activeProfileId: 'p2',
      cwd: '/a',
      run: null,
      resumeSessionId: null,
      permissionQueue: [],
      banners: [],
      model: 'luna',
      effort: null,
      fastMode: false,
      ultracode: false,
      draft: '',
      parkedDrafts: {},
    });
    useApp.setState({ background: [], sessions: [], modelBySession: {} });
  }

  it('drops a model the arriving provider has never heard of', () => {
    seedBothProviders();
    expect(modelOf()).toBe('luna');

    resumeSession(summary('sess-claude', { providerId: 'claude', profileId: 'p1' }));

    // `null` is "the provider's default", which is the only honest state to be
    // in: this conversation has never said what it wants, and the column's last
    // answer belongs to a catalogue that is no longer loaded.
    expect(modelOf()).toBeNull();
  });

  it('drops the rest of the choice with it', () => {
    seedBothProviders();
    setThinkingLevel('max');
    setFastMode(true);

    resumeSession(summary('sess-claude', { providerId: 'claude', profileId: 'p1' }));

    // Spread as a whole or not at all — half a choice is a combination nobody
    // picked, and an effort rung is as provider-specific as a model id.
    const after = paneState(pane());
    expect(after.effort).toBeNull();
    expect(after.fastMode).toBe(false);
  });

  it('still hands back what the conversation itself remembers', () => {
    seedBothProviders();

    // Establish a real preference on the Claude side, then leave and return.
    const claudeSession = summary('sess-claude', { providerId: 'claude', profileId: 'p1' });
    resumeSession(claudeSession);
    setModel('opus');

    resumeSession(summary('sess-oc', { providerId: 'opencode', profileId: 'p2' }));
    resumeSession(claudeSession);

    // A recorded choice was made *for this conversation under this provider*,
    // so it outranks the reset — the reset only covers "no preference".
    expect(modelOf()).toBe('opus');
  });
});

/* -------------------------------------------------------------------------- */
/* Reading the record back off disk                                           */
/* -------------------------------------------------------------------------- */

/**
 * Boot the store against a preferences blob, the way a launch does.
 *
 * `loadPrefs` runs at *module scope*, so the only way to exercise it is to make
 * the module load again — hence `resetModules` and a dynamic import rather than
 * a call. The copy this returns is a second, independent `useApp`; every
 * assertion below is on it, and nothing above this line shares it.
 *
 * Worth the ceremony for one reason beyond the parsing: everything this reads
 * happens before the first paint, so a value that throws here is not a
 * mis-restored preference but a window that never opens — and, because the
 * first launch has no entries to read, one that only fails on the *second*.
 */
async function boot(stored: unknown): Promise<typeof import('./store')> {
  globalThis.localStorage.setItem('artemis.prefs.v1', JSON.stringify(stored));
  vi.resetModules();
  return import('./store');
}

describe('the stored record', () => {
  it('comes back off a preferences file written by a previous launch', async () => {
    const fresh = await boot({
      modelBySession: {
        'sess-a': { model: 'opus', effort: 'max', fastMode: false, ultracode: true },
      },
    });

    expect(fresh.useApp.getState().modelBySession['sess-a']).toEqual({
      model: 'opus',
      effort: 'max',
      fastMode: false,
      ultracode: true,
    });
  });

  it('drops an entry that is not a whole choice rather than restoring half of one', async () => {
    const fresh = await boot({
      modelBySession: {
        good: { model: 'opus', effort: null, fastMode: false, ultracode: false },
        // What a hand edit or a build that stored something else leaves behind.
        // `effort` reaches `RunInput` with no second gate on the way, so a
        // number here is asked of the provider verbatim.
        numeric: { model: 'opus', effort: 3 },
        stringly: 'opus',
        nothing: null,
      },
    });

    const restored = fresh.useApp.getState().modelBySession;
    expect(Object.keys(restored)).toEqual(['good']);
  });

  it('fills in the flags an older entry never carried', async () => {
    const fresh = await boot({ modelBySession: { 'sess-a': { model: 'opus', effort: null } } });

    // Absent is `false`, not `undefined`: these are spread straight into a pane
    // and a missing key would leave the previous conversation's flag standing.
    expect(fresh.useApp.getState().modelBySession['sess-a']).toEqual({
      model: 'opus',
      effort: null,
      fastMode: false,
      ultracode: false,
    });
  });

  it('keeps the newest entries when the file has grown past the cap', async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 500; i += 1) {
      many[`sess-${i}`] = { model: `m-${i}`, effort: null, fastMode: false, ultracode: false };
    }

    const restored = (await boot({ modelBySession: many })).useApp.getState().modelBySession;
    const keys = Object.keys(restored);

    expect(keys.length).toBe(400);
    // The tail, not the head: insertion order is age order, so trimming the
    // wrong end would evict every conversation the user has touched recently
    // and keep 400 they have not opened in months.
    expect(keys[keys.length - 1]).toBe('sess-499');
    expect(keys[0]).toBe('sess-100');
  });
});
