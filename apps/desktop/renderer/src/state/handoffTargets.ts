/**
 * Which accounts could take this conversation, and why the rest cannot.
 * ============================================================================
 *
 * A hand off moves a conversation to another profile (CONTEXT.md: "who runs
 * it"), and ADR 0003 makes the move a chosen act: the user is shown candidates
 * with live facts and picks one, or declines. This module is the *facts* half
 * of that — pure functions from a candidate's polled state to "may this row be
 * chosen, and if not, what is the honest sentence about why".
 *
 * The judgements are deliberately borrowed rather than invented:
 *
 *  - **Reachability** is `canReachSession`'s question, passed in as a predicate
 *    so this module needs no store import. A transcript lives in a config
 *    directory; an account whose directory does not reach that store cannot
 *    resume it, full stop.
 *  - **Freshness** is `actionable`'s bar — {@link PLAN_USAGE_MAX_AGE_MS}, the
 *    same six minutes the recommender and the hand-off trigger hold themselves
 *    to, and for the same reason: sending a conversation to an account is a
 *    claim about *right now*, and a reading three polls old may describe an
 *    account another machine has since drained.
 *  - **Auth** is `checkAuthStatus`'s answer, read from the window's cache. A
 *    probe that has answered "signed out" disables the row; a probe that has
 *    not answered yet reports `unchecked` so the caller can go and ask — the
 *    probe is cheap, and offering a move that fails on credentials after the
 *    user chose it would spend the trust the ADR is written to protect.
 *  - **Exhaustion** is the provider's own `rejected` verdict on the binding
 *    window. Handing work to an account that immediately stalls is the failure
 *    mode §5 names; a rejected account is shown struck through with its reset,
 *    never hidden (the `GatedItem` precedent), and never chooseable.
 *
 * What this module deliberately does **not** do is rank. `bindingWindow` is
 * workload-blind — a full Opus bucket sinks an account for Fable work — and
 * `drain-v1` (ACCOUNT-ROTATION-ALGORITHM.md) is unimplemented. Showing the
 * facts and letting the user choose *is* the design's answer to that
 * blindness, not a placeholder for it.
 */

import { bindingWindow, isProfileEnabled } from '@rx-artemis/protocol';
import type {
  AuthStatusInfo,
  PlanUsage,
  ProfileId,
  ProfileMetadata,
} from '@rx-artemis/protocol';

import { actionable } from './autoHandoff';
import { describeReset } from './modelFacts';

/**
 * Why a candidate cannot be chosen right now, or `null` when it can.
 *
 * A discriminated reason rather than a boolean or a bare sentence, because the
 * two consumers need different things from it: the gate on the move re-checks
 * and needs to branch (`unchecked` means "probe and ask again", everything
 * else means "refuse"), while the picker row needs words. {@link describeBlock}
 * is the words.
 */
export type HandoffTargetBlock =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'stale-reading' }
  | { readonly kind: 'exhausted'; readonly reason: string };

/** Everything the gate judges one candidate on. All of it polled window state. */
export interface HandoffTargetFacts {
  readonly profile: ProfileMetadata;
  /** Can this profile's config directory reach the session's transcript? */
  readonly reachable: boolean;
  /** The cached auth probe, or `undefined` when nobody has asked yet. */
  readonly auth: AuthStatusInfo | undefined;
  /** The polled plan reading, or `undefined` when none has arrived. */
  readonly usage: PlanUsage | undefined;
  readonly now: number;
}

/**
 * The gate. `null` is "this account may take the work".
 *
 * Order matters only for which sentence wins when several are true, and it
 * runs from the most structural fact to the most momentary: a directory that
 * cannot reach the store is a different universe from a reading that is seven
 * minutes old.
 */
export function handoffTargetBlock(facts: HandoffTargetFacts): HandoffTargetBlock | null {
  const { profile, reachable, auth, usage, now } = facts;
  if (!isProfileEnabled(profile)) return { kind: 'disabled' };
  if (!reachable) return { kind: 'unreachable' };
  if (auth === undefined) return { kind: 'unchecked' };
  if (!auth.loggedIn) return { kind: 'signed-out' };
  // `actionable` covers both "no reading" and "reading too old" — the same
  // collapse the trigger makes, because both mean the same thing here: no
  // claim about right now can be made for this account.
  if (!actionable(usage, now)) return { kind: 'stale-reading' };
  const binding = bindingWindow(usage);
  if (binding?.status === 'rejected') {
    const reset = describeReset(binding.resetsAt, now);
    return {
      kind: 'exhausted',
      reason: `Its ${binding.label} limit is reached${reset === null ? '' : ` · ${reset}`}.`,
    };
  }
  return null;
}

/** The row's sentence for a block. One clause, lower-case start, no verdict theatre. */
export function describeBlock(block: HandoffTargetBlock): string {
  switch (block.kind) {
    case 'disabled':
      return 'disabled in Manage';
    case 'unreachable':
      return 'cannot reach this conversation’s transcript';
    case 'signed-out':
      return 'signed out';
    case 'unchecked':
      return 'checking sign-in…';
    case 'stale-reading':
      return 'no fresh plan reading';
    case 'exhausted':
      return block.reason;
  }
}

/**
 * The sentence a limit surface opens with: which window is spent, and when it
 * comes back. `null` when there is no reading to speak from — the caller falls
 * back to whatever it was going to say anyway, rather than inventing a window.
 *
 * The reset leads with wall-clock time (`describeReset`'s rule) because "in
 * 4h" needs arithmetic before anyone can decide whether to wait or move.
 */
export function describeBindingLimit(
  usage: PlanUsage | null | undefined,
  now: number,
): string | null {
  const binding = bindingWindow(usage);
  if (binding === null) return null;
  const reset = describeReset(binding.resetsAt, now);
  const state =
    binding.status === 'rejected'
      ? 'is reached — requests are being refused'
      : binding.utilization === null
        ? 'is the binding limit'
        : `is at ${String(Math.round(binding.utilization))}%`;
  return `The ${binding.label} limit ${state}${reset === null ? '' : ` · ${reset}`}.`;
}

/**
 * The profiles that could conceivably take a session: every *other* profile
 * whose config directory reaches its store. No gate beyond reachability — the
 * picker shows the sick alongside the healthy, disabled with reasons, because
 * a row that vanishes is an account the user concludes was taken away.
 */
export function handoffCandidates(
  profiles: readonly ProfileMetadata[],
  activeProfileId: ProfileId | null,
  reaches: (profileId: ProfileId) => boolean,
): readonly ProfileMetadata[] {
  return profiles.filter((p) => p.id !== activeProfileId && reaches(p.id));
}

/**
 * The accounts that cannot continue this conversation, but could start a new
 * one seeded from it.
 *
 * Every profile the ordinary candidate list refuses on reachability — a
 * different config directory, usually a different provider. They are not
 * failures to be hidden: an account that cannot read a transcript can still do
 * the work, given the briefing, and offering that is the difference between a
 * hand-off that stops at the provider boundary and one that does not. See
 * `seedHandoffToProfile`.
 */
export function seedCandidates(
  profiles: readonly ProfileMetadata[],
  activeProfileId: ProfileId | null,
  reaches: (profileId: ProfileId) => boolean,
): readonly ProfileMetadata[] {
  return profiles.filter((p) => p.id !== activeProfileId && !reaches(p.id));
}
