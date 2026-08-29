/**
 * What the pane is doing, at the foot of the transcript.
 * ============================================================================
 *
 * A run is in exactly one of six conditions, and before this they were not all
 * distinguishable. `Working` covered one of them — a non-streaming provider
 * mid-turn — and everything else was inferred from whether text happened to be
 * arriving. A run that had failed looked like a run that had finished; a run
 * waiting on a permission looked like a run still thinking; a run that had not
 * started yet looked like nothing at all.
 *
 * So the six are named, and each says what it is *and why*:
 *
 *   starting   the provider is being spawned. Nothing has arrived because
 *              nothing has been asked yet, which is different from silence.
 *   running    a turn is in flight. The shuttle, plus elapsed time.
 *   stopping   the user asked it to stop and the provider has not let go yet.
 *              The shuttle keeps moving — winding down is still work — but
 *              the words answer the click. Without this, the seconds between
 *              Stop and `run.end` read as the button having done nothing.
 *   waiting    it wants something from you, and says what.
 *   failed     it stopped because of an error, and says which.
 *   settled    it finished. Renders nothing — the transcript is the record,
 *              and a banner saying "done" under every completed turn is noise.
 *
 * ### Elapsed time is the load-bearing part
 *
 * "Is it stuck" is the actual question behind every glance at a spinner, and a
 * spinner alone cannot answer it — a hung app animates just as smoothly as a
 * working one. The counter can: a number that is still climbing is proof the
 * renderer is alive, and a number that has climbed past what a turn should take
 * is the signal to go and look. It ticks once a second and is the reason this
 * component holds state at all.
 *
 * ### Why it lives at the bottom rather than beside the text
 *
 * It sits where the next turn will appear, so the eye is already in the right
 * place when output starts. A marker attached to the last message would move
 * every time a message arrived, which is the opposite of what a fixed point is
 * for.
 */

import { useEffect, useState, type ReactElement } from 'react';

import { cn } from '../lib/utils';
import { usePane } from '../state/paneContext';
import { useApp } from '../state/store';

/**
 * The six conditions, resolved from run status and the permission queue.
 *
 * Ordered by urgency rather than by lifecycle: a queued permission outranks a
 * `running` status, because a provider that has asked for something and is
 * technically still "running" while it waits is, to the person looking at it,
 * waiting. `awaiting_permission` and a non-empty queue are two spellings of the
 * same condition — the first is what the provider reports, the second is what
 * the renderer holds — and either one is enough.
 *
 * A requested stop outranks even that. The interrupt withdraws whatever was
 * asked — the adapter denies pending prompts on the way down — so "needs your
 * answer" over a question that is being taken back would send the user to
 * answer nothing, when what they want to know is that the stop was heard.
 */
export type Activity = 'starting' | 'running' | 'stopping' | 'waiting' | 'failed' | 'settled';

export interface ActivityState {
  readonly kind: Activity;
  /** Why, in the app's own words. Empty for `settled`, which renders nothing. */
  readonly because: string;
  /** When the current run began, for the elapsed counter. */
  readonly since: number | null;
}

/** Seconds, then minutes and seconds. Never a bare "0s" — that reads as stalled. */
export function formatElapsed(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Resolve the condition. Exported for the tests, which is the point of it being
 * a pure function of two values rather than a hook.
 */
export function activityOf(
  run: { readonly status: string; readonly startedAt: number; readonly endReason?: string; readonly error?: { readonly message?: string }; readonly interruptRequested?: boolean } | null,
  queued: number,
): ActivityState {
  if (run === null) return { kind: 'settled', because: '', since: null };

  // The clock keeps `since`: a counter that stalls while the provider winds
  // down is indistinguishable from the hang the user is afraid of.
  if (run.status !== 'ended' && run.interruptRequested === true) {
    return { kind: 'stopping', because: 'winding down', since: run.startedAt };
  }
  if (queued > 0 || run.status === 'awaiting_permission') {
    return {
      kind: 'waiting',
      because: queued > 1 ? `${queued} requests need an answer` : 'needs your answer to continue',
      since: run.startedAt,
    };
  }
  if (run.status === 'starting') {
    return { kind: 'starting', because: 'starting the provider', since: run.startedAt };
  }
  if (run.status === 'running') {
    return { kind: 'running', because: 'working', since: run.startedAt };
  }
  // Ended. An error is worth a line; a clean finish is not.
  if (run.error || run.endReason === 'error') {
    return {
      kind: 'failed',
      because: run.error?.message?.trim() || 'the run ended with an error',
      since: null,
    };
  }
  return { kind: 'settled', because: '', since: null };
}

/** Ticks once a second while `since` is set, so the counter stays honest. */
function useElapsed(since: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);

  return since === null ? null : formatElapsed(now - since);
}

