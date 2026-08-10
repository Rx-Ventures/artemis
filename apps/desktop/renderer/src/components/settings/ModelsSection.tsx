/**
 * The model catalogue.
 * ============================================================================
 *
 * The one place in Libra where the full lineup is visible: every model the
 * account actually offers, under its real name, with the wire id it resolves
 * to and the flags it honours. Everywhere else in the app the same list is
 * squeezed into a 20px status-line segment or a dropdown, and both of those
 * show `label` ("Sonnet 5") because that is all that fits. Here there is room,
 * so nothing is abbreviated.
 *
 * Three ideas hold this pane together.
 *
 *  1. **Nothing here is a literal.** The rows come from `activeModels`, the
 *     effort names from `activeEffortLevels`, the flags from each option. No
 *     model name, id, or capability is typed into this file — a hand-written
 *     lineup goes stale the day the provider ships a model, which is exactly
 *     the failure the live-catalogue channel exists to prevent.
 *
 *  2. **Provenance is stated, not implied.** `activeModels` silently prefers
 *     the live catalogue and falls back to the provider descriptor's built-in
 *     list, which is the right behaviour and the wrong thing to hide: a user
 *     comparing this list against what their CLI offers deserves to know
 *     whether the account was ever asked. The badge at the top says which one
 *     they are looking at, and a failed refresh is a footnote on a working
 *     list rather than an error that replaces it.
 *
 *  3. **The flags are properties of a model, not of the app.** Fast mode and
 *     ultracode are stored as standing preferences — see `setFastMode` — but
 *     only one model at a time decides whether they mean anything. So the
 *     toggles are gated on the *selected* model and, when they are unavailable,
 *     say so in a sentence instead of vanishing. With no model chosen at all
 *     the provider picks one at run time and Libra cannot know whether the flag
 *     would be honoured, which is a different reason and gets a different
 *     sentence.
 *
 * The quick-access checkboxes edit `quickModelIds`, which the status-line
 * picker narrows itself to. An empty set is not "show nothing" — see
 * `quickModels` — so the empty case is labelled rather than left to look like
 * a broken picker.
 */

