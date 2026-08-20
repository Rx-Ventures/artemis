# A workload-aware, reset-aware account rotation algorithm — proposal

Design proposal, 2026-08-18. Companion to the ranking machinery in
`packages/protocol/src/usage.ts` (`recommendProfile`), `planLoad.ts` and
`planCapacity.ts`. Nothing here modifies the existing algorithm: it stays as
shipped, remains the default, and the new one arrives beside it behind a
user-visible algorithm picker.

## Verdict

**Add a second ranking algorithm, `drain-v1`, as a pure sibling module in
`packages/protocol/src/`, dispatched through a small algorithm registry that the
renderer's one wrapper (`planRecommendation`, `store.ts:3579`) consults. The
current algorithm keeps its id, its code, and the default slot.**

The new algorithm changes the question being asked. Today's ranker asks *"which
account has the most room on its single worst window?"* The proposed one asks
*"which account should absorb **this workload** so that the least plan capacity
expires unused, without the session stalling?"* — which decomposes into the
three things the current ranker cannot see:

1. **The workload.** A Fable session is stopped by the Fable weekly bucket and
   the overall weekly, never by the Opus bucket — yet today a full
   `model_scoped:Opus` window sinks an account for Fable work.
2. **The clock.** Weekly capacity unspent at reset is wasted. An account whose
   weekly resets in 14 hours should be drained ahead of one whose equal
   headroom survives another six days.
3. **The two windows' different natures.** The weekly window is a *stock* (it
   perishes; spend it before reset). The 5-hour window is a *rate limiter* (it
   replenishes within hours; the only cost of exhausting it is a stall). One
   number cannot price both, so the algorithm gates on the 5-hour window and
   ranks on the weekly one.

## What exists today

One pure function, two consumers, one wrapper between them.

- `recommendProfile` — `packages/protocol/src/usage.ts:393`. Excludes
  unavailable/metered profiles, readings older than `PLAN_USAGE_MAX_AGE_MS`,
  and windows with no number; requires ≥ 2 candidates; settles a comparison
  `basis` (`same-plan` / `weighted` / `percentage`); then scores each account
  `headroom × weight − reservation` (or the percentage-basis variant), where
  headroom is `100 − utilization` of the **binding window** — the most-consumed
  window of any kind. Ties keep caller order to stop label flapping.
