/**
 * The routine host: appointments kept, missed, and made up.
 *
 * Driven the way `server.test.ts` drives its host — a fake `EngineHost`, a
 * real temp data directory, broadcasts captured — plus fake timers, because
 * the thing under test here is *when*: the minute tick, the overlap guard,
 * and the one-catch-up-after-sleep rule. Time is moved with
 * `vi.setSystemTime` + `advanceTimersByTimeAsync`, never waited on.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, RoutinesState, RunInput } from '@rx-artemis/protocol';

import type { EngineHost } from './engine.js';
import { createRoutineHost, readRoutines, ROUTINES_CONFIG_FILE, type RoutineHost } from './routines.js';

/** Tuesday 2026-03-03, 08:59:30 local — thirty seconds shy of a 09:00 firing. */
const almostNine = new Date(2026, 2, 3, 8, 59, 30);

interface FakeEngine {
  readonly started: RunInput[];
  emit(event: Partial<AgentEvent>): void;
  host: EngineHost;
}

function fakeEngine(): FakeEngine {
  const started: RunInput[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  const engine = {
    startRun: async (input: RunInput) => {
      started.push(input);
      return {
        runId: input.runId ?? 'run-minted',
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'working',
        startedAt: Date.now(),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
    },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listRuns: async () => [],
  };
  return {
    started,
    emit: (event) => {
      for (const listener of listeners) listener(event as AgentEvent);
    },
    host: { ready: true, require: () => engine } as unknown as EngineHost,
  };
}

let dirs: string[] = [];
let hosts: RoutineHost[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-routines-'));
  dirs.push(dir);
  return dir;
}

interface Harness {
  readonly host: RoutineHost;
  readonly engine: FakeEngine;
  readonly pushed: RoutinesState[];
  readonly notified: { title: string; body: string }[];
  readonly dir: string;
}

async function makeHost(dir?: string): Promise<Harness> {
  const dataDir = dir ?? (await tempDir());
  const engine = fakeEngine();
  const pushed: RoutinesState[] = [];
  const notified: { title: string; body: string }[] = [];
  const host = createRoutineHost({
    engine: engine.host,
    userDataDir: dataDir,
    broadcast: (state) => pushed.push(state),
    notify: (title, body) => notified.push({ title, body }),
  });
  hosts.push(host);
  return { host, engine, pushed, notified, dir: dataDir };
}

const DRAFT = {
  name: 'Morning triage',
  instructions: 'Read the overnight alerts and summarise.',
  cwd: '/tmp',
  profileId: 'prof-1',
  providerId: 'claude' as const,
  schedule: { kind: 'daily' as const, at: '09:00' },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(almostNine);
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('the file', () => {
  it('round-trips a routine through disk', async () => {
    const first = await makeHost();
    await first.host.start();
    await first.host.create(DRAFT);

    const raw = JSON.parse(await readFile(join(first.dir, ROUTINES_CONFIG_FILE), 'utf8'));
    expect(readRoutines(raw.routines)).toHaveLength(1);

    const second = await makeHost(first.dir);
    await second.host.start();
    expect(second.host.state().routines[0]).toMatchObject({
      name: 'Morning triage',
      schedule: { kind: 'daily', at: '09:00' },
      paused: false,
    });
  });

  it('drops rows it cannot read instead of failing the list', () => {
    expect(
      readRoutines([
        { id: 'ok', ...DRAFT, createdAt: 1, paused: false, history: [] },
        { id: 'no-cwd', ...DRAFT, cwd: 'relative/path', createdAt: 1, history: [] },
        { id: 'bad-schedule', ...DRAFT, schedule: { kind: 'daily', at: '25:00' }, createdAt: 1, history: [] },
        'nonsense',
        { id: 'ok', ...DRAFT, createdAt: 2, history: [] },
      ]).map((routine) => routine.id),
    ).toEqual(['ok']);
  });

  it('settles a running row from a dead launch as interrupted', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, ROUTINES_CONFIG_FILE),
      JSON.stringify({
        routines: [
          {
            id: 'r1',
            ...DRAFT,
            createdAt: almostNine.getTime(),
            paused: false,
            lastFiredAt: almostNine.getTime(),
            history: [{ firedAt: 1, runId: 'run-dead', outcome: 'running' }],
          },
        ],
      }),
    );

    const { host } = await makeHost(dir);
    await host.start();
    expect(host.state().routines[0]?.history[0]).toMatchObject({ outcome: 'interrupted' });
  });
});

