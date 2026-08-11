/**
 * When a session gets named, and — more importantly — when it does not.
 *
 * Every test here is about spending or not spending someone's account. The
 * namer sits on the run feed and fires a model call, so the interesting bugs
 * are all "it fired when it should not have": on the second turn of a
 * conversation, on a resumed session that already has a name the user typed, on
 * every re-emitted event, on a provider that cannot store the answer.
 *
 * The failure paths matter for a different reason. Naming is decoration, and
 * decoration that can fail a run, block a quit, or throw into the event feed is
 * a bug of a much worse class than a session called "(untitled session)".
 */

import { describe, expect, it, vi } from 'vitest';

import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type { AgentEvent, ProfileId, RunId, RunInput, SessionId } from '@rx-artemis/protocol';

import type { ProviderAdapter, SessionTitleQuery, SessionTitleUpdate } from '../adapters/types.js';
import { SessionNamer } from './naming.js';
import type { SessionNamerOptions, SessionNamingPlan } from './naming.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PROFILE = 'profile-1' as ProfileId;
const RUN = 'run-1' as RunId;
const SESSION = 'session-1' as SessionId;

const PLAN: SessionNamingPlan = {
  model: 'haiku',
  env: { CLAUDE_CONFIG_DIR: '/config', ANTHROPIC_SECRET: 'x' },
  storeEnv: { CLAUDE_CONFIG_DIR: '/config' },
};

function runInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    providerId: 'claude',
    profileId: PROFILE,
    cwd: '/repo',
    prompt: 'the login page redirects forever after the cookie expires',
    ...overrides,
  };
}

function sessionStarted(runId: RunId = RUN, sessionId: SessionId = SESSION): AgentEvent {
  return { type: 'session.started', runId, seq: 0, ts: 0, sessionId, providerId: 'claude' };
}

function runEnded(runId: RunId = RUN): AgentEvent {
  return { type: 'run.end', runId, seq: 9, ts: 0, reason: 'completed' };
}

/** An adapter that can both name and store, recording what it was asked. */
class FakeAdapter {
  readonly suggested: SessionTitleQuery[] = [];
  readonly stored: SessionTitleUpdate[] = [];

  title: string | null = 'Fix login redirect loop';
  /** Reject this many `setSessionTitle` calls before letting one through. */
  failStores = 0;
  suggestError: Error | null = null;

  readonly adapter: ProviderAdapter;

  constructor(options: { readonly canStore?: boolean; readonly canSuggest?: boolean } = {}) {
    const base = {
      id: 'claude' as const,
      label: 'Claude',
      capabilities: NO_CAPABILITIES,
      credentials: {
        configDirVar: 'CLAUDE_CONFIG_DIR',
        credentialEnvKeys: [],
        signIn: {
          executable: 'claude',
          loginArgs: [],
          statusArgs: [],
          logoutArgs: [],
          howTo: '',
        },
      },
      createRun: () => {
        throw new Error('not used');
      },
    };

    this.adapter = {
      ...base,
      ...(options.canSuggest === false
        ? {}
        : {
            suggestSessionTitle: async (query: SessionTitleQuery): Promise<string | null> => {
              this.suggested.push(query);
              if (this.suggestError) throw this.suggestError;
              return this.title;
            },
          }),
      ...(options.canStore === false
        ? {}
        : {
            setSessionTitle: async (update: SessionTitleUpdate): Promise<void> => {
              this.stored.push(update);
              if (this.failStores > 0) {
                this.failStores -= 1;
                throw new Error('session file not written yet');
              }
            },
          }),
    } as ProviderAdapter;
  }
}

function makeNamer(
  adapter: ProviderAdapter | undefined,
  overrides: Partial<SessionNamerOptions> = {},
): SessionNamer {
  return new SessionNamer({
    resolveAdapter: () => adapter,
    plan: () => PLAN,
    // Retries are exercised explicitly; elsewhere they should not add a second
    // of wall clock to a test.
    renameRetryMs: 0,
    ...overrides,
  });
}

/** Let the namer's fire-and-forget work run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/* -------------------------------------------------------------------------- */
/* Naming a new session                                                       */
/* -------------------------------------------------------------------------- */