- `reservationFor` — `planLoad.ts:197`. Subtracts an uncalibrated estimate of
  what live runs on the account will spend (model × effort × ultracode ×
  `BASELINE_RESERVATION_POINTS`), which is what stops the herd-onto-one-account
  failure (#146).
- `planRecommendation` — renderer `store.ts:3579`. The only wrapper: filters by
  `isProfileAutoSelectable`, attaches usage, provider, resolved plan weight and
  live runs, and calls `recommendProfile`.
- Consumers: `newSession` (`store.ts:6292`) auto-adopts the winner for a fresh
  composer (this is the actual rotation), and the StatusLine's Recommended row
  (`StatusLine.tsx:622`) renders the same computation for a manual click.

What the readings contain (per `packages/core/src/adapters/planUsage.ts`):

| Window | Claude | Codex |
| --- | --- | --- |
| `five_hour` | utilization + `resetsAt` (ms) | — |
| `seven_day` | utilization + `resetsAt` | — |
| `model_scoped:<Name>` (e.g. `Fable`, `Opus`) | one per metered model, own utilization + `resetsAt` | **none** |
| `seven_day_opus` / `seven_day_sonnet` (legacy ids) | as reported | — |
| `seven_day_oauth_apps` | as reported | — |
| `extra_usage`, `spend` | `spend` always has `resetsAt: null` | — |
| anonymous `primary` / `secondary` | — | utilization + `resetsAt`, no model buckets |

So everything the new algorithm needs — per-window reset clocks and per-model
weekly buckets — is already parsed, normalized, polled every ~5 minutes, and
sitting in `planUsageByProfile`. No adapter or poller work is required.

## Where the current algorithm misranks

Each defect below is a direct consequence of collapsing every window into one
"binding" number, and each maps onto a requirement for the new design.

1. **Workload-blind.** `bindingWindow` takes the worst utilization across *all*
   windows. An account at 95% on its Opus bucket and 10% on Fable-week ranks as
   "5% free" even when the next session is Fable — the account best suited for
   Fable work is the one the ranking buries.
2. **Credit meters count as caps.** `spend` and `extra_usage` participate in
   the binding-window scan. An account that has consumed 80% of its extra-usage
   *credits* reads as 20% free even with an empty 5-hour and weekly window.
3. **Time-blind.** `resetsAt` is parsed, carried, displayed — and never read by
   the ranking. Capacity expiring in an hour prices the same as capacity good
   for six days, so use-it-or-lose-it value is systematically wasted.
4. **The two windows are conflated.** An account 90% through a 5-hour window
   that resets in 40 minutes ranks below an account 50% through its *weekly* —
   headroom 10 vs 50 — though the first is minutes from a full fast window and
   the second is spending the scarcer resource. The error runs the other way
   too: an account with a wide-open weekly but a nearly-exhausted 5-hour window
   can win and then stall the session it was recommended for.

## The proposed algorithm: `drain-v1`

### Inputs

Everything `recommendProfile` takes today, plus the one thing both call sites
already hold and currently drop: the pending workload.

```ts
interface RankedWorkload {          // same shape as LiveRunLoad, reused
  readonly model?: string | null;   // fresh composer's model
  readonly effort?: string | null;  // fresh composer's effort
  readonly ultracode?: boolean;
}

recommendProfileDrainAware(
  entries: readonly ProfilePlanUsage[],
  options: { now: number; maxAgeMs?: number; workload?: RankedWorkload },
): PlanRecommendation | null
```

An absent workload falls back exactly as `planLoad.ts` does — Sonnet-family,
medium effort — so the function is total and the wrapper never has to guess.

Candidate exclusions are byte-for-byte the current rules: unavailable readings,
stale readings, all-null windows, fewer than two candidates, and the same
`basisFor` machinery deciding whether weights may be trusted. None of that is
in question; it is what keeps the recommendation honest.

### Step 1 — classify windows by role

A small pure classifier, one window in, one role out:

| Role | Members | Meaning |
| --- | --- | --- |
| `fast` | `five_hour`; any unknown-vocabulary window whose `resetsAt − now ≤ 6 h` | Replenishes quickly. A rate limiter, not a stock. |
| `slow-general` | `seven_day`, `seven_day_oauth_apps`, unknown-vocabulary windows with distant or absent resets (Codex `primary`/`secondary` land here or in `fast` by the reset-horizon test) | Weekly-scale caps every workload draws on. |
| `slow-model(family)` | `model_scoped:<Name>` (family = lowercased display name), `seven_day_opus` → `opus`, `seven_day_sonnet` → `sonnet` | Weekly-scale caps only the matching model family draws on. |
| `ignored` | `spend`, `extra_usage`, any window with `utilization: null` | Credit meters and blanks. Never rank on them. |

Family matching between the workload's model id and a bucket name reuses the
substring discipline of `modelLoadFactor` (`planLoad.ts:159`): `fable` matches
`claude-fable-5[1m]` and `model_scoped:Fable` alike, longest family first,
case-insensitive — ids are not stable across catalogues and display names are
presentation, so neither side is treated as an identifier.

Two classifications are judgement calls, recorded here so recalibrating is an
edit to a table and not an archaeology project:

- `seven_day_oauth_apps` stays in `slow-general` (status quo) because it is not
  established whether CLI subscription auth draws on it. Including it can only
  under-recommend an account; excluding it wrongly would recommend an account
  that then stalls. If observation shows CLI usage never moves it, reclassify
  to `ignored` — a one-line change.
- `spend` / `extra_usage` move to `ignored` deliberately. Overflow credits are
  purchased headroom, not the plan window, and a `resetsAt: null` meter must
  not be able to sink an account forever.

### Step 2 — the two headrooms, per account

Both computed in the same weighted "baseline points" space the current
`scoreOf` uses, so the `basis` machinery and its honest wording carry over
unchanged (under `percentage` basis: raw shares, reservations divided by the
account's own weight — the current rules, verbatim).

- **Scarce headroom `Hs`** — what this workload can still draw from the
  weekly-scale caps that actually bind it:

  `Hs = min( minGeneral − resAll , modelBucket − resFamily )` *(each term × weight)*

  where `minGeneral` is the tightest `slow-general` window's free share,
  `modelBucket` is the matching `slow-model` bucket's free share (absent bucket
  → the general term alone), `resAll` = `reservationFor(all live runs)` and
  `resFamily` = `reservationFor(live runs of the workload's family)` — a run's
  spend lands on the general weekly whatever its model, but only same-family
  runs drain the model bucket.

- **Fast headroom `Hf`** — the 5-hour window's free share × weight, minus a
  5-hour-scale reservation for the same live runs (see the constant below).

### Step 3 — what this session needs

The same load model prices the incoming session:

```
needSlow = runLoadFactor(workload) × BASELINE_RESERVATION_POINTS      // weekly points
needFast = runLoadFactor(workload) × FIVE_HOUR_RESERVATION_POINTS    // 5-hour points
```

`runLoadFactor` is imported from `planLoad.ts` untouched. `needFast` is where
"don't eat through the 5-hour limit so fast the work can't continue" becomes a
number: it is the estimated share of a baseline plan's *5-hour* window one
session consumes, and raising the constant widens the safety margin globally.

### Step 4 — sustainability tiers

Accounts are partitioned before they are scored, because "can this account
absorb the session at all" is a different question from "which account should":

- **Tier A — sustainable**: `Hs ≥ needSlow` and `Hf ≥ needFast`. Can take the
  session and keep working.
- **Tier B — throttled**: `Hs ≥ needSlow` but `Hf < needFast`. The weekly can
  fund the work, but the session will likely stall until the 5-hour reset — a
  bounded, short interruption.
- **Tier C — exhausted**: `Hs < needSlow`. The workload's weekly-scale cap
  cannot fund the session; a stall here lasts days, not minutes.

Every Tier A account outranks every Tier B account, which outranks every
Tier C one. This is the constant-free part of the design: the tiers are an
ordering, not a magnitude, and they alone fix defect 4.

### Step 5 — score within the tier

- **Tier A** ranks by **drain value**:

  `score = Hs / max(τs, 6 h)` — points per hour until they expire

  with `τs` = time until the window that set `Hs` resets (unreported reset →
  the full period, 168 h). This is use-it-or-lose-it, stated as arithmetic: at
  equal headroom the sooner reset wins; at equal resets the bigger headroom
  wins; a fresh account (just reset, high `Hs`, long `τs`) scores like the
  steady state it is. The 6-hour floor bounds the urgency multiplier so a
  window minutes from reset cannot score arbitrarily high on capacity nobody
  could spend in the time remaining.

  Tie-break, before falling back to caller order: larger `Hf` margin — between
  two equally drainable accounts, prefer the one with more 5-hour slack.

- **Tier B** ranks by soonest `five_hour` reset (shortest stall) first, then by
  the Tier A score.
- **Tier C** ranks by soonest reset of the window that set `Hs` — the first
  account back in the game.

Strictly-greater comparisons throughout, so ties keep caller order and the
label does not flap between polls — the current algorithm's rule, kept.

### What this does in the scenarios that motivated it

- *Fable session, account A: Fable bucket 10% used / weekly resets Thursday;
  account B: Fable bucket 60% used / weekly resets tonight.* A has more Fable
  capacity, B's expires first. If B's remaining 40 points clear both gates, B's
  drain value (40 / small τ) beats A's (90 / large τ): B is drained before its
  reset, then resets to fresh and wins on capacity. Exactly the "maximize usage
  on the earlier-reset account, but only while it can still carry the work"
  behaviour requested.
- *Account with a full Opus bucket, empty everything else, Fable workload.* The
  Opus bucket is `slow-model(opus)` ≠ `fable` → ignored. Defect 1 gone.
- *Account 95% through its 5-hour window, resets in 20 minutes, weekly wide
  open.* Tier B, not buried: it outranks exhausted accounts, loses to any
  sustainable one, and among throttled peers the 20-minute reset puts it first.
- *Both accounts weekly-exhausted for this workload.* Tier C, ranked by
  soonest recovery — the honest answer to "nowhere good, but where first?".

## The constants, and the discipline they inherit

One genuinely new magnitude is introduced:

```
FIVE_HOUR_RESERVATION_POINTS = 8   // points of a baseline plan's 5-hour window
                                   // one Sonnet/medium session is expected to consume
```

It is the 5-hour sibling of `BASELINE_RESERVATION_POINTS = 0.75` and inherits
its exact epistemic status: **an informed guess encoding an ordering, not a
measurement** — a 5-hour window is a far smaller pool than a weekly one, so one
session takes a visibly larger share of it. It lives in the new module with the
same all-caps warning block, and the tests assert orderings and invariants,
never magnitudes, so calibration is a one-line edit.

The other two numbers are horizons, not consumption estimates: the 6-hour
fast/slow classification boundary and the 6-hour urgency floor. Both are
bounds on how wrong a heuristic can be, documented in place.

Deliberately *not* introduced: any absolute token budget, any cross-window
"a weekly is N 5-hour windows" ratio, and any cross-provider equivalence — the
same three refusals `planCapacity.ts` is organised around.

## Degradation, stated rather than discovered

| Situation | Behaviour |
| --- | --- |
| No `workload` passed | Sonnet/medium assumed — same default posture as `planLoad.ts`. |
| Codex account (no model buckets) | Model dimension collapses to `slow-general`; the algorithm remains reset-aware and 5-hour-aware via the reset-horizon classifier. Strictly better than today, never worse. |
| `resetsAt` null on a slow window | `τs` = full period (168 h): capacity ranking, no urgency claim. |
| No 5-hour window at all | `Hf` gate passes vacuously; tiers collapse to A/C. |
| Mixed providers / unweighable plans | `basisFor` unchanged; percentage basis computes in raw shares and the UI keeps its "highest share free" wording. |
| Stale / unavailable / singleton | Identical exclusions to today — same `PLAN_USAGE_MAX_AGE_MS`, same ≥ 2 rule. |

## Keeping the current algorithm: the registry and the picker

### The registry — `packages/protocol/src/planRanking.ts` (new)

```ts
export interface PlanRankingAlgorithm {
  readonly id: PlanRankingId;            // 'headroom' | 'drain-v1' | (string & {})
  readonly label: string;                // "Most room (current)" / "Workload drain"
  readonly blurb: string;                // one sentence for the settings row
  readonly experimental: boolean;
  recommend(
    entries: readonly ProfilePlanUsage[],
    options: { now: number; maxAgeMs?: number; workload?: RankedWorkload },
  ): PlanRecommendation | null;
}

export const PLAN_RANKING_ALGORITHMS: readonly PlanRankingAlgorithm[];
export const DEFAULT_PLAN_RANKING_ID = 'headroom';
export function planRankingById(id: string | undefined): PlanRankingAlgorithm; // unknown → default
```

`'headroom'` **delegates to the existing `recommendProfile`, unmodified** — it
ignores `workload`, as it always has. `'drain-v1'` points at the new module.
Future algorithms append to the table; a versioned id (`drain-v2`) is a new
entry, never a mutation of an old one, so "which algorithm produced this
choice" stays answerable after the fact.

`planRankingById` falls back to the default for any unknown id, which is what
makes downgrades safe: a prefs blob naming an algorithm this build does not
know behaves as if nothing were set.

### The setting — the `runSummary` pattern, end to end

No feature-flag mechanism exists in Artemis, and this proposal does not invent
a general one; it adds one enum-valued preference in the established shape:

1. `planRanking?: string` on `interface Prefs` (`store.ts:1114`).
2. Guarded on load with `oneOf(raw['planRanking'], PLAN_RANKING_IDS)`
   (`store.ts:1183`) — a hand-edited or future-build value drops to default.
3. Seeded into state beside its siblings; written back in `savePrefs`.
4. `setPlanRanking(id)`: set state, `savePrefs()` — the `setRunSummary`
   two-liner (`store.ts:5609`).
5. Settings UI: a `ChoiceList` row (`components/settings/pane.tsx:138`) listing
   the registry — label, blurb, and an **"Experimental"** badge whenever
   `algorithm.experimental` — in the Behavior section. Choosing the default is
   always one click; that *is* the off switch, so no second toggle is needed.

The preference is renderer-local (localStorage), which is sufficient because
the entire ranking already runs in the renderer; nothing crosses IPC.

### The dispatch — one function changes

`planRecommendation` (`store.ts:3579`) is the single choke point both consumers
already flow through, and it becomes the dispatcher:

```ts
const algorithm = planRankingById(useApp.getState().planRanking);
return algorithm.recommend(entries, { now, workload });
```

with `workload` read from the target pane's composer state (`s.model`,
`s.effort`, `s.ultracode`) — the values `newSession` and the StatusLine each
already hold. `recommendProfile` itself, its tests, `planLoad.ts`,
`planCapacity.ts`, the poller and the adapters are not edited.

