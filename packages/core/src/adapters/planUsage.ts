/**
 * Reading a Claude plan's remaining capacity.
 *
 * Two things make this different from every other adapter call, and both shape
 * the code below.
 *
 * **It must not cost tokens.** A gauge you pay to read is a gauge nobody opens.
 * The SDK exposes this over its *control* channel, alongside `accountInfo()`
 * and `supportedModels()` — so we open a query whose prompt is an async
 * iterable we never push to, ask the question, and close. The model is never
 * sampled. The cost is one subprocess spawn.
 *
 * **The underlying API is explicitly unstable.** At the time of writing the
 * SDK names the method:
 *
 *     usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
 *
 * with a docstring saying it may change or be removed in any release without
 * notice, and that the name *will* change once it stabilises. Calling that
 * directly from anywhere else in Artemis would put a status-line widget on a
 * foundation that can vanish in a patch bump. So it is reached through a
 * tolerant lookup here, in one file, and a rename degrades to "unavailable"
 * instead of throwing. When it stabilises, this list is the only thing to edit.
 */

import type { PlanUsage, PlanUsageWindow, PlanUsageWindowId } from '@rx-artemis/protocol';

/**
 * Method names to try on the query object, newest first.
 *
 * Keep the experimental name until it is gone: users on an older SDK still
 * depend on it. Add the stable name above it when one appears.
 */
const USAGE_METHOD_NAMES = [
  'usage',
  'getUsage',
  'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET',
] as const;

/**
 * Display order and labels. Anything unrecognised is appended, not dropped.
 *
 * `model_scoped` and `spend` are deliberately absent: neither is a plain
 * window. See {@link expandModelScoped} and {@link spendWindow}.
 */
const KNOWN_WINDOWS: readonly { id: PlanUsageWindowId; label: string }[] = [
  { id: 'five_hour', label: '5 hours' },
  { id: 'seven_day', label: '7 days' },
  { id: 'seven_day_opus', label: '7 days · Opus' },
  { id: 'seven_day_sonnet', label: '7 days · Sonnet' },
  { id: 'seven_day_oauth_apps', label: '7 days · apps' },
  { id: 'extra_usage', label: 'Extra usage' },
];

/** One entry of the `model_scoped` array — a per-model weekly bucket. */
interface RawModelScoped {
  display_name?: string | null;
  utilization?: number | null;
  resets_at?: string | null;
}

/** The shape we need off the SDK response, without depending on its types. */
interface RawUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<
    string,
    // Not `readonly` on the array member: `Array.isArray` does not narrow a
    // union whose array side is readonly, and the two guards below depend on
    // it doing so. This is a description of a wire payload we only read.
    { utilization?: number | null; resets_at?: string | null } | RawModelScoped[] | null
  > | null;
}

/**
 * `model_scoped` is an array of per-model weekly buckets, not a window.
 *
 * The provider sends one entry per model it meters separately — `display_name`
 * is the bucket's own name, e.g. `Fable` — and the set varies by plan, so the
 * buckets cannot be enumerated here the way the fixed windows above are.
 *
 * This was previously read as if it were a single `{ utilization, resets_at }`
 * object like its siblings. An array has neither property, so every account
 * with per-model limits got one row labelled "Model" reporting `null` — a limit
 * that looked broken and, worse, hid the real per-model numbers inside it.
 *
 * Each bucket becomes its own window, keyed `model_scoped:<name>` so the id
 * stays stable across reads and a caller can recognise the family by prefix.
 */
function expandModelScoped(value: unknown): PlanUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const out: PlanUsageWindow[] = [];
  for (const entry of value as readonly RawModelScoped[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const name =
      typeof entry.display_name === 'string' && entry.display_name !== ''
        ? entry.display_name
        : null;
    // A bucket with no name cannot be told apart from any other, and an
    // anonymous per-model limit is worse than none: the user cannot act on it.
    if (name === null) continue;
    out.push({
      id: `model_scoped:${name}`,
      label: `7 days · ${name}`,
      utilization: clampUtilization(entry.utilization),
      resetsAt: parseResetsAt(entry.resets_at),
    });
  }
  return out;
}

/** The fields we read off the `spend` entry. A wire shape, only ever read. */
interface RawSpend {
  percent?: number | null;
}

/**
 * `spend` is the usage-credits balance, not a rate-limit window.
 *
 * Its shape is its own: the fraction consumed arrives as `percent` — of the
 * credit cap, not of a window — alongside money fields this protocol has no
 * vocabulary for, and there is no `resets_at` because credits do not come back
 * on a clock. Read through the generic passthrough it rendered as a row
 * labelled "spend" reporting `null` forever: the same looked-broken-while-
 * hiding-the-number failure `model_scoped` used to be.
 *
 * "Usage Credits" rather than "spend" because that is what the provider's own
 * copy calls the feature — the payload's disclaimer opens "Usage credits cover
 * you when you hit your plan limits".
 */
function spendWindow(value: unknown): PlanUsageWindow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    id: 'spend',
    label: 'Usage Credits',
    utilization: clampUtilization((value as RawSpend).percent),
    resetsAt: null,
  };
}

