/**
 * Resuming a conversation several profiles can reach.
 *
 * A transcript normally lives in exactly one profile's config directory, so
 * `resumeSession` switching the column onto `session.profileId` is not a choice
 * — it is the only account that can read the file. Point two profiles at one
 * store, which is what sharing `projects/` across accounts does, and that stops
 * being true: several can read it, and the adapter names them in
 * `alsoInProfiles`.
 *
 * ## Two shapes, and `profileIsUnknown` is what tells them apart
 *
 * A shared row reaches the renderer in one of two states, and `profileId` means
 * something different in each:
 *
 *  - **`profileIsUnknown: true`** — the adapter had to pick an id and used the
 *    first sharer. Arbitrary. Switching the user's account on the strength of
 *    profile ordering is the silent billing switch the status line exists to
 *    forbid, so the active account keeps the column.
 *  - **flag absent** — `attributeSession` matched the row against the ledger of
 *    runs Artemis drove and wrote back the account it actually ran under. A
 *    fact, and the one the sidebar prints on the row.
 *
 * The bug this file now pins is the second shape being treated as the first.
 * The row said one account, the status line said another, the prompt billed the
 * status line's, and the ledger then moved the badge to match — a conversation
 * that looked like it wandered between accounts by itself (#144, #145).
 *
 * Asserted at ten sharing profiles as well as two, because that is where it was
 * reported from and because the failure gets *more* likely as accounts are
 * added: the odds that the account in use is the one the row names fall with
 * every profile pointed at the same store.
 *
 * The ordinary unshared case is asserted alongside, because the risk in this
 * area is not that sharing misbehaves — it is that the unshared path quietly
 * stops switching profiles when it should.
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

describe('resuming a shared session nothing has attributed', () => {
  it('stays on the active profile when it can reach the transcript', () => {
    resumeSession(summary({ alsoInProfiles: ['p2'], profileIsUnknown: true }));

    // p2 was already active and can read the store, so nothing moves. `p1` on
    // the row is the adapter's pick among the sharers and carries no claim.
    expect(session().activeProfileId).toBe('p2');
    expect(session().resumeSessionId).toBe('sess-1');
  });

  it('says nothing in the transcript when nothing moved', () => {
    resumeSession(summary({ alsoInProfiles: ['p2'], profileIsUnknown: true }));

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

    resumeSession(summary({ profileId: 'p1', alsoInProfiles: ['p2'], profileIsUnknown: true }));

    // p3 cannot read the store at all, so there is no keeping it — the pick is
    // the only account left that can open the transcript.
    expect(session().activeProfileId).toBe('p1');
  });

  it('refuses when every profile that could reach it is gone', () => {
    seedApp({ profiles: [], activeProfileId: null, banners: [] });
    resumeSession(summary());

    expect(session().resumeSessionId).toBeNull();
    expect(useApp.getState().banners.length).toBeGreaterThan(0);
  });
});

/**
 * The attributed shape — `profileId` written back from the ledger, no flag.
 *
 * This is what every row the user has actually opened looks like, so it is the
 * common case rather than a corner of one, and it is where #144 and #145 lived.
 */
describe('resuming a shared session the ledger has attributed', () => {
  it('moves to the account the row names, even though the active one could reach it', () => {
    // p2 is active and shares the store, so the old rule kept it and the status
    // line went on naming p2 under a row labelled p1.
    resumeSession(summary({ profileId: 'p1', alsoInProfiles: ['p2'] }));

    expect(session().activeProfileId).toBe('p1');
    expect(session().resumeSessionId).toBe('sess-1');
  });

  it('says which account it moved to, and why', () => {
    resumeSession(summary({ profileId: 'p1', alsoInProfiles: ['p2'] }));

    expect(noticeText()).toContain('Switched');
    expect(noticeText()).toContain('Personal');
    expect(noticeText()).toContain('the account it last ran on');
  });

  it('stays put when the row already names the active account', () => {
    // The other half: honouring the row must not turn every click into a
    // switch. Resuming your own conversation moves nothing and says nothing.
    resumeSession(summary({ profileId: 'p2', alsoInProfiles: ['p1'] }));

    expect(session().activeProfileId).toBe('p2');
    expect(noticeText()).toBe('');
  });

  it('holds with ten profiles sharing one store', () => {
    // The reported configuration. Every account reaches every transcript, so
    // `canReachSession` is true for all ten and the old rule never switched —
    // which made the bar disagree with the row on nine rows out of ten.
    const ids = Array.from({ length: 10 }, (_, i) => `p${String(i + 1)}`);
    seedApp({
      profiles: ids.map((id) => ({
        id,
        label: `Claude ${id.slice(1)}x`,
        providerId: 'claude' as const,
        configDir: `/u/.c${id}`,
      })),
      activeProfileId: 'p3',
      cwd: '/a',
    });

    // The row the user clicked was last run on p5; they are sitting on p3.
    resumeSession(
      summary({ profileId: 'p5', alsoInProfiles: ids.filter((id) => id !== 'p5') }),
    );

    expect(session().activeProfileId).toBe('p5');
  });

  it('does not re-own the session to whatever account happened to be selected', () => {
    // #145 read from the other end. The badge moved because resuming billed a
    // different account and the ledger recorded that as the new owner; landing
    // on the row's own account is what stops the next listing from moving it.
    const ids = Array.from({ length: 10 }, (_, i) => `p${String(i + 1)}`);
    seedApp({
      profiles: ids.map((id) => ({
        id,
        label: `Claude ${id.slice(1)}x`,
        providerId: 'claude' as const,
        configDir: `/u/.c${id}`,
      })),
      activeProfileId: 'p7',
      cwd: '/a',
    });

    const row = summary({ profileId: 'p2', alsoInProfiles: ids.filter((id) => id !== 'p2') });
    resumeSession(row);

    expect(session().activeProfileId).toBe(row.profileId);
  });
});