### Saying which algorithm chose

`PlanRecommendation` gains optional, additive fields — `algorithmId`, `tier`,
and `relevantWindow` (the window that set `Hs`, with its reset) — so
`explainRecommendation` (`StatusLine.tsx:593`) can say *"most Fable-week
capacity, resets in 14 h"* when the drain algorithm chose, and say nothing new
when the current one did. Existing fields (`headroom`, `binding`, `basis`,
`candidates`, `assumedPlan`) are populated by both algorithms, so every current
consumer renders either output unchanged.

## Testing

Same house rules as `usage.test.ts` and `planLoad.test.ts`: orderings and
refusals, never magnitudes.

- **Relevance**: a full other-model bucket does not demote an account for this
  workload; a full matching bucket does; `spend`/`extra_usage` never rank.
- **Urgency**: equal headroom, earlier reset wins; equal resets, larger
  headroom wins; null reset claims no urgency.
- **Gates**: an account that cannot fund the session's 5-hour need drops below
  any that can; weekly-exhausted drops below both; a throttled account with the
  sooner 5-hour reset outranks its throttled peers.
- **Refusals preserved**: stale, unavailable, all-null, singleton, metered —
  byte-for-byte the current exclusions.
- **Stability**: exact ties keep caller order.
- **Degradation**: Codex two-window accounts classify by reset horizon and
  rank sanely; missing model bucket collapses to the general weekly.
