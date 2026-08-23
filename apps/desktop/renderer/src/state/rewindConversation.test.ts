/**
 * @vitest-environment jsdom
 *
 * Winding a conversation back to one of its user messages.
 *
 * The move is one function with a fork flag — see `rewindConversationTo` —
 * and what these pin is the contract around it: the transcript is cut, the
 * message text lands in the composer, the next run carries the truncation
 * request exactly once, and every state that cannot be wound back refuses
 * without side effects.
 *
 * Same caveat as the neighbouring files: `renderer/tsconfig.json` excludes
 * test files, so the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, Capabilities, SessionId } from '@rx-artemis/protocol';

import { focusedPane, rewindConversationTo, submitPrompt } from './store';
import { paneState, setPaneState, type Pane } from './pane';
import { seedApp, ALL_CAPABILITIES } from './testkit';

const pane = (): Pane => focusedPane();

let started: Array<Record<string, unknown>> = [];
/** What the stored session holds, for the lazy anchor resolution. */
let storedEvents: unknown[] = [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async () => ({ ok: true, value: { events: storedEvents, hasMore: false } }),
  },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
  runs: {
    start: async (arg: { input: Record<string, unknown> }) => {
      started.push(arg.input);
      return {
        ok: true,
        value: {
          run: { runId: 'run_new', status: 'running', capabilities: ALL_CAPABILITIES, startedAt: 1 },
        },
      };
    },
  },
};

function seed(over: Partial<Capabilities> = {}): void {
  const capabilities = { ...ALL_CAPABILITIES, ...over };
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/u/.c' }],
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    cwd: '/w',
    run: null,
    resumeSessionId: 'sess-1' as SessionId,
    rewindToMessageId: null,
    forkOnResume: false,
    permissionQueue: [],
    banners: [],
    draft: '',
    parkedDrafts: {},
  });
  pane().transcript.reset();
}

/** Replay two turns so there is history to wind back. */
function twoTurns(): string {
  const events: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>> = [
    { type: 'text.complete', messageId: 'uuid-1', role: 'user', text: 'first ask', replay: true },
    { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'first answer' },
    { type: 'text.complete', messageId: 'uuid-2', role: 'user', text: 'second ask', replay: true },
    { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'second answer' },
  ];
  events.forEach((event, index) => {
    pane().transcript.apply({ ...event, runId: 'history:sess-1', seq: index, ts: 1000 + index } as AgentEvent);
  });
  pane().transcript.flush();
  const ids = pane().transcript.getListSnapshot();
  return ids.find(
    (id) => (pane().transcript.getItem(id) as { text?: string } | undefined)?.text === 'second ask',
  ) as string;
}

beforeEach(() => {
  started = [];
  storedEvents = [];
  seed();
});

