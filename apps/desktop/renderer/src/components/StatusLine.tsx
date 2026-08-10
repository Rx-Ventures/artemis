/**
 * The status line.
 * ============================================================================
 *
 * One always-visible row across the bottom of the window carrying everything
 * that decides what the *next* prompt will do, and nothing that does not:
 *
 *     [profile ▾] [model ▾] [thinking ▾] [mode ▾]      ◔ 61%   ~/proj  main
 *
 * The first four segments are pickers that change the setting in place; the
 * last is read-only text. That split is the whole design: a setting you can
 * change is a menu, a fact about the run is text, and nothing here is both.
 *
 * The gauge opens the usage popover, which carries the context window and the
 * plan's rate-limit windows together — both answer "how much room is left",
 * and they used to be split across two controls.
 *
 * ## Every list comes off the provider descriptor
 *
 * Profiles from `profiles:list`; models, effort levels and permission modes
 * from `providers:list`. Not one of them is a literal in this file. A second
 * provider offers different models and a different effort scale — quite
 * possibly none at all — and a hard-coded list would show Anthropic's options
 * under a provider that has never heard of them. Where a provider offers
 * nothing, the segment renders **disabled with the reason attached** rather
 * than vanishing, which is the same rule every other degraded control follows.
 *
 * ## The profile segment is the reason this work exists
 *
 * It names the profile, its billing arrangement (API key or subscription) and
 * its masked key hint, because "which account is about to be charged" must be
 * answerable by looking rather than by opening an editor. The masked hint is
 * the only thing the renderer ever sees of a credential — `ProfileMetadata`
 * carries no secret ref, no config directory and no env bundle — so there is
 * nothing on this bar that could be turned back into a key.
 *
 * ## Why permission mode is here
 *
 * It is a fifth picker in a spec that named four, added deliberately. It is the
 * single most safety-relevant setting in the app: `bypassPermissions` runs every
 * tool call without asking, and a control that dangerous must be visible at all
 * times rather than folded into a command palette the user has to go looking
 * for. It is styled as the hazard it is when selected.
 *
 * ## It sits under the composer, not across the window
 *
 * These controls describe what the *prompt you are typing* will do, so they
 * line up with the input's edges (`max-w-4xl`) rather than running the full
 * width of a pane the input does not fill. The composer draws the border above
 * them; a second one here would box the input in.
 *
 * The sidebar toggle rides along at the far left despite acting on the window
 * rather than the prompt. It has to: `Sidebar` renders nothing when collapsed,
 * so its own close button cannot reopen it, and this is the only always-present
 * control that can.
 */

import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import {
  BrainIcon,
  ChevronsUpDownIcon,
  CpuIcon,
  FolderIcon,
  GaugeIcon,
  GitBranchIcon,
  KeyRoundIcon,
  PanelLeftIcon,
  ShieldAlertIcon,
  ShieldIcon,
} from 'lucide-react';
import type { PermissionMode, ProfileId } from '@libra/protocol';

import { keyLabel } from '../hooks/useHotkeys';
import { usePermissionModes } from '../hooks/useCapability';
import { describeCredential, resolveAuthMode, resolveBackend } from '../lib/authModes';
import { formatTokens, formatUsd } from '../lib/format';
import { shortenPath } from '../lib/paths';
import {
  activeCapabilities,
  activeEffort,
  activeEffortLevels,
  activeModel,
  activeModels,
  activeProfile,
  activeProvider,
  activeProviderLabel,
  isLive,
  lastKnownBranch,
  setEffort,
  setInfo,
  setModel,
  setPermissionMode,
  setProfile,
  setScreen,
  toggleSidebar,
  useApp,
} from '../state/store';
import { WorkingDirectoryDialog } from './WorkingDirectory';
import { IconButton, WithReason } from './disabled-reason';
import { PlanUsageMeter } from './PlanUsageMeter';
import { StatusDot, ToneBadge } from './primitives';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'plan',
  default: 'ask',
  acceptEdits: 'accept edits',
  auto: 'auto',
  dontAsk: 'never ask',
  bypassPermissions: 'bypass',
};

