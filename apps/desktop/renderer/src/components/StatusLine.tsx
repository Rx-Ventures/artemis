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
 * On a provider with no fast mode at all it is not rendered, and neither is the
 * ultracode rung — the narrow carve-out from "never hide a control", taken
 * because there is no model to switch to and so nothing the user could do about
 * it. See `providerOffersFastMode`.
 *
 * The closed trigger echoes the whole choice, not just the model: the thinking
 * level rides beside the name and the cyan zap appears when fast mode is in
 * force. Folding four segments into one popover shortened the bar; it must not
 * also hide what the next prompt will do, because "Sonnet 5" with ultracode
 * armed and "Sonnet 5" on low are different promises about time and money and
 * the bar exists precisely to make that readable without opening anything.
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

import { Fragment, useMemo, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import {
  ChevronsUpDownIcon,
  CpuIcon,
  KeyRoundIcon,
  ListTreeIcon,
  ShieldAlertIcon,
  ShieldIcon,
  ZapIcon,
} from 'lucide-react';
import type {
  PermissionMode,
  PlanRecommendation,
  ProfileId,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderId,
  ProviderModelOption,
} from '@rx-artemis/protocol';

import { keyLabel } from '../hooks/useHotkeys';
import { usePermissionModes } from '../hooks/useCapability';
import { shortenPath } from '../lib/paths';
import { formatTokens } from '../lib/format';
import {
  ULTRACODE_LEVEL,
  activeModel,
  activeModels,
  activeProfile,
  activeProviderLabel,
  activeThinkingLevel,
  fastModeAvailable,
  isLive,
  learnedContextWindow,
  openSettings,
  planRecommendation,
  providerOffersFastMode,
  quickModels,
  setFastMode,
  setModel,
  setPermissionMode,
  setProfile,
  setThinkingLevel,
  thinkingLevels,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { IconButton, WithReason } from './disabled-reason';
import { PlanUsageMeter } from './PlanUsageMeter';
import { ProfileSwatch, StatusDot } from './primitives';
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
          {/*
            The directory used to end this row. It reads as a heading for the
            input rather than a setting on it, and at full-path width it was
            squeezing the meter beside it, so it moved above the composer as
            `WorkingDirectoryChip` — same dialog, same one-trigger rule.
          */}
          <PlanUsageMeter />
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
 *
 * `trailing` sits between the label and the chevron, *outside* the truncating
 * span. That placement is the reason the prop exists: `text-overflow` elides
 * text and nothing else, so an icon inside the span would be clipped mid-glyph
 * at the exact widths where truncation kicks in — the mark would break rather
 * than yield. Out here it is `shrink-0` by convention and the text gives way
 * instead.
 */
function SegmentTrigger({
  icon,
  children,
  className,
  label,
  trailing,
  ...rest
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
  readonly trailing?: ReactNode;
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
      {trailing}
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

/**
 * Every profile, grouped by the provider that owns it.
 *
 * Providers keep their catalogue order — the order `providers:list` reported —
 * so the sections do not reshuffle as accounts are added. A profile whose
 * provider is not in that list still gets a section, keyed by its raw id: an
 * account is not worth hiding because the build it belongs to is missing, and
 * that is exactly when someone needs to see it.
 */
function profilesByProvider(
  profiles: readonly ProfileMetadata[],
  providers: readonly ProviderDescriptor[],
): readonly { readonly id: ProviderId; readonly label: string; readonly profiles: readonly ProfileMetadata[] }[] {
  const order = new Map<ProviderId, string>();
  for (const provider of providers) order.set(provider.id, provider.label);
  for (const profile of profiles) {
    if (!order.has(profile.providerId)) order.set(profile.providerId, profile.providerId);
  }

  const sections = [];
  for (const [id, label] of order) {
    const owned = profiles.filter((p) => p.providerId === id);
    if (owned.length > 0) sections.push({ id, label, profiles: owned });
  }
  return sections;
}

/**
 * Which account runs — across every provider, not just the active one.
 *
 * ## The list is not scoped to the active provider
 *
 * It was, and that was a trap. A profile belongs to exactly one CLI, so the
 * provider follows the account rather than being chosen beside it (`setProfile`
 * has the long version). Filtering to the active provider meant that anything
 * moving the provider — creating a Codex profile does, deliberately — emptied
 * this menu of every Claude account at the same moment, and the only other
 * provider control in the app is a page in the command palette. Someone who did
 * not know that page existed had no way back to their own accounts.
 *
 * Grouping by provider is what makes one flat list readable, and it also puts
 * the fact that switching account can switch CLI in front of the person doing
 * it, at the moment they do it.
 */
function ProfileSegment(): ReactElement {
  const pane = usePaneRef();
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);
  const activeId = usePane((s) => s.activeProfileId);
  const profile = usePane(activeProfile);

  const sections = useMemo(() => profilesByProvider(profiles, providers), [profiles, providers]);
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

      <DropdownMenuContent align="start" side="top" className="w-56 max-w-[min(14rem,90vw)]">
        <RecommendedProfile />

        {sections.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
            No profile exists yet. A run needs an account, which comes from a profile.
          </p>
        ) : (
          <DropdownMenuRadioGroup
            value={activeId ?? ''}
            onValueChange={(value) => setProfile(value as ProfileId, pane)}
          >
            {sections.map((section, index) => (
              <Fragment key={section.id}>
                {/*
                 * The heading is dropped when there is only one provider, where
                 * it would label a distinction the user does not have. It
                 * appears the moment a second one exists, which is also the
                 * moment picking a profile starts changing which CLI runs.
                 */}
                {sections.length > 1 ? (
                  <>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuLabel className="text-2xs text-ink-faint">
                      {section.label}
                    </DropdownMenuLabel>
                  </>
                ) : null}
                {section.profiles.map((candidate) => (
                  <ProfileItem key={candidate.id} id={candidate.id} />
                ))}
              </Fragment>
            ))}
          </DropdownMenuRadioGroup>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-2xs" onSelect={() => openSettings('profiles')}>
          Manage
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Which account has room right now, at the top of the menu.
 *
 * ## Why this is worth a section of its own
 *
 * The rest of this menu answers "which accounts do I have"; the meter beside it
 * answers "how full is the one I am in". Neither answers the question that
 * actually comes up mid-session — *my 5-hour window is nearly gone, where
 * should I go?* — because answering it means comparing accounts, and nothing in
 * the app had ever read an account other than the active one. A poll in the
 * main process now reads them all every few minutes; this is what that is for.
 *
 * ## It is a shortcut, not a fourth copy of the list
 *
 * A `DropdownMenuItem` outside the radio group rather than a duplicate radio
 * row inside it. Two radio items with one value both paint their check when
 * selected, which reads as two accounts being active at once — and the
 * recommendation is an action ("take me there"), not a fifth state of the
 * choice below.
 *
 * ## The row is a profile, not a report
 *
 * One line — swatch and name under a "Recommended" heading — the same anatomy
 * as every row in the list below it. A first cut carried a headroom badge, the
 * plan tier and a sentence of justification, and earned the obvious review:
 * the extra markup buried the answer. The heading is the claim; the row is the
 * answer; the numbers that argued for it (how free, which window binds, how
 * many accounts ranked) live in the tooltip, one hover away instead of being
 * asserted at a glance.
 *
 * It renders nothing at all when there is no comparison to make — one account,
 * stale readings, or accounts that bill per token rather than by plan.
 * `recommendProfile` holds those rules and explains each; the important one is
 * that a metered profile is never recommended, because "your plan is full, use
 * the one that charges per token" is not advice anyone asked for.
 */
/**
 * The sentence behind the row, which is where the whole argument lives.
 *
 * The row is a name. This is the case for it, and it has to be *self-correcting*
 * — a reader who disagrees should be able to see which step they disagree with,
 * because every basis below is a different quality of evidence.
 *
 * ## Why the percentage alone will not do
 *
 * Once plan sizes are weighed, the winner can show the **smaller** share free:
 * 30% of a Max 20x window is six Pro windows against a Pro account's nine
 * tenths of one. "30% free — picked across 2 accounts" reads as a bug in that
 * situation, and a tooltip that makes a correct recommendation look broken is
 * worse than no tooltip. So the weighted case names the plan and says the
 * comparison was by size.
 *
 * ## The assumption is disclosed where it changed something
 *
 * A provider reports `max`, never `Max 5x` or `Max 20x`, so an unpinned account
 * is ranked as the family's floor. That understates it, which is the safe
 * direction, but it is still a reason the answer might be wrong — and the fix
 * takes ten seconds in the profile editor. Someone can only take it if they
 * know it is theirs to take.
 *
 * Only under `weighted`, though. That is the one basis where a plan's size
 * enters the arithmetic; under the other two the tier was never consulted, and
 * warning about an assumption that changed no outcome trains people to skip the
 * sentence in the case where it matters.
 */
function explainRecommendation(recommendation: PlanRecommendation): string {
  const share = `${String(Math.round(recommendation.headroom))}% free on its ${recommendation.binding.label} limit`;
  const across = `across ${String(recommendation.candidates)} accounts`;

  const basis =
    recommendation.basis === 'same-plan'
      ? `${share} — the most room ${across} on this plan.`
      : recommendation.basis === 'weighted'
        ? // The plan is named because the number on its own now understates the
          // pick. See the header.
          `${share}, and ${recommendation.plan?.label ?? 'its plan'} is the largest plan in play — the most actual capacity ${across}, not the largest percentage.`
        : `${share} — the largest share of its own plan ${across}. They are on different plans, and providers report only percentages, never how much a plan holds, so this is not a comparison of capacity.`;

  if (!recommendation.assumedPlan || recommendation.basis !== 'weighted') return basis;
  return `${basis} That tier is an assumption — the provider reports a plan family, never which tier of it — so set the exact plan on the profile if it is wrong.`;
}

function RecommendedProfile(): ReactElement | null {
  const pane = usePaneRef();
  const profiles = useApp((s) => s.profiles);
  const usageByProfile = useApp((s) => s.planUsageByProfile);

  /*
   * `Date.now()` is captured at mount, not on every render, and that is exactly
   * right here: Radix mounts this content when the menu opens, so the staleness
   * rule is re-judged at the moment the user is about to act on the answer.
   * A `useApp` selector could not return this — see `planRecommendation`.
   */
  const recommendation = useMemo(
    () => planRecommendation(profiles, usageByProfile, Date.now()),
    [profiles, usageByProfile],
  );
  if (recommendation === null) return null;

  const profile = profiles.find((p) => p.id === recommendation.profileId);
  if (!profile) return null;

  const why = explainRecommendation(recommendation);

  return (
    <>
      <DropdownMenuLabel className="text-2xs text-ink-faint">Recommended</DropdownMenuLabel>
      <DropdownMenuItem
        className="gap-1.5 text-2xs"
        onSelect={() => setProfile(profile.id, pane)}
        title={why}
      >
        <ProfileSwatch color={profile.color} />
        <span className="min-w-0 flex-1 truncate text-ink">{profile.label}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * One profile row: swatch, name, and the plan in muted text beside it.
 *
 * One line, not two. The account and its config directory used to sit stacked,
 * which doubled the height of every row to show a path nobody picks a profile
 * by — the swatch and the name are what identify it. Both the directory and
 * the signed-in email survive as the row's tooltip, which is where a detail
 * belongs when it is wanted rarely and never at a glance.
 *
 * The plan used to be a filled badge pushed to the row's far edge. A badge is a
 * status light, and a plan tier is not a status — it is a fact about the
 * account — so it now reads as quiet text directly after the name. The one
 * state that *is* a status, checked-and-signed-out, keeps its amber; and a
 * signed-in account whose tier is simply unknown shows nothing rather than a
 * "signed in" filler that answers a question nobody asked.
 *
 * The tier falls back to the polled plan reading when the sign-in probe does
 * not name one. The two probes know different things — Codex's auth check
 * answers "signed in" with no plan attached, while its rate-limit read reports
 * `team` — and which plan an account is on should not depend on which probe
 * happened to carry the answer.
 */
function ProfileItem({ id }: { readonly id: ProfileId }): ReactElement | null {
  const profile = useApp((s) => s.profiles.find((p) => p.id === id));
  const status = useApp((s) => s.authByProfile[id]);
  const polledTier = useApp((s) => s.planUsageByProfile[id]?.subscriptionType);
  const platform = useApp((s) => s.platform);
  if (!profile) return null;

  const path = shortenPath(profile.configDir, { platform, max: 60 });
  const tier = status?.loggedIn === true ? (status.subscriptionType ?? polledTier) : undefined;

  return (
    <DropdownMenuRadioItem
      value={profile.id}
      className="gap-2 text-2xs"
      title={status?.email ? `${status.email} — ${path}` : path}
    >
      {/*
       * The name is the only flexible thing on the row: `min-w-0`+`truncate` on
       * it, `shrink-0` on the texts after it, so under pressure the name elides
       * and the tier survives. No `flex-1` on the name, deliberately — that is
       * what pushed the old badge to the far edge, and the tier belongs beside
       * the name it describes, not across the row from it.
       */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <ProfileSwatch color={profile.color} />
        <span className="min-w-0 truncate text-ink">{profile.label}</span>
        {tier !== undefined ? <span className="shrink-0 text-ink-faint">{tier}</span> : null}
        {status !== undefined && !status.loggedIn ? (
          <span className="shrink-0 text-amber">signed out</span>
        ) : null}
      </span>
    </DropdownMenuRadioItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

function ModelSegment(): ReactElement {
  const pane = usePaneRef();
  const catalogue = usePane(activeModels);
  const quick = usePane(quickModels);
  const selected = usePane(activeModel);
  const stored = usePane((s) => s.model);
  const providerLabel = usePane(activeProviderLabel);
  // What the *run* reports it is actually using, which can differ from what was
  // asked for — the provider may substitute. Shown once it is known.
  const running = usePane((s) => s.run?.model);
  // The rest of the choice, for the closed trigger. Same selectors the rows
  // inside the popover read, so the two can never disagree.
  const levels = usePane(thinkingLevels);
  const thinking = usePane(activeThinkingLevel);
  const fastOn = usePane((s) => s.fastMode);
  const fastAvailable = usePane(fastModeAvailable);

  // Undefined on a provider with no effort scale, where there is no ladder and
  // so no rung to name — the suffix vanishes with the ThinkingRow it mirrors.
  const thinkingLabel = levels.find((l) => l.id === thinking)?.label;

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
        reason={`${providerLabel} does not offer a model choice, so Artemis sends no model and the provider picks its own.`}
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
          trailing={
            /*
             * Gated on `on && available`, the same expression as the switch
             * inside — a zap for a flag the run will ignore would be the
             * enabled-toggle-that-does-nothing failure `fastModeAvailable`
             * exists to prevent, shrunk to icon size.
             */
            fastOn && fastAvailable ? (
              <ZapIcon className="size-3 shrink-0 text-cyan" aria-label="fast mode on" />
            ) : undefined
          }
        >
          {/*
            The *short* label here and the full `displayName` on the rows below.
            This trigger is one segment of five on a 20px bar and "Claude Sonnet
            5 (latest)" would push the rest of the bar off the end of it; the
            menu is where there is room to be unambiguous.

            The thinking level rides after it, lowercased to match the bar's
            register (the mode segment says "ask", not "Ask"). It lives inside
            the truncating span *behind* the name deliberately: when the two
            cannot both fit, the model keeps its start and the refinement is
            what the ellipsis eats.
          */}
          {selected?.label ?? (orphaned ? `${stored} (unavailable)` : 'default')}
          {thinkingLabel !== undefined ? (
            <span className={cn(thinking === ULTRACODE_LEVEL ? 'text-lunar' : 'text-ink-muted')}>
              {' · '}
              {thinkingLabel.toLowerCase()}
            </span>
          ) : null}
        </SegmentTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        side="top"
        className="w-52 max-w-[min(15rem,90vw)] p-1"
      >
        <DropdownMenuRadioGroup
          value={selected?.id ?? ''}
          onValueChange={(value) => setModel(value, pane)}
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
 * like `sonnet` actually resolves to today — Artemis offers aliases rather than
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
    /*
     * `px-2`, matching the tick's `right-2` on the model rows above.
     *
     * This used to be `pr-7`, reserving a gutter the width of the model rows'
     * radio indicator so the values would right-align with the tick. But the
     * tick is positioned absolutely at `right-2` and so ignores that padding
     * entirely — the gutter lined these rows up against nothing and simply
     * stopped them a glyph short of the edge, which is what read as "these
     * cannot go full width".
     */
    <div className="flex h-6 items-center gap-2 px-2">
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
  const pane = usePaneRef();
  const levels = usePane(thinkingLevels);
  const current = usePane(activeThinkingLevel);
  if (levels.length === 0) return null;

  const label = levels.find((l) => l.id === current)?.label ?? '—';

  return (
    <DropdownMenuSub>
      {/*
        `[&>svg:last-child]:ml-0` kills the `ml-auto` shadcn puts on the
        submenu chevron. Two `ml-auto` elements in one flex row split the free
        space *between* them, so the value was landing halfway along the row
        with a gap before the chevron rather than sitting against it. Only the
        value pushes now; the chevron follows it to the trailing edge.
      */}
      <DropdownMenuSubTrigger className="h-6 gap-2 px-2 py-0 text-2xs [&>svg:last-child]:ml-0">
        <span className="text-ink-faint">Thinking</span>
        <span className="ml-auto text-ink">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        <DropdownMenuRadioGroup
          value={current ?? ''}
          onValueChange={(value) => setThinkingLevel(value, pane)}
        >
          {levels.map((level) => (
            <DropdownMenuRadioItem
              key={level.id}
              value={level.id}
              disabled={!level.available}
              className="items-start text-2xs"
            >
              <span className="flex min-w-0 flex-col">
                <span className={cn(level.id === ULTRACODE_LEVEL ? 'text-lunar' : 'text-ink')}>
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
 *
 * Absent entirely on a provider with no fast mode at all. That is a different
 * question — see `providerOffersFastMode` — and it is the one case where "switch
 * models and it lights up" is false, because there is no model to switch to.
 */
function FastModeRow(): ReactElement | null {
  const pane = usePaneRef();
  const on = usePane((s) => s.fastMode);
  const available = usePane(fastModeAvailable);
  const offered = usePane(providerOffersFastMode);
  if (!offered) return null;
  return (
    <ShapeRow label="Fast mode">
      <Switch
        checked={on && available}
        disabled={!available}
        onCheckedChange={(next) => setFastMode(next, pane)}
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
  const window = usePane(learnedContextWindow);
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
  const pane = usePaneRef();
  const mode = usePane((s) => s.permissionMode);
  const providerLabel = usePane(activeProviderLabel);

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
          onValueChange={(value) => setPermissionMode(value as PermissionMode, pane)}
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
  const live = usePane(isLive);
  const status = usePane((s) => s.run?.status ?? null);
  const pending = usePane((s) => s.permissionQueue.length);

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
/* Location                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * MOVED: `LocationSegment`, now `WorkingDirectoryChip` in `WorkingDirectory.tsx`.
 *
 * It ended this row showing a shortened absolute path. Two things were wrong
 * with that. The path made the control's width a function of how deeply nested
 * the project was, so it pushed against the meter beside it; and a directory is
 * not a setting on the next prompt the way the model and the permission mode
 * are — it is where the whole session lives, which reads as a heading above the
 * input rather than a chip below it.
 *
 * It lives beside the dialog it opens now. Still exactly one trigger for the
 * value; it just moved.
 */