describe('the tick', () => {
  it('fires a due routine as an ordinary run, tagged with the routine id', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    await host.create(DRAFT);

    await vi.advanceTimersByTimeAsync(31_000); // cross 09:00:00, land on the tick

    expect(engine.started).toHaveLength(1);
    expect(engine.started[0]).toMatchObject({
      prompt: DRAFT.instructions,
      cwd: '/tmp',
      profileId: 'prof-1',
      providerId: 'claude',
    });
    expect(engine.started[0]?.metadata?.['routineId']).toBeDefined();

    const state = host.state();
    expect(state.routines[0]?.running).toBe(true);
    expect(state.routines[0]?.history[0]).toMatchObject({ outcome: 'running' });
  });

  it('does not fire a paused routine', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    const state = await host.create({ ...DRAFT, paused: true });

    await vi.advanceTimersByTimeAsync(31_000);

    expect(engine.started).toHaveLength(0);
    // And the pause is visible: no next appointment is promised.
    expect(state.routines[0]?.nextFireAt).toBeUndefined();
  });

  it('settles the ledger and notifies when the run ends', async () => {
    const { host, engine, notified } = await makeHost();
    await host.start();
    await host.create(DRAFT);
    await vi.advanceTimersByTimeAsync(31_000);

    const runId = engine.started[0]?.runId as string;
    engine.emit({ type: 'session.started', runId, sessionId: 'sess-1' } as Partial<AgentEvent>);
    engine.emit({ type: 'run.end', runId, reason: 'completed' } as Partial<AgentEvent>);

    const row = host.state().routines[0]?.history[0];
    expect(row).toMatchObject({ outcome: 'completed', sessionId: 'sess-1' });
    expect(host.state().routines[0]?.running).toBe(false);
    expect(notified[0]).toMatchObject({ title: 'Morning triage' });
  });

  it('records an error end as one, with the reason kept', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    await host.create(DRAFT);
    await vi.advanceTimersByTimeAsync(31_000);

    const runId = engine.started[0]?.runId as string;
    engine.emit({ type: 'run.end', runId, reason: 'budget_exceeded' } as Partial<AgentEvent>);

    expect(host.state().routines[0]?.history[0]).toMatchObject({
      outcome: 'error',
      endReason: 'budget_exceeded',
    });
  });

  it('skips with a reason instead of stacking a second copy', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    await host.create({ ...DRAFT, schedule: { kind: 'hourly', minute: 0 } });

    await vi.advanceTimersByTimeAsync(31_000); // 09:00 fires
    expect(engine.started).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000); // 10:00 arrives, run still going

    expect(engine.started).toHaveLength(1);
    const rows = host.state().routines[0]?.history ?? [];
    expect(rows[0]).toMatchObject({ outcome: 'skipped', skipReason: 'overlap' });
    expect(rows[1]).toMatchObject({ outcome: 'running' });
  });
});

