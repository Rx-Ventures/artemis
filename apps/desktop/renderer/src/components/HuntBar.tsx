/**
 * The hunt bar: Artemis' bow, pinned at the foot of the conversation.
 * ============================================================================
 *
 * The app is named for the goddess of the hunt, and this is the one place it
 * says so: a small bow at the seam where the transcript ends, loosing an arrow
 * across the pane for as long as a run is going. It replaced the anonymous
 * lunar sweep that used to hairline this seam — same position, same meaning,
 * but now the progress chrome is the app's own mark instead of a gradient any
 * toolkit could have shipped.
 *
 * ## Why this seam, and not a float over the transcript
 *
 * "Pinned to the bottom of the conversation" had two candidate readings. An
 * overlay inside the transcript's scroller stays at the visual bottom only
 * while the tail-follower holds; scroll up mid-run and it either scrolls away
 * (not pinned) or floats over text the user is trying to read (occlusion, and
 * a fight with the Jump-to-latest button for the same corner). The seam above
 * the composer is the conversation's actual bottom edge, is visible in every
 * scroll position, and is a row of its own — the arrow crosses empty range,
 * never someone's diff.
 *
 * ## The three poses are the run's own states, nothing invented
 *
 *  - **firing** (`starting` / `running`): the full cycle — draw, hold, loose,
 *    arrow away. The flight is the strip's whole width, which is what makes it
 *    legible as "in progress" rather than as a decoration that happens to move.
 *  - **holding** (`awaiting_permission`): drawn and dead still. The run is
 *    paused on the user, and an archer holding at full draw *is* that state —
 *    aimed, waiting, going nowhere until someone says so. Deliberately not
 *    tinted amber: the status line already grades what is owed (amber for an
 *    approval, cyan for a question), and a mascot repainting that distinction
 *    in one colour would blur it, not restate it.
 *  - **rest** (`ended`): string straight, arrow gone — it was loosed; the
 *    answer above is where it landed. This is the "animation stops when the
 *    run completes" state, and it *stays on screen* rather than unmounting:
 *    a bow that vanished the instant the run ended would read as chrome
 *    breaking, and the resting pose is what makes the firing one mean
 *    something.
 *
 * The strip exists only once the pane has a run at all (`run` survives its own
 * end — see `RunStatus`), so a fresh pane pays no height for it. The 16px it
 * does cost after the first prompt is the one deliberate trade here: this app
 * strips permanent chrome on sight, and this row is decoration by any honest
 * accounting — but it is *asked-for* decoration, it is the only piece in the
 * window, and at rest it is a dim glyph in an otherwise empty seam.
 *
 * ## All CSS, no clock
 *
 * The poses are attribute swaps; the firing loop is four CSS animations (see
 * `index.css`, `artemis-bow-*`) sharing one 2400ms duration, synchronised by
 * mounting in the same commit. Nothing here ticks, subscribes to tokens, or
 * measures the pane — the flight crosses "however wide the strip is" by
 * translating a full-width span 100% of itself, which is the old runbar's own
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

export function HuntBar(): ReactElement | null {
  const status = usePane((s) => s.run?.status ?? null);
  if (status === null) return null;

  const pose: Pose =
    status === 'ended' ? 'rest' : status === 'awaiting_permission' ? 'holding' : 'firing';

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
        <span className="hunt-flight absolute inset-0 text-cyan opacity-0">
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
        // Rest dims to faint — present, finished, not asking for the eye.
        pose === 'rest' ? 'text-ink-faint' : 'text-ink-muted',
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
            read as a second head and turn the arrow into ⟷. Cyan while firing
            — the app's "work in progress" tone, matching the flight it becomes
            — and the bow's own ink while merely held. Gone at rest: it was
            loosed, and a re-nocked arrow under a finished answer would claim
            work is still coming. */}
        {pose === 'rest' ? null : (
          <g
            className={cn(firing && 'hunt-nock text-cyan')}
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
