/**
 * Runs — what the next run does, and what it costs.
 * ============================================================================
 *
 * The rows here used to live two panes apart: the fast-mode and ultracode
 * switches sat under the model catalogue, the run summary and the handover
 * rules under Appearance. Each placement was defensible and the split was not —
 * all four answer the same question, *what will the next run do and what will
 * it spend doing it*, and a user weighing "spend more compute on this turn"
 * against "hand the work over before the account runs dry" was flipping
 * between panes to hold one thought.
 *
 * ---------------------------------------------------------------------------
 * THE ROWS DO NOT ALL REACH EQUALLY FAR, AND EACH SAYS SO
 * ---------------------------------------------------------------------------
 *
 * Fast mode and ultracode belong to the *column* — a split window sends each
 * pane's own flags, because the flags describe the next prompt in that column.
 * The summary and the handover rules belong to the whole app on this machine.
 * A pane that mixed those scopes silently would be the settings equivalent of
 * a switch that works in one window and not the other, so every row whose
 * reach differs from its neighbours' carries a one-line scope note.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { handoffThresholdsWith, type HandoffThreshold } from '@rx-artemis/protocol';
import type { ProviderModelOption } from '@rx-artemis/protocol';

import { ToneBadge } from '../primitives';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  providerOffersFastMode,
  providerOffersUltracode,
  selectedModelOption,
  setAutoHandoff,
  setFastMode,
  setHandoffThreshold,
  setRunSummary,
  setUltracode,
  useApp,
  type RunSummary,
} from '../../state/store';
import { usePane } from '../../state/paneContext';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

/**
 * How far a row reaches, said in the hint register.
 *
 * The same muted 2xs the nav hints and row descriptions use, so the note reads
 * as a footnote on the row rather than as a second description competing with
 * the first.
 */
function ScopeNote({ children }: { readonly children: string }): ReactElement {
  return <p className="text-2xs leading-snug text-ink-faint">{children}</p>;
}

/* -------------------------------------------------------------------------- */
/* Fast mode / ultracode                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Why a per-model flag cannot be set right now, or `undefined`.
 *
 * Two answers, because they ask two different things of the user: choose a
 * model, or choose a *different* model. There used to be a third — "this
 * provider has no models at all" — and it is gone because that case no longer
 * reaches here: a provider with nothing to ask does not get the row. See
 * `providerOffersFastMode`.
 */
function flagReason(
  flag: 'fast mode' | 'ultracode',
  selected: ProviderModelOption | undefined,
  supported: boolean,
): string | undefined {
  if (!selected) {
    return `No model is chosen, so the provider picks one at run time and Artemis cannot tell whether ${flag} would be honoured. Choose a model under Models.`;
  }
  if (!supported) {
    return `${selected.displayName ?? selected.label} does not accept ${flag}.`;
  }
  return undefined;
}

/**
 * The two standing flags — for the providers that have them.
 *
 * A flag no model in this catalogue offers is not rendered at all, which is the
 * one place this app hides a control instead of explaining it. The rule it bends
 * to is worth stating: an explained-disabled control is better than a hidden one
 * *because the user can act on the explanation*. "Codex does not accept fast
 * mode" is not actionable — there is no model to switch to and no setting to
 * change — so the switch would sit dead forever under a sentence that reads like
 * an error. The per-*model* case is still explained, because switching models is
 * exactly the action that fixes it.
 *
 * With neither flag offered the whole group goes, rather than leaving a heading
 * over nothing.
 */
function Defaults(): ReactElement | null {
  const selected = usePane(selectedModelOption);
  const offersFast = usePane(providerOffersFastMode);
  const offersUltra = usePane(providerOffersUltracode);
  const fastMode = usePane((s) => s.fastMode);
  const ultracode = usePane((s) => s.ultracode);

  if (!offersFast && !offersUltra) return null;

  return (
    <SettingsGroup label="Defaults for the next run">
      <ItemGroup className="gap-2">
        {offersFast ? (
          <FlagRow
            id="settings-fast-mode"
            title="Fast mode"
            description="Trade reasoning depth for latency. Sent only when the chosen model accepts it — the preference itself survives a switch to one that does not."
            checked={fastMode}
            reason={flagReason('fast mode', selected, selected?.supportsFastMode === true)}
            onChange={setFastMode}
          />
        ) : null}
        {offersUltra ? (
          <FlagRow
            id="settings-ultracode"
            title="Ultracode"
            description="Spend materially more compute on a single turn. The opposite trade to fast mode, and independent of it: a model may offer either, both or neither."
            checked={ultracode}
            reason={flagReason('ultracode', selected, selected?.supportsUltracode === true)}
            onChange={setUltracode}
          />
        ) : null}
      </ItemGroup>
    </SettingsGroup>
  );
}

function FlagRow({
  id,
  title,
  description,
  checked,
  reason,
  onChange,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly reason: string | undefined;
  readonly onChange: (on: boolean) => void;
}): ReactElement {
  const disabled = reason !== undefined;
  return (
    <Item variant="outline" size="sm" className="items-start border-line bg-panel">
      <ItemContent>
        <ItemTitle className="text-xs text-ink">
          {title}
          {disabled ? <ToneBadge tone="neutral">unavailable</ToneBadge> : null}
        </ItemTitle>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          {description}
        </ItemDescription>
        {/*
          The reason is rendered *inline* as well as on the switch's tooltip.
          A tooltip is the right home for an explanation the user goes looking
          for; it is the wrong home for the one thing they need in order to
          understand why the control in front of them is dead.
        */}
        {reason ? <p className="text-2xs leading-relaxed text-amber">{reason}</p> : null}
        <ScopeNote>Per column — a split window sends each pane’s own flags.</ScopeNote>
      </ItemContent>
      <ItemActions>
        <Switch
          id={id}
          aria-label={title}
          checked={checked && !disabled}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </ItemActions>
    </Item>
  );
}

