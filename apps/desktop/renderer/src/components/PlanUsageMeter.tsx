/**
 * Plan usage: how much of the subscription's capacity is gone.
 *
 * Deliberately narrow: four things and their reset times — context window, the
 * 5-hour limit, the weekly limit, and any per-model weekly (Fable, Opus,
 * Sonnet). No session cost, no token totals, no plan marketing. Those answer
 * "what did this run cost"; this answers "how much room is left".
 *
 * Context window is the odd one out — it belongs to the *run*, not the account,
 * and it has no reset time because it clears when you start a new session. It
 * is here because it is the other half of "how much room is left", and having
 * to look in two places for that is the thing worth avoiding. It therefore
 * renders even when plan limits are unavailable, which is why it sits above
 * the early returns rather than inside the windows list.
 *
 * ## Stale-while-revalidate
 *
 * A refresh spawns a provider subprocess and takes a second or two, which is
 * far too slow to open a popover on. So the cached reading paints immediately
 * and the fresh one swaps in behind it. The alternative — a spinner on every
 * open — makes a glanceable gauge feel like a page load.
 *
 * The cost of a refresh is a subprocess, **not** model tokens: the provider
 * answers this over its control channel, so opening this popover never bills
 * anything.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { GaugeIcon, RefreshCwIcon } from 'lucide-react';

import { bindingWindow, type PlanUsage, type PlanUsageWindow } from '@libra/protocol';

import { call, resolveBridge } from '../lib/bridge';
import { formatTokens } from '../lib/format';
import { activeCapabilities, activeProviderLabel, useApp } from '../state/store';
import { WithReason } from './disabled-reason';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { cn } from '../lib/utils';

/**
 * Colour by pressure, not by aesthetics.
 *
 * The thresholds are deliberately pessimistic: a window at 75% during a long
 * session is worth noticing *before* it stops you, because the reset can be
 * hours away.
 */
function toneFor(utilization: number | null): string {
  if (utilization === null) return 'text-ink-faint';
  if (utilization >= 90) return 'text-signal';
  if (utilization >= 75) return 'text-amber';
  return 'text-ink-muted';
}

function barToneFor(utilization: number | null): string {
  if (utilization === null) return 'bg-line';
  if (utilization >= 90) return 'bg-signal';
  if (utilization >= 75) return 'bg-amber';
  return 'bg-mint';
}

/**
 * The exact wall-clock reset, with the countdown as secondary.
 *
 * The exact time is what was asked for and it is the more useful of the two:
 * "resets in 4h" needs mental arithmetic before you can decide whether to wait
 * or to stop for the day. The countdown stays alongside it because a bare
 * timestamp does not say whether that is soon.
 *
 * A window resetting more than a day out shows its weekday and date — "3:00 PM"
 * alone would read as today.
 */