describe('rewindConversationTo', () => {
  it('cuts the transcript, refills the composer, and arms the next run', async () => {
    const cut = twoTurns();
    await rewindConversationTo(cut, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBe('uuid-2');
    expect(paneState(pane()).forkOnResume).toBe(false);
    expect(paneState(pane()).draft).toBe('second ask');
    const texts = pane().transcript
      .getListSnapshot()
      .map((id) => (pane().transcript.getItem(id) as { text?: string } | undefined)?.text);
    expect(texts).toEqual(['first ask', 'first answer']);
  });

  it('forks with the same cut when asked to', async () => {
    await rewindConversationTo(twoTurns(), { fork: true }, pane());
    expect(paneState(pane()).forkOnResume).toBe(true);
    expect(paneState(pane()).rewindToMessageId).toBe('uuid-2');
  });

  it('sends the truncation with the next prompt, exactly once', async () => {
    await rewindConversationTo(twoTurns(), { fork: false }, pane());

    expect(await submitPrompt('say it differently', undefined, pane())).toBe(true);
    expect(started[0]).toMatchObject({
      resumeSessionId: 'sess-1',
      rewindToMessageId: 'uuid-2',
    });

    // One-shot: the prompt after the rewound one continues the conversation
    // the rewind produced, it does not re-truncate it.
    expect(paneState(pane()).rewindToMessageId).toBeNull();
    setPaneState(pane(), { run: null });
    await submitPrompt('and carry on', undefined, pane());
    expect(started[1]).not.toHaveProperty('rewindToMessageId');
  });

  it('refuses without the capability, without touching anything', async () => {
    seed({ rewind: false });
    const cut = twoTurns();
    const before = pane().transcript.getListSnapshot();

    await rewindConversationTo(cut, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBeNull();
    expect(paneState(pane()).draft).toBe('');
    expect(pane().transcript.getListSnapshot()).toBe(before);
  });

  it('refuses while a run is live', async () => {
    const cut = twoTurns();
    setPaneState(pane(), {
      run: {
        runId: 'run_live',
        status: 'running',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/w',
        capabilities: ALL_CAPABILITIES,
        startedAt: 1,
        permissionMode: 'default',
      },
    } as never);

    await rewindConversationTo(cut, { fork: false }, pane());
    expect(paneState(pane()).rewindToMessageId).toBeNull();
  });

  it('refuses a message still pending, before any lookup', async () => {
    twoTurns();
    const pendingId = pane().transcript.pushUserMessage('not yet delivered');
    pane().transcript.flush();

    await rewindConversationTo(pendingId, { fork: false }, pane());
    expect(paneState(pane()).rewindToMessageId).toBeNull();
  });

  it('resolves the provider id from the stored session for a live-typed row', async () => {
    // The CLI never echoes a live prompt back, so a row typed this window
    // session has no provider uuid — the control reads the stored chain and
    // matches the row by tail-anchored ordinal instead.
    twoTurns();
    const typedId = pane().transcript.pushUserMessage('typed here');
    pane().transcript.confirmUserMessage(typedId);
    pane().transcript.flush();

    storedEvents = [
      { type: 'text.complete', runId: 'r', seq: 0, ts: 1, messageId: 'uuid-1', role: 'user', text: 'first ask', replay: true },
      { type: 'text.complete', runId: 'r', seq: 1, ts: 2, messageId: 'uuid-2', role: 'user', text: 'second ask', replay: true },
      { type: 'text.complete', runId: 'r', seq: 2, ts: 3, messageId: 'uuid-9', role: 'user', text: 'typed here', replay: true },
    ];

    await rewindConversationTo(typedId, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBe('uuid-9');
    expect(paneState(pane()).draft).toBe('typed here');
  });

  it('refuses when the stored chain does not hold the message yet', async () => {
    twoTurns();
    const typedId = pane().transcript.pushUserMessage('typed here');
    pane().transcript.confirmUserMessage(typedId);
    pane().transcript.flush();
    storedEvents = [];
    const before = pane().transcript.getListSnapshot();

    await rewindConversationTo(typedId, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBeNull();
    expect(pane().transcript.getListSnapshot()).toBe(before);
  });

  it('refuses when the stored text disagrees with the screen', async () => {
    twoTurns();
    const typedId = pane().transcript.pushUserMessage('typed here');
    pane().transcript.confirmUserMessage(typedId);
    pane().transcript.flush();
    storedEvents = [
      { type: 'text.complete', runId: 'r', seq: 0, ts: 1, messageId: 'uuid-9', role: 'user', text: 'something else entirely', replay: true },
    ];

    await rewindConversationTo(typedId, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBeNull();
  });

  it('never sends a registry retention id to the provider', async () => {
    // A row claimed under `${runId}:prompt:${n}` — the dedup identity — is not
    // a provider id; the anchor must come from the stored chain.
    twoTurns();
    const claimedId = pane().transcript.pushUserMessage('typed here', undefined, 'run_x:prompt:1');
    pane().transcript.confirmUserMessage(claimedId);
    pane().transcript.flush();
    storedEvents = [
      { type: 'text.complete', runId: 'r', seq: 0, ts: 1, messageId: 'uuid-1', role: 'user', text: 'first ask', replay: true },
      { type: 'text.complete', runId: 'r', seq: 1, ts: 2, messageId: 'uuid-2', role: 'user', text: 'second ask', replay: true },
      { type: 'text.complete', runId: 'r', seq: 2, ts: 3, messageId: 'uuid-9', role: 'user', text: 'typed here', replay: true },
    ];

    await rewindConversationTo(claimedId, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBe('uuid-9');
  });
});
