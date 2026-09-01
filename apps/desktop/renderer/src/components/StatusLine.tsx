/**
 * The status line.
 * ============================================================================
 *
 * One always-visible row across the bottom of the window carrying everything
 * that decides what the *next* prompt will do, and nothing that does not:
 *
 *     [profile ▾] [model ▾] [mode ▾]         5hr ⬤  Week ⬤  Fable ⬤
 *
 * Everything left of the rings changes a setting in place; everything right of
 * them is read-only. That split is the whole design: a setting you can change
 * is a control, a fact about the run is text, and nothing here is both.
 *
 * The rings open the usage popover, which carries the context window and the
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
 * ## The profile chip and the model chip open one navigator
 *
 * They used to open two menus, and the model one was profile-blind — it
 * offered Fable identically whether that account's Fable weekly window was
 * untouched or `rejected`. Both chips now open the run navigator
 * (`RunNavigator.tsx`): a Finder-column surface — Profile → Model → Effort —
 * whose model rows read the profile's plan, with fast mode, the permission
 * level, context and the plan meters in its footer. The chips stay, because
 * the bar's job is unchanged: everything that decides what the next prompt
 * does, readable without opening anything.
 *
 * The closed model trigger echoes the whole choice, not just the model: the
 * thinking level rides beside the name and the cyan zap appears when fast mode
 * is in force. "Sonnet 5" with ultracode armed and "Sonnet 5" on low are
 * different promises about time and money.
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
 * line up with the input's edges rather than running the full width of a pane
 * the input does not fill. The measure is the transcript's own `COLUMN_MAX` —
 * messages, input and these chips share one column, so the three edges cannot
 * drift apart (they used to: this bar pinned itself to `max-w-4xl` while the
 * transcript read `max-w-5xl`, and the chips sat visibly inside the
 * conversation's margin). The composer draws the border above them; a second
 * one here would box the input in.
 *
 * The sidebar toggle used to ride along at the far left. The header carries it
 * now — it is always present, so this bar no longer needs a second copy.
 */

import { type ComponentProps, type ReactElement, type ReactNode } from 'react';
import {
  ChevronsUpDownIcon,
  CpuIcon,
  KeyRoundIcon,
  MessageCircleQuestionMarkIcon,
  ShieldAlertIcon,
  ShieldIcon,
  ZapIcon,
} from 'lucide-react';
import type { PermissionMode } from '@rx-artemis/protocol';

import {
  ULTRACODE_LEVEL,
  activeModel,
  activeModels,
  activeProfile,
  activeProviderLabel,
  activeThinkingLevel,
  fastModeAvailable,
  isLive,
  setPermissionMode,
  thinkingLevels,
  useApp,
} from '../state/store';
import { usePermissionModes } from '../hooks/useCapability';
import { useServedAccount } from '../hooks/useServedAccount';
import { usePane, usePaneRef } from '../state/paneContext';
import { COLUMN_MAX } from './Transcript';
import { WithReason } from './disabled-reason';
import { PlanUsageMeter } from './PlanUsageMeter';
import { MODE_LABELS, MODE_NOTES, RunNavigatorContent } from './RunNavigator';
import { ProfileSwatch, StatusDot } from './primitives';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * The controls that describe what the next prompt will do.
 *
 * Sits directly under the composer rather than in a bar across the foot of the
 * window. Two consequences are deliberate:
 *
 *  - **No top border.** The composer already draws one above itself; a second
 *    one here would box the input in a way nothing else in the app is.
 *  - **The transcript's own measure.** These controls belong to the column,
 *    so they take `COLUMN_MAX` at the same setting the transcript reads,
 *    instead of a private cap that only agreed with it at one width.
 *
 * There is no sidebar toggle here, and this header used to say there was. The
 * control moved to `AppHeader` — window chrome belongs on the window's bar —
 * and the argument that kept a copy here is gone twice over: the sidebar now
 * collapses to a rail that reopens itself, so no always-present stand-in is
 * needed at all.
 */