function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '';
  const ms = resetsAt - now;
  if (ms <= 0) return 'resetting now';

  const at = new Date(resetsAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const exact = sameDay
    ? clock
    : `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock}`;

  const minutes = Math.round(ms / 60_000);
  const countdown =
    minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`.replace(' 0m', '')
        : `${Math.round(minutes / (24 * 60))}d`;

  return `resets ${exact} · in ${countdown}`;
}

/**
 * The windows worth showing, in this order.
 *
 * Deliberately a shortlist rather than everything the provider returns. The
 * payload also carries `seven_day_oauth_apps` and `extra_usage`, which answer
 * questions nobody asks mid-run; showing seven bars would bury the two that
 * actually stop you.
 *
 * Model-scoped weeklies are matched by prefix so a window for a model that did
 * not exist when this was written — Fable being exactly that case — appears
 * without needing a code change.
 */
function isShown(id: string): boolean {
  return id === 'five_hour' || id.startsWith('seven_day') || id === 'model_scoped';
}

/** Order: overall limits first, then per-model. */
function displayRank(id: string): number {
  if (id === 'five_hour') return 0;
  if (id === 'seven_day') return 1;
  return 2;
}

function ageHint(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function PlanUsageMeter(): ReactElement | null {
  const profileId = useApp((s) => s.activeProfileId);
  const supported = useApp((s) => activeCapabilities(s).planUsageReporting);
  const providerLabel = useApp(activeProviderLabel);

  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (mode: 'cached' | 'refresh') => {
      if (profileId === null) return;
      const { bridge } = resolveBridge();
      if (!bridge) return;

      if (mode === 'refresh') setRefreshing(true);
      const res = await call(() => bridge.usagePlan[mode]({ profileId }));
      if (mode === 'refresh') setRefreshing(false);

      // The active profile can change while a read is in flight; showing one
      // account's limits under another's label would be worse than showing none.
      if (useApp.getState().activeProfileId !== profileId) return;
      if (res.ok && res.value.usage !== null) setUsage(res.value.usage);
    },
    [profileId],
  );

  // Paint from cache as soon as the trigger exists, so the icon can already
  // carry a colour before it is ever clicked.
  useEffect(() => {
    setUsage(null);
    void load('cached');
  }, [load]);

  // Opening is what triggers the network read — see the header note.
  useEffect(() => {
    if (open) void load('refresh');
  }, [open, load]);

  if (profileId === null) return null;

  if (!supported) {
    return (
      <WithReason reason={`${providerLabel} does not report plan usage.`} side="top">
        <span aria-disabled="true" className="px-1 text-ink-faint opacity-60">
          <GaugeIcon className="size-3" aria-hidden="true" />
        </span>
      </WithReason>
    );
  }

  const binding = bindingWindow(usage);
  const now = Date.now();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Plan usage"
        className={cn(
          'flex items-center gap-1 rounded px-1 py-0.5 hover:bg-line/40',
          toneFor(binding?.utilization ?? null),
        )}
      >
        <GaugeIcon className="size-3 shrink-0" aria-hidden="true" />
        {binding?.utilization !== null && binding !== null ? (
          <span className="font-mono text-2xs tabular-nums">{Math.round(binding.utilization!)}%</span>
        ) : null}
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-72 p-3">
        <PlanUsageBody usage={usage} refreshing={refreshing} now={now} onRefresh={() => void load('refresh')} />
      </PopoverContent>
    </Popover>
  );
}

function PlanUsageBody(props: {
  readonly usage: PlanUsage | null;
  readonly refreshing: boolean;
  readonly now: number;
  readonly onRefresh: () => void;
}): ReactElement {
  /*
    Context window first, and outside the plan branches.

    It is a property of the run rather than the account, so it is knowable even
    when plan limits are not — an API-key profile has no limits to report but
    still has a context window filling up.
  */
  return (
    <div className="flex flex-col gap-2.5">
      <ContextWindowRow />
      <PlanWindows {...props} />
    </div>
  );
}

function PlanWindows({
  usage,
  refreshing,
  now,
  onRefresh,
}: {
  readonly usage: PlanUsage | null;
  readonly refreshing: boolean;
  readonly now: number;
  readonly onRefresh: () => void;
}): ReactElement {
  // Cold start: nothing cached and the first read still in flight.
  if (usage === null) {
    return (
      <p className="text-2xs text-ink-faint">
        {refreshing ? 'Reading plan usage…' : 'No plan usage recorded yet.'}
      </p>
    );
  }

  // A profile that bills per token has no limits to report. That is an answer,
  // not a failure, and it must not look like "0% used".
  if (!usage.available) {
    return <p className="text-2xs text-ink-muted">{usage.unavailableReason}</p>;
  }

  const shown = usage.windows
    .filter((w) => isShown(w.id))
    .slice()
    .sort((a, b) => displayRank(a.id) - displayRank(b.id) || a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">
          {usage.subscriptionType ? `${usage.subscriptionType} plan` : 'Plan usage'}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-2xs text-ink-faint hover:text-ink-muted disabled:opacity-50"
        >
          <RefreshCwIcon className={cn('size-2.5', refreshing && 'animate-spin')} aria-hidden="true" />
          {refreshing ? 'updating' : ageHint(usage.fetchedAt, now)}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="text-2xs text-ink-faint">No limits reported for this plan.</p>
      ) : (
        shown.map((window) => <WindowRow key={window.id} window={window} now={now} />)
      )}
    </div>
  );
}

/**
 * How full the current conversation's context is.
 *
 * Not a plan limit — it belongs to the run, not the account — but it is the
 * other "how much room is left" number, and answering both in one place is
 * why this row lives here rather than only in the status bar.
 *
 * It has no reset time by design: a context window empties when you start a
 * new session, not on a clock.
 */
function ContextWindowRow(): ReactElement {
  const usage = useApp((s) => s.run?.usage);
  const reporting = useApp((s) => activeCapabilities(s).usageReporting);
  const providerLabel = useApp(activeProviderLabel);

  const tokens = usage?.contextTokens;
  const window = usage?.contextWindow;
  const pct =
    reporting && tokens !== undefined && window ? Math.min(100, (tokens / window) * 100) : null;

  /*
    Three distinct states, and they must not collapse into one dash:
      - the provider cannot report usage at all   → say which provider, and why
      - it can, but nothing has run yet           → say so
      - it has                                    → the numbers
    A bare "—" for the first case reads as a bug rather than a limitation.
  */
  const note = !reporting
    ? `${providerLabel} does not report token usage`
    : pct === null
      ? 'no run yet'
      : `${formatTokens(tokens ?? 0)} of ${formatTokens(window ?? 0)} · clears on a new session`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="truncate text-ink-muted">Context window</span>
        <span className={cn('shrink-0 font-mono tabular-nums', toneFor(pct))}>
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-line/60">
        <div
          className={cn('h-full rounded-full transition-[width]', barToneFor(pct))}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>

      <span className="text-2xs text-ink-faint">{note}</span>
    </div>
  );
}

function WindowRow({
  window,
  now,
}: {
  readonly window: PlanUsageWindow;
  readonly now: number;
}): ReactElement {
  const pct = window.utilization;
  const hint = resetLabel(window.resetsAt, now);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="truncate text-ink-muted">{window.label}</span>
        <span className={cn('shrink-0 font-mono tabular-nums', toneFor(pct))}>
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-line/60">
        <div
          className={cn('h-full rounded-full transition-[width]', barToneFor(pct))}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>

      {hint === '' ? null : <span className="text-2xs text-ink-faint">{hint}</span>}
    </div>
  );
}