/**
 * Find the usage method regardless of what it is currently called.
 *
 * Returns a bound callable, or null when this SDK build exposes none of the
 * names — which is a supported outcome, not an error.
 */
function resolveUsageMethod(query: unknown): (() => Promise<unknown>) | null {
  if (query === null || typeof query !== 'object') return null;
  const bag = query as Record<string, unknown>;
  for (const name of USAGE_METHOD_NAMES) {
    const candidate = bag[name];
    if (typeof candidate === 'function') return () => (candidate as () => Promise<unknown>).call(query);
  }
  return null;
}

/** ISO 8601 → ms since epoch, tolerating absence and malformed values. */
function parseResetsAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The display label this file gives a window id, or `undefined` for one it has
 * never heard of.
 *
 * Exported for the mapper: the live `rate_limit_event` names windows in the
 * same vocabulary this file labels (`five_hour`, `seven_day`, …), and a window
 * first heard of *live* should read identically to one first read by the poll.
 * Two label tables would drift, and the drift would surface as one window
 * listed twice under two names.
 */
export function planWindowLabel(id: string): string | undefined {
  return KNOWN_WINDOWS.find((w) => w.id === id)?.label;
}

/**
 * Clamp a reported percentage into 0–100.
 *
 * The provider is the source of truth, but a meter that renders past its own
 * ends is worse than one that saturates. Values outside the range are clamped
 * rather than discarded: "over limit" is meaningful, "no data" is not.
 *
 * Exported for the mapper, which holds a live report's percentage to the same
 * rule as a polled one.
 */
export function clampUtilization(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** Translate the provider's payload into the provider-neutral protocol shape. */
export function mapPlanUsage(raw: unknown, fetchedAt: number): PlanUsage {
  const response = (raw ?? {}) as RawUsageResponse;

  if (response.rate_limits_available !== true || !response.rate_limits) {
    return {
      available: false,
      /*
        Deliberately does not assert *why*.

        The provider reports a single boolean for several distinct causes: an
        API-key or cloud-backend profile (metered, genuinely no limits), or a
        credential whose scope does not cover the usage endpoint — a
        `setup-token` credential is scoped to model requests, so a perfectly
        valid subscription can answer "unavailable" here. Claiming "this bills
        per token" would tell a subscription user something false about their
        own billing, which is the one thing this feature exists to get right.
      */
      unavailableReason:
        'No plan limits reported for this profile. That is expected for API-key, Bedrock and Vertex profiles, which bill per token. On a subscription profile it usually means the stored token cannot read the usage endpoint — a token from `claude setup-token` is scoped to model requests only.',
      windows: [],
      fetchedAt,
      ...(typeof response.subscription_type === 'string'
        ? { subscriptionType: response.subscription_type }
        : {}),
    };
  }

  const limits = response.rate_limits;
  const windows: PlanUsageWindow[] = [];

  // Known windows first, in a deliberate display order.
  for (const { id, label } of KNOWN_WINDOWS) {
    const entry = limits[id];
    if (!entry || Array.isArray(entry)) continue;
    windows.push({
      id,
      label,
      utilization: clampUtilization(entry.utilization),
      resetsAt: parseResetsAt(entry.resets_at),
    });
  }

  // Then the per-model buckets, which are a list rather than a window.
  windows.push(...expandModelScoped(limits['model_scoped']));

  // Then usage credits, which carry their own shape — see `spendWindow`.
  const spend = spendWindow(limits['spend']);
  if (spend !== null) windows.push(spend);

  // Then anything the provider has added since this file was written. Passing
  // an unrecognised window through unlabelled beats hiding a limit the user is
  // actually being held to.
  for (const [id, entry] of Object.entries(limits)) {
    if (!entry) continue;
    if (id === 'model_scoped' || id === 'spend') continue;
    if (KNOWN_WINDOWS.some((w) => w.id === id)) continue;
    // An unfamiliar *array* cannot be rendered as one window — that mistake is
    // what `model_scoped` was. Skip it rather than emit a row of nulls.
    if (Array.isArray(entry)) continue;
    windows.push({
      id,
      label: id.replace(/_/g, ' '),
      utilization: clampUtilization(entry.utilization),
      resetsAt: parseResetsAt(entry.resets_at),
    });
  }

  return {
    available: true,
    windows,
    fetchedAt,
    ...(typeof response.subscription_type === 'string'
      ? { subscriptionType: response.subscription_type }
      : {}),
  };
}

/**
 * Ask a live query object for plan usage.
 *
 * Separated from the query's construction so it can be tested against a plain
 * object, and so the caller owns the subprocess lifecycle.
 */
export async function readPlanUsage(query: unknown, now: number): Promise<PlanUsage> {
  const method = resolveUsageMethod(query);
  if (!method) {
    return {
      available: false,
      unavailableReason:
        'This version of the provider CLI does not report plan usage. Updating it may enable this.',
      windows: [],
      fetchedAt: now,
    };
  }

  try {
    return mapPlanUsage(await method(), now);
  } catch (cause) {
    // An experimental endpoint that errors is not a reason to break the caller.
    return {
      available: false,
      unavailableReason: `Could not read plan usage: ${cause instanceof Error ? cause.message : String(cause)}`,
      windows: [],
      fetchedAt: now,
    };
  }
}
