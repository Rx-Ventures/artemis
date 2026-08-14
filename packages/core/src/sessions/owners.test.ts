/**
 * Which account a session ran under, when the store cannot say.
 *
 * The subject is a shared `projects/`: symlinked from every profile into the
 * user's own `~/.claude` so history stops splitting per account. It works, and
 * it costs the one fact the sidebar's account marker is for. A transcript found
 * under `p2/projects/` used to *be* `p2`'s; once the directory is one directory,
 * being found there says nothing, and the adapter can only pick a sharer and
 * flag the pick. This class is where the answer actually comes from — Artemis
 * writing down what it knew at the moment it started the run.
 *
 * Real files, in a real temporary directory, for the reason the sibling
 * `main/sharedConfig.test.ts` gives about symlinks: the behaviour under test is
 * "survives being written and read back", and a faked `fs` would only confirm
 * that the author's model of `fs` agrees with itself. The write is
 * temp-then-rename and the read tolerates a half-edited document; neither claim
 * means anything against a stub.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  AgentEvent,
  ProfileId,
  RunId,
  RunInput,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';

import { attributeSession, SESSION_OWNERS_FILE, SessionOwners } from './owners.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'artemis-owners-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A ledger over the temporary directory, with failures surfaced rather than swallowed. */
function ledger(): { owners: SessionOwners; errors: unknown[] } {
  const errors: unknown[] = [];
  const owners = new SessionOwners({
    userDataDir: dir,
    onError: (error) => errors.push(error),
  });
  return { owners, errors };
}

function runInput(profileId: string, overrides: Partial<RunInput> = {}): RunInput {
  return {
    providerId: 'claude',
    profileId: profileId as ProfileId,
    cwd: '/code/api',
    prompt: 'go',
    ...overrides,
  } as RunInput;
}

function started(runId: string, sessionId: string): AgentEvent {
  return {
    type: 'session.started',
    runId: runId as RunId,
    seq: 0,
    ts: 1_000,
    sessionId: sessionId as SessionId,
    providerId: 'claude',
    cwd: '/code/api',
  } as AgentEvent;
}

function ended(runId: string, sessionId?: string): AgentEvent {
  return {
    type: 'run.end',
    runId: runId as RunId,
    seq: 9,
    ts: 2_000,
    reason: 'completed',
    ...(sessionId === undefined ? {} : { sessionId: sessionId as SessionId }),
  } as AgentEvent;
}

/** The document as it is on disk, which is the only copy that survives a restart. */
async function persisted(): Promise<Record<string, { profileId: string }>> {
  const text = await readFile(path.join(dir, SESSION_OWNERS_FILE), 'utf8');
  return (JSON.parse(text) as { sessions: Record<string, { profileId: string }> }).sessions;
}