describe('naming a new session', () => {
  it('names it from the opening message, on the model the plan chose', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(1);
    expect(fake.suggested[0]?.prompt).toBe(
      'the login page redirects forever after the cookie expires',
    );
    // The whole point of the feature: not the model the user picked for work.
    expect(fake.suggested[0]?.model).toBe('haiku');
    expect(fake.stored).toEqual([
      { sessionId: SESSION, title: 'Fix login redirect loop', cwd: '/repo', env: PLAN.storeEnv },
    ]);
  });

  it('bills the completion to the account and the write to the store only', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    // Two environments, deliberately different: naming contacts the model, the
    // rename only locates a file and must not decrypt anything.
    expect(fake.suggested[0]?.env).toBe(PLAN.env);
    expect(fake.stored[0]?.env).toBe(PLAN.storeEnv);
  });

  it('names a session whose start beat the run being registered', async () => {
    // The real race: `RunRegistry.start()` pumps events as soon as the adapter
    // returns, and the host cannot call `noteRun` until that call resolves.
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.handleEvent(sessionStarted());
    namer.noteRun(runInput(), RUN);
    await settle();

    expect(fake.stored).toHaveLength(1);
  });

  it('names each session once, however many events arrive', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    namer.handleEvent(sessionStarted());
    namer.noteRun(runInput(), RUN);
    await settle();

    expect(fake.suggested).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Declining                                                                  */
/* -------------------------------------------------------------------------- */

describe('declining to name', () => {
  it('ignores a resumed run, which is not a first message', async () => {
    // Turn two of a conversation. Naming here would spend on every turn and
    // could overwrite a title the user typed.
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput({ resumeSessionId: 'earlier' as SessionId }), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(0);
    expect(fake.stored).toHaveLength(0);
  });

  it('ignores a fork, whose title belongs to the session it came from', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(
      runInput({ resumeSessionId: 'earlier' as SessionId, forkSession: true }),
      RUN,
    );
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(0);
  });

  it('ignores an empty prompt', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput({ prompt: '   \n ' }), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(0);
  });

  it('spends nothing on a provider that cannot store the answer', async () => {
    // Codex today: it can run a model but has no way to write a thread name, so
    // generating one would be paying for a string with nowhere to go.
    const fake = new FakeAdapter({ canStore: false });
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(0);
  });

  it('does nothing for a provider that cannot generate one', async () => {
    const fake = new FakeAdapter({ canSuggest: false });
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.stored).toHaveLength(0);
  });

  it('does nothing when the host cannot plan a naming call', async () => {
    // No tiered model in the catalogue: `lowestTierModel` answered nothing, and
    // guessing would bill a frontier model.
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter, { plan: () => null });

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(0);
  });

  it('leaves the session alone when the model declines to name it', async () => {
    const fake = new FakeAdapter();
    fake.title = null;
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    // `null` is "no name", not a failure: the session keeps the provider's own
    // summary or its first prompt.
    expect(fake.stored).toHaveLength(0);
  });

  it('forgets a run that ended without ever reporting a session', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(runEnded());
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

describe('failing quietly', () => {
  it('retries the write once, for the file the provider had not finished creating', async () => {
    const fake = new FakeAdapter();
    fake.failStores = 1;
    const onError = vi.fn();
    const namer = makeNamer(fake.adapter, { onError });

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.stored).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a write that failed twice, and does not throw', async () => {
    const fake = new FakeAdapter();
    fake.failStores = 2;
    const onError = vi.fn();
    const namer = makeNamer(fake.adapter, { onError });

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toEqual({ runId: RUN, sessionId: SESSION });
  });

  it('never throws out of the event feed, whatever the adapter does', async () => {
    const fake = new FakeAdapter();
    fake.suggestError = new Error('the CLI is not installed');
    const namer = makeNamer(fake.adapter, { onError: vi.fn() });

    // `handleEvent` is called from the run registry's fan-out. An exception
    // here would reach a subscriber loop that is delivering to the renderer.
    expect(() => {
      namer.noteRun(runInput(), RUN);
      namer.handleEvent(sessionStarted());
    }).not.toThrow();
    await settle();
  });

  it('does nothing at all when no adapter is registered', async () => {
    const namer = makeNamer(undefined);
    expect(() => {
      namer.noteRun(runInput(), RUN);
      namer.handleEvent(sessionStarted());
    }).not.toThrow();
    await settle();
  });
});

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

describe('dispose', () => {
  it('stops taking work and resolves', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    await namer.dispose();
    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    expect(fake.suggested).toHaveLength(0);
  });

  it('tells an in-flight naming call to abandon itself', async () => {
    const fake = new FakeAdapter();
    const namer = makeNamer(fake.adapter);

    namer.noteRun(runInput(), RUN);
    namer.handleEvent(sessionStarted());
    await settle();

    const signal = fake.suggested[0]?.abortSignal;
    expect(signal?.aborted).toBe(false);
    await namer.dispose();
    // A title is not worth holding a subprocess open through a quit.
    expect(signal?.aborted).toBe(true);
  });
});
