/**
 * Capability-aware controls.
 *
 * The half of the disabled-with-reason machinery that knows about application
 * state. Give a button the capability it needs and it works out the rest: if
 * the active provider supports it, the button is a button; if not, it is
 * dimmed and says which provider is missing which feature.
 *
 * ```tsx
 * <CapabilityButton capability="forkSession" onClick={fork}>
 *   Fork run
 * </CapabilityButton>
 * ```
 *
 * That is the whole API. The point of it existing is that the call site cannot
 * accidentally do half the job — there is no way to gate a control on a
 * capability here and forget to explain the gate, because the explanation
 * comes from the same lookup as the gate.
 *
 * NOT PROVIDED, ON PURPOSE: a `CapabilityGate` that renders children only when
 * a capability is supported. Hiding an unsupported control is the failure mode
 * this whole module exists to prevent — the user is left unable to tell a
 * missing feature from a broken app. If a whole region genuinely has no
 * meaning under the active provider, render it disabled with a reason, or
 * handle the emptiness explicitly with its own copy.
 */

import * as React from 'react';
import { useCapability, type CapabilityKey } from '@/hooks/useCapability';
import {
  IconButton,
  ReasonButton,
  type IconButtonProps,
  type ReasonButtonProps,
} from '@/components/disabled-reason';

/**
 * Folds a capability lookup into the `disabled` / `disabledReason` pair.
 *
 * An explicit `disabled` from the caller still wins — a capability being
 * supported never *forces* a control on — and an explicit `disabledReason`
 * overrides the generated sentence.
 */
function useGate(
  capability: CapabilityKey,
  disabled: boolean | undefined,
  disabledReason: string | undefined,
): { readonly disabled: boolean; readonly disabledReason: string | undefined } {
  const status = useCapability(capability);
  return {
    disabled: !status.supported || disabled === true,
    disabledReason: status.supported ? disabledReason : (disabledReason ?? status.reason),
  };
}

export interface CapabilityButtonProps extends ReasonButtonProps {
  /** The provider feature this control needs. See `hooks/useCapability`. */
  readonly capability: CapabilityKey;
}

/** A {@link ReasonButton} gated on a provider capability. */
export function CapabilityButton({
  capability,
  disabled,
  disabledReason,
  ...props
}: CapabilityButtonProps): React.ReactElement {
  const gate = useGate(capability, disabled, disabledReason);
  return <ReasonButton {...props} disabled={gate.disabled} disabledReason={gate.disabledReason} />;
}

export interface CapabilityIconButtonProps extends IconButtonProps {
  readonly capability: CapabilityKey;
}

/** An icon-only {@link CapabilityButton}. */
export function CapabilityIconButton({
  capability,
  disabled,
  disabledReason,
  ...props
}: CapabilityIconButtonProps): React.ReactElement {
  const gate = useGate(capability, disabled, disabledReason);
  return <IconButton {...props} disabled={gate.disabled} disabledReason={gate.disabledReason} />;
}