describe('recording what a run knew', () => {
  it('claims the session a run opened for the account it ran under', async () => {
    const { owners } = ledger();

    owners.noteRun(runInput('work'), 'r1' as RunId);
    owners.handleEvent(started('r1', 's1'));
    await owners.flush();

    expect(await owners.ownerOf('s1' as SessionId)).toBe('work');
  });

  it('survives a restart, which is the whole point of writing it down', async () => {
    const first = ledger();
    first.owners.noteRun(runInput('work-max'), 'r1' as RunId);
    first.owners.handleEvent(started('r1', 's1'));
    await first.owners.flush();

    // A second instance over the same directory, as the next launch is.
    const second = ledger();

    expect(await second.owners.ownerOf('s1' as SessionId)).toBe('work-max');
    expect(second.errors).toEqual([]);
  });

  it('records a session a run only reported on its way out', async () => {
    const { owners } = ledger();

    // No `session.started` at all. A transport that reports the pair only at
    // the end, or an interrupt after the CLI had already written the file,
    // would otherwise leave a transcript on disk with nothing recorded for it.
    owners.noteRun(runInput('work'), 'r1' as RunId);
    owners.handleEvent(ended('r1', 's1'));
    await owners.flush();

    expect(await owners.ownerOf('s1' as SessionId)).toBe('work');
  });

  it('claims a session reported before its run was registered', async () => {
    const { owners } = ledger();

    // The race `SessionNamer` closes from the other side: the registry starts
    // pumping events the moment the adapter returns, and the host cannot call
    // `noteRun` until that same call resolves.
    owners.handleEvent(started('r1', 's1'));
    owners.noteRun(runInput('storrence'), 'r1' as RunId);
    await owners.flush();

    expect(await owners.ownerOf('s1' as SessionId)).toBe('storrence');
  });

  it('leaves a run that ended without ever naming a session unrecorded', async () => {
    const { owners } = ledger();

    owners.noteRun(runInput('work'), 'r1' as RunId);
    owners.handleEvent(ended('r1'));
    await owners.flush();

    expect(await owners.all()).toEqual(new Map());
  });

  it('moves the claim when the conversation is resumed on another account', async () => {
    const { owners } = ledger();
    owners.noteRun(runInput('work'), 'r1' as RunId);
    owners.handleEvent(started('r1', 's1'));
    await owners.flush();

    // Not drift, and not a conflict to refuse: with the store shared, resuming
    // under another account genuinely moves which one continues the
    // conversation and is billed for it. The row should name the one that pays
    // next, which is this one.
    owners.noteRun(runInput('work-max', { resumeSessionId: 's1' as SessionId }), 'r2' as RunId);
    owners.handleEvent(started('r2', 's1'));
    await owners.flush();

    expect(await owners.ownerOf('s1' as SessionId)).toBe('work-max');
    expect(Object.keys(await persisted())).toEqual(['s1']);
  });

  it('keeps every session of a long conversation apart', async () => {
    const { owners } = ledger();

    owners.noteRun(runInput('work'), 'r1' as RunId);
    owners.handleEvent(started('r1', 's1'));
    owners.noteRun(runInput('storrence'), 'r2' as RunId);
    owners.handleEvent(started('r2', 's2'));
    await owners.flush();

    const all = await owners.all();
    expect(all.get('s1' as SessionId)).toBe('work');
    expect(all.get('s2' as SessionId)).toBe('storrence');
  });
});

describe('what it says when it does not know', () => {
  it('answers nothing for a session it has never seen', async () => {
    const { owners } = ledger();

    // The ordinary state for history that predates the ledger, and it means
    // "not known" rather than "not owned" — the caller shows no account instead
    // of guessing one.
    expect(await owners.ownerOf('never-heard-of-it' as SessionId)).toBeUndefined();
  });

  it('starts empty rather than throwing when there is no file yet', async () => {
    const { owners, errors } = ledger();

    expect(await owners.all()).toEqual(new Map());
    // A first run is not a failure and is not reported as one.
    expect(errors).toEqual([]);
  });

  it('keeps the readable entries of a hand-edited document', async () => {
    await writeFile(
      path.join(dir, SESSION_OWNERS_FILE),
      JSON.stringify({
        version: 1,
        sessions: {
          s1: { profileId: 'work', seenAt: 5 },
          s2: { profileId: '', seenAt: 5 },
          s3: 'nonsense',
          s4: { profileId: 'storrence' },
        },
      }),
      'utf8',
    );
    const { owners, errors } = ledger();

    // One bad entry must not cost every other label — the file is plaintext in
    // a directory the user can open, and a stray comma is not a reason to
    // forget which account owns anything.
    const all = await owners.all();
    expect([...all.keys()].sort()).toEqual(['s1', 's4']);
    expect(all.get('s4' as SessionId)).toBe('storrence');
    expect(errors).toEqual([]);
  });

  it('reports a document that is not JSON at all, and carries on', async () => {
    await writeFile(path.join(dir, SESSION_OWNERS_FILE), 'not json {{{', 'utf8');
    const { owners, errors } = ledger();

    expect(await owners.all()).toEqual(new Map());
    // Reported, unlike a missing file: this one is a real fault and the log is
    // the only place it can surface.
    expect(errors.length).toBe(1);

    // And still usable — a ledger that cannot be read is not a ledger that
    // cannot be written.
    owners.noteRun(runInput('work'), 'r1' as RunId);
    owners.handleEvent(started('r1', 's1'));
    await owners.flush();
    expect(await owners.ownerOf('s1' as SessionId)).toBe('work');
  });
});