export function ActivityIndicator(): ReactElement | null {
  const run = usePane((s) => s.run);
  const queued = usePane((s) => s.permissionQueue.length);
  /*
   * Is a turn already running on this conversation, somewhere this pane cannot
   * see? A new run against a conversation whose retained process is mid-turn —
   * a scheduled wakeup that fired, a workflow's settle turn — is spawned fresh
   * and waits its turn on the provider's own transcript. That wait used to
   * read "starting the provider" for however long the other turn ran, which
   * is a sentence about a spawn that finished long ago. Main's working set is
   * the one place the other turn is visible from.
   */
  const sessionId = usePane((s) => s.run?.sessionId ?? s.resumeSessionId);
  const busyElsewhere = useApp(
    (s) => sessionId !== null && sessionId !== undefined && s.sessionsWorking.includes(sessionId),
  );
  const raw = activityOf(run, queued);
  const state =
    raw.kind === 'starting' && busyElsewhere
      ? { ...raw, because: "finishing this conversation's current turn first" }
      : raw;
  const elapsed = useElapsed(state.since);

  if (state.kind === 'settled') return null;

  const tone =
    state.kind === 'waiting' ? 'text-amber' : state.kind === 'failed' ? 'text-signal' : 'text-beam-text';

  return (
    <div
      // `status` rather than `alert`: this is an advisory that changes often,
      // and an assertive live region would interrupt a screen reader on every
      // state change. The label carries the same words the sighted user sees.
      role="status"
      aria-label={`${state.kind} — ${state.because}`}
      className="flex flex-col gap-1.5 px-1 pt-1 pb-2"
      data-activity={state.kind}
    >
      {/* The rule that used to be here is now the composer's top border — see
          {@link ActivityRule}. What is left is the part a rule cannot say:
          which of the five conditions this is, why, and for how long.

          `chrome-label`, because this line is Artemis talking about itself —
          "waiting", "needs your answer to continue" — and the app's voice is
          the sans in sentence case now. The counter keeps the mono and the
          tabular figures: it is a measurement, it changes once a second, and
          proportional digits make it jitter while it counts. */}
      <div className="chrome-label flex items-center gap-2 text-ink-faint">
        <span className={tone}>{state.kind === 'failed' ? 'failed' : state.kind}</span>
        <span className="min-w-0 truncate">{state.because}</span>
        {elapsed ? (
          <span className="ml-auto shrink-0 font-mono tabular-nums">{elapsed}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The same five conditions, drawn as the seam above the composer.
 * ============================================================================
 *
 * A boundary the eye is already at. The conversation ends here and the prompt
 * begins, so a reader watching output arrive is looking within an inch of this
 * line — which is the objection that removed the old hairline from this seam
 * and is now the argument for putting one back, with something worth reading on
 * it.
 *
 * At rest it is an ordinary 1px border: the transcript needs an edge, and the
 * composer floating on the window background without one was the seam looking
 * unfinished. While a run is live it grows to 3px and carries the state —
 * the shuttle while work is happening, amber while something is waiting on an
 * answer, signal when a run has failed.
 *
 * **Growing rather than overlaying.** A 3px animation drawn inside a 1px border
 * would either clip or straddle the seam; the height moves instead, and the
 * transition is what keeps that from reading as the layout jumping.
 *
 * `aria-hidden`, because {@link ActivityIndicator} is the `status` region for
 * exactly this state and says it in words. Two live regions for one fact is how
 * a screen reader ends up announcing every turn twice.
 */
export function ActivityRule(): ReactElement {
  const run = usePane((s) => s.run);
  const queued = usePane((s) => s.permissionQueue.length);
  const state = activityOf(run, queued);

  // `stopping` still moves: the provider is winding down, which is work, and a
  // bar that froze on the click would say "hung" where the words say "heard".
  const moving =
    state.kind === 'running' || state.kind === 'starting' || state.kind === 'stopping';

  return (
    <div
      aria-hidden="true"
      data-activity-rule={state.kind}
      className={cn(
        'relative w-full shrink-0 overflow-hidden transition-[height] duration-200',
        state.kind === 'settled' ? 'h-px' : 'h-[3px]',
        moving
          ? 'bg-line shuttle'
          : state.kind === 'waiting'
            ? 'bg-amber'
            : state.kind === 'failed'
              ? 'bg-signal'
              : 'bg-line',
      )}
    />
  );
}
