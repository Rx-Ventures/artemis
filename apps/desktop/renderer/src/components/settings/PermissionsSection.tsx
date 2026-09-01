/**
 * Permissions & access.
 * ============================================================================
 *
 * What the agent is allowed to do without asking first, whose browser it does
 * it in, and — for the parts Artemis cannot yet decide — an honest account of
 * who does decide.
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
 * THE BROWSER SWITCHES ARE PERMISSION QUESTIONS, SO THEY LIVE HERE
 * ---------------------------------------------------------------------------
 *
 * They had a pane of their own once, parked beside this one with a nav comment
 * arguing the adjacency — "a comfort question until it is a permission
 * question". The second half of that sentence won. Both switches decide what
 * the agent may *reach*: the user's signed-in Chrome with a two-way bridge, or
 * their default browser one-way. That is the same species of question as the
 * mode list above, so they sit under it rather than one door over.
 *
 * The pair is the same preference at two strengths, which is why it is two
 * switches and not a three-way choice:
 *
 *  - **Chrome** hands the agent a two-way bridge (the Claude-in-Chrome
 *    extension): it opens tabs in the user's Chrome *and* can read, click and
 *    type there, in a tab group the user watches. Claude sessions only, and
 *    only when the profile is signed in — an API-key profile keeps the bridge
 *    off, a rule the CLI enforces and this pane only reports.
 *  - **Default browser** is one-way: pages the agent opens land in the user's
 *    default browser, and the agent is told it cannot see them. Works with
 *    every provider, grants nothing beyond "open a tab".
 *
 * When both are on, Chrome wins for the runs it applies to — it is the
 * stronger form of the same preference. The copy under each switch says so,
 * because a pair of toggles whose interaction is a surprise is a pane that
 * teaches distrust. Why the embedded dock browser loses on the real web —
 * its own cookie jar, every permission refused, sign-in flows that reject
 * embedded browsers outright — is told under the first switch, where the
 * question comes up.
 *
 * ---------------------------------------------------------------------------
 * THE TOOL LISTS ARE SHOWN, DISABLED, AND SAY WHY
 * ---------------------------------------------------------------------------
 *
 * `RunInput` carries `allowedTools` and `disallowedTools`, but nothing in the
 * renderer store holds them and no IPC call writes them — the fields exist in
 * the protocol and no UI fills them in. A textarea wired to nothing would take
 * a user's carefully written deny list and drop it on close, which is the worst
 * outcome available. So the controls are here, disabled, each carrying the
 * sentence that says what would have to exist for them to work. That is the
 * same rule every capability-gated control in this app follows, applied to a
 * gap in Artemis rather than a gap in the provider.
 *
 * `additionalDirectories` is no longer one of them. The working-directory pane
 * fills it in per session — folders picked there, plus the enabled team memory
 * banks the main process merges into every run — so this pane says where that
 * control lives instead of offering a second, disconnected copy of it. Two
 * editors for one field is how a setting gets lost.
 */

import type { ReactElement } from 'react';
import { ShieldIcon } from 'lucide-react';
import type { PermissionMode } from '@rx-artemis/protocol';

import { WithReason } from '../disabled-reason';
import { usePermissionModes } from '../../hooks/useCapability';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  activeProviderLabel,
  setAgentChrome,
  setOpenWebExternally,
  setPermissionMode,
  useApp,
} from '../../state/store';
import { usePane } from '../../state/paneContext';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
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
  'Artemis has nowhere to keep this yet. The protocol carries it per run, but no setting writes it, so anything typed here would be lost when this dialog closes.';

export function PermissionsSection(): ReactElement {
  const modes = usePermissionModes();
  const mode = usePane((s) => s.permissionMode);
  const providerLabel = usePane(activeProviderLabel);
  const chrome = useApp((s) => s.agentChrome);
  const external = useApp((s) => s.openWebExternally);

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
      title="Permissions & access"
      description="When the agent has to stop and ask you, what it is allowed to reach, and whose browser it reaches the web through."
    >
      <SettingsGroup label="Default permission mode">
        {modes.length === 0 ? (
          <Empty className="mx-3 my-2.5 border border-dashed border-hairline py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldIcon />
              </EmptyMedia>
              <EmptyTitle className="text-ink">No permission modes to choose from</EmptyTitle>
              <EmptyDescription className="text-2xs">
                {providerLabel} does not expose permission modes. It decides on its own whether to
                prompt, and Artemis has no way to ask it for something different.
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
            <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
              Applies to the next run. A run already in flight keeps the mode it started with.
            </p>
            {orphaned ? (
              <p className="px-3 py-2.5 text-2xs leading-relaxed text-amber">
                “{mode}” was chosen under a different provider. {providerLabel} does not accept it,
                so the next run will use the provider’s own default until you pick one above.
              </p>
            ) : null}
          </>
        )}
      </SettingsGroup>

      {/* After the mode list, deliberately: the modes decide what runs without
          asking, and these decide what the agent may reach while it runs —
          the same question, asked of the web. See the file header. */}
      <SettingsGroup label="Agent browsing">
        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Browse with your Chrome</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Claude sessions drive your own Chrome through the Claude in Chrome extension: tabs
                open in a colour-coded group in your real browser, with your logins and your
                password manager, and the agent can read and act on what it opened while you keep
                using other tabs. Needs the extension installed and a profile signed in with an
                account — a profile using an API key keeps this off, silently, because the
                extension cannot authenticate with one. The embedded dock browser is not offered
                to these runs. Applies to Claude accounts running on this machine: a session on an
                Artemis Server account runs on the server, which cannot reach this browser. If the
                extension does not connect on the first enabled run, restart Chrome once — it only
                discovers newly installed connectors at startup — and approve the connection when
                the extension asks.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-agent-chrome"
                aria-label="Browse with your Chrome"
                checked={chrome}
                onCheckedChange={setAgentChrome}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Pages opened for you">
        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Open pages in your default browser</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Previews and pages the agent opens land in your default browser — signed in,
                password manager and all — instead of the embedded dock browser. The agent keeps a
                way to show you a page and loses the ability to read or click it, so it is told to
                verify its work through logs and tests, or to ask you. Applies to every provider.
                When Chrome browsing above is on, Claude runs use that richer bridge instead.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-open-web-externally"
                aria-label="Open pages in your default browser"
                checked={external}
                onCheckedChange={setOpenWebExternally}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
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
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          Until these are real settings, tool policy comes from wherever the provider’s own CLI
          reads it — its config file for this project. Artemis sends no allow list and no deny list,
          so nothing here is silently overriding what you configured there.
        </p>
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          <span className="text-ink-muted">Additional directories</span> are set per session, not
          here: open the directory chip above the composer and use{' '}
          <span className="text-ink-muted">Additional folders</span> to let a run read outside the
          project. Enabled team memory banks are attached there automatically.
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
    <Field className="px-3 py-2.5">
      <FieldLabel htmlFor={id} className="chrome-label text-ink-faint">
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
