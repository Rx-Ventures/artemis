/**
 * Reading a provider's authentication modes.
 *
 * An auth mode says *what the credential is and how the work is billed*; a
 * backend says *where the models are hosted*. They are independent axes, and
 * one constrains the other: a mode may declare `backends`, meaning it is only
 * valid on those. Claude's subscription billing, for instance, exists only on
 * Anthropic's first-party API — a subscription profile pointed at Bedrock is a
 * contradiction, not an unsupported feature.
 *
 * Everything here reads the descriptor that came off `providers:list`. Nothing
 * in this file names a mode, a backend or a provider: add a third provider with
 * six modes and this code does not change. That is the same rule the backend
 * picker and the permission-mode picker already follow.
 *
 * The resolution below deliberately mirrors what the credential resolver in
 * `@libra/core` does when it decides which environment variable a secret is
 * written to. It has to: if the editor shows one mode and the resolver picks
 * another, the user is told the wrong account is being billed. The core copy is
 * authoritative — this one exists so the form can *explain* the choice, and it
 * must be kept in step with it.
 */

import type {
  ProviderAuthModeOption,
  ProviderBackendOption,
  ProviderDescriptor,
} from '@libra/protocol';

/**
 * The modes a provider offers.
 *
 * `authModes` is optional on the wire and an empty list is meaningful: both say
 * "this provider has one implicit way of authenticating", and the editor should
 * render no picker at all rather than a picker with one entry.
 */
export function authModesOf(provider: ProviderDescriptor | undefined): readonly ProviderAuthModeOption[] {
  return provider?.authModes ?? [];
}

/** Whether a mode may be used on a given backend. No `backends` means "any". */
export function authModeSupportsBackend(
  mode: ProviderAuthModeOption,
  backendId: string | undefined,
): boolean {
  if (mode.backends === undefined) return true;
  if (backendId === undefined) return false;
  return mode.backends.includes(backendId);
}

/**
 * The backend a profile actually runs on.
 *
 * An absent `backend` means "the provider's default", which the provider
 * resolves as the first entry in its own list — so that is what has to be
 * consulted here rather than assuming any particular one.
 */
export function resolveBackend(
  provider: ProviderDescriptor | undefined,
  backendId: string | undefined,
): ProviderBackendOption | undefined {
  const backends = provider?.backends ?? [];
  return backends.find((backend) => backend.id === backendId) ?? backends[0];
}

/**
 * The mode a profile actually authenticates with.
 *
 * Absent means the provider's first mode that is valid on the resolved backend
 * — *not* simply the first mode, because the first one may be invalid there.
 * Every profile written before the auth-mode axis existed therefore keeps
 * billing exactly as it did.
 */
export function resolveAuthMode(
  provider: ProviderDescriptor | undefined,
  backendId: string | undefined,
  authModeId: string | undefined,
): ProviderAuthModeOption | undefined {
  const modes = authModesOf(provider);
  if (modes.length === 0) return undefined;
  const backend = resolveBackend(provider, backendId);
  const named = authModeId === undefined ? undefined : modes.find((mode) => mode.id === authModeId);
  // A named mode still has to be legal on the resolved backend. Returning it
  // regardless was wrong in a way that mattered: switching an existing
  // subscription profile to Bedrock left the picker reading "Claude
  // subscription" on a backend where subscription billing does not exist, so
  // the screen promised an arrangement the credential resolver refuses. The
  // caller detects the substitution by comparing ids and says so.
  if (named && authModeSupportsBackend(named, backend?.id)) return named;
  return modes.find((mode) => authModeSupportsBackend(mode, backend?.id));
}

/**
 * Whether a credential must be supplied, as the AND of the two axes.
 *
 * A backend on an ambient credential chain needs nothing whatever the mode
 * says; a mode that authenticates ambiently needs nothing whatever the backend
 * says. Only when both want one is a secret required — which is exactly how the
 * resolver in core decides it.
 */
export function needsSecret(
  backend: ProviderBackendOption | undefined,
  mode: ProviderAuthModeOption | undefined,
): boolean {
  if (backend?.requiresApiKey !== true) return false;
  return mode === undefined || mode.requiresSecret;
}

/** How a profile's credential arrangement should be described to the user. */
export interface CredentialSummary {
  /** Short chip text. */
  readonly label: string;
  /** One sentence on what this arrangement bills. */
  readonly note: string;
  /** False when nothing Libra stores is used to authenticate. */
  readonly usesStoredSecret: boolean;
}

/**
 * What to *say* about how a profile authenticates.
 *
 * This exists because naming the auth mode unconditionally lies. A profile on a
 * backend with an ambient credential chain still resolves to some mode — the
 * first one legal there — but Libra's stored credential is never read and the
 * mode's billing note ("billed to the key's account") describes an account that
 * is not being charged. On those backends the honest answer is the backend's
 * own note, so that is what comes back.
 *
 * Returns `undefined` only when there is nothing at all to say: no backend
 * information and no modes, i.e. a provider with no adapter in this build.
 */
export function describeCredential(
  backend: ProviderBackendOption | undefined,
  mode: ProviderAuthModeOption | undefined,
): CredentialSummary | undefined {
  if (!needsSecret(backend, mode)) {
    if (!backend) return undefined;
    return {
      label: 'ambient credentials',
      note: backend.note,
      usesStoredSecret: false,
    };
  }
  return {
    label: mode?.label ?? 'stored credential',
    note: mode?.note ?? 'Authenticates with the credential stored for this profile.',
    usesStoredSecret: true,
  };
}
