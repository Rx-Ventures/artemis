/**
 * The session-lifecycle log writer: shape, redaction, and refusal to throw.
 *
 * Real files in a real temporary directory, for the same reason the owners
 * ledger's tests use them: the behaviour under test is "survives being written
 * and read back as JSONL", and the crash-survival claim rests on the append
 * actually reaching the filesystem before `record` returns.
 *
 * The redaction tests are the ones this file exists for. The log is written
 * on machines whose transcripts are already shared plaintext; the guarantee
 * that no prompt text, message content or token can reach it must hold at
 * runtime against events the type system never saw.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SESSION_LIFECYCLE_LOG_FILE, SessionLifecycleLog } from './lifecycleLog.js';
import type { SessionLifecycleEvent } from './lifecycleLog.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'artemis-lifecycle-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (): string => path.join(dir, SESSION_LIFECYCLE_LOG_FILE);

function log(options: { now?: () => number; file?: string } = {}): {
  lifecycle: SessionLifecycleLog;
  errors: unknown[];
} {
  const errors: unknown[] = [];
  const lifecycle = new SessionLifecycleLog({
    file: options.file ?? file(),
    now: options.now ?? (() => 1_700_000_000_000),
    onError: (error) => errors.push(error),
  });
  return { lifecycle, errors };
}

async function lines(): Promise<Record<string, unknown>[]> {
  const text = await readFile(file(), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('SessionLifecycleLog', () => {
  it('writes one JSONL line per event, stamped and id-complete', async () => {
    const { lifecycle, errors } = log();

    lifecycle.record({
      kind: 'run.started',
      runId: 'run-1',
      profileId: 'work-max',
      providerId: 'claude',
      cwd: '/code/api',
      resumeSessionId: 'session-prior',
    });
    lifecycle.record({
      kind: 'run.ended',
      runId: 'run-1',
      profileId: 'work-max',
      providerId: 'claude',
      cwd: '/code/api',
      sessionId: 'session-abc',
      reason: 'completed',
      synthesized: false,
    });

    expect(errors).toEqual([]);
    expect(await lines()).toEqual([
      {
        ts: '2023-11-14T22:13:20.000Z',
        kind: 'run.started',
        runId: 'run-1',
        profileId: 'work-max',
        providerId: 'claude',
        cwd: '/code/api',
        resumeSessionId: 'session-prior',
      },
      {
        ts: '2023-11-14T22:13:20.000Z',
        kind: 'run.ended',
        runId: 'run-1',
        profileId: 'work-max',
        providerId: 'claude',
        cwd: '/code/api',
        sessionId: 'session-abc',
        reason: 'completed',
        synthesized: false,
      },
    ]);
  });

  it('appends — a second log over the same file adds lines rather than replacing them', async () => {
    log().lifecycle.record({ kind: 'engine.started' });
    // A fresh instance, as after an app restart: the crash-forensics use case
    // is precisely reading the lines a previous process left behind.
    log().lifecycle.record({ kind: 'engine.started' });

    const recorded = await lines();
    expect(recorded).toHaveLength(2);
    expect(recorded.map((line) => line['kind'])).toEqual(['engine.started', 'engine.started']);
  });

  it('records queue-depth reports with what was waiting and holding', async () => {
    const { lifecycle } = log();
    lifecycle.record({
      kind: 'history.lock.queued',
      depth: 4,
      waiting: 'getSessionMessages',
      holding: 'listAllSessions',
    });

    expect(await lines()).toEqual([
      {
        ts: '2023-11-14T22:13:20.000Z',
        kind: 'history.lock.queued',
        depth: 4,
        waiting: 'getSessionMessages',
        holding: 'listAllSessions',
      },
    ]);
  });

  it('never writes a content-bearing field, even when one is smuggled onto the event', async () => {
    const { lifecycle } = log();

    // What an upstream refactor could accidentally hand it: an event object
    // that grew content-bearing fields. The type is bypassed on purpose —
    // types erase, and the redaction rule has to hold at runtime.
    lifecycle.record({
      kind: 'run.started',
      runId: 'run-1',
      profileId: 'work-max',
      providerId: 'claude',
      cwd: '/code/api',
      prompt: 'the user typed a secret in here',
      text: 'assistant output',
      message: { content: 'a whole transcript' },
      token: 'sk-ant-oops',
    } as unknown as SessionLifecycleEvent);

    const raw = await readFile(file(), 'utf8');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('assistant output');
    expect(raw).not.toContain('transcript');
    expect(raw).not.toContain('sk-ant');
    const [line] = await lines();
    expect(Object.keys(line ?? {}).sort()).toEqual([
      'cwd',
      'kind',
      'profileId',
      'providerId',
      'runId',
      'ts',
    ]);
  });

  it('drops a non-scalar value even under an allowed key', async () => {
    const { lifecycle } = log();
    lifecycle.record({
      kind: 'run.ended',
      runId: 'run-1',
      profileId: 'work-max',
      providerId: 'claude',
      cwd: '/code/api',
      reason: { smuggled: 'an object where a string belongs' },
      synthesized: true,
    } as unknown as SessionLifecycleEvent);

    const [line] = await lines();
    expect(line).not.toHaveProperty('reason');
    expect(raw(line)).not.toContain('smuggled');
  });

  it('creates the parent directory on the first record', async () => {
    const nested = path.join(dir, 'logs', 'deeper', SESSION_LIFECYCLE_LOG_FILE);
    const { lifecycle, errors } = log({ file: nested });
    lifecycle.record({ kind: 'engine.started' });

    expect(errors).toEqual([]);
    expect(await readFile(nested, 'utf8')).toContain('engine.started');
  });

  it('reports an unwritable file to onError and never throws', () => {
    // A directory where the file should be: appendFileSync fails, record must not.
    const { lifecycle, errors } = log({ file: dir });
    expect(() => {
      lifecycle.record({ kind: 'engine.stopped' });
    }).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

function raw(line: Record<string, unknown> | undefined): string {
  return JSON.stringify(line ?? {});
}
