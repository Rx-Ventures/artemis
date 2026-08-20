/**
 * @vitest-environment jsdom
 *
 * A half-written prompt belongs to the conversation it was written to.
 * ============================================================================
 *
 * `draft` lives in the pane, which is right — closing the column beside this one
 * re-parents it in the React tree and component-local text would be thrown away
 * by an action about the *other* conversation. But a pane outlives the
 * conversation in it: clicking a row in the sidebar points the same column at a
 * different session, keeping every field that is about the user's *setup* and
 * dropping every field that is about the conversation. The draft was on the
 * wrong side of that line, and all three failures below are the same fact:
 *
 *  - **It travelled.** Type half a prompt into a new session, click another
 *    conversation, and the text was still sitting in the composer — looking like
 *    something written *there*, and going *there* on Enter. That is a prompt
 *    delivered to a conversation it was never meant for, which is the worst of
 *    the three because nothing about the screen says it happened.
 *  - **It vanished.** When the conversation clicked was one already running in
 *    the background, the column is handed over to *its* pane and the blank one
 *    is retired — with the sentence in it. Enter then did nothing at all,
 *    because by then there was nothing in the field to send.
 *  - **It did not come back.** Nothing kept what was typed at the conversation
 *    being left, so returning to it found an empty composer.
 *
 * What these pin is the rule that replaced it: a started conversation's draft is
 * parked under its session id and handed back on return, and the *unstarted*
 * one — the blank session ⌘N gives you, which has no id until its first prompt
 * lands — follows the column, because there is no conversation for it to follow.
 *
 * Same caveat as the neighbouring files: `renderer/tsconfig.json` excludes test
 * files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Capabilities, ProviderDescriptor, SessionSummary } from '@rx-artemis/protocol';

import { focusedPane, newSession, resumeSession, useApp } from './store';
import { paneState, setPaneState, type Pane } from './pane';
import { seedApp } from './testkit';

const pane = (): Pane => focusedPane();
const draftOf = (of: Pane = pane()): string => paneState(of).draft;

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

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-old',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    title: 'Yesterday',
    updatedAt: 10,
    ...over,
  } as SessionSummary;
}

/** A run this window believes is in flight, so the pane counts as working. */
function liveRun(sessionId: string) {
  return {
    runId: 'run-live',
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

beforeEach(() => {
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
    draft: '',
    parkedDrafts: {},
  });
  useApp.setState({ background: [] });
  pane().transcript.reset();
});

describe('a prompt half-typed into a new session', () => {
  it('does not follow the column into another conversation', () => {
    newSession(pane());
    setPaneState(pane(), { draft: 'the thing I was about to ask' });

    resumeSession(summary());

    // The reported bug. The composer kept the sentence, and Enter would have
    // sent it to `sess-old` — a conversation the user had not typed a word to.
    expect(draftOf()).toBe('');
    expect(paneState(pane()).resumeSessionId).toBe('sess-old');
  });

  it('is still there when the new session comes back', () => {
    newSession(pane());
    setPaneState(pane(), { draft: 'the thing I was about to ask' });

    resumeSession(summary());
    newSession(pane());

    expect(draftOf()).toBe('the thing I was about to ask');
  });

  it('survives the column being handed to a conversation that was running', () => {
    /*
     * The vanishing half, and the one that made Enter do nothing at all.
     * Clicking a row for a conversation already in the background hands the
     * column over to *its* pane and retires the blank one — with whatever was
     * typed into it — so the field the user pressed Enter in was empty by the
     * time they pressed it.
     */
    setPaneState(pane(), { run: liveRun('sess-old'), resumeSessionId: 'sess-old' });
    const working = pane();

    newSession(working);
    setPaneState(pane(), { draft: 'the thing I was about to ask' });
    expect(pane().id).not.toBe(working.id);

    resumeSession(summary());

    // Back in the working conversation, whose own composer is untouched…
    expect(pane().id).toBe(working.id);
    expect(draftOf()).toBe('');

    // …and the sentence is where the person who typed it would look for it.
    newSession(pane());
    expect(draftOf()).toBe('the thing I was about to ask');
  });
});

describe('a prompt half-typed at a conversation', () => {
  it('is handed back when the reader returns to it', () => {
    resumeSession(summary({ id: 'sess-a' }));
    setPaneState(pane(), { draft: 'and another thing' });

    resumeSession(summary({ id: 'sess-b' }));
    expect(draftOf()).toBe('');

    resumeSession(summary({ id: 'sess-a' }));
    expect(draftOf()).toBe('and another thing');
  });

  it('keeps the two conversations’ drafts apart', () => {
    resumeSession(summary({ id: 'sess-a' }));
    setPaneState(pane(), { draft: 'for a' });
    resumeSession(summary({ id: 'sess-b' }));
    setPaneState(pane(), { draft: 'for b' });

    resumeSession(summary({ id: 'sess-a' }));
    expect(draftOf()).toBe('for a');
    resumeSession(summary({ id: 'sess-b' }));
    expect(draftOf()).toBe('for b');
  });

  it('parks nothing for a conversation left with an empty field', () => {
    // Growth is bounded by what was actually typed: there is no difference
    // between "typed nothing" and "was never here", and an entry per session
    // visited would be a map that only grows.
    resumeSession(summary({ id: 'sess-a' }));
    setPaneState(pane(), { draft: '   ' });

    resumeSession(summary({ id: 'sess-b' }));

    expect(paneState(pane()).parkedDrafts).toEqual({});
  });

  it('forgets a draft once it has been sent', () => {
    resumeSession(summary({ id: 'sess-a' }));
    setPaneState(pane(), { draft: 'ask this' });
    // What the composer does on send, before the round trip: the field is
    // cleared, so there is nothing left to park.
    setPaneState(pane(), { draft: '' });

    resumeSession(summary({ id: 'sess-b' }));
    resumeSession(summary({ id: 'sess-a' }));

    expect(draftOf()).toBe('');
  });
});