export function StatusLine(): ReactElement {
  const width = useApp((s) => s.conversationWidth);
  // No fill on the strip itself. These controls belong to the input directly
  // above them, and the composer no longer sits in a bar of its own — filling
  // this row would re-draw the same bottom panel one row lower. The fill went
  // to the segments instead: 7D `.sc` gives each one a soft chip of its own,
  // which is what let the dividers between them go. Two ways of saying "these
  // are separate things" is one too many, and the rules were the noisier.
  return (
    <footer className="shrink-0 pb-1">
      <div
        className={cn(
          'mx-auto flex h-7 w-full items-center gap-1.5 px-3 text-2xs',
          COLUMN_MAX[width],
        )}
      >
        <ProfileSegment />
        {/*
          The same navigator as the profile chip, anchored at the model chip.
          Model, thinking and fast mode used to be four segments on this bar,
          then one popover; they are now the middle of the run navigator, where
          the model rows can finally read the profile's plan. Everything that
          was on the bar is one click away instead of zero, and the bar is
          short enough to read.
        */}
        <ModelSegment />
        <ModeSegment />
        <SandboxSegment />

        <div className="ml-auto flex min-w-0 items-center gap-2">
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

/*
 * REMOVED: `Divider`. A 12px rule between each pair of segments, from the
 * treatment where the segments were bare text on the window and needed one.
 * They carry their own ground now (see `CHIP` below), so a rule between two of
 * them drew a boundary that the fills had already drawn.
 */

/*
 * The sidebar toggle used to live here, because `Sidebar` renders nothing when
 * collapsed and so could not reopen itself. The header owns that control now
 * and is always present, so a second copy on this bar was simply the same
 * button drawn twice.
 */

/**
 * One segment's chip.
 *
 * 7D `.sc`: a 22px pill on a 3.5% wash, which is the fill the transcript's
 * cards take — the status line reads as the same material as the column above
 * it rather than as window furniture. The hover and open states go a step up
 * the same wash instead of shadcn's `muted`, which is a *solid* grey and would
 * make an alpha chip jump to an opaque one under the cursor.
 *
 * `dark:hover:` is spelled out because the ghost variant's own
 * `dark:hover:bg-muted/50` is `.dark`-scoped and outranks an unscoped
 * override; `cn`'s tailwind-merge drops the conflicting pair only when the
 * modifiers match exactly.
 */
const CHIP =
  'h-[22px] rounded-md bg-wash px-2 hover:bg-wash-strong aria-expanded:bg-wash-strong dark:hover:bg-wash-strong';

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
        /*
          Sans, not mono. The chrome voice dropped the monospace with the rest
          of the instrument-panel treatment — what these chips carry is a
          profile's name, a model's marketing label and a mode, all of them
          words the app chose rather than machine output. The one mono survivor
          on this row is the meter's ring labels, which are readings.
        */
        CHIP,
        'max-w-[15rem] min-w-0 gap-1.5 text-2xs font-normal text-ink-muted',
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
        className="flex h-[22px] max-w-[15rem] cursor-not-allowed items-center gap-1.5 rounded-md bg-wash px-2 text-2xs text-ink-faint opacity-70"
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
 * Which account runs. The chip reports it; the navigator changes it.
 *
 * The trigger's obligations are unchanged: it names the profile, and it goes
 * amber only for a profile that has been *checked* and is signed out — an
 * unchecked profile is not evidence of anything, and colouring it would put a
 * permanent warning on a status bar for a state nobody has looked at.
 *
 * What opens is the run navigator (`RunNavigator.tsx`), whose first column is
 * the account list this segment used to own — same rows, same rules, plus the
 * model and effort columns the pick reveals. The rules that lived here
 * (provider grouping, the disabled-but-running exception, mid-run lockout)
 * moved with the rows and are documented on `ProfileColumn`.
 */
function ProfileSegment(): ReactElement {
  const profile = usePane(activeProfile);
  const status = useApp((s) => (profile ? s.authByProfile[profile.id] : undefined));
  const signedOut = status !== undefined && !status.loggedIn;
  /*
   * At a server the profile's own label names the *place* ("Artemis Server"),
   * not the account about to be charged — the question this segment exists
   * for. The account rides the active pick, so it is appended the way the
   * catalogue's notes already spell it: "Artemis Server — work max".
   */
  const served = useServedAccount();
  const label =
    profile === undefined
      ? 'no profile'
      : served.label === null
        ? profile.label
        : `${profile.label} — ${served.label}`;

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
          // The one value 7D bolds on this row (`.sc b`). Which account is
          // about to be charged is the question this segment exists for, so it
          // gets the weight rather than the model beside it.
          className={cn(signedOut && 'text-amber', profile && 'font-medium text-ink')}
        >
          {label}
        </SegmentTrigger>
      </DropdownMenuTrigger>
      <RunNavigatorContent />
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which model runs, and how hard. The chip reports the whole choice; the
 * navigator changes it.
 *
 * The trigger's contract is unchanged: the *short* label (the bar is 20px
 * tall), the thinking level riding behind it inside the truncating span so the
 * model keeps its start under pressure, the cyan zap when fast mode is in
 * force — gated on `on && available`, the same expression as the footer's
 * switch, so a flag the run would ignore never reads as armed. A stored id the
 * current provider does not offer goes amber rather than being silently
 * ignored, and a provider with no model choice renders the segment dead with
 * the reason attached.
 *
 * What opens is the run navigator — the same surface the profile chip opens,
 * anchored here. Its model column carries the rows this menu used to hold,
 * now with the per-profile facts (exhaustion, pressure, cost posture); its
 * effort column is the thinking ladder that used to be a submenu; fast mode,
 * context and the plan meters live in its footer.
 */
function ModelSegment(): ReactElement {
  const catalogue = usePane((s) => activeModels(s).length);
  const selected = usePane(activeModel);
  const stored = usePane((s) => s.model);
  const providerLabel = usePane(activeProviderLabel);
  // What the *run* reports it is actually using, which can differ from what was
  // asked for — the provider may substitute. Shown once it is known.
  const running = usePane((s) => s.run?.model);
  // The rest of the choice, for the closed trigger. Same selectors the rows
  // inside the navigator read, so the two can never disagree.
  const levels = usePane(thinkingLevels);
  const thinking = usePane(activeThinkingLevel);
  const fastOn = usePane((s) => s.fastMode);
  const fastAvailable = usePane(fastModeAvailable);

  // Undefined on a provider with no effort scale, where there is no ladder and
  // so no rung to name — the suffix vanishes with the effort column it mirrors.
  const thinkingLabel = levels.find((l) => l.id === thinking)?.label;

  if (catalogue === 0) {
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SegmentTrigger
          label="Model"
          icon={<CpuIcon className="size-3 shrink-0" aria-hidden="true" />}
          className={cn(selected && 'text-ink', orphaned && 'text-amber')}
          trailing={
            fastOn && fastAvailable ? (
              <ZapIcon className="size-3 shrink-0 text-cyan" aria-label="fast mode on" />
            ) : undefined
          }
        >
          {selected?.label ?? (orphaned ? `${stored} (unavailable)` : 'default')}
          {thinkingLabel !== undefined ? (
            <span className={cn(thinking === ULTRACODE_LEVEL ? 'text-beam-text' : 'text-ink-muted')}>
              {' · '}
              {thinkingLabel.toLowerCase()}
            </span>
      ) : null}
        </SegmentTrigger>
      </DropdownMenuTrigger>
      <RunNavigatorContent />
    </DropdownMenu>
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

/**
 * Live status and the count of prompts waiting on the user. Read-only.
 *
 * No chip, unlike the segments to its left, and that is the split this bar is
 * built on: a chip is a control's ground, so wearing one on a readout would
 * offer a click there is nothing behind. 7D leaves the run state as bare text
 * between the chips and the rings for the same reason.
 */
function RunSegment(): ReactElement | null {
  const live = usePane(isLive);
  const status = usePane((s) => s.run?.status ?? null);
  const pending = usePane((s) => s.permissionQueue.length);
  // Amber is the app's alarm colour and an approval is what earns it. A parked
  // question is not a risk decision, so a queue that holds only questions says
  // so in cyan — otherwise "the agent asked which library to use" looks
  // identical to "something wants to run `rm -rf`".
  const asking = usePane((s) => s.permissionQueue.every((r) => r.question !== undefined));

  if (pending > 0) {
    const Icon = asking ? MessageCircleQuestionMarkIcon : ShieldAlertIcon;
    return (
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 px-1 text-2xs',
          asking ? 'text-cyan' : 'text-amber',
        )}
      >
        <Icon className="size-3" aria-hidden="true" />
        {pending} awaiting you
      </span>
    );
  }
  if (!status) return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5 px-1 text-2xs text-ink-faint">
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

/**
 * What is confining this provider's shell commands, when anything is.
 *
 * `_layout.md` item 4 put `seatbelt` in the elided chip beside the effort and
 * the directory. Those two found homes elsewhere — effort inside the model
 * popover, the directory above the composer — and this one found none at all:
 * the word `seatbelt` appeared nowhere in the renderer, while the release notes
 * led with "commands execute inside an OS sandbox". A headline claim the app
 * never made.
 *
 * ## Only where it is true
 *
 * Absent for Claude and Codex, because it would be a lie there. They spawn
 * their own CLI and that CLI owns permission handling — which is what the mode
 * segment immediately to the left already reports. Artemis builds and confines
 * the shell tool only for the local providers, so only they publish a
 * `sandbox` on their descriptor and only they draw this.
 *
 * ## `none` is the loud case
 *
 * A machine that cannot confine will refuse to run commands at all, so the
 * interesting state is the failure: it takes the warning colour and says so.
 * A working sandbox is the quiet default and reads as chrome, because "things
 * are as they should be" does not deserve attention.
 */
function SandboxSegment(): ReactElement | null {
  const sandbox = usePane(
    (s) => s.providers.find((p) => p.id === s.activeProviderId)?.sandbox,
  );
  if (sandbox === undefined) return null;

  const refused = sandbox.confinement === 'none';
  const label = refused ? 'unconfined' : (sandbox.backend ?? 'sandboxed').toLowerCase();

  // A chip like the settings beside it, even though nothing opens: this states
  // the confinement the *next* prompt's commands will run under, which is the
  // same kind of fact its neighbours carry, and the divider that used to hold
  // it apart from them went with the rest of the rules.
  return (
    <span
      title={sandbox.detail}
      className={cn(
        'flex h-[22px] shrink-0 items-center rounded-md bg-wash px-2 text-2xs',
        refused ? 'text-amber' : 'text-ink-faint',
      )}
    >
      {label}
      {/* An unverified backend is a claim we have not tested on a real
          machine of that platform. The capability bar's rule applies to this
          as much as to a flag: say what is unproven rather than let a green
          word imply otherwise. */}
      {!refused && sandbox.verification === 'unverified' ? (
        <span className="text-amber"> ?</span>
      ) : null}
    </span>
  );
}