- **Registry**: unknown id → default; `'headroom'` output equals
  `recommendProfile` output on identical inputs (delegation, not a copy).
- **Renderer**: with the pref unset, `newSession` behaviour is unchanged
  (existing `newSession.test.ts` passes untouched); with `drain-v1` set, a
  fresh composer adopts the drain winner.

## Rollout

1. Land the two protocol modules + tests. Pure additions; no behaviour change.
2. Land the pref, dispatcher, and settings row. Default `'headroom'` — still no
   behaviour change for anyone who has not opted in.
3. Opt in on daily-driver machines; watch the Recommended row's explanation and
   the meters. The uncalibrated constants live in one file each.
4. When proven, either promote `drain-v1` to default (a one-constant change,
   with `'headroom'` remaining selectable) or revise into `drain-v2` beside it.

## Open questions, carried honestly

- **`seven_day_oauth_apps` semantics** — does CLI subscription auth draw on it?
  Classified conservatively until observed; reclassifying is one table row.
- **`FIVE_HOUR_RESERVATION_POINTS` magnitude** — ordering is defensible, the
  number is a guess. The calibration path is the poller's own readings: the
  delta between consecutive polls of an account running known work is a
  measurement of points-per-session, and a later change can fit the constants
  to it (requires the main process to retain a short reading history — today
  only the latest survives, `engine.ts:620`).
- **Claude clamps utilization at 100** — overage is invisible, so Tier C
  cannot distinguish "just full" from "deep over". Ranking by reset time
  sidesteps this, but it is worth knowing when reading meters.
- **Not attempted here**: predictive handoff (start on A, pre-plan continuation
  on B when A's 5-hour fills), cross-account fan-out of ultracode subagents,
  and burn-rate forecasting. All want the reading history first.
