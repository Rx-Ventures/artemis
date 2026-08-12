/**
 * The leak tripwire, checked against the *real* shapes core produces.
 *
 * `redact.test.ts` tests the scanner against hand-written payloads. That proves
 * the rules fire, but it cannot prove the two things this file cares about,
 * both of which are properties of the seam between `@rx-artemis/core` and
 * `apps/desktop/main` rather than of either side alone:
 *
 *  1. **No false negative.** A real `Profile` — the exact object
 *     `ProfileStore.create()` resolves — must be rejected. This is the bug the
 *     tripwire exists to catch.
 *  2. **No false positive.** A real `ProfileMetadata` must pass. This one
 *     matters more than it looks: `profiles:list` runs at boot, so a scanner
 *     that rejects its own legitimate output would not "fail closed", it would
 *     make the app unusable on first launch with an empty profile list and a
 *     confusing error.
 *
 * (2) got sharper when profiles stopped carrying credentials. The renderer-safe
 * shape now includes an absolute filesystem path, which is exactly the sort of
 * thing a leak scanner is inclined to be suspicious of — so the test that it
 * passes is doing real work.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultProviderRegistry, toMetadata } from '@rx-artemis/core';
import type { Profile, SessionsMessagesResponse } from '@rx-artemis/protocol';

import {
  assertNoSecrets,
  assertResponseSafe,
  looksLikeSecretValue,
  RESPONSE_SCAN_POLICY,
  SecretLeakError,
} from './redact.js';

const profile: Profile = {
  id: 'p_1',
  label: 'Work',
  providerId: 'claude',
  configDir: '/Users/me/Library/Application Support/Artemis/profiles/work',
  publicEnv: { AWS_REGION: 'us-east-1' },
};

describe('the leak tripwire against real core output', () => {
  it('rejects a real Profile, which is the shape that must never be returned', () => {
    // `publicEnv` is what distinguishes it from the metadata projection, and it
    // is the key the scanner catches.
    expect(() =>
      assertNoSecrets({ profiles: [profile] }, 'artemis:profiles:list', RESPONSE_SCAN_POLICY),
    ).toThrow(SecretLeakError);
  });

  it('passes a real ProfileMetadata, config directory and all', () => {
    const metadata = toMetadata(profile);

    // The directory is on the wire on purpose: the user chose it, the sign-in
    // command names it, and the profile screen cannot work without it. A
    // scanner that rejected it would break `profiles:list` at boot.
    expect(metadata.configDir).toBe(profile.configDir);
    expect(looksLikeSecretValue(metadata.configDir)).toBe(false);
    expect(() =>
      assertNoSecrets({ profiles: [metadata] }, 'artemis:profiles:list', RESPONSE_SCAN_POLICY),
    ).not.toThrow();
  });

  it('passes a config directory inside a home folder, which is the common case', () => {
    const metadata = toMetadata({ ...profile, configDir: '/Users/me/.claude' });

    expect(() =>
      assertNoSecrets({ profiles: [metadata] }, 'artemis:profiles:list', RESPONSE_SCAN_POLICY),
    ).not.toThrow();
  });

  it('passes the real providers:list response', async () => {
    const descriptors = await createDefaultProviderRegistry().describe();

    expect(() =>
      assertNoSecrets({ providers: descriptors }, 'artemis:providers:list', RESPONSE_SCAN_POLICY),
    ).not.toThrow();
  });

  it('carries sign-in instructions but no variable names', async () => {
    const descriptors = await createDefaultProviderRegistry().describe();
    const claude = descriptors.find((d) => d.id === 'claude');

    // The renderer is told what the command does, never which variable a
    // credential would travel in — it has no use for the latter, and every
    // field it does not receive is one it cannot leak back.
    expect(claude?.signInHowTo).toBeTruthy();
    const serialized = JSON.stringify(claude);
    expect(serialized).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
  });

  it('keeps the credential spec itself off the wire', () => {
    // A whole `ProviderCredentialSpec` is the wrong shape to return, the way a
    // whole `Profile` is. The scanner's `credentials` key rule covers it.
    const adapter = createDefaultProviderRegistry().require('claude');
    expect(() =>
      assertNoSecrets(
        { providers: [{ id: 'claude', credentials: adapter.credentials }] },
        'artemis:providers:list',
        RESPONSE_SCAN_POLICY,
      ),
    ).toThrow(SecretLeakError);
  });
});

/**
 * The same no-false-positive argument as (2) above, for the channel that
 * reopens a conversation.
 *
 * These fixtures are typed as `AgentEvent` and `SessionsMessagesResponse` on
 * purpose. The exemptions in `redact.ts` name fields — `text`, `input`,
 * `result` — and a rename on the protocol side would silently strand them,
 * turning a scanner into a session-shredder again. Typing the fixture makes
 * that a compile error instead.
 */
describe('the leak tripwire against a real transcript', () => {
  const transcript: SessionsMessagesResponse = {
    hasMore: false,
    events: [
      {
        type: 'session.started',
        runId: 'history:s1',
        seq: 0,
        ts: 0,
        sessionId: 's1',
        providerId: 'claude',
        cwd: '/repo',
      },
      {
        type: 'text.complete',
        runId: 'history:s1',
        seq: 1,
        ts: 0,
        messageId: 'm1',
        text: 'Set ANTHROPIC_API_KEY=sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123 to authenticate.',
      },
      {
        type: 'tool.start',
        runId: 'history:s1',
        seq: 2,
        ts: 0,
        toolCallId: 't1',
        name: 'Bash',
        input: { command: 'printenv', env: { CI: '1' } },
        title: 'printenv',
      },
      {
        type: 'tool.end',
        runId: 'history:s1',
        seq: 3,
        ts: 0,
        toolCallId: 't1',
        status: 'ok',
        result: { stdout: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
        resultText: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    ],
  };

  it('reopens a session whose transcript talks about credentials', () => {
    // Every one of these events would trip the strict policy, and every one of
    // them is ordinary output from an agent doing ordinary work. This is the
    // regression test for #68: the whole conversation used to vanish behind
    // "Artemis blocked a response that failed its credential-safety check".
    expect(() => assertResponseSafe(transcript, 'artemis:sessions:messages')).not.toThrow();
  });

  it('scans each event exactly as the live push path would', () => {
    // Not an implementation detail — it is the reason history renders the same
    // as the run that produced it.
    for (const event of transcript.events) {
      expect(() => assertResponseSafe({ runId: event.runId, events: [event] }, 'artemis:runs:events')).not.toThrow();
    }
  });

  it('still rejects a Profile smuggled in beside the events', () => {
    expect(() => assertResponseSafe({ ...transcript, profile }, 'artemis:sessions:messages')).toThrow(SecretLeakError);
  });
});
