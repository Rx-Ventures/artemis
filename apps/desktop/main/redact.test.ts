import { describe, expect, it } from 'vitest';

import {
  assertNoSecrets,
  EVENT_SCAN_POLICY,
  looksLikeSecretValue,
  RESPONSE_SCAN_POLICY,
  scrubSecrets,
  SecretLeakError,
} from './redact.js';

/**
 * These tests are the executable version of Apollo's central invariant: a
 * secret never crosses IPC into the renderer. If the tripwire stops firing,
 * the invariant is being enforced by nothing but good intentions.
 */

const FAKE_KEY = 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCD';

describe('looksLikeSecretValue', () => {
  it('recognises the credential shapes Apollo can hold', () => {
    expect(looksLikeSecretValue(FAKE_KEY)).toBe(true);
    expect(looksLikeSecretValue('sk-0123456789abcdefghijklmnop')).toBe(true);
    expect(looksLikeSecretValue('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeSecretValue('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    expect(looksLikeSecretValue('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(looksLikeSecretValue('Read src/index.ts')).toBe(false);
    expect(looksLikeSecretValue('sk-short')).toBe(false);
    // A masked hint is what the renderer is *supposed* to receive.
    expect(looksLikeSecretValue('sk-ant-...4f2a')).toBe(false);
  });
});

describe('scrubSecrets', () => {
  it('replaces credentials in log lines', () => {
    const scrubbed = scrubSecrets(`request failed with key ${FAKE_KEY}`);
    expect(scrubbed).not.toContain(FAKE_KEY);
    expect(scrubbed).toContain('[redacted]');
  });
});

describe('assertNoSecrets — response policy', () => {
  it('passes a well-formed ProfileMetadata list', () => {
    expect(() =>
      assertNoSecrets(
        {
          profiles: [
            { id: 'p1', label: 'Work', providerId: 'claude', backend: 'bedrock', keyHint: 'sk-ant-...4f2a' },
            { id: 'p2', label: 'Personal', providerId: 'claude', keyHint: null },
          ],
        },
        'apollo:profiles:list',
      ),
    ).not.toThrow();
  });

  it('catches a Profile returned where ProfileMetadata was expected', () => {
    // The exact refactor this module exists to prevent: someone returns the
    // stored record instead of its renderer-safe projection.
    const leaked = {
      profile: {
        id: 'p1',
        label: 'Work',
        providerId: 'claude',
        configDirName: 'work',
        secretRef: 'profile-abc',
        publicEnv: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
      },
    };
    expect(() => assertNoSecrets(leaked, 'apollo:profiles:create')).toThrow(SecretLeakError);
  });

  it('catches a raw key smuggled into an unexpected field', () => {
    expect(() => assertNoSecrets({ run: { runId: 'r1', cwd: `/tmp/${FAKE_KEY}` } }, 'apollo:runs:start')).toThrow(
      SecretLeakError,
    );
  });

  it('does not fire on user text, which may legitimately contain anything', () => {
    // A user who pasted a key into a prompt still has to be able to see their
    // own session history.
    expect(() =>
      assertNoSecrets(
        { sessions: [{ id: 's1', title: `use ${FAKE_KEY} please`, updatedAt: 0 }], hasMore: false },
        'apollo:sessions:list',
      ),
    ).not.toThrow();
  });

  it('survives a cyclic payload instead of hanging', () => {
    const cyclic: Record<string, unknown> = { id: 'r1' };
    cyclic['self'] = cyclic;
    expect(() => assertNoSecrets(cyclic, 'test')).not.toThrow();
  });

  it('fails closed on a payload too deep to verify', () => {
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < RESPONSE_SCAN_POLICY.maxDepth + 4; i += 1) nested = { nested };
    expect(() => assertNoSecrets(nested, 'test')).toThrow(SecretLeakError);
  });
});

describe('assertNoSecrets — event policy', () => {
  it('lets model output through untouched', () => {
    // The agent explaining how to set an API key is normal transcript content.
    const event = {
      type: 'text.delta',
      runId: 'r1',
      seq: 4,
      ts: 0,
      messageId: 'm1',
      blockIndex: 0,
      text: `export ANTHROPIC_API_KEY=${FAKE_KEY}`,
    };
    expect(() => assertNoSecrets(event, 'push', EVENT_SCAN_POLICY)).not.toThrow();
  });

  it('does not walk into unbounded tool payloads', () => {
    const event = {
      type: 'tool.end',
      runId: 'r1',
      seq: 9,
      ts: 0,
      toolCallId: 't1',
      status: 'ok',
      result: { stdout: FAKE_KEY },
    };
    expect(() => assertNoSecrets(event, 'push', EVENT_SCAN_POLICY)).not.toThrow();
  });

  it('still refuses a profile field on an event', () => {
    const event = { type: 'session.started', runId: 'r1', seq: 0, ts: 0, secretRef: 'profile-abc' };
    expect(() => assertNoSecrets(event, 'push', EVENT_SCAN_POLICY)).toThrow(SecretLeakError);
  });
});
