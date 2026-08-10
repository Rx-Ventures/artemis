/**
 * The status line.
 * ============================================================================
 *
 * One always-visible row across the bottom of the window carrying everything
 * that decides what the *next* prompt will do, and nothing that does not:
 *
 *     [profile ▾] [model ▾] [fast|ultra] [thinking ▾] [mode ▾]   ◔ 61%  ~/proj
 *
 * Everything left of the gauge changes a setting in place; everything right of
 * it is read-only text. That split is the whole design: a setting you can
 * change is a control, a fact about the run is text, and nothing here is both.
 *
 * The gauge opens the usage popover, which carries the context window and the
 * plan's rate-limit windows together — both answer "how much room is left",
 * and they used to be split across two controls.
 *
 * ## Every list comes off the provider descriptor
 *
 * Profiles from `profiles:list`; models, effort levels and permission modes
 * from `providers:list`, with the model list preferring the live catalogue the
 * account actually reported (see `activeModels`). Not one of them is a literal
 * in this file. A second provider offers different models and a different
 * effort scale — quite possibly none at all — and a hard-coded list would show
 * Anthropic's options under a provider that has never heard of them. Where a
 * provider offers nothing, the segment renders **disabled with the reason
 * attached** rather than vanishing, which is the same rule every other degraded
 * control follows.
 *
 * ## The model picker is a short list with a door out of it
 *
 * The catalogue is now as long as whatever the installed CLI ships, which is
 * too long for a menu opened off a 20px bar. So the picker lists the user's
 * quick-access models (`quickModels`, which stands in the whole catalogue for
 * anyone who has not curated one) and offers "All models…" into the settings
 * pane for the rest. The currently selected model is appended when it is not
 * among the pinned ones — a picker that cannot show its own current value is
 * worse than a long one.
 *
 * ## Fast mode and ultracode are model properties, shown twice
 *
 * They appear as toggles on the bar *and* inside the model menu. That is not
 * duplication for its own sake: on the bar they are one click away from any
 * prompt, and in the menu they sit under the model that determines whether
 * they exist at all, which is where a user works out why they are dimmed.
 *
 * Both are gated on the selected model's `supportsFastMode` /
 * `supportsUltracode`, and — like everything else here — an unsupported one is
 * rendered dead with the reason rather than removed. They are styled as
 * run-shaping settings (cyan and brass, the same weight as thinking effort),
 * deliberately *not* as hazards: `bypassPermissions` is the only control on
 * this bar that gets the signal colour, and diluting it would cost the thing
 * that makes it work.
 *
 * The two are mutually exclusive; see {@link setFastMode}.
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

import { useMemo, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import {
  BrainIcon,
  ChevronsUpDownIcon,
  CpuIcon,
  FolderIcon,
  GitBranchIcon,
  KeyRoundIcon,
  ListTreeIcon,
  PanelLeftIcon,
  ShieldAlertIcon,
  ShieldIcon,
  SparklesIcon,
  ZapIcon,
} from 'lucide-react';
import type { PermissionMode, ProfileId, ProviderModelOption } from '@libra/protocol';

import { keyLabel } from '../hooks/useHotkeys';
import { usePermissionModes } from '../hooks/useCapability';
import { describeCredential, resolveAuthMode, resolveBackend } from '../lib/authModes';
import { shortenPath } from '../lib/paths';
import {
  activeEffort,
  activeEffortLevels,
  activeModel,
  activeModels,
  activeProfile,
  activeProvider,
  activeProviderLabel,
  fastModeAvailable,
  isLive,
  lastKnownBranch,
  openSettings,
  quickModels,
  selectedModelOption,
  setEffort,
  setFastMode,
  setModel,
  setPermissionMode,
  setProfile,
  setUltracode,
  toggleSidebar,
  ultracodeAvailable,
  useApp,
} from '../state/store';
import { WorkingDirectoryDialog } from './WorkingDirectory';
import { IconButton, WithReason } from './disabled-reason';
import { PlanUsageMeter } from './PlanUsageMeter';
import { StatusDot, ToneBadge } from './primitives';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toggle } from '@/components/ui/toggle';
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
        {/*
          No divider between the model picker and these two. The dividers on
          this bar separate independent settings, and fast mode and ultracode
          are not independent of the model — they are properties of whichever
          one is selected, and sitting flush against it is what says so.
        */}
        <RunShapeToggles />
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
        <DropdownMenuItem className="text-2xs" onSelect={() => openSettings('profiles')}>
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
  const catalogue = useApp(activeModels);
  const quick = useApp(quickModels);
  const selected = useApp(activeModel);
  const stored = useApp((s) => s.model);
  const providerLabel = useApp(activeProviderLabel);
  // What the *run* reports it is actually using, which can differ from what was
  // asked for — the provider may substitute. Shown once it is known.
  const running = useApp((s) => s.run?.model);

  /*
   * The pinned models, plus the selected one when it is not among them.
   *
   * That second half is not a nicety. `quickModels` is a *user's shortlist*,
   * and nothing stops them selecting a model from the full catalogue in
   * settings and then never pinning it — at which point a picker built from the
   * shortlist alone would open with no row matching its own trigger, and the
   * radio group would render as if nothing were selected. Appending it costs
   * one row and removes the whole class of bug.
   *
   * Memoised for stable row identity, not for speed: unlike the store's
   * `quickModels`, this array never crosses a zustand selector's identity
   * check, so an unmemoised version would be merely wasteful rather than a
   * render loop.
   */
  const listed = useMemo(() => {
    if (selected === undefined || quick.some((m) => m.id === selected.id)) return quick;
    return [...quick, selected];
  }, [quick, selected]);

  if (catalogue.length === 0) {
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
  // Whether this menu is showing a shortlist or the lot. Only worth saying when
  // it is a shortlist — "there are 9 more of these" is information; "there are
  // 0 more" is noise.
  const hidden = catalogue.length - listed.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SegmentTrigger
          label="Model"
          icon={<CpuIcon className="size-3 shrink-0" aria-hidden="true" />}
          className={cn(selected && 'text-ink', orphaned && 'text-amber')}
        >
          {/*
            The *short* label here and the full `displayName` on the rows below.
            This trigger is one segment of five on a 20px bar and "Claude Sonnet
            5 (latest)" would push the rest of the bar off the end of it; the
            menu is where there is room to be unambiguous.
          */}
          {selected?.label ?? (orphaned ? `${stored} (unavailable)` : 'default')}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="min-w-80 max-w-[min(26rem,90vw)]">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          {hidden > 0 ? 'Quick access' : 'Model'} — {providerLabel}
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
          {listed.map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <ModelOptionItems />

        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-1.5 text-2xs" onSelect={() => openSettings('models')}>
          <ListTreeIcon className="size-3 shrink-0" aria-hidden="true" />
          All models and defaults…
          {hidden > 0 ? (
            <span className="ml-auto font-mono text-2xs text-ink-faint">{hidden} more</span>
          ) : null}
        </DropdownMenuItem>

        {running ? (
          <p className="px-2 pt-0.5 pb-1.5 font-mono text-2xs text-ink-faint">
            this run reports: {running}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One model in the picker: full name, what it is for, and the wire id.
 *
 * All three, because they answer three different questions and only the first
 * is guessable from the trigger. `resolvedModel` in particular is what an alias
 * like `sonnet` actually resolves to today — Libra offers aliases rather than
 * dated snapshots, so without it the menu never says which model that is, and
 * "which snapshot am I on" is a question people ask a bill about.
 *
 * The two flag icons repeat the status-line toggles exactly, colour included.
 * That is the point: a user wondering why the cyan lightning is dim looks at
 * this list and sees which models carry it.
 */
function ModelRow({ model }: { readonly model: ProviderModelOption }): ReactElement {
  return (
    <DropdownMenuRadioItem value={model.id} className="items-start text-2xs">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ink">{model.displayName ?? model.label}</span>
          {model.supportsFastMode === true ? (
            <>
              <ZapIcon className="size-2.5 shrink-0 text-cyan" aria-hidden="true" />
              <span className="sr-only">offers fast mode</span>
            </>
          ) : null}
          {model.supportsUltracode === true ? (
            <>
              <SparklesIcon className="size-2.5 shrink-0 text-brass" aria-hidden="true" />
              <span className="sr-only">offers ultracode</span>
            </>
          ) : null}
          {model.adaptiveThinking === true ? (
            <ToneBadge tone="sage" className="shrink-0">
              adaptive
            </ToneBadge>
          ) : null}
        </span>
        <span className="text-2xs leading-snug text-ink-faint">{model.note}</span>
        {model.resolvedModel ? (
          <span className="truncate font-mono text-2xs text-ink-faint/75">
            {model.resolvedModel}
          </span>
        ) : null}
      </span>
    </DropdownMenuRadioItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Fast mode and ultracode                                                    */
/* -------------------------------------------------------------------------- */

/**
/*
 * The mutual exclusion between fast mode and ultracode used to live here, as a
 * pair of `*Exclusive` wrappers this file exported for itself and the command
 * palette to share. It has moved into `setFastMode` / `setUltracode` in the
 * store, because a settings pane calling the plain setters could reach a state
 * with both flags on — see the note on `setFastMode`. Call the store actions
 * directly; there is nothing to wrap.
 */

function modelName(model: ProviderModelOption): string {
  return model.displayName ?? model.label;
}

/**
 * Why fast mode cannot be used, or `undefined` when it can.
 *
 * One function rather than three copies, because the toggle on the bar, the row
 * inside the menu and the command in the palette must give the same answer —
 * and this is the answer, not a tooltip string: `fastModeAvailable` decides
 * *whether*, this says *why*.
 *
 * The trailing sentence about the stored preference matters more than it looks.
 * The store keeps the flag on across a model switch on purpose, but the control
 * shows off, because showing it on next to a model that ignores it would be a
 * lie about what the next run does. Saying so is what stops that reading as a
 * setting Libra quietly threw away.
 */
export function fastModeReason(
  model: ProviderModelOption | undefined,
  on: boolean,
): string | undefined {
  const kept = on ? ' It stays on and applies again on a model that offers it.' : '';
  if (model === undefined) {
    return `Fast mode belongs to a specific model, and “provider default” means Libra does not know which one will run — so it will not offer a switch whose effect it cannot promise. Choose a model.${kept}`;
  }
  if (model.supportsFastMode !== true) {
    return `${modelName(model)} does not offer fast mode.${kept}`;
  }
  return undefined;
}

/** The same question for ultracode. Separate flag, separate answer. */
export function ultracodeReason(
  model: ProviderModelOption | undefined,
  on: boolean,
): string | undefined {
  const kept = on ? ' It stays on and applies again on a model that offers it.' : '';
  if (model === undefined) {
    return `Ultracode belongs to a specific model, and “provider default” means Libra does not know which one will run. Choose a model.${kept}`;
  }
  if (model.supportsUltracode !== true) {
    return `${modelName(model)} does not offer ultracode — it needs a model that can think at xhigh effort.${kept}`;
  }
  return undefined;
}

/** The pair of toggles that ride next to the model picker. */
function RunShapeToggles(): ReactElement {
  const model = useApp(selectedModelOption);
  const fastOk = useApp(fastModeAvailable);
  const ultraOk = useApp(ultracodeAvailable);
  const fast = useApp((s) => s.fastMode);
  const ultra = useApp((s) => s.ultracode);

  return (
    <ButtonGroup className="shrink-0" aria-label="Run shaping">
      <ShapeToggle
        name="Fast mode"
        short="fast"
        icon={<ZapIcon className="size-2.5 shrink-0" aria-hidden="true" />}
        hint="Answer sooner, thinking less. Best on edits you can check at a glance."
        activeClass="border-cyan/40 text-cyan aria-pressed:bg-cyan/10 data-[state=on]:bg-cyan/10 hover:bg-cyan/15 hover:text-cyan"
        // `fastOk && fast`, never `fast` alone: the toggle reports what the next
        // run will do, and on a model without fast mode the answer is "nothing".
        pressed={fastOk && fast}
        reason={fastOk ? undefined : fastModeReason(model, fast)}
        onPressedChange={setFastMode}
      />
      <ShapeToggle
        name="Ultracode"
        short="ultra"
        icon={<SparklesIcon className="size-2.5 shrink-0" aria-hidden="true" />}
        hint="Think as hard as the model can before writing. Slower, and worth it on a design you cannot easily undo."
        activeClass="border-brass/40 text-brass aria-pressed:bg-brass/10 data-[state=on]:bg-brass/10 hover:bg-brass/15 hover:text-brass"
        pressed={ultraOk && ultra}
        reason={ultraOk ? undefined : ultracodeReason(model, ultra)}
        onPressedChange={setUltracode}
      />
    </ButtonGroup>
  );
}

/**
 * One run-shaping toggle, always tooltipped: the hint when it works, the reason
 * when it does not.
 *
 * Unavailable does **not** mean `disabled`. A natively disabled control takes
 * no pointer events and no focus, so the tooltip carrying the explanation could
 * never open for a mouse or a keyboard — the argument set out at length in
 * `disabled-reason.tsx`, applied here to a Radix toggle. Instead it keeps
 * `aria-disabled`, and the change handler is swapped for a no-op: `pressed` is
 * controlled, so a click that reaches the primitive still cannot move it.
 */
function ShapeToggle({
  name,
  short,
  icon,
  hint,
  activeClass,
  pressed,
  reason,
  onPressedChange,
}: {
  readonly name: string;
  readonly short: string;
  readonly icon: ReactNode;
  readonly hint: string;
  readonly activeClass: string;
  readonly pressed: boolean;
  readonly reason: string | undefined;
  readonly onPressedChange: (on: boolean) => void;
}): ReactElement {
  const dead = reason !== undefined;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          aria-label={name}
          aria-disabled={dead ? true : undefined}
          pressed={pressed}
          onPressedChange={dead ? noop : onPressedChange}
          className={cn(
            'h-5 min-w-0 shrink-0 gap-1 border border-transparent px-1.5 font-mono text-2xs font-normal text-ink-faint',
            /*
             * `activeClass` states its background under the *same* variants the
             * toggle's own styles use — `aria-pressed:` and `data-[state=on]:`
             * — rather than as a plain `bg-*`. It has to: the base variant sets
             * `aria-pressed:bg-muted`, an attribute selector, which outranks an
             * unmodified class no matter what order they appear in. Matching
             * the modifier is what lets tailwind-merge drop the grey instead of
             * layering a losing rule underneath it.
             */
            pressed && activeClass,
            dead && 'cursor-not-allowed opacity-50',
          )}
        >
          {icon}
          {short}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-xs">
        {reason ?? hint}
      </TooltipContent>
    </Tooltip>
  );
}

function noop(): void {}

/**
 * The same two flags, inside the model menu, where they read as properties of
 * the model above them.
 *
 * Menu items rather than the bar's toggles: this is a menu, so the things in it
 * should be reachable with the arrow keys and announced as
 * `menuitemcheckbox`es. A pair of buttons dropped into `DropdownMenuContent`
 * would look identical and be unreachable without a mouse.
 */
function ModelOptionItems(): ReactElement {
  const model = useApp(selectedModelOption);
  const fastOk = useApp(fastModeAvailable);
  const ultraOk = useApp(ultracodeAvailable);
  const fast = useApp((s) => s.fastMode);
  const ultra = useApp((s) => s.ultracode);

  return (
    <>
      <DropdownMenuLabel className="text-2xs text-ink-faint">
        {model ? `${modelName(model)} — options` : 'Model options'}
      </DropdownMenuLabel>
      <OptionItem
        name="Fast mode"
        note="Answer sooner, thinking less."
        icon={<ZapIcon className="size-3 shrink-0 text-cyan" aria-hidden="true" />}
        checked={fastOk && fast}
        reason={fastOk ? undefined : fastModeReason(model, fast)}
        onCheckedChange={setFastMode}
      />
      <OptionItem
        name="Ultracode"
        note="Think as hard as the model can before writing."
        icon={<SparklesIcon className="size-3 shrink-0 text-brass" aria-hidden="true" />}
        checked={ultraOk && ultra}
        reason={ultraOk ? undefined : ultracodeReason(model, ultra)}
        onCheckedChange={setUltracode}
      />
    </>
  );
}

function OptionItem({
  name,
  note,
  icon,
  checked,
  reason,
  onCheckedChange,
}: {
  readonly name: string;
  readonly note: string;
  readonly icon: ReactNode;
  readonly checked: boolean;
  readonly reason: string | undefined;
  readonly onCheckedChange: (on: boolean) => void;
}): ReactElement {
  const dead = reason !== undefined;
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      disabled={dead}
      /*
       * Selecting a checkbox item closes the menu. Here it must not: these are
       * properties of the model listed directly above, and closing the menu to
       * report a one-bit change would take away the rows that give it meaning —
       * including the *other* flag, which this one may have just turned off.
       */
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={dead ? noop : onCheckedChange}
      // The reason is rendered as part of the row, so the row must stay legible
      // even though it is disabled; the palette's `GatedItem` does the same.
      className={cn('items-start text-2xs', dead && 'opacity-100')}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn('flex items-center gap-1.5', dead ? 'text-ink-faint' : 'text-ink')}>
          {icon}
          {name}
        </span>
        <span className="text-2xs leading-snug text-ink-faint">{reason ?? note}</span>
      </span>
    </DropdownMenuCheckboxItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Effort                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How hard the model should think, narrowed to what the selected model accepts.
 *
 * The provider declares a scale; a model declares which rungs of it are real.
 * `ProviderModelOption.effortLevels` is `undefined` for "all of them", a list
 * for "these", and `[]` for "this model takes no effort setting at all" — and
 * the three cases are genuinely different, not a tri-state for its own sake:
 * offering `xhigh` on a model that ignores it sends a parameter the run drops
 * on the floor while the bar goes on claiming it is set.
 *
 * (An earlier version of this comment said no provider declared per-model
 * levels, so the narrowing was not worth building. That stopped being true when
 * the live catalogue landed — the models now arrive carrying their own lists.)
 */
function EffortSegment(): ReactElement {
  const providerLevels = useApp(activeEffortLevels);
  const model = useApp(selectedModelOption);
  const selected = useApp(activeEffort);
  const stored = useApp((s) => s.effort);
  const providerLabel = useApp(activeProviderLabel);

  const allowed = model?.effortLevels;
  const levels = useMemo(
    () =>
      allowed === undefined ? providerLevels : providerLevels.filter((l) => allowed.includes(l.id)),
    [providerLevels, allowed],
  );

  if (providerLevels.length === 0) {
    return (
      <DeadSegment
        label="Thinking"
        icon={<BrainIcon className="size-3 shrink-0" aria-hidden="true" />}
        text="thinking"
        reason={`${providerLabel} does not expose a reasoning-effort setting, so there is nothing to choose.`}
      />
    );
  }

  // The provider has a scale and this model sits outside all of it. Dead for a
  // different reason than the case above, and the reason names the model rather
  // than the provider, because switching model is what fixes it.
  if (levels.length === 0) {
    return (
      <DeadSegment
        label="Thinking"
        icon={<BrainIcon className="size-3 shrink-0" aria-hidden="true" />}
        text="thinking"
        reason={`${model ? modelName(model) : 'This model'} takes no reasoning-effort setting. Another model on ${providerLabel} will.`}
      />
    );
  }

  const orphaned = stored !== null && selected === undefined;
  // Chosen under a different model, and not on this one's scale. The run will
  // fall back to the model's own default, so the bar says so rather than
  // showing a level that is not going to be sent.
  const offModel = selected !== undefined && !levels.some((l) => l.id === selected.id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SegmentTrigger
          label="Thinking"
          icon={<BrainIcon className="size-3 shrink-0" aria-hidden="true" />}
          className={cn(selected && 'text-sage', (orphaned || offModel) && 'text-amber')}
        >
          {offModel
            ? `${selected.label.toLowerCase()} (not on this model)`
            : (selected?.label.toLowerCase() ?? (orphaned ? `${stored} (unavailable)` : 'default'))}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="min-w-72">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Thinking effort — least to most
          {allowed === undefined || model === undefined ? null : ` · ${modelName(model)}`}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={offModel ? '' : (selected?.id ?? '')}
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
        {offModel ? (
          <p className="px-2 pt-1 pb-1.5 text-2xs leading-snug text-amber">
            “{selected.label}” was chosen under a different model.{' '}
            {model ? modelName(model) : 'This model'} does not accept it, so the next run will use
            the model’s own default.
          </p>
        ) : null}
        {model?.adaptiveThinking === true ? (
          <p className="px-2 pt-1 pb-1.5 text-2xs leading-snug text-ink-faint">
            {modelName(model)} decides its own thinking depth, so this is a hint rather than an
            instruction and may not visibly change anything.
          </p>
        ) : null}
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
