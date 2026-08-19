/**
 * Stopping before the wall, and spending the last of the budget on a handover.
 * ============================================================================
 *
 * Running out of plan mid-conversation is not a graceful failure. The provider
 * stops answering, the turn dies wherever it happened to be, and everything the
 * agent had worked out — which files matter, what it had already tried, what it
 * was about to do next — is left implicit in a transcript nobody is going to
 * read back. Picking the work up on another account means reconstructing all of
 * it by hand, which is the expensive part of being cut off; the lost turn is
 * not.
 *
 * So when an account gets close enough to a limit, this stops the conversation
 * on purpose and asks the agent for a document the next session can start from.
 * {@link handoffTrigger} decides *whether*; this file decides *what happens* and
 * is careful about three things it would be easy to get wrong.
 *
 * ## It must not loop
 *
 * The handoff turn spends budget of its own, so the reading that fired it is
 * still over the threshold when that turn ends — and would fire it again, and
 * again, each attempt eating the runway the first one was written to preserve.
 * The pane's `handoff` field is the latch: `asked` while the document is being
 * written, `done` once it has been, and nothing fires in either state.
 *
 * ## It must not be a surprise the user cannot get out of
 *
 * Stopping someone's work is the most intrusive thing this app does on its own,
 * so it is off unless switched on, it says what it did and why in the
 * transcript, and `dismissed` is a door out that stays open for the rest of the
 * conversation. A feature that keeps re-asking after being told no is not a
 * safeguard, it is an obstacle.
 *
 * ## The reading has to be worth acting on
 *
 * These numbers are polled, and a stale one is a bad reason to stop a working
 * agent. `PLAN_USAGE_MAX_AGE_MS` is the same bar the profile recommender holds
 * itself to, and for the same reason: a claim about *right now* made from
 * numbers that old is a guess. An account whose plan has no limits at all
 * (`available: false` — API-key, Bedrock, Vertex billing) never triggers,
 * because there is nothing to run out of.
 */

import {
  handoffTrigger,
  PLAN_USAGE_MAX_AGE_MS,
  type HandoffTrigger,
  type PlanUsage,
  type ProfileId,
} from '@rx-artemis/protocol';

import { paneState, setPaneState, type Pane, type SessionState } from './pane';

/**
 * Whether this reading is fresh enough to stop a conversation over.
 *
 * Deliberately the recommender's bar rather than a looser one. Interrupting a
 * working agent on a figure that might be three polls out of date is worse than
 * the exhaustion it is trying to avoid: the exhaustion at least happens for a
 * real reason.
 */
export function actionable(usage: PlanUsage | undefined, now: number): boolean {
  if (!usage?.available) return false;
  return now - usage.fetchedAt <= PLAN_USAGE_MAX_AGE_MS;
}

/**
 * The reason to hand this pane's work off, or `null`.
 *
 * Pure, and takes everything it needs — which is what lets the decision be
 * tested without a store, a bridge or a clock. The caller supplies the reading
 * for the pane's *own* profile: an account being drained in another column is
 * not this conversation's problem.
 */
export function handoffReason(input: {
  readonly enabled: boolean;
  readonly session: Pick<SessionState, 'handoff' | 'activeProfileId'>;
  readonly usageByProfile: Readonly<Record<ProfileId, PlanUsage>>;
  readonly now: number;
}): HandoffTrigger | null {
  const { enabled, session, usageByProfile, now } = input;
  if (!enabled) return null;
  // Every state but `none` has already had its say. See the header: the latch is
  // what stops the handoff turn from triggering another handoff.
  if (session.handoff !== 'none') return null;
  if (!session.activeProfileId) return null;

  const usage = usageByProfile[session.activeProfileId];
  if (!actionable(usage, now)) return null;
  return handoffTrigger(usage);
}

/**
 * What to ask the agent for.
 *
 * Addressed to the agent rather than to the user, because it is sent as a
 * prompt. The instructions are specific about the *file* — a handoff nobody can
 * find is not a handoff — and about the contents being what a stranger needs
 * rather than what a summary usually contains. "What I did" is the part the
 * next session can read out of the diff for itself; "what I had not worked out
 * yet" is the part that is otherwise lost.
 *
 * `.artemis/` inside the working directory, so it travels with the repository
 * and `artifact.ts` recognises it as generated output — the document arrives as
 * an artifact tile with a preview rather than as a wall of diff.
 */
export function handoffPrompt(trigger: HandoffTrigger, stamp: string): string {
  return [
    `This account's ${trigger.threshold.label} limit is at ${String(trigger.utilization)}%, so this`,
    'conversation is stopping here and the work is being handed to another session.',
    '',
    `Write \`.artemis/handoff-${stamp}.md\` — create the directory if it is not there — as a`,
    'briefing for an agent that has never seen this conversation. It has the repository and',
    'nothing else: no transcript, no memory of what was tried.',
    '',
    'Cover, in your own structure:',
    '',
    '- **The goal.** What was actually being asked for, not the last instruction you received.',
    '- **Where things stand.** What is finished and verified, what is written but unproven, and',
    '  what has not been started. Be specific about which is which.',
    '- **What you learned.** The things that cost you time to find out — a surprising file',
    '  layout, a test that fails for an unrelated reason, an API that does not behave as',
    '  documented. This is the part that is otherwise lost.',
    '- **What you tried that did not work**, and why, so it is not tried again.',
    '- **The next step**, concretely enough to act on without asking anyone.',
    '',
    'Reference files by path. Do not summarise the diff — the next session can read that.',
    'Write the file and stop; do not start the next piece of work.',
  ].join('\n');
}

/** A filename-safe stamp: `2026-08-19T1407`. */
export function handoffStamp(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** Move a pane's latch, leaving every other field alone. */
export function setHandoff(pane: Pane, next: SessionState['handoff']): void {
  if (paneState(pane).handoff === next) return;
  setPaneState(pane, { handoff: next });
}

/**
 * The sentence shown when a new turn is refused.
 *
 * Names the way out in the same breath as the refusal. A block whose remedy is
 * not on screen reads as the app being broken.
 */
export const HANDOFF_BLOCK_DETAIL =
  'The handoff document is written. Open a session on another account and point it at the same folder, or dismiss this to keep working here.';
