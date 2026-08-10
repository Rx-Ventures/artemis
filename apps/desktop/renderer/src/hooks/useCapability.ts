/**
 * Capability lookup.
 *
 * Libra drives three providers with three unrelated transports, and the UI has
 * to degrade against whichever one is active rather than assume they can all
 * do everything. Every gated control asks this hook the same question and gets
 * back both the answer and the sentence to show the user — so an unsupported
 * control renders disabled *with an explanation*, never silently missing.
 */

import type { Capabilities, PermissionMode } from '@libra/protocol';
import { useApp, activeCapabilities, activeProviderLabel } from '../state/store';

/** The boolean fields of {@link Capabilities}. */
export type CapabilityKey = {
  [K in keyof Capabilities]-?: Capabilities[K] extends boolean ? K : never;
}[keyof Capabilities];

/** How each capability is described in a tooltip. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  interactivePermissions: 'interactive tool approval',
  partialMessages: 'token-by-token streaming',
  midRunSteering: 'sending messages mid-run',
  forkSession: 'forking a session',
  listSessions: 'listing past sessions',
  subagents: 'subagents',
  resumeSession: 'resuming a session',
  usageReporting: 'token usage reporting',
  costReporting: 'cost reporting',
  planUsageReporting: 'plan usage reporting',
};

export interface CapabilityStatus {
  readonly supported: boolean;
  /** Empty when supported; a full sentence when not. */
  readonly reason: string;
  readonly label: string;
}

export function useCapability(key: CapabilityKey): CapabilityStatus {
  const supported = useApp((s) => activeCapabilities(s)[key]);
  const provider = useApp(activeProviderLabel);
  const hasProvider = useApp((s) => s.providers.length > 0);
  const label = CAPABILITY_LABELS[key];

  if (supported) return { supported: true, reason: '', label };
  return {
    supported: false,
    label,
    reason: hasProvider
      ? `${provider} does not support ${label}.`
      : `No provider is available yet, so ${label} is unavailable.`,
  };
}

/** Permission modes the active provider accepts. Empty means "not applicable". */
export function usePermissionModes(): readonly PermissionMode[] {
  return useApp((s) => activeCapabilities(s).permissionModes);
}
