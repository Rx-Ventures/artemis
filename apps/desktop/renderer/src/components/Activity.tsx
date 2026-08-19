/**
 * What the pane is doing, at the foot of the transcript.
 * ============================================================================
 *
 * A run is in exactly one of five conditions, and before this they were not all
 * distinguishable. `Working` covered one of them — a non-streaming provider
 * mid-turn — and everything else was inferred from whether text happened to be
 * arriving. A run that had failed looked like a run that had finished; a run
 * waiting on a permission looked like a run still thinking; a run that had not
 * started yet looked like nothing at all.
 *
 * So the five are named, and each says what it is *and why*:
 *
 *   starting   the provider is being spawned. Nothing has arrived because
 *              nothing has been asked yet, which is different from silence.
 *   running    a turn is in flight. The shuttle, plus elapsed time.
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

/**
 * The five conditions, resolved from run status and the permission queue.
 *
 * Ordered by urgency rather than by lifecycle: a queued permission outranks a
 * `running` status, because a provider that has asked for something and is
 * technically still "running" while it waits is, to the person looking at it,
 * waiting. `awaiting_permission` and a non-empty queue are two spellings of the
 * same condition — the first is what the provider reports, the second is what
 * the renderer holds — and either one is enough.
 */
export type Activity = 'starting' | 'running' | 'waiting' | 'failed' | 'settled';

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
  run: { readonly status: string; readonly startedAt: number; readonly endReason?: string; readonly error?: { readonly message?: string } } | null,
  queued: number,
): ActivityState {
  if (run === null) return { kind: 'settled', because: '', since: null };

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
  const state = activityOf(run, queued);
  const elapsed = useElapsed(state.since);

  if (state.kind === 'settled') return null;

  const moving = state.kind === 'running' || state.kind === 'starting';
  const tone =
    state.kind === 'waiting' ? 'text-amber' : state.kind === 'failed' ? 'text-signal' : 'text-beam';

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
      <div
        className={cn(
          'relative h-[3px] overflow-hidden',
          // Square, because the machine is what is producing this.
          'rounded-none',
          moving ? 'bg-line shuttle' : 'bg-transparent',
        )}
      >
        {/* Not moving: a static rule in the state's own colour, so a waiting or
            failed pane still reads as *something* from across the room rather
            than as an empty gap where the indicator used to be. */}
        {moving ? null : (
          <span
            className={cn(
              'absolute inset-y-0 left-0 w-full',
              state.kind === 'waiting' ? 'bg-amber' : 'bg-signal',
            )}
          />
        )}
      </div>
      <div className="flex items-center gap-2 font-mono text-2xs tracking-wide text-ink-faint">
        <span className={tone}>{state.kind === 'failed' ? 'failed' : state.kind}</span>
        <span className="min-w-0 truncate">{state.because}</span>
        {elapsed ? <span className="ml-auto shrink-0 tabular-nums">{elapsed}</span> : null}
      </div>
    </div>
  );
}
