/**
 * The hunt bar: Artemis' bow, a constant at the foot of the conversation.
 * ============================================================================
 *
 * The app is named for the goddess of the hunt, and this is the one place it
 * says so: a small bow pinned directly under the transcript, loosing an arrow
 * across the pane for as long as a run is going. It is a *fixture*, not a
 * status row — present from the moment a pane exists, at rest before the first
 * prompt and after the last answer, firing in between. The transient report of
 * "a run is live" belongs to the runbar, the hairline lunar sweep above the
 * composer; the bow is the secondary telling of the same fact, and the one
 * with a resting state.
 *
 * ## Why under the transcript, outside the scroller
 *
 * "Pinned to the bottom of the conversation" rules out both obvious homes. A
 * row *inside* the scroller scrolls away mid-run — not pinned. An overlay
 * floated over the scroller stays put but paints over the text the reader is
 * trying to read, and fights the Jump-to-latest button for the same corner.
 * A strip of the pane column between the two — below the scroller, above the
 * composer — is the conversation's actual bottom edge, visible in every scroll
 * position, and a row of its own: the arrow crosses empty range, never
 * someone's diff. It renders from `PaneColumn` rather than inside `Composer`
 * because it belongs to the conversation above it, not to the prompt below.
 *
 * ## The three poses are the run's own states, nothing invented
 *
 *  - **firing** (`starting` / `running`): the full cycle — draw, hold, loose,
 *    arrow away across the strip's whole width.
 *  - **holding** (`awaiting_permission`): drawn and dead still. The run is
 *    paused on the user, and an archer holding at full draw *is* that state —
 *    aimed, waiting, going nowhere until someone says so.
 *  - **rest** (everything else — before the first run and after `ended`):
 *    string straight, arrow gone, dimmed. The animation stopping rather than
 *    the element vanishing is what says "complete"; the fixture staying is
 *    what makes it a fixture.
 *
 * ## Moonlight, not machine-cyan
 *
 * The bow draws in `lunar` while it works and fades to `ink-faint` at rest.
 * An earlier cut coloured the arrow `cyan` to match the transcript's
 * work-in-progress tone, and that was the wrong instinct: the tone system
 * grades *rows* — badges, dots, labels — and this is not a row, it is the
 * app's own mark. Artemis is the moon as much as the hunt; the accent is
 * literally named for her light, it is the colour the runbar above already
 * sweeps in, and the two indicators reading as one system matters more than
 * the bow participating in a taxonomy it is not part of.
 *
 * ## All CSS, no clock
 *
 * The poses are attribute swaps; the firing loop is four CSS animations (see
 * `index.css`, `artemis-bow-*`) sharing one 2400ms duration, synchronised by
 * mounting in the same commit. Nothing here ticks, subscribes to tokens, or
 * measures the pane — the flight crosses "however wide the strip is" by
 * translating a full-width span 100% of itself, which is the runbar's own
 * trick. The single subscription is `run?.status`, which changes a handful of
 * times per run.
 *
 * `aria-hidden`, whole strip: the status line's run segment already reports
 * this state as text, and a screen reader announcing an SVG archery loop would
 * be noise on top of it.
 */

import type { ReactElement } from 'react';

import { usePane } from '../state/paneContext';
import { cn } from '@/lib/utils';

type Pose = 'firing' | 'holding' | 'rest';

/** String at rest and at full draw. Same M-L-L structure, so the CSS `d`
 * morph between them is legal; the midpoint is where the arrow nocks. */
const STRING_REST = 'M5 2 L5 8 L5 14';
const STRING_DRAWN = 'M5 2 L2 8 L5 14';

export function HuntBar(): ReactElement {
  const status = usePane((s) => s.run?.status ?? null);

  // No run yet reads as `rest`, deliberately — the fixture is constant, and a
  // fresh pane's quiet bow is the same statement as a finished run's: nothing
  // is in flight here.
  const pose: Pose =
    status === 'starting' || status === 'running'
      ? 'firing'
      : status === 'awaiting_permission'
        ? 'holding'
        : 'rest';

  return (
    <div
      data-slot="hunt-bar"
      data-pose={pose}
      aria-hidden="true"
      className="relative h-4 shrink-0 overflow-hidden"
    >
      {/*
        The arrow in flight. A span the width of the whole strip with the glyph
        at its left edge, translated by percentages of itself — see the flight
        keyframes for why that is the only way to cross an unmeasured pane.
        `opacity-0` in the markup is load-bearing: it is the element's state
        whenever its animation is not running, which is what keeps a loose
        arrow from parking over the bow under `prefers-reduced-motion`.
        Mounted only while firing, so the other poses hold no invisible DOM.
      */}
      {pose === 'firing' ? (
        <span className="hunt-flight absolute inset-0 text-lunar opacity-0">
          <ArrowInFlight />
        </span>
      ) : null}
      <Bow pose={pose} />
    </div>
  );
}

/**
 * The bow, facing down-range: string on the left where the archer is, stave
 * bellying right, arrow nocked at the string's midpoint. 16×16 user units
 * rendered at 16px, so the CSS pixel transforms in the keyframes move exactly
 * the user units the paths are drawn in.
 *
 * The firing classes and the static poses are exclusive on purpose. `holding`
 * writes the drawn string and the pulled-back arrow as attributes with no
 * animation to fight; `firing` leaves the attributes at rest and lets the
 * keyframes own the motion. One source of truth per pose, never both.
 */
function Bow({ pose }: { readonly pose: Pose }): ReactElement {
  const firing = pose === 'firing';
  const holding = pose === 'holding';

  return (
    <svg
      viewBox="0 0 16 16"
      className={cn(
        'absolute top-0 left-1 size-4',
        // Lunar while anything is happening; faint ink at rest. A constant
        // fixture has to earn its permanence by being quiet when idle, and
        // has room to be the accent when it is the thing reporting.
        pose === 'rest' ? 'text-ink-faint' : 'text-lunar',
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className={firing ? 'hunt-recoil' : undefined}>
        {/* The stave: a shallow arc, drawn heavier than the string so the two
            read as limb and wire rather than as one closed outline — at a
            deeper arc and a single weight the whole bow read as a leaf. It
            never moves relative to the archer; the recoil kicks the group. */}
        <path strokeWidth="1.5" d="M5 2 Q 9.5 8 5 14" />
        <path
          strokeWidth="0.8"
          className={firing ? 'hunt-string' : undefined}
          d={holding ? STRING_DRAWN : STRING_REST}
        />
        {/* The nocked arrow: shaft and head only — fletch ticks at this size
            read as a second head and turn the arrow into ⟷. Gone at rest: it
            was loosed (or never drawn), and a nocked arrow under a finished
            answer would claim work is still coming. */}
        {pose === 'rest' ? null : (
          <g
            className={cn(firing && 'hunt-nock')}
            style={holding ? { transform: 'translateX(-3px)' } : undefined}
          >
            <path d="M5 8 L14 8" />
            <path d="M12 6.2 L14 8 L12 9.8" />
          </g>
        )}
      </g>
    </svg>
  );
}

/**
 * The loosed arrow, drawn once at the flight span's left edge. Same anatomy
 * and stroke as the nocked one so the loose reads as the *same* arrow leaving,
 * not a swap — the nocked glyph blinks out and this appears in the next frame
 * of the shared clock.
 */
function ArrowInFlight(): ReactElement {
  return (
    <svg
      viewBox="0 0 20 16"
      className="absolute top-0 left-0 h-4 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 8 L17 8" />
      <path d="M14.6 5.6 L17 8 L14.6 10.4" />
    </svg>
  );
}