import type { ReactElement } from 'react';
import { BoxesIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import type { ProviderModelOption } from '@libra/protocol';

import { ReasonButton } from '../disabled-reason';
import { ToneBadge } from '../primitives';
import { SettingsGroup, SettingsPane } from './pane';
import {
  activeEffortLevels,
  activeModels,
  activeProviderLabel,
  refreshModels,
  selectedModelOption,
  setFastMode,
  setModel,
  setQuickModels,
  setUltracode,
  toggleQuickModel,
  useApp,
} from '../../state/store';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export function ModelsSection(): ReactElement {
  const catalogue = useApp(activeModels);
  const efforts = useApp(activeEffortLevels);
  const providerLabel = useApp(activeProviderLabel);
  const profileId = useApp((s) => s.activeProfileId);
  const loading = useApp((s) => s.modelsLoading);
  const error = useApp((s) => s.modelsError);
  /**
   * Whether this list came off the installed CLI.
   *
   * Read as "a live catalogue was stored" rather than from a separate flag,
   * because that is precisely the condition `activeModels` uses to prefer it —
   * see `refreshModels`, which only writes `models` when the response was
   * `live`. Deriving it here from the same fact keeps the badge from ever
   * disagreeing with the list it labels.
   */
  const live = useApp((s) => s.models.length > 0);

  const refreshReason = profileId
    ? undefined
    : 'No profile is active, so there is no credential to ask with. Create one under Profiles first.';

  return (
    <SettingsPane
      title="Models"
      description={`Everything ${providerLabel} will run for this profile, and which of them reach the picker under the composer.`}
      actions={
        <ReasonButton
          size="sm"
          variant="outline"
          disabled={loading || refreshReason !== undefined}
          disabledReason={refreshReason}
          onClick={() => void refreshModels()}
        >
          {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
          {loading ? 'Asking…' : 'Refresh'}
        </ReasonButton>
      }
    >
      <Provenance live={live} providerLabel={providerLabel} error={error} />

      <Defaults />

      {catalogue.length === 0 ? (
        <Empty className="border border-dashed border-line py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle className="text-ink">No models to choose from</EmptyTitle>
            <EmptyDescription className="text-2xs">
              {providerLabel} published no model list and no account answered with one, so runs use
              whatever the installed CLI picks for itself.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Catalogue catalogue={catalogue} efforts={efforts} />
      )}
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

function Provenance({
  live,
  providerLabel,
  error,
}: {
  readonly live: boolean;
  readonly providerLabel: string;
  readonly error: string | null;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-inset/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <ToneBadge tone={live ? 'sage' : 'amber'}>{live ? 'live' : 'built-in'}</ToneBadge>
        <span className="text-2xs leading-relaxed text-ink-muted">
          {live
            ? `This list came from the installed ${providerLabel} CLI, asked with this profile’s credential.`
            : `Nobody has confirmed this list. It is the lineup this build of Libra ships for ${providerLabel}, which goes stale as soon as a model is added or withdrawn.`}
        </span>
      </div>
      {error ? (
        // A footnote, not an error state: the list above is still real — either
        // a stale live one or the built-in fallback — so replacing it with a
        // failure message would take away something that works.
        <p className="flex items-start gap-1.5 font-mono text-2xs leading-snug text-amber">
          <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
          Last refresh failed: {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Fast mode / ultracode                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Why a per-model flag cannot be set right now, or `undefined`.
 *
 * Three distinct answers, because they ask for three different things from the
 * user: choose a model, choose a *different* model, or nothing at all because
 * this provider has no models to choose between.
 */
function flagReason(
  flag: 'fast mode' | 'ultracode',
  selected: ProviderModelOption | undefined,
  supported: boolean,
  hasCatalogue: boolean,
  providerLabel: string,
): string | undefined {
  if (!hasCatalogue) {
    return `${providerLabel} offers no model choice here, so there is no model to ask for ${flag}.`;
  }
  if (!selected) {
    return `No model is chosen, so the provider picks one at run time and Libra cannot tell whether ${flag} would be honoured. Choose a model below.`;
  }
  if (!supported) {
    return `${selected.displayName ?? selected.label} does not accept ${flag}.`;
  }
  return undefined;
}

function Defaults(): ReactElement {
  const selected = useApp(selectedModelOption);
  const providerLabel = useApp(activeProviderLabel);
  const hasCatalogue = useApp((s) => activeModels(s).length > 0);
  const fastMode = useApp((s) => s.fastMode);
  const ultracode = useApp((s) => s.ultracode);

  const fastReason = flagReason(
    'fast mode',
    selected,
    selected?.supportsFastMode === true,
    hasCatalogue,
    providerLabel,
  );
  const ultraReason = flagReason(
    'ultracode',
    selected,
    selected?.supportsUltracode === true,
    hasCatalogue,
    providerLabel,
  );

  return (
    <SettingsGroup label="Defaults for the next run">
      <ItemGroup className="gap-2">
        <FlagRow
          id="settings-fast-mode"
          title="Fast mode"
          description="Trade reasoning depth for latency. Sent only when the chosen model accepts it — the preference itself survives a switch to one that does not."
          checked={fastMode}
          reason={fastReason}
          onChange={setFastMode}
        />
        <FlagRow
          id="settings-ultracode"
          title="Ultracode"
          description="Spend materially more compute on a single turn. The opposite trade to fast mode, and independent of it: a model may offer either, both or neither."
          checked={ultracode}
          reason={ultraReason}
          onChange={setUltracode}
        />
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
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

function Catalogue({
  catalogue,
  efforts,
}: {
  readonly catalogue: readonly ProviderModelOption[];
  readonly efforts: ReturnType<typeof activeEffortLevels>;
}): ReactElement {
  const quickIds = useApp((s) => s.quickModelIds);
  const selectedId = useApp((s) => s.model);
  const curated = quickIds.length > 0;

  return (
    <SettingsGroup label="Quick access">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-faint">
          {curated
            ? 'The picker under the composer shows only the models ticked here, in this order.'
            : 'Nothing is pinned, so the picker shows the whole catalogue. Tick a few to narrow it down to the ones you actually switch between.'}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <ReasonButton
            size="xs"
            variant="ghost"
            onClick={() => setQuickModels(catalogue.map((model) => model.id))}
          >
            Pin all
          </ReasonButton>
          <ReasonButton
            size="xs"
            variant="ghost"
            disabled={!curated}
            disabledReason="Nothing is pinned yet."
            onClick={() => setQuickModels([])}
          >
            Clear
          </ReasonButton>
        </div>
      </div>

      <ItemGroup className="gap-2">
        {catalogue.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            efforts={efforts}
            pinned={quickIds.includes(model.id)}
            selected={model.id === selectedId}
          />
        ))}
      </ItemGroup>

      {/* `null` is a real, reachable state — "send no model at all and let the
          CLI decide" — and it is not one of the rows, so it needs its own way
          back. Offered only when a model is actually chosen. */}
      <ReasonButton
        size="xs"
        variant="ghost"
        className="self-start text-ink-faint"
        disabled={selectedId === null}
        disabledReason="Runs already use whatever the installed CLI selects."
        onClick={() => setModel(null)}
      >
        Send no model — let the CLI choose
      </ReasonButton>
    </SettingsGroup>
  );
}

/**
 * Effort levels this model accepts, as a sentence.
 *
 * `undefined` and `[]` are opposite answers on `ProviderModelOption` — "every
 * level the provider offers" and "no effort setting at all" — and getting them
 * the wrong way round would advertise a knob that does nothing. Ids are
 * resolved against the descriptor's own list so the pane never names a level
 * the picker cannot show.
 */
function effortSummary(
  model: ProviderModelOption,
  efforts: ReturnType<typeof activeEffortLevels>,
): string | null {
  if (efforts.length === 0) return null;
  if (model.effortLevels === undefined) return 'every effort level';
  if (model.effortLevels.length === 0) return 'no effort setting';
  const named = model.effortLevels
    .map((id) => efforts.find((level) => level.id === id)?.label ?? id)
    .join(' · ');
  return named.length > 0 ? named : null;
}

function ModelRow({
  model,
  efforts,
  pinned,
  selected,
}: {
  readonly model: ProviderModelOption;
  readonly efforts: ReturnType<typeof activeEffortLevels>;
  readonly pinned: boolean;
  readonly selected: boolean;
}): ReactElement {
  const effort = effortSummary(model, efforts);
  const name = model.displayName ?? model.label;

  return (
    <Item
      variant="outline"
      size="sm"
      className={cn('items-start bg-panel', selected ? 'border-brass/45' : 'border-line')}
    >
      <ItemMedia className="pt-0.5">
        <Checkbox
          checked={pinned}
          // The visible label is the row's title, which is not a `<label>` for
          // this control — so the checkbox states its own purpose rather than
          // announcing as an unnamed tick box.
          aria-label={`Show ${name} in the quick picker`}
          onCheckedChange={() => toggleQuickModel(model.id)}
        />
      </ItemMedia>

      <ItemContent>
        <ItemTitle className="flex-wrap text-xs text-ink">
          {name}
          {selected ? <ToneBadge tone="brass">in use</ToneBadge> : null}
          {model.supportsFastMode ? <ToneBadge tone="mint">fast mode</ToneBadge> : null}
          {model.supportsUltracode ? <ToneBadge tone="cyan">ultracode</ToneBadge> : null}
          {model.adaptiveThinking ? <ToneBadge tone="sage">adaptive</ToneBadge> : null}
        </ItemTitle>

        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          {model.note}
        </ItemDescription>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-2xs text-ink-faint">
          {/* The id Libra sends, and — when the provider publishes one — the
              concrete model that id resolves to. Libra offers aliases rather
              than dated snapshots, so without the second half a user cannot
              tell which snapshot `sonnet` is pointing at this week. */}
          <span className="text-ink-muted">{model.id}</span>
          {model.resolvedModel && model.resolvedModel !== model.id ? (
            <span>→ {model.resolvedModel}</span>
          ) : null}
          {effort ? <span>effort: {effort}</span> : null}
        </div>
      </ItemContent>

      <ItemActions>
        <ReasonButton
          size="xs"
          variant={selected ? 'secondary' : 'outline'}
          disabled={selected}
          disabledReason="Already the model the next run will use."
          onClick={() => setModel(model.id)}
        >
          {selected ? 'Current' : 'Use'}
        </ReasonButton>
      </ItemActions>
    </Item>
  );
}
