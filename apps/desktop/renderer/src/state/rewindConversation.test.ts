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

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async () => ({ ok: true, value: { events: [], hasMore: false } }),
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
  seed();
});

describe('rewindConversationTo', () => {
  it('cuts the transcript, refills the composer, and arms the next run', () => {
    const cut = twoTurns();
    rewindConversationTo(cut, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBe('uuid-2');
    expect(paneState(pane()).forkOnResume).toBe(false);
    expect(paneState(pane()).draft).toBe('second ask');
    const texts = pane().transcript
      .getListSnapshot()
      .map((id) => (pane().transcript.getItem(id) as { text?: string } | undefined)?.text);
    expect(texts).toEqual(['first ask', 'first answer']);
  });

  it('forks with the same cut when asked to', () => {
    rewindConversationTo(twoTurns(), { fork: true }, pane());
    expect(paneState(pane()).forkOnResume).toBe(true);
    expect(paneState(pane()).rewindToMessageId).toBe('uuid-2');
  });

  it('sends the truncation with the next prompt, exactly once', async () => {
    rewindConversationTo(twoTurns(), { fork: false }, pane());

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

  it('refuses without the capability, without touching anything', () => {
    seed({ rewind: false });
    const cut = twoTurns();
    const before = pane().transcript.getListSnapshot();

    rewindConversationTo(cut, { fork: false }, pane());

    expect(paneState(pane()).rewindToMessageId).toBeNull();
    expect(paneState(pane()).draft).toBe('');
    expect(pane().transcript.getListSnapshot()).toBe(before);
  });

  it('refuses while a run is live', () => {
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

    rewindConversationTo(cut, { fork: false }, pane());
    expect(paneState(pane()).rewindToMessageId).toBeNull();
  });

  it('refuses a message the provider has not filed yet', () => {
    twoTurns();
    const pendingId = pane().transcript.pushUserMessage('not yet echoed');
    pane().transcript.flush();

    rewindConversationTo(pendingId, { fork: false }, pane());
    expect(paneState(pane()).rewindToMessageId).toBeNull();
  });
});