const MODE_NOTES: Record<PermissionMode, string> = {
  plan: 'Research and propose only. No file is written and no command runs.',
  default: 'Prompt for anything not already allowed.',
  acceptEdits: 'Auto-approve file edits; prompt for everything else.',
  auto: 'The provider’s own classifier decides, and prompts on risk.',
  dontAsk: 'Never prompt — deny instead of asking.',
  bypassPermissions: 'Approve everything. Every tool call runs without asking.',
};

/**
 * The controls that describe what the next prompt will do.
 *
 * Sits directly under the composer rather than in a bar across the foot of the
 * window. Two consequences are deliberate:
 *
 *  - **No top border.** The composer already draws one above itself; a second
 *    one here would box the input in a way nothing else in the app is.
 *  - **Same `max-w-4xl` as the composer.** These controls belong to the input,
 *    so they line up with its edges instead of running the full width of a
 *    pane the input does not fill.
 *
 * The sidebar toggle stays, and has to: `Sidebar` renders nothing at all when
 * collapsed, so its own close button cannot reopen it. This is the only
 * always-present control that can, and dropping it would make collapsing the
 * sidebar a one-way door for anyone who does not know `mod+b`.
 */
export function StatusLine(): ReactElement {
  return (
    <footer className="shrink-0 bg-panel">
      <div className="mx-auto flex h-7 w-full max-w-4xl items-center gap-0.5 px-3 text-2xs">
        <SidebarToggle />
        <Divider />
        <ProfileSegment />
        <Divider />
        <ModelSegment />
        <Divider />
        <EffortSegment />
        <Divider />
        <ModeSegment />

        <div className="ml-auto flex min-w-0 items-center gap-0.5">
          <RunSegment />
          {/*
            The context readout used to sit here. It moved into the usage
            popover, where it belongs next to the plan limits — both answer
            "how much room is left", and splitting them across two controls
            meant checking two places.
          */}
          <PlanUsageMeter />
          <Divider />
          <LocationSegment />
        </div>
      </div>
    </footer>
  );
}

function Divider(): ReactElement {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-line" />;
}

/**
 * Show/hide the session sidebar.
 *
 * Lives here rather than only inside the sidebar for the obvious reason: a
 * control that disappears along with the thing it controls leaves a collapsed
 * sidebar reachable only by remembering a shortcut.
 */
function SidebarToggle(): ReactElement {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  return (
    <IconButton
      size="icon-xs"
      label={`${collapsed ? 'Show' : 'Hide'} the session sidebar (${keyLabel('mod+b')})`}
      onClick={toggleSidebar}
      className={cn('shrink-0', collapsed ? 'text-ink-muted' : 'text-ink-faint')}
    >
      <PanelLeftIcon />
    </IconButton>
  );
}

/**
 * Shared chrome for a picker's trigger.
 *
 * A `ghost` button at `xs`, not a `Select`: these are compact menus over a
 * dense bar, and a select trigger carries a border and a fixed width that would
 * turn a status line into a toolbar.
 *
 * ## `...rest` is load-bearing, not tidiness
 *
 * Every use of this sits under `<DropdownMenuTrigger asChild>`, which renders a
 * Radix `Slot`: it clones this element and merges the trigger's own props onto
 * it — `onPointerDown`, `aria-expanded`, `data-state`, `id`, and the ref the
 * menu positions itself against. Because the immediate child of `Slot` is this
 * *component* rather than a DOM element, those props arrive here as ordinary
 * props and are only wired up if this component passes them on.
 *
 * An earlier version destructured the four props it cared about and dropped the
 * rest. It looked completely fine — the button rendered, styled correctly, took
 * focus — and not one of the four pickers opened, because the click handler had
 * been quietly thrown away. Keep the spread.
 */
