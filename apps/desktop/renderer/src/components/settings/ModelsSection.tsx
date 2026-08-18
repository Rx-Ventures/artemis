/**
 * The model catalogue.
 * ============================================================================
 *
 * The one place in Artemis where the full lineup is visible: every model the
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
 *     the provider picks one at run time and Artemis cannot know whether the flag
 *     would be honoured, which is a different reason and gets a different
 *     sentence.
 *
 * The quick-access checkboxes edit this profile's entry in
 * `quickModelIdsByProfile`, which the status-line picker narrows itself to. An
 * empty set is not "show nothing" — see `quickModels` — so the empty case is
 * labelled rather than left to look like a broken picker.
 *
 * The shortlist is per *profile* rather than per window because catalogues are
 * not comparable. Claude ships a handful of models; an OpenCode account reaches
 * hundreds across twenty providers. One shared shortlist is either swamped by
 * the large catalogue or empty for it, and since "pinned nothing" renders as
 * the whole catalogue, the swamped case degrades into no shortlist at all —
 * which is precisely the state the pins exist to rescue the user from.
 *
 * That size difference is also why the filter appears above `SEARCH_THRESHOLD`
 * rows and not below it. Nothing in this file asks which provider is active:
 * a pane that can be read at a glance gets no search box, and one that cannot
 * gets one, which happens to sort the providers correctly without naming them.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { BoxesIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react';
import type { ProviderModelOption } from '@rx-artemis/protocol';

import { ReasonButton } from '../disabled-reason';
import { ToneBadge } from '../primitives';
import { SettingsGroup, SettingsPane } from './pane';
import {
  activeEffortLevels,
  activeModels,
  activeProviderLabel,
  providerOffersFastMode,
  providerOffersUltracode,
  paneQuickModelIds,
  refreshModels,
  selectedModelOption,
  setFastMode,
  setModel,
  setQuickModels,
  setUltracode,
  toggleQuickModel,
  useApp,
} from '../../state/store';
import { usePane } from '../../state/paneContext';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
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
  const catalogue = usePane(activeModels);
  const efforts = usePane(activeEffortLevels);
  const providerLabel = usePane(activeProviderLabel);
  const profileId = usePane((s) => s.activeProfileId);
  const loading = usePane((s) => s.modelsLoading);
  const error = usePane((s) => s.modelsError);
  /**
   * Whether this list came off the installed CLI.
   *
   * Read as "a live catalogue was stored" rather than from a separate flag,
   * because that is precisely the condition `activeModels` uses to prefer it —
   * see `refreshModels`, which only writes `models` when the response was
   * `live`. Deriving it here from the same fact keeps the badge from ever
   * disagreeing with the list it labels.
   */
  const live = usePane((s) => s.models.length > 0);

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
            : `Nobody has confirmed this list. It is the lineup this build of Artemis ships for ${providerLabel}, which goes stale as soon as a model is added or withdrawn.`}
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
    return `No model is chosen, so the provider picks one at run time and Artemis cannot tell whether ${flag} would be honoured. Choose a model below.`;
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

/**
 * The size past which a flat list stops being a list and becomes a wall.
 *
 * Claude and Codex ship single figures, so the search box would be furniture
 * over a list you can already see all of. OpenCode reaches hundreds across
 * twenty providers, where scrolling to find one model is the whole problem.
 * The threshold is what lets one pane serve both without a provider check —
 * nothing here asks *which* provider, only how much there is to show.
 */
const SEARCH_THRESHOLD = 12;

/**
 * Match a model against a typed query.
 *
 * Searches the id as well as the names, because with a large catalogue the id
 * is what carries the vendor — `anthropic/…`, `openai/…` — and typing a vendor
 * to see its lineup is the most useful thing the box does. Case-insensitive and
 * substring rather than fuzzy: a user typing "gpt" wants the gpt models, not a
 * ranked guess that also matches something else.
 */
function matches(model: ProviderModelOption, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return (
    model.id.toLowerCase().includes(needle) ||
    model.label.toLowerCase().includes(needle) ||
    (model.displayName?.toLowerCase().includes(needle) ?? false)
  );
}

function Catalogue({
  catalogue,
  efforts,
}: {
  readonly catalogue: readonly ProviderModelOption[];
  readonly efforts: ReturnType<typeof activeEffortLevels>;
}): ReactElement {
  // Per profile, resolved through this pane — two columns on two accounts pin
  // separately, and the settings pane edits the one it is looking at.
  const quickIds = usePane(paneQuickModelIds);
  const selectedId = usePane((s) => s.model);
  const curated = quickIds.length > 0;

  const [query, setQuery] = useState('');
  const searchable = catalogue.length > SEARCH_THRESHOLD;
  const shown = useMemo(
    () => (searchable ? catalogue.filter((model) => matches(model, query)) : catalogue),
    [catalogue, query, searchable],
  );

  return (
    <SettingsGroup label="Quick access">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-faint">
          {curated
            ? `The picker under the composer shows only the ${quickIds.length} models ticked here, in catalogue order.`
            : 'Nothing is pinned, so the picker shows the whole catalogue. Tick a few to narrow it down to the ones you actually switch between.'}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <ReasonButton
            size="xs"
            variant="ghost"
            disabled={shown.length === 0}
            disabledReason="Nothing matches the search."
            // Scoped to what is on screen, not to the catalogue. With a search
            // active, "pin all" meaning "pin all four hundred" would be a
            // destructive misread of a button the user pressed while looking at
            // six rows — so the label counts, and the count is the filtered one.
            onClick={() => setQuickModels([...new Set([...quickIds, ...shown.map((m) => m.id)])])}
          >
            {query === '' ? 'Pin all' : `Pin these ${shown.length}`}
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

      {searchable ? (
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name, id or vendor…"
              aria-label="Filter models"
              spellCheck={false}
              className="h-6 rounded-md pl-6.5 text-2xs md:text-2xs"
            />
          </div>
          <span className="shrink-0 font-mono text-2xs text-ink-faint">
            {shown.length === catalogue.length
              ? `${catalogue.length} models`
              : `${shown.length} of ${catalogue.length}`}
          </span>
        </div>
      ) : null}

      <ItemGroup className="gap-2">
        {shown.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            efforts={efforts}
            pinned={quickIds.includes(model.id)}
            selected={model.id === selectedId}
          />
        ))}
      </ItemGroup>

      {/* A search that matches nothing is the one case where the list below is
          legitimately empty, and it needs saying — an empty ItemGroup under a
          populated search box reads as a broken pane rather than as no hits. */}
      {shown.length === 0 ? (
        <p className="py-4 text-center text-2xs text-ink-faint">
          No model matches “{query}”.
        </p>
      ) : null}

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
      className={cn('items-start bg-panel', selected ? 'border-lunar/45' : 'border-line')}
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
          {selected ? <ToneBadge tone="lunar">in use</ToneBadge> : null}
          {model.supportsFastMode ? <ToneBadge tone="mint">fast mode</ToneBadge> : null}
          {model.supportsUltracode ? <ToneBadge tone="cyan">ultracode</ToneBadge> : null}
          {model.adaptiveThinking ? <ToneBadge tone="sage">adaptive</ToneBadge> : null}
        </ItemTitle>

        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          {model.note}
        </ItemDescription>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-2xs text-ink-faint">
          {/* The id Artemis sends, and — when the provider publishes one — the
              concrete model that id resolves to. Artemis offers aliases rather
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
