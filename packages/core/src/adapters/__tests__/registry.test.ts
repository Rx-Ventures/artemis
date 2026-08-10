/**
 * Tests for the provider registry and the seam's error helpers.
 *
 * The registry is driven with fake adapters: what matters is that it treats a
 * provider as an opaque implementation of the seam, which is exactly what makes
 * adding Codex or OpenCode a one-line change.
 */

import { describe, expect, it, vi } from 'vitest';

import { NO_CAPABILITIES } from '@libra/protocol';

import { CLAUDE_CAPABILITIES } from '../claude.js';
import {
  PROVIDER_LABELS,
  createDefaultProviderRegistry,
  createProviderRegistry,
} from '../registry.js';
import { AdapterError, adapterError, isAdapterError, scrubSecrets, toAgentError } from '../types.js';
import type { ProviderAdapter, ProviderCredentialSpec } from '../types.js';

/**
 * A credential spec with no backend and no auth-mode choice — the shape a
 * provider that authenticates one way and one way only would declare.
 * Deliberately nothing like Claude's, so these tests cannot accidentally depend
 * on Anthropic's vocabulary leaking back into the registry.
 */
const FAKE_CREDENTIALS: ProviderCredentialSpec = {
  apiKeyVar: 'FAKE_API_KEY',
  configDirVar: 'FAKE_CONFIG_DIR',
  extraManagedEnvKeys: [],
  authModes: [],
  backends: [],
};

function fakeAdapter(overrides: Partial<ProviderAdapter> & Pick<ProviderAdapter, 'id'>): ProviderAdapter {
  return {
    label: PROVIDER_LABELS[overrides.id],
    capabilities: NO_CAPABILITIES,
    credentials: FAKE_CREDENTIALS,
    createRun: () => Promise.reject(new Error('not implemented')),
    ...overrides,
  };
}

describe('createProviderRegistry', () => {
  it('registers, finds and removes adapters', () => {
    const claude = fakeAdapter({ id: 'claude' });
    const registry = createProviderRegistry([claude]);

    expect(registry.has('claude')).toBe(true);
    expect(registry.get('claude')).toBe(claude);
    expect(registry.require('claude')).toBe(claude);
    expect(registry.unregister('claude')).toBe(true);
    expect(registry.unregister('claude')).toBe(false);
    expect(registry.get('claude')).toBeUndefined();
  });

  it('throws a typed provider_not_found rather than returning undefined', () => {
    const registry = createProviderRegistry();
    expect(() => registry.require('codex')).toThrow(AdapterError);
    try {
      registry.require('codex');
    } catch (error) {
      expect(isAdapterError(error)).toBe(true);
      expect(toAgentError(error).code).toBe('provider_not_found');
    }
  });

  it('refuses a duplicate registration unless replacement is explicit', () => {
    const first = fakeAdapter({ id: 'claude' });
    const second = fakeAdapter({ id: 'claude' });
    const registry = createProviderRegistry([first]);

    expect(() => registry.register(second)).toThrow(AdapterError);
    registry.register(second, { replace: true });
    expect(registry.get('claude')).toBe(second);
  });

  it('lists in the protocol display order, not registration order', () => {
    const registry = createProviderRegistry([
      fakeAdapter({ id: 'opencode' }),
      fakeAdapter({ id: 'claude' }),
    ]);
    expect(registry.list().map((adapter) => adapter.id)).toEqual(['claude', 'opencode']);
  });
});

describe('describe()', () => {
  it('shows unregistered providers greyed out with a reason instead of hiding them', async () => {
    const registry = createProviderRegistry([fakeAdapter({ id: 'claude' })]);
    const descriptors = await registry.describe();

    expect(descriptors.map((d) => d.id)).toEqual(['claude', 'codex', 'opencode']);
    expect(descriptors[1]).toMatchObject({
      id: 'codex',
      label: 'Codex',
      available: false,
      unavailableReason: 'Not supported in this version of Libra yet.',
      capabilities: NO_CAPABILITIES,
    });
  });

  it('can be asked for registered providers only', async () => {
    const registry = createProviderRegistry([fakeAdapter({ id: 'claude' })]);
    const descriptors = await registry.describe({ includeUnregistered: false });
    expect(descriptors.map((d) => d.id)).toEqual(['claude']);
  });

  it('treats an adapter with no probe as available', async () => {
    const registry = createProviderRegistry([fakeAdapter({ id: 'claude' })]);
    const [claude] = await registry.describe();
    expect(claude).toMatchObject({ available: true, unavailableReason: undefined });
  });

  it('caches the probe and re-runs it only on refresh', async () => {
    const checkAvailability = vi.fn().mockResolvedValue({ available: true });
    const registry = createProviderRegistry([fakeAdapter({ id: 'claude', checkAvailability })]);

    await registry.describe();
    await registry.describe();
    expect(checkAvailability).toHaveBeenCalledTimes(1);

    await registry.describe({ refresh: true });
    expect(checkAvailability).toHaveBeenCalledTimes(2);
  });

  it('reports an unavailable provider with its reason', async () => {
    const registry = createProviderRegistry([
      fakeAdapter({
        id: 'claude',
        checkAvailability: () =>
          Promise.resolve({ available: false, unavailableReason: 'No runtime for this platform.' }),
      }),
    ]);
    const [claude] = await registry.describe();
    expect(claude).toMatchObject({ available: false, unavailableReason: 'No runtime for this platform.' });
  });

  it('survives a probe that throws — one bad provider must not fail the list', async () => {
    const registry = createProviderRegistry([
      fakeAdapter({
        id: 'claude',
        checkAvailability: () => Promise.reject(new Error('disk exploded')),
      }),
    ]);

    const [claude] = await registry.describe();
    expect(claude?.available).toBe(false);
    expect(claude?.unavailableReason).toContain('disk exploded');
  });

  it('re-registering invalidates the cached availability', async () => {
    const registry = createProviderRegistry([
      fakeAdapter({ id: 'claude', checkAvailability: () => Promise.resolve({ available: false, unavailableReason: 'nope' }) }),
    ]);
    expect((await registry.describe())[0]?.available).toBe(false);

    registry.register(fakeAdapter({ id: 'claude' }), { replace: true });
    expect((await registry.describe())[0]?.available).toBe(true);
  });
});