/* -------------------------------------------------------------------------- */
/* Run summary                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What each setting keeps of the block a run ends with.
 *
 * Every note says what still appears, not what disappears — the question a
 * user has here is "will I lose the error", and the answer is no in all three
 * cases. Trimming is described as trimming; nothing here is described as off.
 */
const RUN_SUMMARIES: readonly Choice<RunSummary>[] = [
  {
    id: 'always',
    label: 'After every run',
    note: 'Duration, turns, tokens and cost. Worth keeping while you are watching spend or comparing models.',
  },
  {
    id: 'failures',
    label: 'Only when a run is cut short',
    note: 'A clean run ends quietly. Errors, interruptions and hitting a turn or budget limit still report — each means the answer above is unfinished.',
  },
  {
    id: 'never',
    label: 'Never',
    note: 'No accounting at all. A failed run still shows its message and code, because this is the only place either appears.',
  },
];

/* -------------------------------------------------------------------------- */
/* Handing over                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One handoff rule's slider.
 *
 * The dragged value lives in local state until the pointer releases, and only
 * the release commits: `setHandoffThreshold` re-judges the readings already in
 * hand, so committing every intermediate value would let a drag *through* the
 * needle latch a handoff the user's finger was still on its way past. The
 * label tracks the drag, because a number that lags the thumb reads as broken.
 *
 * The floor is 50 rather than 1: the store accepts anything, but a slider is
 * an instrument for the usable range, and "hand off when half the budget
 * remains" is already the extreme of what the feature means. The default is
 * always inside [50, 100], so the floor can never hide a shipped value.
 */
function ThresholdSlider({
  rule,
  disabled,
}: {
  readonly rule: HandoffThreshold;
  readonly disabled: boolean;
}): ReactElement {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? rule.at;

  return (
    <div className="flex w-full items-center gap-3">
      <span className="w-14 shrink-0 text-2xs text-ink-muted">{rule.label}</span>
      <Slider
        value={[shown]}
        min={50}
        max={100}
        step={1}
        disabled={disabled}
        aria-label={`${rule.label} handoff threshold`}
        onValueChange={(values) => setDragging(values[0] ?? null)}
        onValueCommit={(values) => {
          setDragging(null);
          if (values[0] !== undefined) setHandoffThreshold(rule.id, values[0]);
        }}
      />
      <span className="w-9 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-muted">
        {shown}%
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The pane                                                                   */
/* -------------------------------------------------------------------------- */

export function RunsSection(): ReactElement {
  const runSummary = useApp((s) => s.runSummary);
  const autoHandoff = useApp((s) => s.autoHandoff);
  const handoffOverrides = useApp((s) => s.handoffThresholds);
  // The resolved rules rather than the raw overrides, so the sliders show the
  // numbers the feature will actually act on — defaults included, hand-edited
  // values clamped the same way `considerHandoff` clamps them.
  const handoffRules = useMemo(() => handoffThresholdsWith(handoffOverrides), [handoffOverrides]);

  return (
    <SettingsPane
      title="Runs"
      description="What the next run does and what it costs: the standing flags sent with the prompt, how much the transcript reports when a run ends, and whether a nearly-spent account hands its work on before the limit."
    >
      <Defaults />

      <SettingsGroup label="Run summary">
        <ChoiceList
          label="Run summary"
          value={runSummary}
          choices={RUN_SUMMARIES}
          onChange={setRunSummary}
        />
        <ScopeNote>One answer for the whole app on this machine.</ScopeNote>
      </SettingsGroup>

      <SettingsGroup label="Handing over">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Hand the work over before the limit</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Running out of plan mid-conversation loses the expensive part: not the turn, but
                everything the agent had worked out — which files matter, what it had already
                tried, what it was about to do. On, Artemis stops the conversation just short of
                the limit and spends the last of the budget asking for a briefing another session
                can start from, written to{' '}
                <span className="font-mono text-ink-muted">.artemis/</span> in the working folder
                and shown as an artifact.
                <br />
                <br />
                Where it stops is set below, per window. A run in flight is interrupted to do
                it, so this is off unless you ask for it; every conversation it stops offers a
                button to carry on regardless.
              </ItemDescription>
              <ScopeNote>One answer for the whole app on this machine.</ScopeNote>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-auto-handoff"
                aria-label="Hand the work over before the limit"
                checked={autoHandoff}
                onCheckedChange={setAutoHandoff}
              />
            </ItemActions>
          </Item>

          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent className="w-full">
              <ItemTitle className="text-xs text-ink">Where each window hands over</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Percent full at which the handover fires. The defaults are deliberately uneven:
                the 5-hour window refills within the working day, so margin there is cheap; the
                weekly one is gone for days once spent, so it is ridden closer to the edge; Fable
                sits between, because its exhaustion takes one model away rather than the
                account. How much runway a handover needs depends on how you work — the numbers
                are yours to move.
              </ItemDescription>
              <div className="mt-2 flex w-full flex-col gap-2.5">
                {handoffRules.map((rule) => (
                  <ThresholdSlider key={rule.id} rule={rule} disabled={!autoHandoff} />
                ))}
              </div>
            </ItemContent>
          </Item>
        </ItemGroup>
      </SettingsGroup>
    </SettingsPane>
  );
}
