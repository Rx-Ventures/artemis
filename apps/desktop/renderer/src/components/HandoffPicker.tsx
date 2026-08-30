/**
 * The hand-off picker: the informed question a plan limit now opens.
 * ============================================================================
 *
 * ADR 0003 in component form. When `handoffTrigger` fires, the run is
 * interrupted and settled exactly as before — and then, instead of silently
 * spending the last of the budget on a continuity note, this dialog asks the
 * one question the machinery cannot answer: *where should this work go?* It
 * says what happened (which window tripped, when it resets), shows every
 * account that could take the conversation with its live facts, and waits.
 * Nothing moves unchosen; declining degrades to the note, exactly as shipped.
 *
 * ## The rows speak the navigator's language
 *
 * A candidate row is the run navigator's profile row re-said in a dialog:
 * swatch, name, tier, signed-out amber, and the binding window's percentage at
 * the trailing edge on `toneFor`'s thresholds — plus one fact the navigator
 * cannot show, because only this surface knows which model the conversation is
 * on: that model's own pressure on the candidate account, through the
 * `modelFacts` join and the navigator's exported `PressureDot`. That is the
 * honest answer to `bindingWindow`'s workload-blindness (§5 obstacle 5):
 * `drain-v1` does not exist yet, so no ranking is offered — the facts are, and
 * the user chooses. A blocked account renders struck through with its reason,
 * never hidden — the `GatedItem` precedent, again.
 *
 * ## Why the store opens it and the component only answers
 *
 * The offer is pane state (`handoffOffer`), written by the trigger flow after
 * the interrupted run has settled — which is what guarantees the promotion of
 * the session id has already happened by the time a choice can land. The
 * component renders the standing question and routes the three answers:
 * choose (`chooseHandoffTarget`), decline to the note
 * (`declineHandoffOffer`), stay (`dismissHandoffOffer` — also Escape, which
 * must never be a trap).
 */

import { useState, type ReactElement } from 'react';
import { ArrowRightLeftIcon } from 'lucide-react';
import { bindingWindow } from '@rx-artemis/protocol';
import type {
  PlanUsage,
  ProfileId,
  ProfileMetadata,
  ProviderModelOption,
} from '@rx-artemis/protocol';

import {
  activeModel,
  chooseHandoffTarget,
  canReachSession,
  declineHandoffOffer,
  dismissHandoffOffer,
  useApp,
} from '../state/store';
import {
  describeBlock,
  handoffCandidates,
  handoffTargetBlock,
} from '../state/handoffTargets';
import { describeReset, modelExhaustion, modelPressure } from '../state/modelFacts';
import { usePane, usePaneRef } from '../state/paneContext';
import { PressureDot } from './RunNavigator';
import { toneFor } from './PlanUsageMeter';
import { ProfileSwatch } from './primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function HandoffPicker(): ReactElement | null {
  const offer = usePane((s) => s.handoffOffer);
  // `==`: a pane seeded before this field existed reads `undefined`, and both
  // spellings of "no question" must render nothing.
  if (offer == null) return null;
  return <OpenPicker />;
}

/**
 * Mounted only while the offer stands, so per-mount state — the `now` the
 * facts are judged at, the busy latch — is scoped to one question, the same
 * way Radix scopes the navigator's columns to one open.
 */
function OpenPicker(): ReactElement | null {
  const pane = usePaneRef();
  const offer = usePane((s) => s.handoffOffer);
  const profiles = usePane((s) => s.profiles);
  const activeId = usePane((s) => s.activeProfileId);
  const sessions = usePane((s) => s.sessions);
  const sessionId = usePane((s) => s.resumeSessionId);
  const model = usePane(activeModel);
  const usageByProfile = useApp((s) => s.planUsageByProfile);
  const authByProfile = useApp((s) => s.authByProfile);

  // Captured per mount — the moment the question opened is the moment its
  // staleness rules are judged from, exactly as the navigator captures its
  // clock per open. (Not per render: vitest runs without the React Compiler,
  // and a render-time clock would make the rows' verdicts flap either way.)
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  if (offer == null) return null;
  const { trigger } = offer;

  const summary = sessionId === null ? undefined : sessions.find((s) => s.id === sessionId);
  const candidates = handoffCandidates(profiles, activeId, (id) =>
    summary === undefined ? false : canReachSession(summary, id),
  );

  const reset = describeReset(trigger.window.resetsAt, now);
  const source = profiles.find((p) => p.id === activeId);

  const choose = (profileId: ProfileId): void => {
    setBusy(true);
    void chooseHandoffTarget(profileId, pane).finally(() => setBusy(false));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape and the close ✕ are "keep working here" — the standing door
        // out, never a trap. Not while a move is in flight, though: the store
        // is about to answer, and dismissing under it would race the latch.
        if (!open && !busy) dismissHandoffOffer(pane);
      }}
    >
      <DialogContent className="sm:max-w-[560px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeftIcon className="size-4 text-amber" aria-hidden="true" />
            Hand off this conversation?
          </DialogTitle>
          <DialogDescription className="text-xs">
            {source ? `${source.label}’s` : 'This account’s'} {trigger.threshold.label} limit is at{' '}
            {trigger.utilization}%{reset === null ? '' : ` · ${reset}`}. The run was stopped before
            the wall. Another account can pick this conversation up exactly where it stands — or the
            agent can write a continuity note here instead.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5" role="listbox" aria-label="Accounts that can take this conversation">
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              profile={candidate}
              usage={usageByProfile[candidate.id]}
              authKnown={authByProfile[candidate.id] !== undefined}
              signedOut={authByProfile[candidate.id]?.loggedIn === false}
              model={model ?? null}
              now={now}
              busy={busy}
              summaryReachable={summary !== undefined && canReachSession(summary, candidate.id)}
              onChoose={choose}
            />
          ))}
          {candidates.length === 0 ? (
            // Unreachable in practice — the store only opens the picker with a
            // chooseable candidate — but a dialog must never render an empty
            // hole where its answers were promised.
            <p className="px-1 py-2 text-2xs leading-snug text-ink-faint">
              No other account can reach this conversation’s transcript.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => dismissHandoffOffer(pane)}
          >
            Keep working here
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => declineHandoffOffer(pane)}
          >
            Write a continuity note instead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One candidate: the navigator's profile-row anatomy, with the current
 * model's pressure on that account as its second line. Disabled — struck
 * through, reason inline, never hidden — whenever the gate says no.
 */