describe('createDefaultProviderRegistry', () => {
  it('ships with Claude registered and its real capability set', async () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.list().map((a) => a.id)).toEqual(['claude']);

    const [claude] = await registry.describe();
    expect(claude?.label).toBe('Claude');
    expect(claude?.capabilities).toEqual(CLAUDE_CAPABILITIES);
    expect(claude?.capabilities).toMatchObject({
      interactivePermissions: true,
      partialMessages: true,
      midRunSteering: true,
      forkSession: true,
      listSessions: true,
      subagents: true,
      resumeSession: true,
      usageReporting: true,
      costReporting: true,
    });
  });

  it('exposes listSessions only because the capability says so', () => {
    const claude = createDefaultProviderRegistry().require('claude');
    expect(claude.capabilities.listSessions).toBe(true);
    expect(typeof claude.listSessions).toBe('function');
  });

  it('publishes Claude’s auth modes so the profile editor can build a picker', async () => {
    const [claude] = await createDefaultProviderRegistry().describe();

    expect(claude?.authModes?.map((mode) => mode.id)).toEqual(['console', 'cloud', 'subscription']);
    // The first entry is the default, and it must be the metered one: a user
    // who never opens the picker should not land on subscription billing.
    //
    // Every mode is `requiresSecret: false` now — Libra stores no credential at
    // all. Console and subscription are the same `claude auth login` with a
    // different flag, and cloud defers to the cloud provider's own chain.
    expect(claude?.authModes?.[0]).toMatchObject({ id: 'console', requiresSecret: false });
    expect(claude?.authModes?.every((mode) => mode.requiresSecret !== true)).toBe(true);
    expect(claude?.authModes?.[2]).toMatchObject({
      id: 'subscription',
      // No stored secret: the credential is created by `claude auth login`
      // against this profile's own config directory and stays with the CLI.
      requiresSecret: false,
      // The constraint the editor needs in order to grey the option out.
      backends: ['anthropic'],
    });
    // The editor still needs to tell the user how to authenticate — it just
    // points at the in-app sign-in now rather than at a token to paste.
    // Both Anthropic-billed modes point at the in-app sign-in rather than at a
    // token to paste. Cloud is exempt: it has nothing to sign in to.
    expect(claude?.authModes?.[0]?.secretHowTo).toContain('claude auth login');
    expect(claude?.authModes?.[2]?.secretHowTo).toContain('claude auth login');
  });

  it('does not publish which variable a mode’s secret is written into', async () => {
    const [claude] = await createDefaultProviderRegistry().describe();
    const serialized = JSON.stringify(claude?.authModes);

    expect(serialized).not.toContain('secretEnvVar');
    expect(serialized).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('offers no auth modes for a provider that is not registered', async () => {
    const descriptors = await createDefaultProviderRegistry().describe();
    const codex = descriptors.find((d) => d.id === 'codex');

    // An empty picker rather than Claude's list rendered under Codex's name.
    expect(codex?.authModes).toEqual([]);
    expect(codex?.backends).toEqual([]);
  });
});

describe('error helpers', () => {
  it('classifies HTTP status codes', () => {
    const unauthorized = Object.assign(new Error('nope'), { status: 401 });
    expect(toAgentError(unauthorized).code).toBe('auth');

    const limited = Object.assign(new Error('slow down'), { status: 429 });
    expect(toAgentError(limited)).toMatchObject({ code: 'rate_limit', retryable: true });

    const down = Object.assign(new Error('overloaded'), { status: 503 });
    expect(toAgentError(down).code).toBe('provider_unavailable');
  });

  it('classifies transport and process failures', () => {
    expect(toAgentError(new Error('spawn claude ENOENT')).code).toBe('provider_not_found');
    expect(toAgentError(new Error('connect ECONNREFUSED 127.0.0.1:4096')).code).toBe('network');
  });

  it('recognises cancellation', () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(toAgentError(aborted).code).toBe('cancelled');
  });

  it('passes an AdapterError’s own AgentError straight through', () => {
    const error = adapterError('invalid_request', 'cwd must be absolute');
    expect(toAgentError(error)).toEqual({ code: 'invalid_request', message: 'cwd must be absolute' });
  });

  it('falls back rather than guessing', () => {
    expect(toAgentError({ weird: true }, 'transport')).toEqual({
      code: 'transport',
      message: 'Unknown error',
    });
  });

  it('redacts credential-shaped text on the way into an error', () => {
    const error = adapterError('auth', 'rejected key sk-ant-api03-Zx9abcdefghij4f2a');
    expect(error.agentError.message).not.toContain('Zx9abcdefghij4f2a');
    expect(error.agentError.message).toContain('[redacted]');
  });

  it('scrubs bearer tokens and inline secrets', () => {
    expect(scrubSecrets('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890');
    expect(scrubSecrets('api_key="super-secret-value-here"')).toContain('[redacted]');
    expect(scrubSecrets('nothing sensitive here')).toBe('nothing sensitive here');
  });
});