describe('sleep and relaunch', () => {
  it('makes up the newest missed appointment once, and lets the rest go', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    await host.create({ ...DRAFT, schedule: { kind: 'hourly', minute: 0 } });

    await vi.advanceTimersByTimeAsync(31_000); // 09:00 fires normally
    const first = engine.started[0]?.runId as string;
    engine.emit({ type: 'run.end', runId: first, reason: 'completed' } as Partial<AgentEvent>);

    // The lid closes at ~09:01 and opens at 13:30:10 — 10:00 through 13:00
    // all missed. The pending tick fires hours late, which is the signal.
    vi.setSystemTime(new Date(2026, 2, 3, 13, 30, 10));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(engine.started).toHaveLength(2);
    const row = host.state().routines[0]?.history[0];
    expect(row).toMatchObject({ outcome: 'running', catchUp: true });
  });

  it('does not double-fire when the wake lands on a due minute', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    await host.create({ ...DRAFT, schedule: { kind: 'hourly', minute: 0 } });

    await vi.advanceTimersByTimeAsync(31_000);
    const first = engine.started[0]?.runId as string;
    engine.emit({ type: 'run.end', runId: first, reason: 'completed' } as Partial<AgentEvent>);

    // The pending tick has ~59s of fake delay left, so waking the clock here
    // lands it inside 13:00 exactly — the due minute itself.
    vi.setSystemTime(new Date(2026, 2, 3, 12, 59, 30));
    await vi.advanceTimersByTimeAsync(60_000);

    // One firing for 13:00, not a 12:00 catch-up beside it.
    expect(engine.started).toHaveLength(2);
    expect(host.state().routines[0]?.history[0]).toMatchObject({ outcome: 'running' });
    expect(host.state().routines[0]?.history[0]?.catchUp).toBeUndefined();
  });

  it('fires one make-up on launch for an appointment missed while closed', async () => {
    const first = await makeHost();
    await first.host.start();
    await first.host.create(DRAFT);
    await first.host.dispose();

    // Relaunch the next day at 09:30 — yesterday's 09:00 was kept (the app
    // was open), today's was missed while closed.
    vi.setSystemTime(new Date(2026, 2, 4, 9, 30, 0));
    const second = await makeHost(first.dir);
    await second.host.start();

    expect(second.engine.started).toHaveLength(1);
    expect(second.host.state().routines[0]?.history[0]).toMatchObject({
      outcome: 'running',
      catchUp: true,
    });
  });

  it('fires nothing on a relaunch whose appointments were all kept', async () => {
    const first = await makeHost();
    await first.host.start();
    await first.host.create(DRAFT);
    await vi.advanceTimersByTimeAsync(31_000); // 09:00 kept
    const run = first.engine.started[0]?.runId as string;
    first.engine.emit({ type: 'run.end', runId: run, reason: 'completed' } as Partial<AgentEvent>);
    await first.host.dispose();

    vi.setSystemTime(new Date(2026, 2, 3, 9, 45, 0)); // same morning, later
    const second = await makeHost(first.dir);
    await second.host.start();

    expect(second.engine.started).toHaveLength(0);
  });
});

describe('run now', () => {
  it('fires immediately, pause and schedule notwithstanding', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    const state = await host.create({ ...DRAFT, paused: true });
    const id = state.routines[0]?.id as string;

    await host.runNow(id);

    expect(engine.started).toHaveLength(1);
  });

  it('still refuses to stack a second copy', async () => {
    const { host, engine } = await makeHost();
    await host.start();
    const state = await host.create(DRAFT);
    const id = state.routines[0]?.id as string;

    await host.runNow(id);
    await host.runNow(id);

    expect(engine.started).toHaveLength(1);
    expect(host.state().routines[0]?.history[0]).toMatchObject({
      outcome: 'skipped',
      skipReason: 'overlap',
    });
  });
});

describe('edits', () => {
  it('patches fields and clears the model with the empty string', async () => {
    const { host } = await makeHost();
    await host.start();
    const created = await host.create({ ...DRAFT, model: 'opus' });
    const id = created.routines[0]?.id as string;

    const patched = await host.update(id, { name: 'Evening triage', model: '' });

    expect(patched.routines[0]).toMatchObject({ name: 'Evening triage' });
    expect(patched.routines[0]?.model).toBeUndefined();
  });

  it('refuses an edit that would break the routine, keeping the original', async () => {
    const { host } = await makeHost();
    await host.start();
    const created = await host.create(DRAFT);
    const id = created.routines[0]?.id as string;

    const after = await host.update(id, { schedule: { kind: 'daily', at: 'nonsense' } });

    expect(after.routines[0]?.schedule).toEqual({ kind: 'daily', at: '09:00' });
  });

  it('removes a routine', async () => {
    const { host } = await makeHost();
    await host.start();
    const created = await host.create(DRAFT);
    const removed = await host.remove(created.routines[0]?.id as string);
    expect(removed.routines).toHaveLength(0);
  });
});