function CandidateRow({
  profile,
  usage,
  authKnown,
  signedOut,
  model,
  now,
  busy,
  summaryReachable,
  onChoose,
}: {
  readonly profile: ProfileMetadata;
  readonly usage: PlanUsage | undefined;
  readonly authKnown: boolean;
  readonly signedOut: boolean;
  readonly model: ProviderModelOption | null;
  readonly now: number;
  readonly busy: boolean;
  readonly summaryReachable: boolean;
  readonly onChoose: (profileId: ProfileId) => void;
}): ReactElement {
  const block = handoffTargetBlock({
    profile,
    reachable: summaryReachable,
    auth: authKnown ? { loggedIn: !signedOut } : undefined,
    usage,
    now,
  });
  // `unchecked` rows stay clickable: the probe was fired when the picker
  // opened, and the move re-validates against its answer either way.
  const blocked = block !== null && block.kind !== 'unchecked';

  const tier = signedOut ? undefined : usage?.subscriptionType;
  const binding = bindingWindow(usage);
  const capacity = binding?.utilization ?? null;
  const rejected = binding?.status === 'rejected';

  const pressure = model === null ? null : modelPressure(model, usage);
  const exhausted = model === null ? null : modelExhaustion(model, usage, now);

  return (
    <button
      type="button"
      disabled={blocked || busy}
      onClick={() => onChoose(profile.id)}
      // A card per candidate, at the surface radius: this is a list of accounts
      // to weigh, not a menu to run down, and the hairline is what says each row
      // is a whole answer. Hover fills with a wash rather than lifting to
      // `raised` — nothing in the flow lifts, and the border does the rest.
      className={cn(
        'flex flex-col gap-0.5 rounded-lg border border-hairline px-3 py-2 text-left text-xs',
        blocked
          ? 'cursor-default opacity-80'
          : 'hover:border-hairline-strong hover:bg-wash focus-visible:border-ring focus-visible:outline-none',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <ProfileSwatch color={profile.color} />
        <span className={cn('min-w-0 truncate', blocked ? 'text-ink-faint line-through' : 'text-ink')}>
          {profile.label}
        </span>
        {tier !== undefined ? <span className="shrink-0 text-2xs text-ink-faint">{tier}</span> : null}
        {signedOut ? <span className="shrink-0 text-2xs text-amber">signed out</span> : null}
        <span className="ml-auto shrink-0" />
        {rejected ? (
          <span className="shrink-0 text-2xs tabular-nums text-signal">out</span>
        ) : capacity === null ? null : (
          <span className={cn('shrink-0 text-2xs tabular-nums', toneFor(capacity))}>
            {Math.round(capacity)}%
          </span>
        )}
      </span>

      {blocked && block !== null ? (
        <span className="text-2xs leading-snug text-ink-faint no-underline">
          {describeBlock(block)}
        </span>
      ) : exhausted !== null && model !== null ? (
        // Chooseable, but the conversation's own model is spent there — the
        // fact `bindingWindow` cannot see and the user most needs.
        <span className="flex items-center gap-1 text-2xs leading-snug text-ink-faint">
          <PressureDot pressure={{ window: exhausted.window, utilization: null }} />
          {model.label}: {exhausted.reason}
        </span>
      ) : pressure !== null && model !== null ? (
        <span className="flex items-center gap-1 text-2xs leading-snug text-ink-faint">
          <PressureDot pressure={pressure} />
          {model.label} here:{' '}
          {pressure.utilization === null ? '—' : `${Math.round(pressure.utilization)}%`} of its{' '}
          {pressure.window.label} window
        </span>
      ) : null}
    </button>
  );
}