describe('putting the reading back on a listing', () => {
  /** A row out of a store three profiles reach, with the adapter's pick on it. */
  const shared = (): SessionSummary =>
    ({
      id: 's1',
      title: 'Adapter seam',
      cwd: '/code/api',
      updatedAt: 10,
      providerId: 'claude',
      profileId: 'p1',
      alsoInProfiles: ['p2', 'p3'],
      profileIsUnknown: true,
    }) as SessionSummary;

  const ledgerOf = (entries: Record<string, string>): ReadonlyMap<SessionId, ProfileId> =>
    new Map(Object.entries(entries) as [SessionId, ProfileId][]);

  it('names the recorded account and re-sorts the rest into the sharers', () => {
    const result = attributeSession(shared(), ledgerOf({ s1: 'p3' }));

    expect(result.profileId).toBe('p3');
    // The full set is unchanged — the same three profiles reach the same store.
    // Only which of them is *named* moved.
    expect([...(result.alsoInProfiles ?? [])].sort()).toEqual(['p1', 'p2']);
    // Absent, not false: this is now a fact, and the sidebar draws the badge.
    expect('profileIsUnknown' in result).toBe(false);
  });

  it('leaves an unrecorded row exactly as the adapter produced it', () => {
    const before = shared();
    const result = attributeSession(before, ledgerOf({ 'some-other': 'p3' }));

    // Still flagged, so the sidebar still shows no account. Guessing here is
    // the failure the whole feature exists to stop.
    expect(result).toEqual(before);
    expect(result.profileIsUnknown).toBe(true);
  });

  it('ignores a recorded account that no longer reaches this store', () => {
    // `p9` ran it once, and has since been re-pointed or un-shared. Naming it
    // would aim a resume at a config directory the transcript is not in.
    const result = attributeSession(shared(), ledgerOf({ s1: 'p9' }));

    expect(result.profileId).toBe('p1');
    expect(result.profileIsUnknown).toBe(true);
  });

  it('does not touch a row from a store only one profile reaches', () => {
    const solo = {
      id: 's9',
      title: 'Private',
      cwd: '/code/api',
      updatedAt: 10,
      providerId: 'claude',
      profileId: 'p2',
    } as SessionSummary;

    // Its `profileId` is a fact from the filesystem. A ledger entry that
    // disagreed would be the ledger being stale, not the directory being wrong.
    expect(attributeSession(solo, ledgerOf({ s9: 'p3' }))).toEqual(solo);
  });
});

describe('forgetting a deleted account', () => {
  it('drops that account’s claims and leaves the rest', async () => {
    const { owners } = ledger();
    owners.noteRun(runInput('work'), 'r1' as RunId);
    owners.handleEvent(started('r1', 's1'));
    owners.noteRun(runInput('storrence'), 'r2' as RunId);
    owners.handleEvent(started('r2', 's2'));
    await owners.flush();

    await owners.forget(['work' as ProfileId]);

    // Stale claims are inert on their own, but a config directory reused by a
    // new profile would otherwise inherit the old one's.
    expect(await owners.ownerOf('s1' as SessionId)).toBeUndefined();
    expect(await owners.ownerOf('s2' as SessionId)).toBe('storrence');
    expect(Object.keys(await persisted())).toEqual(['s2']);
  });

  it('does nothing, and writes nothing, for an account with no claims', async () => {
    const { owners, errors } = ledger();

    await owners.forget(['never-used' as ProfileId]);

    expect(errors).toEqual([]);
    expect(await owners.all()).toEqual(new Map());
  });
});