function SegmentTrigger({
  icon,
  children,
  className,
  label,
  ...rest
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
} & ComponentProps<typeof Button>): ReactElement {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={label}
      {...rest}
      className={cn(
        'h-5 max-w-[15rem] min-w-0 gap-1 px-1.5 font-mono text-2xs font-normal text-ink-muted',
        className,
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      <ChevronsUpDownIcon className="size-2.5 shrink-0 opacity-50" aria-hidden="true" />
    </Button>
  );
}

/** A segment that cannot be used, rendered disabled with the reason attached. */
function DeadSegment({
  icon,
  text,
  reason,
  label,
}: {
  readonly icon: ReactNode;
  readonly text: string;
  readonly reason: string;
  readonly label: string;
}): ReactElement {
  return (
    <WithReason reason={reason} side="top" align="start">
      <span
        aria-label={label}
        aria-disabled="true"
        className="flex h-5 max-w-[15rem] cursor-not-allowed items-center gap-1 px-1.5 font-mono text-2xs text-ink-faint opacity-70"
      >
        {icon}
        <span className="truncate">{text}</span>
      </span>
    </WithReason>
  );
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

function ProfileSegment(): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const providerId = useApp((s) => s.activeProviderId);
  const activeId = useApp((s) => s.activeProfileId);
  const profile = useApp(activeProfile);
  const provider = useApp(activeProvider);

  const forProvider = profiles.filter((p) => p.providerId === providerId);
  const backend = resolveBackend(provider, profile?.backend);
  const authMode = resolveAuthMode(provider, profile?.backend, profile?.authMode);
  const credential = profile ? describeCredential(backend, authMode) : undefined;

  // A credential that is missing *and needed* is the only thing worth an amber
  // segment. A profile on an ambient-chain backend legitimately stores none.
  const needsKey = credential?.usesStoredSecret === true && !profile?.keyHint;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SegmentTrigger
          label="Profile"
          icon={<KeyRoundIcon className="size-3 shrink-0" aria-hidden="true" />}
          className={cn(needsKey && 'text-amber', profile && 'text-ink')}
        >
          {profile?.label ?? 'no profile'}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-96 max-w-[min(24rem,90vw)]">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Profile — credentials and billing
        </DropdownMenuLabel>

        {forProvider.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
            No profile exists for this provider yet. A run needs credentials, which come from a
            profile.
          </p>
        ) : (
          <DropdownMenuRadioGroup
            value={activeId ?? ''}
            onValueChange={(value) => setProfile(value as ProfileId)}
          >
            {forProvider.map((candidate) => (
              <ProfileItem key={candidate.id} id={candidate.id} />
            ))}
          </DropdownMenuRadioGroup>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-2xs" onSelect={() => setScreen('profiles')}>
          Manage profiles…
        </DropdownMenuItem>
        <p className="px-2 pt-1 pb-1.5 text-2xs leading-snug text-ink-faint">
          Credentials live in the OS keychain. This window only ever receives a masked hint.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One profile row: label, billing arrangement, masked hint. */
function ProfileItem({ id }: { readonly id: ProfileId }): ReactElement | null {
  const profile = useApp((s) => s.profiles.find((p) => p.id === id));
  const provider = useApp((s) => s.providers.find((p) => p.id === profile?.providerId));
  if (!profile) return null;

  const backend = resolveBackend(provider, profile.backend);
  const mode = resolveAuthMode(provider, profile.backend, profile.authMode);
  const credential = describeCredential(backend, mode);
  const missing = credential?.usesStoredSecret === true && !profile.keyHint;

  return (
    <DropdownMenuRadioItem value={profile.id} className="items-start gap-2 text-2xs">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/*
         * `min-w-0 flex-1` on the label and `shrink-0` on the badges, in that
         * combination. Without it the badges — which have their own intrinsic
         * width and no reason to yield — squeeze the label to nothing, and a
         * profile row ends up showing its billing arrangement and no name at
         * all. Which of the two the user needs more is not a close call.
         */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-ink">{profile.label}</span>
          {credential ? (
            <ToneBadge
              tone={credential.usesStoredSecret ? 'brass' : 'neutral'}
              className="shrink-0"
            >
              {credential.label}
            </ToneBadge>
          ) : null}
          {backend && backend.id !== provider?.backends[0]?.id ? (
            <ToneBadge tone="cyan" className="shrink-0">
              {backend.label}
            </ToneBadge>
          ) : null}
        </span>
        <span className={cn('font-mono text-2xs', missing ? 'text-amber' : 'text-ink-faint')}>
          {profile.keyHint ?? (missing ? 'no credential stored — this backend needs one' : 'no credential needed')}
        </span>
      </span>
    </DropdownMenuRadioItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

function ModelSegment(): ReactElement {
  const models = useApp(activeModels);
  const selected = useApp(activeModel);
  const stored = useApp((s) => s.model);
  const providerLabel = useApp(activeProviderLabel);
  // What the *run* reports it is actually using, which can differ from what was
  // asked for — the provider may substitute. Shown once it is known.
  const running = useApp((s) => s.run?.model);

  if (models.length === 0) {
    return (
      <DeadSegment
        label="Model"
        icon={<CpuIcon className="size-3 shrink-0" aria-hidden="true" />}
        text={running ?? 'model'}
        reason={`${providerLabel} does not offer a model choice, so Libra sends no model and the provider picks its own.`}
      />
    );
  }

  // A stored id the current provider does not offer is not silently ignored:
  // the run will use the provider default, so the bar says so.
  const orphaned = stored !== null && selected === undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SegmentTrigger
          label="Model"
          icon={<CpuIcon className="size-3 shrink-0" aria-hidden="true" />}
          className={cn(selected && 'text-ink', orphaned && 'text-amber')}
        >
          {selected?.label ?? (orphaned ? `${stored} (unavailable)` : 'default')}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="min-w-72">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Model — {providerLabel}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selected?.id ?? ''}
          onValueChange={(value) => setModel(value === '' ? null : value)}
        >
          <DropdownMenuRadioItem value="" className="items-start text-2xs">
            <span className="flex min-w-0 flex-col">
              <span className="text-ink">Provider default</span>
              <span className="text-2xs text-ink-faint">
                Send no model and let {providerLabel} choose.
              </span>
            </span>
          </DropdownMenuRadioItem>
          {models.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id} className="items-start text-2xs">
              <span className="flex min-w-0 flex-col">
                <span className="text-ink">{model.label}</span>
                <span className="text-2xs leading-snug text-ink-faint">{model.note}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {running ? (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 pt-0.5 pb-1.5 font-mono text-2xs text-ink-faint">
              this run reports: {running}
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------------- */
/* Effort                                                                     */
/* -------------------------------------------------------------------------- */

function EffortSegment(): ReactElement {
  const levels = useApp(activeEffortLevels);
  const selected = useApp(activeEffort);
  const stored = useApp((s) => s.effort);
  const providerLabel = useApp(activeProviderLabel);

  if (levels.length === 0) {
    return (
      <DeadSegment
        label="Thinking"
        icon={<BrainIcon className="size-3 shrink-0" aria-hidden="true" />}
        text="thinking"
        reason={`${providerLabel} does not expose a reasoning-effort setting, so there is nothing to choose.`}
      />
    );
  }

  const orphaned = stored !== null && selected === undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SegmentTrigger
          label="Thinking"
          icon={<BrainIcon className="size-3 shrink-0" aria-hidden="true" />}
          className={cn(selected && 'text-sage', orphaned && 'text-amber')}
        >
          {selected?.label.toLowerCase() ?? (orphaned ? `${stored} (unavailable)` : 'default')}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="min-w-72">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Thinking effort — least to most
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selected?.id ?? ''}
          onValueChange={(value) => setEffort(value === '' ? null : value)}
        >
          <DropdownMenuRadioItem value="" className="items-start text-2xs">
            <span className="flex min-w-0 flex-col">
              <span className="text-ink">Provider default</span>
              <span className="text-2xs text-ink-faint">Send no effort setting at all.</span>
            </span>
          </DropdownMenuRadioItem>
          {levels.map((level) => (
            <DropdownMenuRadioItem key={level.id} value={level.id} className="items-start text-2xs">
              <span className="flex min-w-0 flex-col">
                <span className="text-ink">{level.label}</span>
                <span className="text-2xs leading-snug text-ink-faint">{level.note}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------------- */
/* Permission mode                                                            */
/* -------------------------------------------------------------------------- */

function ModeSegment(): ReactElement {
  const modes = usePermissionModes();
  const mode = useApp((s) => s.permissionMode);
  const providerLabel = useApp(activeProviderLabel);

  if (modes.length === 0) {
    return (
      <DeadSegment
        label="Permission mode"
        icon={<ShieldIcon className="size-3 shrink-0" aria-hidden="true" />}
        text="mode"
        reason={`${providerLabel} does not expose permission modes. It decides on its own whether to prompt.`}
      />
    );
  }

  const offered = modes.includes(mode);
  const dangerous = mode === 'bypassPermissions' && offered;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SegmentTrigger
          label="Permission mode"
          icon={
            dangerous ? (
              <ShieldAlertIcon className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <ShieldIcon className="size-3 shrink-0" aria-hidden="true" />
            )
          }
          className={cn('text-ink', dangerous && 'text-signal', !offered && 'text-amber')}
        >
          {offered ? MODE_LABELS[mode] : `${mode} (not accepted)`}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="min-w-80">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          When should the agent ask before acting?
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => setPermissionMode(value as PermissionMode)}
        >
          {modes.map((value) => (
            <DropdownMenuRadioItem key={value} value={value} className="items-start text-2xs">
              <span className="flex min-w-0 flex-col">
                <span className={cn(value === 'bypassPermissions' ? 'text-signal' : 'text-ink')}>
                  {MODE_LABELS[value]}
                </span>
                <span className="text-2xs leading-snug text-ink-faint">{MODE_NOTES[value]}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {offered ? null : (
          <p className="px-2 pt-1 pb-1.5 text-2xs leading-snug text-amber">
            “{mode}” was chosen under a different provider. {providerLabel} does not accept it, so
            the next run will use the provider’s own default.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------------- */
/* Run state                                                                  */
/* -------------------------------------------------------------------------- */

/** Live status and the count of prompts waiting on the user. Read-only. */
function RunSegment(): ReactElement | null {
  const live = useApp(isLive);
  const status = useApp((s) => s.run?.status ?? null);
  const pending = useApp((s) => s.permissionQueue.length);

  if (pending > 0) {
    return (
      <span className="flex shrink-0 items-center gap-1 px-1.5 font-mono text-2xs text-amber">
        <ShieldAlertIcon className="size-3" aria-hidden="true" />
        {pending} awaiting you
      </span>
    );
  }
  if (!status) return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5 px-1.5 font-mono text-2xs text-ink-faint">
      <StatusDot tone={live ? 'cyan' : 'neutral'} pulse={live} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */



/* -------------------------------------------------------------------------- */
/* Location                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Working directory and branch.
 *
 * The directory half is now a control rather than a readout: it opens the same
 * chooser the sidebar and the palette use, which offers the host's folder
 * picker when the bridge exposes one and a validated path field when it does
 * not. It is still not an *inline* editable field — a half-typed path committed
 * by a stray blur is exactly the failure a bar like this invites — so it opens
 * a dialog and commits deliberately.
 *
 * The branch is a last-known value read off session history for this directory;
 * see `lastKnownBranch` for why it cannot be live.
 */
function LocationSegment(): ReactElement {
  const cwd = useApp((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const branch = useApp(lastKnownBranch);
  const [open, setOpen] = useState(false);
  const unset = cwd.trim().length === 0;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setOpen(true)}
            aria-label="Working directory — change it"
            className={cn(
              'h-5 min-w-0 gap-1.5 px-1.5 font-mono text-2xs font-normal',
              unset ? 'text-amber' : 'text-ink-faint',
            )}
          >
            <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className={cn('truncate', !unset && 'text-ink-muted')}>
              {unset ? 'no directory' : shortenPath(cwd, { platform, max: 28 })}
            </span>
            {branch ? (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranchIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{branch}</span>
              </span>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="max-w-md">
          {unset ? (
            <span>
              No working directory set — the agent needs an absolute path to work in. Click to
              choose one.
            </span>
          ) : (
            <span className="font-mono">{cwd}</span>
          )}
          {branch ? (
            <span className="mt-1 block text-ink-faint">
              Branch “{branch}” is the last one recorded in this directory’s session history — Libra
              cannot read the working tree, so it may be out of date.
            </span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <WorkingDirectoryDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
