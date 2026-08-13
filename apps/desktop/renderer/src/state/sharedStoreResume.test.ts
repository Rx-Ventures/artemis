/**
 * Resuming a conversation several profiles can reach.
 *
 * A transcript normally lives in exactly one profile's config directory, so
 * `resumeSession` switching the column onto `session.profileId` is not a choice
 * — it is the only account that can read the file. Point two profiles at one
 * store, which is what sharing `projects/` across accounts does, and that stops
 * being true: several can read it, the adapter names them in `alsoInProfiles`,
 * and the one that happened to sort first is an arbitrary winner rather than a
 * fact about the conversation.
 *
 * What is asserted here is that the arbitrary winner does not get to move the
 * user's account. Switching which account the next prompt bills is the one
 * thing the status line exists to keep answerable, and doing it on the strength
 * of profile ordering would be exactly the silent switch that rule forbids.
 *
 * The ordinary case is asserted alongside, because the risk in this change is
 * not that sharing misbehaves — it is that the unshared path quietly stops
 * switching profiles when it should.
 *
 * Same caveat as `newSession.test.ts`: `renderer/tsconfig.json` excludes test
 * files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@rx-artemis/protocol';

import { canReachSession, focusedPane, resumeSession, useApp } from './store';
import { paneState, setPaneState } from './pane';
import { seedApp } from './testkit';

const pane = () => focusedPane();
const session = () => paneState(pane());

/**
 * Every notice currently in the column's transcript, flattened to one string.
 *
 * Reads through the real accessors rather than a convenience snapshot, because
 * the first version of this file asserted against a `snapshot()` that does not
 * exist — optional-chained, so it produced `[]` and passed against anything.
 */
function noticeText(): string {
  const transcript = pane().transcript;
  // The model batches onto animation frames, so without this the list is still
  // empty on the line after the call and every assertion here would pass by
  // reading nothing.
  transcript.flush();
  return transcript
    .getListSnapshot()
    .map((id) => JSON.stringify(transcript.getItem(id) ?? null))
    .join('\n');
}

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    title: 'One conversation',
    updatedAt: 10,
    ...over,
  } as SessionSummary;
}

beforeEach(() => {
  seedApp({
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.personal' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.work' },
    ],
    activeProviderId: 'claude',
    activeProfileId: 'p2',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
  });
  pane().transcript.reset();
});

describe('canReachSession', () => {
  it('is true for the owner and false for a stranger', () => {
    expect(canReachSession(summary(), 'p1')).toBe(true);
    expect(canReachSession(summary(), 'p2')).toBe(false);
  });

  it('is true for a profile sharing the store', () => {
    expect(canReachSession(summary({ alsoInProfiles: ['p2'] }), 'p2')).toBe(true);
  });
});

describe('resuming a shared session', () => {
  it('stays on the active profile when it can reach the transcript', () => {
    resumeSession(summary({ alsoInProfiles: ['p2'] }));

    // p2 was already active and can read the store, so nothing moves.
    expect(session().activeProfileId).toBe('p2');
    expect(session().resumeSessionId).toBe('sess-1');
  });

  it('says nothing in the transcript when nothing moved', () => {
    resumeSession(summary({ alsoInProfiles: ['p2'] }));

    // The note exists to report a switch. With no switch and no directory
    // change there is nothing to report, and a note saying so would be noise
    // on every click.
    expect(noticeText()).not.toContain('Switched');
    expect(noticeText()).toBe('');
  });

  it('does report the switch when one actually happens', () => {
    // The counterpart to the test above: silence has to mean "nothing moved",
    // not "this stopped reporting".
    resumeSession(summary({ profileId: 'p1', cwd: '/elsewhere' }));

    expect(noticeText()).toContain('Switched');
    expect(noticeText()).toContain('Personal');
  });

  it('falls back to the owner when the active profile cannot reach it', () => {
    setPaneState(pane(), { activeProfileId: 'p2' });
    resumeSession(summary({ profileId: 'p1' }));

    // No sharing: p2 cannot read p1's store, so the switch is forced.
    expect(session().activeProfileId).toBe('p1');
  });

  it('still switches when the session is shared but the active profile is not among them', () => {
    seedApp({
      profiles: [
        { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.personal' },
        { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/u/.work' },
        { id: 'p3', label: 'Other', providerId: 'claude', configDir: '/u/.other' },
      ],
      activeProfileId: 'p3',
    });

    resumeSession(summary({ profileId: 'p1', alsoInProfiles: ['p2'] }));

    expect(session().activeProfileId).toBe('p1');
  });

  it('refuses when every profile that could reach it is gone', () => {
    seedApp({ profiles: [], activeProfileId: null, banners: [] });
    resumeSession(summary());

    expect(session().resumeSessionId).toBeNull();
    expect(useApp.getState().banners.length).toBeGreaterThan(0);
  });
});
