/**
 * Permissions & tools.
 * ============================================================================
 *
 * What the agent is allowed to do without asking first, and — for the parts
 * Apollo cannot yet decide — an honest account of who does decide.
 *
 * ---------------------------------------------------------------------------
 * THE MODE LIST COMES FROM THE PROVIDER, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * `usePermissionModes()` reads the *active provider's* declared subset, not the
 * `PermissionMode` union. Providers accept different subsets, and a mode this
 * pane offered that the provider rejects would be a setting the user changed
 * and the run silently ignored. The copy below is keyed by mode so that adding
 * a mode to the protocol shows up here as a type error rather than as a blank
 * row — but the copy decides *wording*, never *membership*.
 *
 * The labels are longer than the status line's. That is deliberate rather than
 * an oversight: the status line renders these into a 20px segment where "ask"
 * and "bypass" are all that fit, and the same terseness in a settings pane
 * would leave the user to guess what "auto" means from four letters. Same
 * modes, two registers, and the one that has room spells it out.
 *
 * ---------------------------------------------------------------------------
 * THE TOOL LISTS ARE SHOWN, DISABLED, AND SAY WHY
 * ---------------------------------------------------------------------------
 *
 * `RunInput` carries `allowedTools`, `disallowedTools` and
 * `additionalDirectories`, but nothing in the renderer store holds them and no
 * IPC call writes them — the fields exist in the protocol and no UI fills them
 * in. A textarea wired to nothing would take a user's carefully written deny
 * list and drop it on close, which is the worst outcome available. So the
 * controls are here, disabled, each carrying the sentence that says what would
 * have to exist for them to work. That is the same rule every capability-gated
 * control in this app follows, applied to a gap in Apollo rather than a gap in
 * the provider.
 */

import type { ReactElement } from 'react';
import { ShieldIcon } from 'lucide-react';
import type { PermissionMode } from '@apollo/protocol';

import { WithReason } from '../disabled-reason';
import { usePermissionModes } from '../../hooks/useCapability';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import { activeProviderLabel, setPermissionMode, useApp } from '../../state/store';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/** Long-form names for the settings pane. See the file header on why these differ from the status line's. */
const MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'Plan only',
  default: 'Ask before acting',
  acceptEdits: 'Accept edits, ask for the rest',
  auto: 'Let the provider decide',
  dontAsk: 'Never ask',
  bypassPermissions: 'Bypass all permission checks',
};

const MODE_NOTES: Record<PermissionMode, string> = {
  plan: 'Research and propose only. No file is written and no command runs, however the conversation goes.',
  default: 'Prompt for anything not already allowed. The safe default, and the noisiest.',
  acceptEdits: 'File edits go through without asking; commands, network calls and everything else still prompt.',
  auto: 'The provider’s own classifier decides what is routine, and prompts when it judges a call risky.',
  dontAsk: 'Never prompt. A call that would have needed approval is denied instead of asked about.',
  bypassPermissions: 'Every tool call runs, including destructive ones, with no prompt and no second look.',
};

/**
 * Nothing in the renderer persists a tool policy yet.
 *
 * Stated once, as one sentence per control, because each control needs its own
 * reason attached — a single note above the group would leave three dimmed
 * boxes with no explanation on the box itself.
 */
const NO_TOOL_POLICY =
  'Apollo has nowhere to keep this yet. The protocol carries it per run, but no setting writes it, so anything typed here would be lost when this dialog closes.';

export function PermissionsSection(): ReactElement {
  const modes = usePermissionModes();
  const mode = useApp((s) => s.permissionMode);
  const providerLabel = useApp(activeProviderLabel);

  /**
   * A stored mode the current provider does not accept.
   *
   * Routine rather than exceptional: the preference is global and persisted,
   * and providers accept different subsets, so switching provider strands it.
   * The run falls back to the provider's own default, and saying so is the
   * whole point — otherwise the pane shows nothing selected and looks broken.
   */
  const orphaned = modes.length > 0 && !modes.includes(mode);

  const choices: readonly Choice<PermissionMode>[] = modes.map((id) => ({
    id,
    label: MODE_LABELS[id],
    note: MODE_NOTES[id],
    ...(id === 'bypassPermissions' ? { tone: 'signal' as const } : {}),
  }));

  return (
    <SettingsPane
      title="Permissions & tools"
      description="When the agent has to stop and ask you, and what it is allowed to reach."
    >
      <SettingsGroup label="Default permission mode">
        {modes.length === 0 ? (
          <Empty className="border border-dashed border-line py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldIcon />
              </EmptyMedia>
              <EmptyTitle className="text-ink">No permission modes to choose from</EmptyTitle>
              <EmptyDescription className="text-2xs">
                {providerLabel} does not expose permission modes. It decides on its own whether to
                prompt, and Apollo has no way to ask it for something different.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ChoiceList
              label="Default permission mode"
              value={mode}
              choices={choices}
              onChange={setPermissionMode}
            />
            <p className="text-2xs leading-relaxed text-ink-faint">
              Applies to the next run. A run already in flight keeps the mode it started with.
            </p>
            {orphaned ? (
              <p className="text-2xs leading-relaxed text-amber">
                “{mode}” was chosen under a different provider. {providerLabel} does not accept it,
                so the next run will use the provider’s own default until you pick one above.
              </p>
            ) : null}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup label="Tool policy">
        <ToolPolicyField
          id="settings-allowed-tools"
          label="Always allow"
          placeholder={'Read\nGrep'}
          description="Tool names that never prompt, one per line, whatever the mode above says."
        />
        <ToolPolicyField
          id="settings-disallowed-tools"
          label="Never allow"
          placeholder={'Bash(rm:*)\nWebFetch'}
          description="Tool names that are always refused. Applied after the allow list, so it wins."
        />
        <ToolPolicyField
          id="settings-additional-directories"
          label="Additional directories"
          placeholder={'/Users/you/notes'}
          description="Absolute paths outside the working directory that the agent may read and write."
        />
        <p className="text-2xs leading-relaxed text-ink-faint">
          Until these are real settings, tool policy comes from wherever the provider’s own CLI
          reads it — its config file for this project. Apollo sends no allow list, no deny list and no
          extra directories, so nothing here is silently overriding what you configured there.
        </p>
      </SettingsGroup>
    </SettingsPane>
  );
}

function ToolPolicyField({
  id,
  label,
  description,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
}): ReactElement {
  return (
    <Field>
      <FieldLabel htmlFor={id} className="text-2xs text-ink-faint uppercase">
        {label}
      </FieldLabel>
      {/*
        `WithReason` rather than a bare `disabled`: a disabled textarea takes no
        pointer events and no focus, so a tooltip on the control itself could
        never open and a keyboard user would never learn why it is dead. The
        wrapper is the focusable stand-in — see `disabled-reason.tsx`.
      */}
      <WithReason reason={NO_TOOL_POLICY} side="top" className="w-full">
        <Textarea
          id={id}
          rows={2}
          disabled
          readOnly
          spellCheck={false}
          placeholder={placeholder}
          className="min-h-14 w-full font-mono text-xs md:text-xs"
        />
      </WithReason>
      <FieldDescription className="text-2xs">{description}</FieldDescription>
    </Field>
  );
}
