/**
 * Capability lookup.
 *
 * Artemis drives three providers with three unrelated transports, and the UI has
 * to degrade against whichever one is active rather than assume they can all
 * do everything. Every gated control asks this hook the same question and gets
 * back both the answer and the sentence to show the user — so an unsupported
 * control renders disabled *with an explanation*, never silently missing.
 */

import type { Capabilities, PermissionMode } from '@rx-artemis/protocol';
import { activeCapabilities, activeProviderLabel } from '../state/store';
import { usePane } from '../state/paneContext';

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
  subagentTranscripts: "opening a subagent's transcript",
  renameSession: 'renaming a session',
  deleteSession: 'deleting a session',
  tagSession: 'archiving a session',
  resumeSession: 'resuming a session',
  rewind: 'rewinding a conversation',
  usageReporting: 'token usage reporting',
  costReporting: 'cost reporting',
  planUsageReporting: 'plan usage reporting',
  systemPromptAppend: 'standing instructions from the prompt library',
  imageInput: 'images in a prompt',
  fileInput: 'file attachments',
};

export interface CapabilityStatus {
  readonly supported: boolean;
  /** Empty when supported; a full sentence when not. */
  readonly reason: string;
  readonly label: string;
}

/**
 * Answered for the column this component is in.
 *
 * Two panes can be pointed at two providers, so a capability is not a property
 * of the window: the composer on the left may steer mid-run while the one on
 * the right is disabled with Codex's reason attached, at the same moment.
 */
export function useCapability(key: CapabilityKey): CapabilityStatus {
  const supported = usePane((s) => activeCapabilities(s)[key]);
  const provider = usePane(activeProviderLabel);
  const hasProvider = usePane((s) => s.providers.length > 0);
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
  return usePane((s) => activeCapabilities(s).permissionModes);
}
