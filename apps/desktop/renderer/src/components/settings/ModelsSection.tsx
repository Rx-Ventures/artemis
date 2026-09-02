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
 *  3. **This pane describes the lineup; it does not shape the run.** The fast
 *     mode and ultracode switches lived here once, on the argument that the
 *     flags are properties of a model. They still are — the badges on each row
 *     say which models honour them — but *setting* them is a decision about
 *     the next run, and it lives with the rest of those decisions in the Runs
 *     pane. What stays here is the catalogue's testimony: which models exist,
 *     what each accepts, and which of them reach the picker.
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

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { BoxesIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react';
import type { PlanUsage, ProfileId, ProviderModelOption } from '@rx-artemis/protocol';
import { isProfileEnabled } from '@rx-artemis/protocol';

import { ReasonButton } from '../disabled-reason';
import { ToneBadge } from '../primitives';
import { PressureDot } from '../RunNavigator';
import { toneFor } from '../PlanUsageMeter';
import { SettingsGroup, SettingsPane } from './pane';
import { call, resolveBridge } from '../../lib/bridge';
import {
  activeEffortLevels,
  activeModels,
  activeProviderLabel,
  refreshModels,
  setModel,
  setQuickModelsFor,
  toggleQuickModelFor,
  useApp,
} from '../../state/store';
import { modelExhaustion, modelPressure } from '../../state/modelFacts';
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
import { cn } from '@/lib/utils';

export function ModelsSection(): ReactElement {
  const paneCatalogue = usePane(activeModels);
  const efforts = usePane(activeEffortLevels);
  const paneProviderLabel = usePane(activeProviderLabel);
  const paneProfileId = usePane((s) => s.activeProfileId);
  const paneLoading = usePane((s) => s.modelsLoading);
  const paneError = usePane((s) => s.modelsError);
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);

  /*
   * Which account is being curated. The pane's own by default — the old
   * behaviour exactly — and any enabled profile on request, because the quick
   * picker this section feeds is per profile and a curator that could only
   * reach the active one showed "only claude models" to anyone whose active
   * profile was Claude. An override's catalogue is fetched here, not through
   * the pane: curating an account must not switch the conversation onto it.
   */
  const [override, setOverride] = useState<ProfileId | null>(null);
  const [fetched, setFetched] = useState<{
    readonly forProfile: ProfileId;
    readonly models: readonly ProviderModelOption[];
    readonly live: boolean;
    readonly error: string | null;
  } | null>(null);
  const curatable = useMemo(() => profiles.filter((p) => isProfileEnabled(p)), [profiles]);
  const curatedId = override ?? paneProfileId;

  useEffect(() => {
    if (override === null) return;
    let stale = false;
    setFetched(null);
    const { bridge } = resolveBridge();
    const profile = profiles.find((p) => p.id === override);
    if (!bridge || profile === undefined) return;
    void call(() =>
      bridge.providers.models({ providerId: profile.providerId, profileId: profile.id }),
    ).then((result) => {
      if (stale) return;
      if (!result.ok) {
        setFetched({ forProfile: override, models: [], live: false, error: result.error.message });
        return;
      }
      setFetched({
        forProfile: override,
        models: result.value.models,
        live: result.value.live === true,
        error: null,
      });
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override]);

  const overridden = override !== null && fetched?.forProfile === override;
  const catalogue = override === null ? paneCatalogue : (overridden ? fetched.models : []);
  const providerLabel =
    override === null
      ? paneProviderLabel
      : (providers.find((p) => p.id === profiles.find((x) => x.id === override)?.providerId)?.label ??
        'This provider');
  const profileId = curatedId;
  const loading = override === null ? paneLoading : !overridden;
  const error = override === null ? paneError : (overridden ? fetched.error : null);
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
        <>
          {curatable.length > 1 ? (
            <select
              value={curatedId ?? ''}
              onChange={(event) =>
                setOverride(
                  event.target.value === (paneProfileId ?? '') ? null : (event.target.value as ProfileId),
                )
              }
              className="h-8 rounded border border-line bg-transparent px-1 text-xs text-ink"
              aria-label="Profile to curate"
            >
              {curatable.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
          ) : null}
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
        </>
      }
    >
      <Provenance live={live} providerLabel={providerLabel} error={error} />

      {catalogue.length === 0 ? (
        <Empty className="border border-dashed border-hairline py-10">
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
        <Catalogue catalogue={catalogue} efforts={efforts} curatedProfileId={profileId} />
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
    <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-inset/60 px-3 py-2">
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
 * "This profile has pinned nothing", with a stable identity.
 *
 * A selector that allocates cannot be read through a store hook — see the note
 * at its use below, and `NO_OPTIONS` in the store, which names the render loop
 * this prevents. The sibling routines pane keeps its own copy of this constant
 * for the same reason.
 */
const NO_PINS: readonly string[] = [];

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
  curatedProfileId,
}: {
  readonly catalogue: readonly ProviderModelOption[];
  readonly efforts: ReturnType<typeof activeEffortLevels>;
  readonly curatedProfileId: ProfileId | null;
}): ReactElement {
  // Per profile — the one being curated, which is the pane's own unless the
  // section's switcher pointed it elsewhere. Pins for another account write
  // to that account's entry and never touch the conversation.
  const profileId = curatedProfileId;
  /*
   * `NO_PINS`, never a fresh `[]`, and this is the whole reason the pane could
   * not be opened.
   *
   * A zustand selector's result is compared by identity to decide whether to
   * re-render. Both branches here used to allocate — `[]` for a pane with no
   * profile, `?? []` for a profile that has pinned nothing — so the value
   * changed on every read, `useSyncExternalStore` reported a new snapshot on
   * every check, and React looped to its update-depth ceiling and unmounted the
   * tree. The window went blank, and it went blank for the commonest state
   * there is: an account that has never pinned a model. Anyone who *had*
   * pinned one read a stored array and never saw it.
   *
   * One frozen constant for both branches. The same hazard, the same fix, and
   * the same reasoning as `NO_OPTIONS` and `paneQuickModelIds` in the store —
   * see the note beside `NO_OPTIONS`, which describes this exact loop.
   */
  const quickIds = useApp((s) =>
    profileId === null ? NO_PINS : (s.quickModelIdsByProfile[profileId] ?? NO_PINS),
  );
  const selectedId = usePane((s) => s.model);
  const curated = quickIds.length > 0;
  /*
    The same three facts the run navigator and the palette put on their rows,
    from the same helpers and the same polled map — three surfaces, one system.
    Read-only: this pane renders the whole catalogue at once, and a fetch per
    row would spawn a subprocess per model.
  */
  const usage = useApp((s) =>
    profileId === null ? null : (s.planUsageByProfile[profileId] ?? null),
  );
  // Captured at mount: the facts are judged when the pane opens.
  const [now] = useState(() => Date.now());

  const [query, setQuery] = useState('');
  const searchable = catalogue.length > SEARCH_THRESHOLD;
  const shown = useMemo(
    () => (searchable ? catalogue.filter((model) => matches(model, query)) : catalogue),
    [catalogue, query, searchable],
  );

  return (
    // The anchor is the address the status line's "Edit quick access…" aims at
    // — `openSettings('models', { row: 'quick-access' })` — so this group has
    // to keep answering to it even if the group itself is renamed.
    <SettingsGroup label="Quick access" anchor="quick-access">
      <div className="flex items-start gap-3 px-3 py-2.5">
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
            onClick={() => {
              if (profileId !== null)
                setQuickModelsFor(profileId, [...new Set([...quickIds, ...shown.map((m) => m.id)])]);
            }}
          >
            {query === '' ? 'Pin all' : `Pin these ${shown.length}`}
          </ReasonButton>
          <ReasonButton
            size="xs"
            variant="ghost"
            disabled={!curated}
            disabledReason="Nothing is pinned yet."
            onClick={() => { if (profileId !== null) setQuickModelsFor(profileId, []); }}
          >
            Clear
          </ReasonButton>
        </div>
      </div>

      {searchable ? (
        <div className="flex items-center gap-2 px-3 py-2.5">
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

      <ItemGroup className="gap-0 divide-y divide-hairline">
        {shown.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            efforts={efforts}
            pinned={quickIds.includes(model.id)}
            selected={model.id === selectedId}
            usage={usage}
            profileId={profileId}
            now={now}
          />
        ))}
      </ItemGroup>

      {/* A search that matches nothing is the one case where the list below is
          legitimately empty, and it needs saying — an empty ItemGroup under a
          populated search box reads as a broken pane rather than as no hits. */}
      {shown.length === 0 ? (
        <p className="px-3 py-4 text-center text-2xs text-ink-faint">
          No model matches “{query}”.
        </p>
      ) : null}

      {/* `null` is a real, reachable state — "send no model at all and let the
          CLI decide" — and it is not one of the rows, so it needs its own way
          back. Offered only when a model is actually chosen. */}
      <div className="px-3 py-2.5">
        <ReasonButton
          size="xs"
          variant="ghost"
          className="text-ink-faint"
          disabled={selectedId === null}
          disabledReason="Runs already use whatever the installed CLI selects."
          onClick={() => setModel(null)}
        >
          Send no model — let the CLI choose
        </ReasonButton>
      </div>
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
  usage,
  now,
  profileId,
}: {
  readonly model: ProviderModelOption;
  readonly efforts: ReturnType<typeof activeEffortLevels>;
  readonly pinned: boolean;
  readonly selected: boolean;
  readonly usage: PlanUsage | null;
  readonly now: number;
  readonly profileId: ProfileId | null;
}): ReactElement {
  const effort = effortSummary(model, efforts);
  const name = model.displayName ?? model.label;
  const exhausted = modelExhaustion(model, usage, now);
  const pressure = modelPressure(model, usage);

  return (
    <Item size="sm" className={cn('items-start', selected && 'rounded-md bg-wash-strong')}>
      <ItemMedia className="pt-0.5">
        <Checkbox
          checked={pinned}
          // The visible label is the row's title, which is not a `<label>` for
          // this control — so the checkbox states its own purpose rather than
          // announcing as an unnamed tick box.
          aria-label={`Show ${name} in the quick picker`}
          onCheckedChange={() => { if (profileId !== null) toggleQuickModelFor(profileId, model.id); }}
        />
      </ItemMedia>

      <ItemContent>
        <ItemTitle className="flex-wrap text-xs text-ink">
          <span className={cn(exhausted !== null && 'text-ink-faint line-through')}>{name}</span>
          {selected ? <ToneBadge tone="beam">in use</ToneBadge> : null}
          {model.supportsFastMode ? <ToneBadge tone="mint">fast mode</ToneBadge> : null}
          {model.supportsUltracode ? <ToneBadge tone="cyan">ultracode</ToneBadge> : null}
          {model.adaptiveThinking ? <ToneBadge tone="sage">adaptive</ToneBadge> : null}
        </ItemTitle>

        {/* The navigator's exhaustion fact, in the catalogue's own register:
            present, struck through above, and explained here with the reset
            time — never hidden. Same helper, same wording, three surfaces. */}
        {exhausted !== null ? (
          <p className="text-2xs leading-snug text-signal">{exhausted.reason}</p>
        ) : null}

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
          {/* Pressure, as the navigator draws it: the window that binds *this*
              model, its number in the meter's own tones. */}
          {pressure !== null && pressure.window.status !== 'rejected' ? (
            <span className="flex items-center gap-1">
              <PressureDot pressure={pressure} />
              {pressure.utilization === null ? null : (
                <span className={cn('tabular-nums', toneFor(pressure.utilization, pressure.window.status))}>
                  {Math.round(pressure.utilization)}% of {pressure.window.label}
                </span>
              )}
            </span>
          ) : null}
        </div>
      </ItemContent>

      <ItemActions>
        <ReasonButton
          size="xs"
          variant={selected ? 'secondary' : 'outline'}
          disabled={selected || exhausted !== null}
          disabledReason={
            selected ? 'Already the model the next run will use.' : exhausted?.reason
          }
          onClick={() => setModel(model.id)}
        >
          {selected ? 'Current' : 'Use'}
        </ReasonButton>
      </ItemActions>
    </Item>
  );
}
