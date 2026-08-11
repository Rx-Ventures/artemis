/**
 * Tests for the provider registry and the seam's error helpers.
 *
 * The registry is driven with fake adapters: what matters is that it treats a
 * provider as an opaque implementation of the seam, which is exactly what makes
 * adding Codex or OpenCode a one-line change.
 */

import { describe, expect, it, vi } from 'vitest';

import { NO_CAPABILITIES } from '@rx-apollo/protocol';

import { CLAUDE_CAPABILITIES } from '../claude.js';
import { CODEX_CAPABILITIES } from '../codex.js';
import {
  PROVIDER_LABELS,
  createDefaultProviderRegistry,
  createProviderRegistry,
} from '../registry.js';
import { AdapterError, adapterError, isAdapterError, scrubSecrets, toAgentError } from '../types.js';
import type { ProviderAdapter, ProviderCredentialSpec } from '../types.js';

/**
 * A credential spec deliberately nothing like Claude's, so these tests cannot
 * accidentally depend on Anthropic's vocabulary leaking back into the registry.
 */
const FAKE_CREDENTIALS: ProviderCredentialSpec = {
  configDirVar: 'FAKE_CONFIG_DIR',
  credentialEnvKeys: ['FAKE_API_KEY'],
  signIn: {
    executable: 'fake-cli',
    loginArgs: ['login'],
    statusArgs: ['whoami', '--json'],
    logoutArgs: ['logout'],
    howTo: 'Run the fake CLI’s login.',
  },
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
      unavailableReason: 'Not supported in this version of Apollo yet.',
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
  it('ships with Claude and Codex registered, in PROVIDER_IDS order', () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.list().map((a) => a.id)).toEqual(['claude', 'codex']);
  });

  it('gives Claude its real capability set', async () => {
    const registry = createDefaultProviderRegistry();
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

  it('publishes sign-in instructions so the profile screen can explain the command', async () => {
    const [claude] = await createDefaultProviderRegistry().describe();

    // The screen generates the command but does not know what it does. The
    // adapter that owns the argv owns the explanation too.
    expect(claude?.signInHowTo).toBeTruthy();
    expect(claude?.signInHowTo).toContain('config directory');
  });

  it('publishes no credential vocabulary at all', async () => {
    const [claude] = await createDefaultProviderRegistry().describe();
    const serialized = JSON.stringify(claude);

    // A descriptor crosses IPC to the renderer. It carries which command to
    // run, never which variable a credential would travel in — the renderer has
    // no use for the latter, and every field it does not receive is one it
    // cannot leak back.
    expect(serialized).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
    expect(serialized).not.toContain('configDirVar');
  });

  it('offers no sign-in instructions for a provider that is not registered', async () => {
    const descriptors = await createDefaultProviderRegistry().describe();
    const opencode = descriptors.find((d) => d.id === 'opencode');

    // Silence rather than another adapter's command rendered under OpenCode's
    // name. Codex used to be the example here; it is registered now, so the
    // still-unimplemented provider carries the case.
    expect(opencode?.signInHowTo).toBeUndefined();
    expect(opencode?.available).toBe(false);
  });

  it('gives Codex a capability set that differs from Claude’s', async () => {
    const descriptors = await createDefaultProviderRegistry().describe();
    const codex = descriptors.find((d) => d.id === 'codex');

    expect(codex?.label).toBe('Codex');
    expect(codex?.capabilities).toEqual(CODEX_CAPABILITIES);

    // The point of the seam: two providers, genuinely different answers. If
    // these ever match Claude's, the descriptor is being filled in from the
    // wrong adapter.
    expect(codex?.capabilities.subagents).toBe(false);
    expect(codex?.capabilities.costReporting).toBe(false);
    expect(codex?.capabilities.planUsageReporting).toBe(true);
  });

  it('advertises only the permission modes Codex can honour exactly', async () => {
    const descriptors = await createDefaultProviderRegistry().describe();
    const codex = descriptors.find((d) => d.id === 'codex');

    // `dontAsk` means "never prompt, deny instead"; Codex's nearest mode
    // (`never`) proceeds instead of denying. Advertising it would make Apollo
    // silently more permissive than the user asked for, so it is omitted rather
    // than approximated. `auto` has no Codex equivalent at all.
    expect(codex?.capabilities.permissionModes).not.toContain('dontAsk');
    expect(codex?.capabilities.permissionModes).not.toContain('auto');
    expect(codex?.capabilities.permissionModes).toContain('plan');
    expect(codex?.capabilities.permissionModes).toContain('bypassPermissions');
  });

  it('publishes no Codex credential vocabulary either', async () => {
    const descriptors = await createDefaultProviderRegistry().describe();
    const serialized = JSON.stringify(descriptors.find((d) => d.id === 'codex'));

    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('CODEX_HOME');
    expect(serialized).not.toContain('configDirVar');
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
