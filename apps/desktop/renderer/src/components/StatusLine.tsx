/**
 * The status line.
 * ============================================================================
 *
 * One always-visible row across the bottom of the window carrying everything
 * that decides what the *next* prompt will do, and nothing that does not:
 *
 *     [profile ▾] [model ▾] [mode ▾]                    ◔ 61%  ~/proj  main
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
 * ## Everything about *how* the model runs is in the model popover
 *
 * Model, thinking and fast mode were four separate segments on this bar. They
 * are all properties of one choice, so they now share one popover: the model
 * list, then thinking, fast mode and context under it. Thinking is a single
 * ladder from `low` up to ultracode — see `thinkingLevels` for why ultracode is
 * a rung rather than a switch of its own.
 *
 * Fast mode disables *without* a reason on a model that does not offer it,
 * which is a deliberate exception to the rule below. That rule earns its keep
 * when the user can act on the reason; here it is always "this model does not
 * do that", which the disabled state already says.
 *
 * ## The profile segment is the reason this work exists
 *
 * It names the profile, whether that profile is signed in, and the account it
 * is signed in as — because "which account is about to be charged" must be
 * answerable by looking rather than by opening an editor.
 *
 * There is no credential here to reveal or mask. A profile is a config
 * directory, the provider's own login put a credential inside it, and this bar
 * shows only what a status read reported. The amber state means *checked and
 * signed out*, never merely unchecked: a warning on a state nobody has looked
 * at is a warning the user learns to ignore.
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
 * The sidebar toggle used to ride along at the far left. The header carries it
 * now — it is always present, so this bar no longer needs a second copy.
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
  ShieldAlertIcon,
  ShieldIcon,
  SparklesIcon,
  ZapIcon,
} from 'lucide-react';
import type { PermissionMode, ProfileId, ProviderModelOption } from '@rx-apollo/protocol';

import { keyLabel } from '../hooks/useHotkeys';
import { usePermissionModes } from '../hooks/useCapability';
import { shortenPath } from '../lib/paths';
import { formatTokens } from '../lib/format';
import {
  ULTRACODE_LEVEL,
  activeModel,
  activeModels,
  activeProfile,
  activeProvider,
  activeProviderLabel,
  activeThinkingLevel,
  fastModeAvailable,
  isLive,
  lastKnownBranch,
  learnedContextWindow,
  openSettings,
  quickModels,
  setFastMode,
  setModel,
  setPermissionMode,
  setProfile,
  setThinkingLevel,
  thinkingLevels,
  useApp,
} from '../state/store';
import { WorkingDirectoryDialog } from './WorkingDirectory';
import { IconButton, WithReason } from './disabled-reason';
import { PlanUsageMeter } from './PlanUsageMeter';
import { ProfileSwatch, StatusDot, ToneBadge } from './primitives';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
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
  // No fill. These controls belong to the input directly above them, and the
  // composer no longer sits in a bar of its own — filling this strip would
  // re-draw the same bottom panel one row lower.
  return (
    <footer className="shrink-0 pb-1">
      <div className="mx-auto flex h-7 w-full max-w-4xl items-center gap-0.5 px-3 text-2xs">
        <ProfileSegment />
        <Divider />
        {/*
          One control, not four. Model, thinking and fast mode used to be a
          picker plus a picker plus two chips strung along this bar — four
          segments for settings that are all properties of the *same* choice.
          They now share a single popover: pick a model, then shape how it runs.
          Everything that was on the bar is one click away instead of zero, and
          the bar is short enough to read.
        */}
        <ModelSegment />
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

