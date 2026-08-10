/**
 * Auth-mode resolution.
 *
 * These rules decide which billing arrangement the profile editor *claims* a
 * profile uses, so getting them wrong tells the user the wrong account is being
 * charged. They mirror the credential resolver in `@rx-apollo/core`; this file is
 * where the mirror is held still.
 *
 * Nothing here names a real provider. The descriptors are invented, because the
 * property under test is that the logic reads the descriptor rather than
 * knowing anything about Claude.
 */

import { describe, expect, it } from 'vitest';
import type { ProviderDescriptor } from '@rx-apollo/protocol';

import {
  authModeSupportsBackend,
  authModesOf,
  describeCredential,
  needsSecret,
  resolveAuthMode,
  resolveBackend,
} from './authModes';

const CAPABILITIES = {
  interactivePermissions: false,
  partialMessages: false,
  midRunSteering: false,
  forkSession: false,
  listSessions: false,
  subagents: false,
  permissionModes: [],
  resumeSession: false,
  usageReporting: false,
  costReporting: false,
} as const;

/** Two backends and two modes, one of which is restricted to one backend. */
const PROVIDER: ProviderDescriptor = {
  id: 'claude',
  label: 'Test Provider',
  capabilities: CAPABILITIES,
  backends: [
    { id: 'first-party', label: 'First party', note: 'Needs a credential.', requiresApiKey: true },
    { id: 'cloud', label: 'Cloud', note: 'Uses the ambient chain.', requiresApiKey: false },
  ],
  authModes: [
    { id: 'metered', label: 'Metered', note: 'Billed per token.', requiresSecret: true },
    {
      id: 'plan',
      label: 'Plan',
      note: 'Billed to a plan.',
      requiresSecret: true,
      backends: ['first-party'],
    },
  ],
  available: true,
};

/** A provider with no adapter in this build: no backends, no modes. */
const UNREGISTERED: ProviderDescriptor = {
  id: 'codex',
  label: 'Unregistered',
  capabilities: CAPABILITIES,
  backends: [],
  authModes: [],
  available: false,
};

describe('authModesOf', () => {
  it('treats a missing list and an empty list alike', () => {
    const noField: ProviderDescriptor = { ...PROVIDER, authModes: undefined };
    expect(authModesOf(noField)).toEqual([]);
    expect(authModesOf(UNREGISTERED)).toEqual([]);
    expect(authModesOf(undefined)).toEqual([]);
  });
});

describe('authModeSupportsBackend', () => {
  it('treats an absent backend list as "every backend"', () => {
    const mode = PROVIDER.authModes![0]!;
    expect(authModeSupportsBackend(mode, 'first-party')).toBe(true);
    expect(authModeSupportsBackend(mode, 'cloud')).toBe(true);
  });

  it('honours a restriction', () => {
    const mode = PROVIDER.authModes![1]!;
    expect(authModeSupportsBackend(mode, 'first-party')).toBe(true);
    expect(authModeSupportsBackend(mode, 'cloud')).toBe(false);
  });
});

describe('resolveBackend', () => {
  it('falls back to the provider default, which is the first entry', () => {
    expect(resolveBackend(PROVIDER, undefined)?.id).toBe('first-party');
  });

  it('returns nothing for a provider with no backends', () => {
    expect(resolveBackend(UNREGISTERED, undefined)).toBeUndefined();
  });
});

describe('resolveAuthMode', () => {
  it('returns the named mode when it is legal on the backend', () => {
    expect(resolveAuthMode(PROVIDER, 'first-party', 'plan')?.id).toBe('plan');
  });

  /**
   * The regression that matters. Switching an existing plan profile onto a
   * backend where plan billing does not exist used to leave the picker reading
   * "Plan" — promising an arrangement the credential resolver refuses outright.
   */
  it('substitutes when the named mode is illegal on the backend', () => {
    expect(resolveAuthMode(PROVIDER, 'cloud', 'plan')?.id).toBe('metered');
  });

  it('falls back to the first mode legal on the backend, not simply the first', () => {
    const planFirst: ProviderDescriptor = {
      ...PROVIDER,
      authModes: [PROVIDER.authModes![1]!, PROVIDER.authModes![0]!],
    };
    expect(resolveAuthMode(planFirst, 'cloud', undefined)?.id).toBe('metered');
    expect(resolveAuthMode(planFirst, 'first-party', undefined)?.id).toBe('plan');
  });

  it('ignores a mode id the provider does not have', () => {
    expect(resolveAuthMode(PROVIDER, 'first-party', 'invented')?.id).toBe('metered');
  });

  it('returns nothing when the provider declares no modes', () => {
    expect(resolveAuthMode(UNREGISTERED, undefined, 'metered')).toBeUndefined();
  });
});

describe('needsSecret', () => {
  it('is the AND of the backend and the mode', () => {
    const [metered] = PROVIDER.authModes!;
    const [firstParty, cloud] = PROVIDER.backends;
    expect(needsSecret(firstParty, metered)).toBe(true);
    expect(needsSecret(cloud, metered)).toBe(false);
    expect(
      needsSecret(firstParty, { id: 'ambient', label: 'A', note: '', requiresSecret: false }),
    ).toBe(false);
  });

  it('requires one when a credential-taking backend declares no modes', () => {
    expect(needsSecret(PROVIDER.backends[0], undefined)).toBe(true);
  });
});

describe('describeCredential', () => {
  it('describes the billing mode when a stored credential is actually used', () => {
    const summary = describeCredential(PROVIDER.backends[0], PROVIDER.authModes![1]);
    expect(summary?.label).toBe('Plan');
    expect(summary?.note).toBe('Billed to a plan.');
    expect(summary?.usesStoredSecret).toBe(true);
  });

  /**
   * On an ambient-chain backend a mode still resolves, but Apollo's stored
   * credential is never read — so quoting the mode's billing note would name an
   * account that is not being charged.
   */
  it('describes the backend instead when nothing stored is used', () => {
    const summary = describeCredential(PROVIDER.backends[1], PROVIDER.authModes![0]);
    expect(summary?.usesStoredSecret).toBe(false);
    expect(summary?.note).toBe('Uses the ambient chain.');
    expect(summary?.label).not.toBe('Metered');
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(describeCredential(undefined, undefined)).toBeUndefined();
  });
});