/*
 * The sidebar toggle used to live here, because `Sidebar` renders nothing when
 * collapsed and so could not reopen itself. The header owns that control now
 * and is always present, so a second copy on this bar was simply the same
 * button drawn twice.
 */

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
  const status = useApp((s) => (profile ? s.authByProfile[profile.id] : undefined));

  // Amber only for a profile that has been *checked* and is signed out. An
  // unchecked profile is not evidence of anything, and colouring it would put a
  // permanent warning on a status bar for a state nobody has looked at.
  const signedOut = status !== undefined && !status.loggedIn;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/*
          The swatch stands in for the key icon when the profile has one. Two
          marks for one thing would be noise, and of the two the colour is the
          one carrying information — the key says "profile", which the label
          beside it already says.
        */}
        <SegmentTrigger
          label="Profile"
          icon={
            profile?.color ? (
              <ProfileSwatch color={profile.color} />
            ) : (
              <KeyRoundIcon className="size-3 shrink-0" aria-hidden="true" />
            )
          }
          className={cn(signedOut && 'text-amber', profile && 'text-ink')}
        >
          {profile?.label ?? 'no profile'}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-96 max-w-[min(24rem,90vw)]">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Profile — which account runs
        </DropdownMenuLabel>

        {forProvider.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
            No profile exists for this provider yet. A run needs an account, which comes from a
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
          Each profile’s account lives in its own config directory, signed in with Claude’s own CLI.
          Apollo stores no credential.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One profile row: label, sign-in state, config directory. */
function ProfileItem({ id }: { readonly id: ProfileId }): ReactElement | null {
  const profile = useApp((s) => s.profiles.find((p) => p.id === id));
  const status = useApp((s) => s.authByProfile[id]);
  const platform = useApp((s) => s.platform);
  if (!profile) return null;

  const signedOut = status !== undefined && !status.loggedIn;

  return (
    <DropdownMenuRadioItem value={profile.id} className="items-start gap-2 text-2xs">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/*
         * `min-w-0 flex-1` on the label and `shrink-0` on the badge, in that
         * combination. Without it the badge — which has its own intrinsic width
         * and no reason to yield — squeezes the label to nothing, and a profile
         * row ends up showing its sign-in state and no name at all. Which of
         * the two the user needs more is not a close call.
         */}
        <span className="flex min-w-0 items-center gap-1.5">
          <ProfileSwatch color={profile.color} />
          <span className="min-w-0 flex-1 truncate text-ink">{profile.label}</span>
          {status ? (
            <ToneBadge tone={status.loggedIn ? 'sage' : 'amber'} className="shrink-0">
              {status.loggedIn ? (status.subscriptionType ?? 'signed in') : 'signed out'}
            </ToneBadge>
          ) : null}
        </span>
        <span
          className={cn('truncate font-mono text-2xs', signedOut ? 'text-amber' : 'text-ink-faint')}
          title={profile.configDir}
        >
          {signedOut
            ? 'not signed in — open Manage profiles'
            : (status?.email ?? shortenPath(profile.configDir, { platform, max: 40 }))}
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
        reason={`${providerLabel} does not offer a model choice, so Apollo sends no model and the provider picks its own.`}
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

      <DropdownMenuContent
        align="start"
        side="top"
        className="w-52 max-w-[min(15rem,90vw)] p-1"
      >
        <DropdownMenuRadioGroup
          value={selected?.id ?? ''}
          onValueChange={(value) => setModel(value)}
        >
          {listed.map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <ThinkingRow />
        <FastModeRow />
        <ContextRow />

        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-6 gap-1.5 px-2 text-2xs" onSelect={() => openSettings('models')}>
          <ListTreeIcon className="size-3 shrink-0" aria-hidden="true" />
          Edit quick access…
          {hidden > 0 ? (
            <span className="ml-auto font-mono text-2xs text-ink-faint">{hidden} more</span>
          ) : null}
        </DropdownMenuItem>

        {running && running !== selected?.resolvedModel && running !== selected?.id ? (
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
 * like `sonnet` actually resolves to today — Apollo offers aliases rather than
 * dated snapshots, so without it the menu never says which model that is, and
 * "which snapshot am I on" is a question people ask a bill about.
 *
 * The two flag icons repeat the status-line toggles exactly, colour included.
 * That is the point: a user wondering why the cyan lightning is dim looks at
 * this list and sees which models carry it.
 */
function ModelRow({ model }: { readonly model: ProviderModelOption }): ReactElement {
  return (
    /*
     * Name flush left, tick on the right.
     *
     * shadcn's radio item reserves the left gutter for its indicator, which
     * indented every model name past the labels of the rows beneath it — the
     * list read as if it belonged to a different menu. The indicator is moved
     * to the trailing edge instead, so the names start on the same left margin
     * as "Thinking" and "Fast mode" and the whole popover has one text column.
     */
    <DropdownMenuRadioItem
      value={model.id}
      className="py-1 pr-7 pl-2 text-xs [&>span:first-child]:right-2 [&>span:first-child]:left-auto"
    >
      <span className="min-w-0 truncate text-ink">{model.label}</span>
    </DropdownMenuRadioItem>
  );
}

/* -------------------------------------------------------------------------- */
/* How the selected model runs                                                */
/* -------------------------------------------------------------------------- */

/** Shared chrome for the three rows under the model list: label, then control. */
function ShapeRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex h-6 items-center gap-2 pr-7 pl-2">
      <span className="shrink-0 text-2xs text-ink-faint">{label}</span>
      <span className="ml-auto flex min-w-0 items-center">{children}</span>
    </div>
  );
}

/**
 * The thinking ladder, as a submenu.
 *
 * One list from `low` up to ultracode — see `thinkingLevels` for why ultracode
 * is a rung here rather than a switch of its own. A rung the selected model
 * cannot do is rendered disabled and unexplained, the same as fast mode below.
 */
function ThinkingRow(): ReactElement | null {
  const levels = useApp(thinkingLevels);
  const current = useApp(activeThinkingLevel);
  if (levels.length === 0) return null;

  const label = levels.find((l) => l.id === current)?.label ?? '—';

  return (
    <DropdownMenuSub>
      {/* `pr-7` matches the gutter the model rows reserve for their tick, so
          the values in this column right-align with it rather than floating. */}
      <DropdownMenuSubTrigger className="h-6 gap-2 py-0 pr-7 pl-2 text-2xs">
        <span className="text-ink-faint">Thinking</span>
        <span className="ml-auto text-ink">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        <DropdownMenuRadioGroup value={current ?? ''} onValueChange={setThinkingLevel}>
          {levels.map((level) => (
            <DropdownMenuRadioItem
              key={level.id}
              value={level.id}
              disabled={!level.available}
              className="items-start text-2xs"
            >
              <span className="flex min-w-0 flex-col">
                <span className={cn(level.id === ULTRACODE_LEVEL ? 'text-ember' : 'text-ink')}>
                  {level.label}
                </span>
                <span className="text-2xs leading-snug text-ink-faint">{level.note}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Fast mode.
 *
 * Disabled without explanation on a model that does not offer it — deliberately.
 * Every other degraded control in this app attaches a reason, and that rule is
 * right when the user could *act* on it. Here they cannot: the answer is always
 * "this model does not do that", which the disabled state already says, and
 * spelling it out on a row this small is noise. Switch models and it lights up.
 */
function FastModeRow(): ReactElement {
  const on = useApp((s) => s.fastMode);
  const available = useApp(fastModeAvailable);
  return (
    <ShapeRow label="Fast mode">
      <Switch
        checked={on && available}
        disabled={!available}
        onCheckedChange={setFastMode}
        aria-label="Fast mode"
        className="scale-90"
      />
    </ShapeRow>
  );
}

/**
 * The selected model's context window — a fact, not a control.
 *
 * There is nothing to choose: the current lineup ships 1M as both the default
 * and the maximum, so a picker here would offer exactly one option. And the
 * number is *learned* from a completed run rather than declared by the
 * catalogue, so it is blank until this model has run once. Blank is the honest
 * state; the alternative is a hard-coded spec table that goes stale silently.
 */
function ContextRow(): ReactElement | null {
  const window = useApp(learnedContextWindow);
  if (window === undefined) return null;
  return (
    <ShapeRow label="Context">
      <span className="font-mono text-2xs text-ink-muted">{formatTokens(window)}</span>
    </ShapeRow>
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
        {/*
          `flex-col items-start`, because `TooltipContent` is a flex *row* with
          centred items — it is built for one line of text next to a `Kbd`. Two
          children in it become two columns, which is how this tooltip spent a
          while rendering the path and the branch note side by side, each half
          the width and neither reading as a sentence.

          The note is one clause now rather than three. The reason a hover lands
          here is the path, which the chip truncates; the branch caveat is a
          footnote and was set at the size of the answer.
        */}
        <TooltipContent side="top" align="end" className="max-w-sm flex-col items-start gap-1">
          {unset ? (
            <span>
              No working directory set — the agent needs an absolute path to work in. Click to
              choose one.
            </span>
          ) : (
            <span className="font-mono break-all">{cwd}</span>
          )}
          {branch ? (
            <span className="text-ink-faint">
              Branch “{branch}” is the last one recorded here, so it may be stale.
            </span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <WorkingDirectoryDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
